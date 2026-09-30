// AGEN-44 — GET /sessions?agent_type=<unknown> must 400 instead of silently
// returning zero results. A known value still filters correctly; an
// absent/empty value is unchanged (no filter).
//
// AGENT_TYPES gained copilot_cli on this branch (agent-cli-parity), so
// copilot_cli is now a known, filterable value here — unlike on
// /templates (see templates-agent-type-filter.test.ts), which stays
// launchable-only since a template can never target copilot_cli.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { sessionsRouter } = await import("./sessions.js");
const { AGENT_TYPES } = await import("../../shared/constants.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

describe("GET /sessions?agent_type=", () => {
	test("unknown agent_type → 400 invalid_agent_type, naming the value and allowed list", async () => {
		const res = await app.request("/api/v1/sessions?agent_type=totally_bogus");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; value?: string; allowed?: string[] };
		expect(body.error).toBe("invalid_agent_type");
		expect(body.value).toBe("totally_bogus");
		expect(body.allowed).toEqual([...AGENT_TYPES]);
	});

	test("copilot_cli agent_type filters results (a known, observed AgentType — see agent-cli-parity)", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "s1", displayName: "s1", agentType: "claude_code", status: "active" },
				{ sessionId: "s2", displayName: "s2", agentType: "copilot_cli", status: "active" },
			])
			.execute();

		const res = await app.request("/api/v1/sessions?agent_type=copilot_cli");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
	});

	test("known agent_type still filters results", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "s1", displayName: "s1", agentType: "claude_code", status: "active" },
				{ sessionId: "s2", displayName: "s2", agentType: "codex_cli", status: "active" },
			])
			.execute();

		const res = await app.request("/api/v1/sessions?agent_type=codex_cli");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
	});

	test("absent agent_type → unchanged (no filter, 200 with all sessions)", async () => {
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "s1", displayName: "s1", agentType: "claude_code", status: "active" },
				{ sessionId: "s2", displayName: "s2", agentType: "codex_cli", status: "active" },
			])
			.execute();

		const res = await app.request("/api/v1/sessions");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.length).toBe(2);
	});

	test("empty agent_type param → unchanged (no filter)", async () => {
		await getDb()
			.insert(sessions)
			.values([{ sessionId: "s1", displayName: "s1", agentType: "claude_code", status: "active" }])
			.execute();

		const res = await app.request("/api/v1/sessions?agent_type=");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
		expect(body.sessions.length).toBe(1);
	});
});
