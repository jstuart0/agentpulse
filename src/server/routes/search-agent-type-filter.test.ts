// AGEN-44 — GET /search?agentType=<unknown> must 400 instead of
// parseAgentType silently dropping the value (so the filter is just never
// applied and results race ahead unfiltered / diverge from caller intent).
//
// AGENT_TYPES gained copilot_cli on this branch (agent-cli-parity), so
// copilot_cli is now a known, accepted value here.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { searchRouter } = await import("./search.js");
const { AGENT_TYPES } = await import("../../shared/constants.js");

const app = new Hono().route("/api/v1", searchRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

describe("GET /search?agentType=", () => {
	test("unknown agentType → 400 invalid_agent_type, naming the value and allowed list", async () => {
		const res = await app.request("/api/v1/search?q=deploy&agentType=totally_bogus");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; value?: string; allowed?: string[] };
		expect(body.error).toBe("invalid_agent_type");
		expect(body.value).toBe("totally_bogus");
		expect(body.allowed).toEqual([...AGENT_TYPES]);
	});

	test("known agentType is accepted (200, no error)", async () => {
		const res = await app.request("/api/v1/search?q=deploy&agentType=codex_cli");
		expect(res.status).toBe(200);
	});

	test("copilot_cli agentType is accepted (200, no error — a known, observed AgentType)", async () => {
		const res = await app.request("/api/v1/search?q=deploy&agentType=copilot_cli");
		expect(res.status).toBe(200);
	});

	test("absent agentType → unchanged (200, no error)", async () => {
		const res = await app.request("/api/v1/search?q=deploy");
		expect(res.status).toBe(200);
	});
});
