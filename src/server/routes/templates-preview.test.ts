/**
 * Regression for ian's Phase 1 mid-build finding: buildTemplatePreview did
 * keyed AGENT_METADATA/PROVIDER_COMMAND lookups on an unvalidated
 * agentType *before* validateTemplateInput ran, so a non-launchable or
 * garbage agentType threw a TypeError (500) instead of the route's
 * intended 400 with the validation error body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { templatesRouter } = await import("./templates.js");

const originalDisableAuth = config.disableAuth;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", templatesRouter);
	return app;
}

beforeAll(async () => {
	await initializeDatabase();
	await deleteAllSupervisors();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

async function postPreview(body: Record<string, unknown>) {
	const app = buildApp();
	return app.request("/api/v1/templates/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /templates/preview — non-launchable/garbage agentType never crashes", () => {
	test("copilot_cli (recognized, non-launchable) → 400 with the validation error body, not a 500", async () => {
		const res = await postPreview({ name: "t", cwd: "/tmp", agentType: "copilot_cli" });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Agent type must be claude_code or codex_cli.");
		expect(body.preview).toBeDefined();
	});

	test("garbage agentType → 400 with the validation error body, not a 500", async () => {
		const res = await postPreview({ name: "t", cwd: "/tmp", agentType: "not-a-real-agent" });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Agent type must be claude_code or codex_cli.");
	});

	test("claude_code → 200, unchanged", async () => {
		const res = await postPreview({ name: "t", cwd: "/tmp", agentType: "claude_code" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.normalizedTemplate.agentType).toBe("claude_code");
		expect(body.launchSpec.providerConfig.command).toBe("claude");
		expect(body.launchSpec.providerConfig.instructionsFile).toBe("CLAUDE.md");
	});
});
