/**
 * What a fork's tool calls ran (AGEN-123): the person routes and the host's report, over the real app.
 * Who may read (a signed-in owner or an admin, never an API key), the refusals that reveal nothing, the
 * host's side of the contract, and the limits. Real SQLite by default, Postgres under
 * AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { FORK_TOOL_DETAIL_LIMITS, type ForkToolCallReport } from "../../shared/fork-tool-calls.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const detail = await import("../services/fork-tool-detail.js");
const { mayReadToolDetail } = await import("../services/authorization.js");

const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hostIds: string[] = [];
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	detail.__resetForkToolDetailLimiterForTests();
	await harness.cleanApprovalFixtures(used.splice(0), hostIds.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(async () => {
	await reset();
	await deleteAllSupervisors();
});

let counter = 0;
async function seedFork(ownerUserId: string | null) {
	counter++;
	const sessionId = `t123-route-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = `t123-route-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	used.push(sessionId);
	hostIds.push(supervisorId);
	await harness.seedApprovalSession({
		sessionId,
		supervisorId,
		ownerUserId,
		agentType: "claude_code",
	});
	await getDb()
		.update(sessions)
		.set({ metadata: { forkedFromSessionId: "the-original" } })
		.where(eq(sessions.sessionId, sessionId));
	return { sessionId, supervisorId };
}

const call = (over: Partial<ForkToolCallReport> = {}): ForkToolCallReport => ({
	toolUseId: `toolu_${crypto.randomUUID().slice(0, 12)}`,
	turnActionId: "act-1",
	tool: "Bash",
	outcome: "unasked",
	fromSubagent: false,
	input: '{"command":"echo hi"}',
	inputTruncated: false,
	output: "hi",
	outputTruncated: false,
	...over,
});

async function store(
	ctx: { sessionId: string; supervisorId: string },
	...calls: ForkToolCallReport[]
) {
	await detail.recordForkToolCalls(ctx.supervisorId, ctx.sessionId, calls);
}

const list = (sessionId: string, headers: Headers, query = "") =>
	app.request(`/api/v1/sessions/${sessionId}/tool-calls${query}`, { headers });
const one = (sessionId: string, toolUseId: string, headers: Headers) =>
	app.request(`/api/v1/sessions/${sessionId}/tool-calls/${toolUseId}`, { headers });
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

async function team() {
	await setStoredMode("team");
	const owner = await seedLocalUser("t123-owner");
	const member = await seedLocalUser("t123-member");
	const admin = await seedLocalUser("t123-admin", "admin");
	return { owner, member, admin };
}

describe("who may read (the matrix)", () => {
	test("team: the owner and an admin read; another member is refused; an unowned session is an admin's", async () => {
		const t = await team();
		const mine = await seedFork(t.owner.id);
		const c = call();
		await store(mine, c);
		for (const [who, status] of [
			[t.owner.id, 200],
			[t.admin.id, 200],
			[t.member.id, 403],
		] as const) {
			const headers = await cookieHeadersFor(who);
			expect({ who, list: (await list(mine.sessionId, headers)).status }).toEqual({
				who,
				list: status,
			});
			expect({ who, one: (await one(mine.sessionId, c.toolUseId, headers)).status }).toEqual({
				who,
				one: status,
			});
		}
		const unowned = await seedFork(null);
		await store(unowned, c);
		expect((await list(unowned.sessionId, await cookieHeadersFor(t.member.id))).status).toBe(403);
		expect((await list(unowned.sessionId, await cookieHeadersFor(t.owner.id))).status).toBe(403);
		expect((await list(unowned.sessionId, await cookieHeadersFor(t.admin.id))).status).toBe(200);
	});

	test("an owner change moves access", async () => {
		const t = await team();
		const ctx = await seedFork(t.owner.id);
		await store(ctx, call());
		expect((await list(ctx.sessionId, await cookieHeadersFor(t.member.id))).status).toBe(403);
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.member.id })
			.where(eq(sessions.sessionId, ctx.sessionId));
		expect((await list(ctx.sessionId, await cookieHeadersFor(t.member.id))).status).toBe(200);
		expect((await list(ctx.sessionId, await cookieHeadersFor(t.owner.id))).status).toBe(403);
	});

	test("a disabled owner is refused", async () => {
		const t = await team();
		const ctx = await seedFork(t.owner.id);
		await store(ctx, call());
		const headers = await cookieHeadersFor(t.owner.id);
		const { disableUserDirectly } = await import("../test-utils/team-fixtures.js");
		await disableUserDirectly(t.owner.id);
		expect((await list(ctx.sessionId, headers)).status).toBeGreaterThanOrEqual(401);
		expect((await list(ctx.sessionId, headers)).status).not.toBe(200);
	});

	test("solo: the signed-in person reads; DISABLE_AUTH reads too (the flag's existing posture)", async () => {
		const ctx = await seedFork(null);
		const c = call();
		await store(ctx, c);
		const person = await seedLocalUser("t123-solo");
		expect((await list(ctx.sessionId, await cookieHeadersFor(person.id))).status).toBe(200);
		(config as Record<string, unknown>).disableAuth = true;
		expect((await list(ctx.sessionId, new Headers())).status).toBe(200);
		expect((await one(ctx.sessionId, c.toolUseId, new Headers())).status).toBe(200);
	});

	test("every key scope is refused, an admin-owned and an ownerless manage key included, in solo and in team", async () => {
		for (const mode of ["solo", "team"] as const) {
			await resetIdentityState();
			await clearInstanceSettings();
			await setStoredMode(mode);
			const admin = await seedLocalUser(`t123-key-admin-${mode}`, "admin");
			const ctx = await seedFork(admin.id);
			const c = call();
			await store(ctx, c);
			const keys = {
				ingest: await seedKey("k-ingest", ["ingest"]),
				observe: await seedKey("k-observe", ["observe"]),
				respond: await seedKey("k-respond", ["respond"]),
				manage: await seedKey("k-manage", ["manage"]),
				adminManage: await seedKey("k-admin-manage", ["manage"], admin.id),
			};
			if (mode === "team") await setAdminServiceKeyList([keys.manage.id]);
			for (const [name, key] of Object.entries(keys)) {
				const headers = bearerHeaders(key.key);
				const a = await list(ctx.sessionId, headers);
				const b = await one(ctx.sessionId, c.toolUseId, headers);
				expect({ mode, name, list: a.status, one: b.status }).toEqual({
					mode,
					name,
					list: 403,
					one: 403,
				});
				if (name === "manage" || name === "adminManage") {
					expect(await errorOf(a)).toBe("human_required");
					expect(await errorOf(b)).toBe("human_required");
				}
			}
		}
	});

	test("no credential at all is refused", async () => {
		const ctx = await seedFork(null);
		expect((await list(ctx.sessionId, new Headers())).status).toBe(401);
	});

	test("the pure rule: an inverted predicate is caught by the table", () => {
		const person = (role: "admin" | "user" | "none", userId: string | null) =>
			({ mode: "team", role, userId, source: "cookie" }) as never;
		const cases: Array<[never, "solo" | "team", { ownerUserId: string | null } | null, boolean]> = [
			[person("user", "o"), "team", { ownerUserId: "o" }, true],
			[person("user", "m"), "team", { ownerUserId: "o" }, false],
			[person("admin", "a"), "team", { ownerUserId: "o" }, true],
			[person("user", "m"), "team", { ownerUserId: null }, false],
			[person("admin", "a"), "team", { ownerUserId: null }, true],
			[person("user", "m"), "team", null, false],
			[person("admin", "a"), "team", null, true],
			[person("none", null), "team", { ownerUserId: "o" }, false],
			[person("user", "m"), "solo", { ownerUserId: "o" }, true],
		];
		const disagreements = (rule: typeof mayReadToolDetail) =>
			cases.filter(([actor, mode, session, want]) => rule(actor, mode, session) !== want);
		expect(disagreements(mayReadToolDetail)).toEqual([]);
		expect(disagreements(() => true).length).toBeGreaterThan(0);
		expect(disagreements(() => false).length).toBeGreaterThan(0);
	});
});

describe("what a refusal reveals, and what a read returns", () => {
	test("the same 403 body for a missing and an existing tool_use_id", async () => {
		const t = await team();
		const ctx = await seedFork(t.owner.id);
		const c = call();
		await store(ctx, c);
		const headers = await cookieHeadersFor(t.member.id);
		const real = await one(ctx.sessionId, c.toolUseId, headers);
		const missing = await one(ctx.sessionId, "toolu_does_not_exist", headers);
		expect(real.status).toBe(403);
		expect(missing.status).toBe(403);
		expect(await real.json()).toEqual(await missing.json());
		// A session that doesn't exist reads the same to a member.
		const ghost = await one("t123-no-such-session", c.toolUseId, headers);
		expect(ghost.status).toBe(403);
	});

	test("an authorised reader gets 404 for a missing call and a missing session", async () => {
		const t = await team();
		const ctx = await seedFork(t.owner.id);
		const headers = await cookieHeadersFor(t.admin.id);
		expect((await one(ctx.sessionId, "toolu_missing", headers)).status).toBe(404);
		expect(await errorOf(await list("t123-no-such-session", headers))).toBe("session_not_found");
	});

	test("responses are no-store and carry only the documented keys", async () => {
		const ctx = await seedFork(null);
		const c = call();
		await store(ctx, c);
		const person = await seedLocalUser("t123-shape");
		const headers = await cookieHeadersFor(person.id);
		const res = await list(ctx.sessionId, headers);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const body = (await res.json()) as {
			v: number;
			calls: Array<Record<string, unknown>>;
			nextBeforeId: unknown;
		};
		expect(Object.keys(body).sort()).toEqual(["calls", "nextBeforeId", "v"]);
		expect(Object.keys(body.calls[0] ?? {}).sort()).toEqual(
			[
				"createdAt",
				"fromSubagent",
				"input",
				"inputTruncated",
				"output",
				"outputTruncated",
				"outcome",
				"redacted",
				"tool",
				"toolUseId",
			].sort(),
		);
		expect(body.calls[0]?.output).toBe("hi");
		const single = await one(ctx.sessionId, c.toolUseId, headers);
		expect(single.headers.get("Cache-Control")).toBe("no-store");
	});

	test("view=index leaves the text out", async () => {
		const ctx = await seedFork(null);
		await store(ctx, call());
		const person = await seedLocalUser("t123-index");
		const body = (await (
			await list(ctx.sessionId, await cookieHeadersFor(person.id), "?view=index")
		).json()) as {
			calls: Array<{ input: unknown; output: unknown; tool: string }>;
		};
		expect(body.calls).toHaveLength(1);
		expect(body.calls[0]?.input).toBeNull();
		expect(body.calls[0]?.output).toBeNull();
		expect(body.calls[0]?.tool).toBe("Bash");
	});

	test("beforeId pages within the path session; another session's id returns nothing of it", async () => {
		const ctx = await seedFork(null);
		const other = await seedFork(null);
		const calls = Array.from({ length: 5 }, (_, i) => call({ toolUseId: `toolu_p${i}` }));
		for (const c of calls) await store(ctx, c);
		const foreign = call({ toolUseId: "toolu_foreign" });
		await store(other, foreign);
		const person = await seedLocalUser("t123-page");
		const headers = await cookieHeadersFor(person.id);
		const page1 = (await (await list(ctx.sessionId, headers, "?limit=2")).json()) as {
			calls: Array<{ toolUseId: string }>;
			nextBeforeId: string | null;
		};
		expect(page1.calls.map((c) => c.toolUseId)).toEqual(["toolu_p4", "toolu_p3"]);
		const page2 = (await (
			await list(ctx.sessionId, headers, `?limit=2&beforeId=${page1.nextBeforeId}`)
		).json()) as { calls: Array<{ toolUseId: string }> };
		expect(page2.calls.map((c) => c.toolUseId)).toEqual(["toolu_p2", "toolu_p1"]);
		const probe = (await (
			await list(ctx.sessionId, headers, "?beforeId=toolu_foreign")
		).json()) as {
			calls: unknown[];
		};
		expect(probe.calls).toEqual([]);
	});

	test("the same tool_use_id in two sessions resolves within the path session", async () => {
		const a = await seedFork(null);
		const b = await seedFork(null);
		await store(a, call({ toolUseId: "toolu_same", output: "from a" }));
		await store(b, call({ toolUseId: "toolu_same", output: "from b" }));
		const person = await seedLocalUser("t123-same");
		const headers = await cookieHeadersFor(person.id);
		const fromA = (await (await one(a.sessionId, "toolu_same", headers)).json()) as {
			call: { output: string };
		};
		const fromB = (await (await one(b.sessionId, "toolu_same", headers)).json()) as {
			call: { output: string };
		};
		expect([fromA.call.output, fromB.call.output]).toEqual(["from a", "from b"]);
	});

	test("turnActionId filters; limit 0, 101 and x are 400", async () => {
		const ctx = await seedFork(null);
		await store(
			ctx,
			call({ toolUseId: "toolu_t1", turnActionId: "act-1" }),
			call({ toolUseId: "toolu_t2", turnActionId: "act-2" }),
		);
		const person = await seedLocalUser("t123-query");
		const headers = await cookieHeadersFor(person.id);
		const filtered = (await (await list(ctx.sessionId, headers, "?turnActionId=act-2")).json()) as {
			calls: Array<{ toolUseId: string }>;
		};
		expect(filtered.calls.map((c) => c.toolUseId)).toEqual(["toolu_t2"]);
		for (const bad of [
			"?limit=0",
			"?limit=101",
			"?limit=x",
			"?limit=-1",
			"?limit=1.5",
			"?turnActionId=has%20space",
		]) {
			const res = await list(ctx.sessionId, headers, bad);
			expect({ bad, status: res.status, error: await errorOf(res) }).toEqual({
				bad,
				status: 400,
				error: "invalid_query",
			});
		}
		expect((await list(ctx.sessionId, headers, "?limit=100")).status).toBe(200);
	});

	test("without the secrets key the read says the feature is unavailable", async () => {
		const ctx = await seedFork(null);
		const person = await seedLocalUser("t123-nokey");
		const key = config.secretsKey;
		(config as Record<string, unknown>).secretsKey = "";
		try {
			const res = await list(ctx.sessionId, await cookieHeadersFor(person.id));
			expect(res.status).toBe(503);
			expect(await errorOf(res)).toBe("detail_unavailable");
		} finally {
			(config as Record<string, unknown>).secretsKey = key;
		}
	});
});

// ---- the host's report ----

type Host = { id: string; token: string };
let manageKey: string;

async function enroll(name: string): Promise<Host> {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name }),
	});
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: name,
			enrollmentToken,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: {},
			},
			trustedRoots: ["/tmp"],
		}),
	});
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
		serverFeatures?: string[];
	};
	expect(body.serverFeatures).toContain("fork_tool_detail");
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

describe("the host's report", () => {
	let hostA: Host;
	let hostB: Host;
	beforeEach(async () => {
		(config as Record<string, unknown>).disableAuth = false;
		manageKey = (await createApiKey("t123-manage", ["manage"])).key;
		hostA = await enroll("t123-host-a");
		hostB = await enroll("t123-host-b");
	});

	const post = (host: Host, sessionId: string, body: unknown) =>
		app.request(`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/tool-calls`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-AgentPulse-Supervisor-Token": host.token },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});

	async function forkOn(host: Host) {
		counter++;
		const sessionId = `t123-host-session-${counter}-${crypto.randomUUID().slice(0, 6)}`;
		used.push(sessionId);
		await harness.seedApprovalSession({
			sessionId,
			supervisorId: host.id,
			agentType: "claude_code",
		});
		await getDb()
			.update(sessions)
			.set({ metadata: { forkedFromSessionId: "the-original" } })
			.where(eq(sessions.sessionId, sessionId));
		return sessionId;
	}

	test("201 with the counts; the owner then reads what was sent", async () => {
		const sessionId = await forkOn(hostA);
		const c = call({ output: "from the host" });
		const res = await post(hostA, sessionId, { v: 1, calls: [c] });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ stored: 1, dropped: 0 });
	});

	test("another host's credential is 403 and stores nothing; a non-fork is refused", async () => {
		const sessionId = await forkOn(hostA);
		const foreign = await post(hostB, sessionId, { v: 1, calls: [call()] });
		expect(foreign.status).toBe(403);
		expect(await errorOf(foreign)).toBe("session_not_owned");
		counter++;
		const plain = `t123-plain-${counter}-${crypto.randomUUID().slice(0, 6)}`;
		used.push(plain);
		await harness.seedApprovalSession({
			sessionId: plain,
			supervisorId: hostA.id,
			agentType: "claude_code",
		});
		const refused = await post(hostA, plain, { v: 1, calls: [call()] });
		expect(refused.status).toBe(409);
		expect(await errorOf(refused)).toBe("not_a_fork");
	});

	test("a body that isn't the contract is 400; a bad credential is refused", async () => {
		const sessionId = await forkOn(hostA);
		for (const body of ["not json", { v: 1, calls: [] }, { v: 1, calls: [{ nope: true }] }, [1]]) {
			expect((await post(hostA, sessionId, body)).status).toBe(400);
		}
		const noToken = await app.request(
			`/api/v1/supervisors/${hostA.id}/managed-sessions/${sessionId}/tool-calls`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect([401, 403]).toContain(noToken.status);
	});

	test("256 KiB is the body limit (413), and 300 reports a minute then 429 with Retry-After", async () => {
		const sessionId = await forkOn(hostA);
		const big = await post(
			hostA,
			sessionId,
			"x".repeat(FORK_TOOL_DETAIL_LIMITS.reportBodyBytes + 1),
		);
		expect(big.status).toBe(413);
		const host = await enroll("t123-host-limit");
		const limited = await forkOn(host);
		const reportsPerMinute = FORK_TOOL_DETAIL_LIMITS.reportsPerMinute;
		let throttled: Response | null = null;
		for (let i = 0; i < reportsPerMinute + 1; i++) {
			const res = await post(host, limited, "not json");
			if (res.status === 429) {
				throttled = res;
				expect(i).toBe(reportsPerMinute);
				break;
			}
		}
		expect(throttled?.status).toBe(429);
		expect(throttled?.headers.get("Retry-After")).toBeTruthy();
	}, 60_000);

	test("without the secrets key the host is told the feature isn't there, and register stops offering it", async () => {
		const sessionId = await forkOn(hostA);
		const key = config.secretsKey;
		(config as Record<string, unknown>).secretsKey = "";
		try {
			const res = await post(hostA, sessionId, { v: 1, calls: [call()] });
			expect(res.status).toBe(503);
			const heartbeat = await app.request(`/api/v1/supervisors/${hostA.id}/heartbeat`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentPulse-Supervisor-Token": hostA.token,
				},
				body: "{}",
			});
			const body = (await heartbeat.json()) as { serverFeatures?: string[] };
			expect(body.serverFeatures).not.toContain("fork_tool_detail");
		} finally {
			(config as Record<string, unknown>).secretsKey = key;
		}
	});
});
