// AGEN — GET /sessions?operational=<unknown> must 400 instead of silently
// matching zero rows, mirroring agent_type's validation
// (sessions-agent-type-filter.test.ts). A known value filters by the
// computed operational state, not the raw lifecycle status, and the GET
// /sessions/stats response carries the same four counts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { projects, sessions } = await import("../db/schema/index.js");
const { sessionsRouter } = await import("./sessions.js");
const { ACTIVE_OPERATIONAL_STATUSES } = await import("../../shared/session-state.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb().delete(projects).execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

describe("GET /sessions?operational=", () => {
	test("unknown value -> 400 invalid_operational, naming the value and allowed list", async () => {
		const res = await app.request("/api/v1/sessions?operational=totally_bogus");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; value?: string; allowed?: string[] };
		expect(body.error).toBe("invalid_operational");
		expect(body.value).toBe("totally_bogus");
		expect(body.allowed).toEqual([...ACTIVE_OPERATIONAL_STATUSES]);
	});

	test("waiting filters to only sessions the classifier puts in waiting", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "s-waiting",
					displayName: "s-waiting",
					agentType: "claude_code",
					status: "active",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-working",
					displayName: "s-working",
					agentType: "claude_code",
					status: "active",
					isWorking: true,
				},
			])
			.execute();

		const res = await app.request("/api/v1/sessions?operational=waiting");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["s-waiting"]);
		expect(body.total).toBe(1);
	});

	test("absent operational param -> unchanged (no filter, 200 with all sessions)", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "s1", displayName: "s1", agentType: "claude_code", status: "active" },
				{ sessionId: "s2", displayName: "s2", agentType: "claude_code", status: "active" },
			])
			.execute();

		const res = await app.request("/api/v1/sessions");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.length).toBe(2);
	});
});

// AGEN: client-side search over the loaded page only works for whatever
// page the dashboard happens to have fetched -- a match on a later page of
// a server-paged status filter is invisible. `q` filters server-side, by
// the same fields the dashboard's own client search matches on
// (displayName, cwd, gitBranch), and composes with `operational=` so the
// total/paging stay correct for the combined filter.
describe("GET /sessions?q=&operational=", () => {
	beforeEach(async () => {
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "s-match-name",
					displayName: "fix the flaky retry",
					agentType: "claude_code",
					status: "active",
					cwd: "/home/u/unrelated",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-match-cwd",
					displayName: "unrelated name",
					agentType: "claude_code",
					status: "active",
					cwd: "/home/u/retry-service",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-match-branch",
					displayName: "unrelated name",
					agentType: "claude_code",
					status: "active",
					cwd: "/home/u/unrelated",
					gitBranch: "fix/retry-loop",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-no-match",
					displayName: "totally different",
					agentType: "claude_code",
					status: "active",
					cwd: "/home/u/other",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
			])
			.execute();
	});

	test("matches on displayName, cwd, or gitBranch, case-insensitively", async () => {
		const res = await app.request("/api/v1/sessions?operational=waiting&q=RETRY");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
		expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
			"s-match-branch",
			"s-match-cwd",
			"s-match-name",
		]);
		expect(body.total).toBe(3);
	});

	test("no match -> empty sessions, total 0, not a 404 or error", async () => {
		const res = await app.request("/api/v1/sessions?operational=waiting&q=nonexistent-xyz");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
		expect(body.sessions).toEqual([]);
		expect(body.total).toBe(0);
	});

	test("empty q is the same as no q (no filtering)", async () => {
		const res = await app.request("/api/v1/sessions?operational=waiting&q=");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { total: number };
		expect(body.total).toBe(4);
	});

	test("also composes with the unfiltered (no operational=) list", async () => {
		const res = await app.request("/api/v1/sessions?q=retry");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
		expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
			"s-match-branch",
			"s-match-cwd",
			"s-match-name",
		]);
		expect(body.total).toBe(3);
	});
});

