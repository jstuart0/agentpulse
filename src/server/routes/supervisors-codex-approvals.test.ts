/**
 * Codex approvals, phase 5: the supervisor's two routes (report and sync), what `register` and
 * `heartbeat` tell it, and what a restart closes (AGEN-87, plan 5.1, D11, D14). Real enrollment and
 * credentials over the real app: another host's token, another host's ids and an oversize body are
 * all shown to change nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { CODEX_APPROVAL_LIMITS } from "../../shared/codex-approvals.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { codexApprovals, sessions: sessionsTable } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");

const originalDisableAuth = config.disableAuth;
let manageKey: string;

type Host = { id: string; token: string };

async function enroll(name: string): Promise<Host & { serverFeatures?: string[] }> {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await register({ hostName: name, enrollmentToken });
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
		serverFeatures?: string[];
	};
	return {
		id: body.supervisor.id,
		token: body.supervisorCredential,
		serverFeatures: body.serverFeatures,
	};
}

function register(extra: Record<string, unknown>, token?: string) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-AgentPulse-Supervisor-Token": token } : {}),
		},
		body: JSON.stringify({
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: { codex: { available: true, command: "codex", resolvedPath: "/bin/codex" } },
			},
			trustedRoots: ["/tmp"],
			...extra,
		}),
	});
}

const agentHeaders = (host: Host) => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": host.token,
});

const reportPath = (host: Host, sessionId: string) =>
	`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`;
const syncPath = (host: Host) => `/api/v1/supervisors/${host.id}/approvals/sync`;

const postJson = (path: string, host: Host, body: unknown) =>
	app.request(path, {
		method: "POST",
		headers: agentHeaders(host),
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

let hostA: Host;
let hostB: Host;
const sessionsUsed: string[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("p5-routes-manage", ["manage"])).key;
	hostA = await enroll("p5-host-a");
	hostB = await enroll("p5-host-b");
});

afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	await deleteAllSupervisors();
});

afterEach(async () => {
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
});

let counter = 0;
async function sessionOn(host: Host) {
	const sessionId = `p5-routes-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
	return sessionId;
}

const report = (over: Record<string, unknown> = {}) => ({
	...harness.commandReport({ rpcId: crypto.randomUUID(), itemId: crypto.randomUUID() }),
	...over,
});

async function open(host: Host, sessionId: string, over: Record<string, unknown> = {}) {
	const res = await postJson(reportPath(host, sessionId), host, report(over));
	expect([200, 201]).toContain(res.status);
	return ((await res.json()) as { approvalId: string }).approvalId;
}

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];

const sync = (host: Host, body: unknown) => postJson(syncPath(host), host, body);
const emptySync = { v: 1, live: [], resolved: [] };

describe("what register and heartbeat say", () => {
	test("both register paths and the heartbeat advertise codex_approvals; the heartbeat keeps its own fields", async () => {
		const first = await enroll("p5-fresh");
		expect(first.serverFeatures).toEqual([
			"codex_approvals",
			"claude_approvals",
			"claude_turn_control",
		]);

		const again = await register({ id: first.id, hostName: "p5-fresh" }, first.token);
		expect(again.status).toBe(200);
		const body = (await again.json()) as { supervisor: { id: string }; serverFeatures: string[] };
		expect(body.serverFeatures).toEqual([
			"codex_approvals",
			"claude_approvals",
			"claude_turn_control",
		]);
		expect(body.supervisor.id).toBe(first.id);

		const beat = await app.request(`/api/v1/supervisors/${first.id}/heartbeat`, {
			method: "POST",
			headers: agentHeaders(first),
		});
		const beatBody = (await beat.json()) as {
			supervisor: { id: string };
			serverFeatures: string[];
		};
		expect(beatBody.serverFeatures).toEqual([
			"codex_approvals",
			"claude_approvals",
			"claude_turn_control",
		]);
		expect(beatBody.supervisor.id).toBe(first.id);
	});

	test("a rotation token (an enrollment for an existing host) also closes that host's rows", async () => {
		const sessionId = await sessionOn(hostA);
		const id = await open(hostA, sessionId);
		const rotate = await app.request(`/api/v1/admin/supervisors/${hostA.id}/rotate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
			body: JSON.stringify({}),
		});
		const { token } = (await rotate.json()) as { token: string };

		const res = await register({ id: hostA.id, hostName: "p5-host-a", enrollmentToken: token });

		expect(res.status).toBe(200);
		const body = (await res.json()) as { supervisorCredential: string; serverFeatures: string[] };
		expect(body.serverFeatures).toEqual([
			"codex_approvals",
			"claude_approvals",
			"claude_turn_control",
		]);
		hostA = { id: hostA.id, token: body.supervisorCredential };
		expect((await rowOf(id))?.closedReason).toBe("runtime_gone");
	});
});

describe("restart closes this host's rows only", () => {
	test("registering again closes the host's open rows runtime_gone, an issued accept outcome_unknown, and leaves another host's alone", async () => {
		const a = await sessionOn(hostA);
		const b = await sessionOn(hostB);
		const aPending = await open(hostA, a);
		const aIssued = await open(hostA, a);
		const bPending = await open(hostB, b);
		await getDb()
			.update(codexApprovals)
			.set({
				status: "answered",
				decision: "accept",
				answeredAt: new Date().toISOString(),
				firstDeliveredAt: new Date().toISOString(),
			})
			.where(eq(codexApprovals.id, aIssued));

		const res = await register({ id: hostA.id, hostName: "p5-host-a" }, hostA.token);

		expect(res.status).toBe(200);
		expect((await rowOf(aPending))?.closedReason).toBe("runtime_gone");
		expect((await rowOf(aIssued))?.closedReason).toBe("outcome_unknown");
		expect((await rowOf(bPending))?.status).toBe("pending");
	});
});

describe("the report route", () => {
	test("201 for a new request and 200 for the same key again, with the contract's three fields", async () => {
		const sessionId = await sessionOn(hostA);
		const body = report();

		const first = await postJson(reportPath(hostA, sessionId), hostA, body);
		expect(first.status).toBe(201);
		const created = (await first.json()) as Record<string, unknown>;
		expect(Object.keys(created).sort()).toEqual(["approvalId", "expiresInMs", "revision", "v"]);
		expect(created.v).toBe(1);

		const second = await postJson(reportPath(hostA, sessionId), hostA, body);
		expect(second.status).toBe(200);
		expect(((await second.json()) as { approvalId: string }).approvalId).toBe(
			created.approvalId as string,
		);
	});

	test("host B reporting for host A's session gets 403 session_not_owned and changes nothing", async () => {
		const sessionId = await sessionOn(hostA);

		const res = await postJson(reportPath(hostB, sessionId), hostB, report());

		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("session_not_owned");
		expect(await harness.approvalRows(sessionId)).toHaveLength(0);
	});

	test("a session the server has no row for yet is 409 session_unknown; one nobody owns is 403", async () => {
		const sessionId = await sessionOn(hostA);
		await getDb().delete(sessionsTable).where(eq(sessionsTable.sessionId, sessionId));
		const unknown = await postJson(reportPath(hostA, sessionId), hostA, report());
		expect(unknown.status).toBe(409);
		expect(await errorOf(unknown)).toBe("session_unknown");

		const nobody = await postJson(reportPath(hostA, "p5-routes-never-existed"), hostA, report());
		expect(nobody.status).toBe(403);
		expect(await errorOf(nobody)).toBe("session_not_owned");
	});

	test("an unknown version, a garbled body and a body of the wrong shape are 400 invalid_body", async () => {
		const sessionId = await sessionOn(hostA);
		for (const body of [
			report({ v: 2 }),
			"not json",
			"[]",
			report({ requestKind: "other" }),
			report({ revision: 2 ** 40 }),
			report({ declineOnly: ["made_up"] }),
		]) {
			const res = await postJson(reportPath(hostA, sessionId), hostA, body);
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toBe("invalid_body");
		}
	});

	test("a body over 1 MiB is 413 before it is parsed", async () => {
		const sessionId = await sessionOn(hostA);
		const huge = JSON.stringify(
			report({ command: "x".repeat(CODEX_APPROVAL_LIMITS.reportBodyBytes) }),
		);

		const res = await postJson(reportPath(hostA, sessionId), hostA, huge);

		expect(res.status).toBe(413);
		expect(await errorOf(res)).toBe("payload_too_large");
	});

	test("no credential and another host's credential are refused", async () => {
		const sessionId = await sessionOn(hostA);
		const bare = await app.request(reportPath(hostA, sessionId), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(report()),
		});
		expect(bare.status).toBe(401);
		const wrong = await app.request(reportPath(hostA, sessionId), {
			method: "POST",
			headers: agentHeaders(hostB),
			body: JSON.stringify(report()),
		});
		expect(wrong.status).toBe(403);
		expect(await harness.approvalRows(sessionId)).toHaveLength(0);
	});

	test("refusals: session_stopping while a Stop is active, too_many_pending past 32 open, identity_conflict for a key that names another request", async () => {
		const stopping = await sessionOn(hostA);
		await harness.seedActiveStop(stopping);
		const stopped = await postJson(reportPath(hostA, stopping), hostA, report());
		expect(stopped.status).toBe(409);
		expect(await errorOf(stopped)).toBe("session_stopping");

		const crowded = await sessionOn(hostA);
		for (let i = 0; i < CODEX_APPROVAL_LIMITS.openPerSession; i++) await open(hostA, crowded);
		const over = await postJson(reportPath(hostA, crowded), hostA, report());
		expect(over.status).toBe(409);
		expect(await errorOf(over)).toBe("too_many_pending");

		const clash = await sessionOn(hostA);
		const same = { runtimeEpoch: "epoch-x", rpcId: "5" };
		await open(hostA, clash, same);
		const conflict = await postJson(
			reportPath(hostA, clash),
			hostA,
			report({ ...same, itemId: "another-item" }),
		);
		expect(conflict.status).toBe(409);
		expect(await errorOf(conflict)).toBe("identity_conflict");
	});

	test("the report limiter answers 429 with Retry-After once a host has sent its minute's worth", async () => {
		const fresh = await enroll("p5-report-limit");
		const sessionId = await sessionOn(fresh);
		let last: Response | null = null;
		for (let i = 0; i <= CODEX_APPROVAL_LIMITS.reportPerMinute; i++) {
			last = await postJson(reportPath(fresh, sessionId), fresh, "garbled");
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("5");
		expect(await errorOf(last as Response)).toBe("rate_limited");
	});
});

describe("the sync route", () => {
	test("an empty poll is 200 with the contract's four fields", async () => {
		const res = await sync(hostA, emptySync);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ v: 1, answers: [], closed: [], ack: [] });
	});

	test("host B with host A's ids: no answers, A's rows unchanged, the ids come back closed and acked like any unknown id", async () => {
		const a = await sessionOn(hostA);
		const id = await open(hostA, a);
		await getDb()
			.update(codexApprovals)
			.set({ status: "answered", decision: "accept", answeredAt: new Date().toISOString() })
			.where(eq(codexApprovals.id, id));
		const before = await rowOf(id);

		const res = await sync(hostB, {
			v: 1,
			live: [{ approvalId: id, revision: 1 }],
			resolved: [{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" }],
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { answers: unknown[]; closed: string[]; ack: unknown[] };
		expect(body.answers).toEqual([]);
		expect(body.closed).toEqual([id]);
		expect(body.ack).toEqual([{ approvalId: id, outcome: "resolved_after_response" }]);
		const after = await rowOf(id);
		expect(after?.status).toBe(before?.status);
		expect(after?.firstDeliveredAt).toBeNull();
		expect(after?.hostOutcome).toBeNull();
		expect(after?.closedReason).toBeNull();
	});

	test("the owner host is handed an answered accept once it lists the request at the revision the person saw", async () => {
		const a = await sessionOn(hostA);
		const id = await open(hostA, a);
		await getDb()
			.update(codexApprovals)
			.set({ status: "answered", decision: "accept", answeredAt: new Date().toISOString() })
			.where(eq(codexApprovals.id, id));

		const res = await sync(hostA, { v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] });

		const body = (await res.json()) as {
			answers: Array<{ approvalId: string; decision: string; revision: number }>;
		};
		expect(body.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);
	});

	test("a malformed body, an unknown version and a list past its cap are 400 invalid_body", async () => {
		const live = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ approvalId: `x${i}`, revision: 1 }));
		const resolved = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				approvalId: `x${i}`,
				outcome: "declined_local",
				sentDecision: null,
			}));
		for (const body of [
			"nope",
			{ v: 2, live: [], resolved: [] },
			{ v: 1, live: "x", resolved: [] },
			{ v: 1, live: live(CODEX_APPROVAL_LIMITS.liveMax + 1), resolved: [] },
			{ v: 1, live: [], resolved: resolved(CODEX_APPROVAL_LIMITS.resolvedMax + 1) },
			{ v: 1, live: [], resolved: [{ approvalId: "a", outcome: "made_up", sentDecision: null }] },
		]) {
			const res = await sync(hostA, body);
			expect(res.status).toBe(400);
			expect(await errorOf(res)).toBe("invalid_body");
		}
		const edge = await sync(hostA, {
			v: 1,
			live: live(CODEX_APPROVAL_LIMITS.liveMax),
			resolved: resolved(CODEX_APPROVAL_LIMITS.resolvedMax),
		});
		expect(edge.status).toBe(200);
	});

	test("a body over 256 KiB is 413 before it is parsed", async () => {
		const res = await sync(
			hostA,
			`{"v":1,"live":[],"resolved":[],"pad":"${"x".repeat(CODEX_APPROVAL_LIMITS.syncBodyBytes)}"}`,
		);
		expect(res.status).toBe(413);
	});

	test("120 polls a minute, the 121st is 429 with Retry-After; another host is unaffected", async () => {
		const fresh = await enroll("p5-sync-limit");
		let last: Response | null = null;
		for (let i = 0; i <= CODEX_APPROVAL_LIMITS.syncPerMinute; i++)
			last = await sync(fresh, emptySync);
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("5");
		expect((await sync(hostB, emptySync)).status).toBe(200);
	});

	test("no credential is 401, and another host's credential 403, before the body is read", async () => {
		const bare = await app.request(syncPath(hostA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(emptySync),
		});
		expect(bare.status).toBe(401);
		const wrong = await app.request(syncPath(hostA), {
			method: "POST",
			headers: agentHeaders(hostB),
			body: JSON.stringify(emptySync),
		});
		expect(wrong.status).toBe(403);
	});
});
