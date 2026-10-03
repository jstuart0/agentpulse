/**
 * The supervisor's heartbeat carries one optional field, excludeRulesState
 * ("none" | "ok" | "invalid"): whether the user's exclude file on that host is
 * in use, absent, or broken. The server keeps only the one state somebody has to
 * act on: "invalid" is stored and returned, any other valid value is stored as
 * null (so the server never records that a host uses exclusion at all). The
 * flag is cleared when the supervisor registers and when a heartbeat arrives
 * with no body or an empty one (an older supervisor after a downgrade).
 *
 * A heartbeat is never rejected because of this field: a failing heartbeat makes
 * the supervisor exit. `{}`, unparseable JSON, a value outside the domain, an
 * oversized body and a body of the wrong shape all get 200 and leave the column
 * as it was.
 *
 * The cases that read the column go through raw SQL, so they do not depend on
 * the schema file that declares it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb, getSqlite } = await import("../db/client.js");
const { executeRows } = await import("../db/sql-helpers.js");
const { sql } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { recordHeartbeatExcludeState } = await import("../services/supervisor-exclude-state.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function registerFreshSupervisor(): Promise<{ id: string; credential: string }> {
	const { token } = await createSupervisorEnrollmentToken(`hb-${crypto.randomUUID()}`, null, null);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "heartbeat-test-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	const body = (await res.json()) as { supervisorCredential: string };
	return { id, credential: body.supervisorCredential };
}

function heartbeat(id: string, credential: string, body?: BodyInit | null) {
	return app.request(`/api/v1/supervisors/${id}/heartbeat`, {
		method: "POST",
		headers: {
			"X-AgentPulse-Supervisor-Token": credential,
			...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
		},
		...(body === undefined ? {} : { body }),
	});
}

async function storedState(id: string): Promise<string | null> {
	const rows = await executeRows<{ state: string | null }>(
		getDb(),
		sql`SELECT exclude_rules_state AS state FROM supervisors WHERE id = ${id}`,
	);
	return rows[0]?.state ?? null;
}

describe("only an invalid file is stored and returned", () => {
	test("invalid: the column holds it and the heartbeat's supervisor carries it", async () => {
		const { id, credential } = await registerFreshSupervisor();
		const res = await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
		expect(body.supervisor.excludeRulesState).toBe("invalid");
		expect(await storedState(id)).toBe("invalid");
	});

	for (const state of ["none", "ok"] as const) {
		test(`${state}: valid, accepted, and stored as null: the server does not record that a host uses exclusion`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			const res = await heartbeat(id, credential, JSON.stringify({ excludeRulesState: state }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
			expect(body.supervisor.excludeRulesState ?? null).toBeNull();
			expect(await storedState(id)).toBeNull();
		});
	}

	test("a later valid heartbeat that is not invalid clears an earlier invalid one, and a later invalid one sets it again", async () => {
		const { id, credential } = await registerFreshSupervisor();
		await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
		await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "ok" }));
		expect(await storedState(id)).toBeNull();
		await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
		expect(await storedState(id)).toBe("invalid");
	});

	for (const state of ["none", "ok"] as const) {
		test(`a heartbeat that says ${state} clears an earlier invalid one`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
			expect(await storedState(id)).toBe("invalid");
			await heartbeat(id, credential, JSON.stringify({ excludeRulesState: state }));
			expect(await storedState(id)).toBeNull();
		});
	}

	test("a state an earlier version stored (none or ok) reads back as null, not as that state", async () => {
		for (const legacy of ["none", "ok"]) {
			const { id, credential } = await registerFreshSupervisor();
			await executeRows(
				getDb(),
				sql`UPDATE supervisors SET exclude_rules_state = ${legacy} WHERE id = ${id}`,
			);
			const res = await heartbeat(id, credential, "{}");
			const body = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
			expect(body.supervisor.excludeRulesState ?? null, legacy).toBeNull();
		}
	});

	test("a supervisor that has never said anything is null (unknown), also in its DTO", async () => {
		const { id, credential } = await registerFreshSupervisor();
		expect(await storedState(id)).toBeNull();
		const res = await heartbeat(id, credential);
		const body = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
		expect(body.supervisor.excludeRulesState ?? null).toBeNull();
	});
});

describe("the flag is cleared when its source can no longer be speaking", () => {
	for (const [label, body] of [
		["no body", undefined],
		["an empty body", ""],
		["a body of only whitespace", "  \n"],
	] as [string, BodyInit | undefined][]) {
		test(`a heartbeat with ${label} clears an invalid flag (an old supervisor after a downgrade)`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
			expect(await storedState(id)).toBe("invalid");
			const res = await heartbeat(id, credential, body);
			expect(res.status).toBe(200);
			expect(await storedState(id)).toBeNull();
			const json = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
			expect(json.supervisor.excludeRulesState ?? null).toBeNull();
		});
	}

	test("registering again clears an invalid flag, and the registration's own answer already says so", async () => {
		const { id, credential } = await registerFreshSupervisor();
		await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-AgentPulse-Supervisor-Token": credential },
			body: JSON.stringify({
				hostName: "heartbeat-test-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				id,
			}),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { supervisor: { excludeRulesState?: string | null } };
		expect(json.supervisor.excludeRulesState ?? null).toBeNull();
		expect(await storedState(id)).toBeNull();
	});
});

describe("a heartbeat is never rejected because of this field, and the column stays as it was", () => {
	const BAD_BODIES: [string, BodyInit | null | undefined][] = [
		["{}", "{}"],
		["unparseable JSON", "{ not json"],
		["an out-of-domain value", JSON.stringify({ excludeRulesState: "frozen" })],
		["a value of the wrong type", JSON.stringify({ excludeRulesState: 5 })],
		["null", JSON.stringify({ excludeRulesState: null })],
		["an array", JSON.stringify([{ excludeRulesState: "invalid" }])],
		["a bare string", JSON.stringify("invalid")],
		[
			"a prototype key, as the raw text a client would send",
			'{"__proto__":{"excludeRulesState":"invalid"}}',
		],
		["a constructor key", '{"constructor":{"prototype":{"excludeRulesState":"invalid"}}}'],
		[
			"a body far over the limit",
			JSON.stringify({ excludeRulesState: "invalid", pad: "x".repeat(100_000) }),
		],
	];

	for (const [label, body] of BAD_BODIES) {
		test(`${label}: 200, and the supervisor's record is still returned`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			const res = await heartbeat(id, credential, body);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { supervisor?: { id: string } };
			expect(json.supervisor?.id).toBe(id);
		});

		test(`${label}: nothing is stored for a supervisor that had nothing`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			const res = await heartbeat(id, credential, body);
			expect(res.status).toBe(200);
			expect(await storedState(id)).toBeNull();
		});

		test(`${label}: a value stored earlier is left alone`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
			const res = await heartbeat(id, credential, body);
			expect(res.status).toBe(200);
			expect(await storedState(id)).toBe("invalid");
		});
	}

	test("a wrong credential still gets 401 and another supervisor's credential 403 (the field changes neither)", async () => {
		const { id, credential } = await registerFreshSupervisor();
		const wrong = await heartbeat(
			id,
			"not-a-credential",
			JSON.stringify({ excludeRulesState: "ok" }),
		);
		expect(wrong.status).toBe(401);
		const other = await app.request("/api/v1/supervisors/someone-else/heartbeat", {
			method: "POST",
			headers: { "X-AgentPulse-Supervisor-Token": credential },
		});
		expect(other.status).toBe(403);
	});
});

describe("registration does not carry the state (heartbeat only)", () => {
	test("a registration that names excludeRulesState does not set it", async () => {
		const { token } = await createSupervisorEnrollmentToken(
			`hb-${crypto.randomUUID()}`,
			null,
			null,
		);
		const id = crypto.randomUUID();
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "h",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				enrollmentToken: token,
				id,
				excludeRulesState: "invalid",
			}),
		});
		expect(res.status).toBe(200);
		expect(await storedState(id)).toBeNull();
	});
});

describe("a failure to write the flag is swallowed (an injected failing write, so no migration is involved)", () => {
	const writes: [string, string | null][] = [];
	const failingWrite = async (supervisorId: string, state: string | null) => {
		writes.push([supervisorId, state]);
		throw new Error("the column is not there");
	};
	const probe = new Hono().post("/hb/:id", async (c) => {
		await recordHeartbeatExcludeState(c, c.req.param("id"), failingWrite);
		return c.json({ ok: true });
	});

	test("a heartbeat that says invalid still answers 200, and the write was attempted", async () => {
		writes.length = 0;
		const res = await probe.request("/hb/sup-x", {
			method: "POST",
			body: JSON.stringify({ excludeRulesState: "invalid" }),
		});
		expect(res.status).toBe(200);
		expect(writes).toEqual([["sup-x", "invalid"]]);
	});

	test("a heartbeat with no body (a clear) still answers 200, and the write was attempted", async () => {
		writes.length = 0;
		const res = await probe.request("/hb/sup-x", { method: "POST" });
		expect(res.status).toBe(200);
		expect(writes).toEqual([["sup-x", null]]);
	});
});

describeSqliteOnly("a healthy host's heartbeat writes what it always did", () => {
	/** The lease update, and the host credential's last-used time. */
	const LEASE_AND_LAST_USED = 2;
	const rowsWritten = () =>
		(getSqlite().query("SELECT total_changes() AS n").get() as { n: number }).n;

	for (const [label, body] of [
		["no body (the shipped supervisor when its file is fine)", undefined],
		["an empty body", ""],
		["a body that says ok", JSON.stringify({ excludeRulesState: "ok" })],
	] as [string, BodyInit | undefined][]) {
		test(`a heartbeat with ${label} writes only the lease and the credential's last-used time, not the flag`, async () => {
			const { id, credential } = await registerFreshSupervisor();
			const before = rowsWritten();
			const res = await heartbeat(id, credential, body);
			expect(res.status).toBe(200);
			expect(rowsWritten() - before).toBe(LEASE_AND_LAST_USED);
		});
	}

	test("positive control: a heartbeat that has a flag to clear writes it too", async () => {
		const { id, credential } = await registerFreshSupervisor();
		await heartbeat(id, credential, JSON.stringify({ excludeRulesState: "invalid" }));
		const before = rowsWritten();
		await heartbeat(id, credential);
		expect(rowsWritten() - before).toBe(LEASE_AND_LAST_USED + 1);
		expect(await storedState(id)).toBeNull();
	});
});