// AGEN: `q` is user-supplied and forwarded straight into a LIKE/ILIKE
// pattern (searchCondition, session-tracker.ts) -- an unbounded value lets
// a caller force an arbitrarily large pattern through the query planner,
// and an unescaped `%`/`_` turns a search for a literal character into a
// wildcard match over the whole table.
describe("GET /sessions?q= — length cap and literal-metacharacter matching", () => {
	test("a query over 200 chars -> 400, same error shape as the other parameter errors", async () => {
		const res = await app.request(`/api/v1/sessions?q=${"a".repeat(201)}`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; value?: number };
		expect(body.error).toBe("query_too_long");
		expect(body.value).toBe(201);
	});

	test("exactly 200 chars is accepted", async () => {
		const res = await app.request(`/api/v1/sessions?q=${"a".repeat(200)}`);
		expect(res.status).toBe(200);
	});

	test("the same cap applies when composed with operational=", async () => {
		const res = await app.request(`/api/v1/sessions?operational=waiting&q=${"a".repeat(201)}`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("query_too_long");
	});

	test("a literal % in q matches only sessions containing that literal character, not every row", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "s-literal-percent",
					displayName: "90% complete",
					agentType: "claude_code",
					status: "active",
				},
				{
					sessionId: "s-no-percent",
					displayName: "totally unrelated",
					agentType: "claude_code",
					status: "active",
				},
			])
			.execute();

		const res = await app.request("/api/v1/sessions?q=90%25");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["s-literal-percent"]);
	});
});

// AGEN: a scratch-tagged project's sessions are hidden client-side (the
// dashboard's "Show scratch workspaces" toggle) only AFTER the server has
// already paged and counted them -- the list, "Showing N of M", and the
// status card's count disagreed. excludeScratch applies the same
// project-tag rule server-side, for both the filtered list and its total,
// and for GET /sessions/stats's per-status counts.
describe("GET /sessions?operational=&excludeScratch= / GET /sessions/stats?excludeScratch=", () => {
	async function seedScratchAndRealWaiting() {
		await getDb()
			.insert(projects)
			.values([
				{ id: "proj-scratch", name: "proj-scratch", cwd: "/scratch/one", tags: ["scratch"] },
				{ id: "proj-real", name: "proj-real", cwd: "/real/one", tags: [] },
			])
			.execute();
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "s-scratch-waiting",
					displayName: "s-scratch-waiting",
					agentType: "claude_code",
					status: "active",
					projectId: "proj-scratch",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-real-waiting",
					displayName: "s-real-waiting",
					agentType: "claude_code",
					status: "active",
					projectId: "proj-real",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-no-project-waiting",
					displayName: "s-no-project-waiting",
					agentType: "claude_code",
					status: "active",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
			])
			.execute();
	}

	test("excludeScratch=true drops the scratch-project row from the list and its total", async () => {
		await seedScratchAndRealWaiting();
		const res = await app.request("/api/v1/sessions?operational=waiting&excludeScratch=true");
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
		expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
			"s-no-project-waiting",
			"s-real-waiting",
		]);
		expect(body.total).toBe(2);
	});

	test("excludeScratch=true drops the scratch row from the matching stats.operational count", async () => {
		await seedScratchAndRealWaiting();
		const res = await app.request("/api/v1/sessions/stats?excludeScratch=true");
		const body = (await res.json()) as { operational: { waiting: number } };
		expect(body.operational.waiting).toBe(2);
	});

	test("omitting excludeScratch is unchanged -- the scratch row still counts", async () => {
		await seedScratchAndRealWaiting();
		const listRes = await app.request("/api/v1/sessions?operational=waiting");
		const listBody = (await listRes.json()) as { total: number };
		expect(listBody.total).toBe(3);

		const statsRes = await app.request("/api/v1/sessions/stats");
		const statsBody = (await statsRes.json()) as { operational: { waiting: number } };
		expect(statsBody.operational.waiting).toBe(3);
	});

	test("a session with no project at all is never excluded as scratch", async () => {
		await seedScratchAndRealWaiting();
		const res = await app.request("/api/v1/sessions?operational=waiting&excludeScratch=true");
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.some((s) => s.sessionId === "s-no-project-waiting")).toBe(true);
	});
});

describe("GET /sessions/stats — operational counts", () => {
	test("response carries the four operational counts alongside the existing fields", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "s-stats-waiting",
					displayName: "s-stats-waiting",
					agentType: "claude_code",
					status: "active",
					lastAgentTurnCompletedAt: new Date().toISOString(),
				},
				{
					sessionId: "s-stats-working",
					displayName: "s-stats-working",
					agentType: "claude_code",
					status: "active",
					isWorking: true,
				},
			])
			.execute();

		const res = await app.request("/api/v1/sessions/stats");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			operational: { waiting: number; working: number; idle: number; error: number };
		};
		expect(body.operational.waiting).toBe(1);
		expect(body.operational.working).toBe(1);
	});
});
