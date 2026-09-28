/**
 * Regression for xander's Phase 1 mid-build finding (F70): POST
 * /launches/recommendation never validated body.template.agentType before
 * echoing it into RecommendedLaunch.agentType (typed LaunchableAgentType)
 * and returning 200.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { launchesRouter } = await import("./launches.js");

const originalDisableAuth = config.disableAuth;
const originalAiEnabled = config.aiEnabled;
const originalSecretsKey = config.secretsKey;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", launchesRouter);
	return app;
}

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
	config.aiEnabled = true;
	config.secretsKey = "test-secrets-key-32-characters!!";
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
	config.aiEnabled = originalAiEnabled;
	config.secretsKey = originalSecretsKey;
});

async function postRecommendation(template: Record<string, unknown>) {
	const app = buildApp();
	return app.request("/api/v1/launches/recommendation", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ template }),
	});
}

describe("POST /launches/recommendation — agentType validation (F70)", () => {
	test("copilot_cli agentType → 400, not echoed into a 200 RecommendedLaunch", async () => {
		const res = await postRecommendation({
			name: "t",
			agentType: "copilot_cli",
			cwd: "/tmp",
			baseInstructions: "",
			taskPrompt: "",
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("agentType must be claude_code or codex_cli");
	});

	test("garbage agentType → 400", async () => {
		const res = await postRecommendation({
			name: "t",
			agentType: "not-a-real-agent",
			cwd: "/tmp",
			baseInstructions: "",
			taskPrompt: "",
		});
		expect(res.status).toBe(400);
	});

	test("claude_code agentType → 200, recommendation echoes it back", async () => {
		const res = await postRecommendation({
			name: "t",
			agentType: "claude_code",
			cwd: "/tmp",
			baseInstructions: "",
			taskPrompt: "",
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.recommendation.agentType).toBe("claude_code");
	});
});
