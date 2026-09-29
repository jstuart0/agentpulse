// AGEN-44 — GET /templates?agent_type=<unknown> must 400 instead of
// silently returning zero results, matching the sessions-route fix.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessionTemplates } = await import("../db/schema/index.js");
const { templatesRouter } = await import("./templates.js");
const { AGENT_TYPES } = await import("../../shared/constants.js");

const app = new Hono().route("/api/v1", templatesRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(sessionTemplates).execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

describe("GET /templates?agent_type=", () => {
	test("unknown agent_type → 400 invalid_agent_type, naming the value and allowed list", async () => {
		const res = await app.request("/api/v1/templates?agent_type=copilot_cli");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; value?: string; allowed?: string[] };
		expect(body.error).toBe("invalid_agent_type");
		expect(body.value).toBe("copilot_cli");
		expect(body.allowed).toEqual([...AGENT_TYPES]);
	});

	test("known agent_type still filters results", async () => {
		await getDb()
			.insert(sessionTemplates)
			.values([
				{ name: "t1", agentType: "claude_code", cwd: "/tmp/t1" },
				{ name: "t2", agentType: "codex_cli", cwd: "/tmp/t2" },
			])
			.execute();

		const res = await app.request("/api/v1/templates?agent_type=codex_cli");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { templates: Array<{ name: string }> };
		expect(body.templates.map((t) => t.name)).toEqual(["t2"]);
	});

	test("absent agent_type → unchanged (no filter, 200 with all templates)", async () => {
		await getDb()
			.insert(sessionTemplates)
			.values([
				{ name: "t1", agentType: "claude_code", cwd: "/tmp/t1" },
				{ name: "t2", agentType: "codex_cli", cwd: "/tmp/t2" },
			])
			.execute();

		const res = await app.request("/api/v1/templates");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { templates: Array<{ name: string }> };
		expect(body.templates.length).toBe(2);
	});
});
