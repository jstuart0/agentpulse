/**
 * Phase 6 (D7): Copilot's event name doesn't live in the request body, so
 * it arrives as the `?event=` query param instead — this exercises the
 * full ingest path (detectAgentType -> canonicalizeHookPayload ->
 * event-processor) with a real DB, mirroring
 * ingest-canonicalize.test.ts's harness.
 *
 * RED at Phase 6's start commit: AGENT_TYPES doesn't include "copilot_cli"
 * yet, so detectAgentType falls back to "claude_code" regardless of the
 * X-Agent-Type header, and canonicalizeHookPayload has no copilot_cli
 * entry — every assertion below that expects a real copilot_cli session
 * fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { ingest, getInFlightCount } = await import("./ingest.js");

const originalDisableAuth = config.disableAuth;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", ingest);
	return app;
}

async function waitForQuiescence() {
	for (let i = 0; i < 200 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(getInFlightCount()).toBe(0);
}

async function postCopilotHook(
	app: ReturnType<typeof buildApp>,
	event: string,
	body: Record<string, unknown>,
	opts: { header?: boolean } = {},
) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (opts.header !== false) headers["X-Agent-Type"] = "copilot_cli";
	return app.request(`/api/v1/hooks?event=${event}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

describe("POST /api/v1/hooks?event=... — Copilot ingestion (Phase 6 contract item 6)", () => {
	test("?event=sessionStart with the X-Agent-Type header creates a copilot_cli session with the fixture's cwd", async () => {
		const app = buildApp();
		const sessionId = `copilot-start-${Date.now()}`;
		const res = await postCopilotHook(app, "sessionStart", {
			sessionId,
			cwd: "/home/user/project",
		});
		expect(res.status).toBe(200);
		await waitForQuiescence();

		const [session] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.execute();
		expect(session).toBeDefined();
		expect(session.agentType).toBe("copilot_cli");
		expect(session.cwd).toBe("/home/user/project");
	});

	test("prompt and tool events land in timeline order", async () => {
		const app = buildApp();
		const sessionId = `copilot-order-${Date.now()}`;
		await postCopilotHook(app, "sessionStart", { sessionId, cwd: "/tmp" });
		await postCopilotHook(app, "userPromptSubmitted", {
			sessionId,
			cwd: "/tmp",
			prompt: "run `echo hi` and stop",
		});
		const res = await postCopilotHook(app, "postToolUse", {
			sessionId,
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: { command: "echo hi" },
			toolResponse: "hi\n",
		});
		expect(res.status).toBe(200);
		await waitForQuiescence();

		const rows = await getDb().select().from(events).execute();
		const sessionRows = rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.id - b.id);
		expect(sessionRows.map((r) => r.eventType)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PostToolUse",
		]);
		const promptRow = sessionRows.find((r) => r.eventType === "UserPromptSubmit");
		expect(promptRow?.content).toBe("run `echo hi` and stop");
	});

	test("the identical body without X-Agent-Type: copilot_cli produces zero DB rows for that session id (misdetected as claude_code, no cwd match expected here)", async () => {
		const app = buildApp();
		const sessionId = `copilot-noheader-${Date.now()}`;
		// Omit the event-name-bearing hook_event_name entirely (Copilot's
		// native shape) so a claude_code misdetection can't accidentally
		// satisfy ingest's missing-fields check via some other field.
		const res = await postCopilotHook(
			app,
			"sessionStart",
			{ sessionId, cwd: "/home/user/project" },
			{ header: false },
		);
		expect(res.status).toBe(200);
		await waitForQuiescence();

		const rows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId))
			.execute();
		expect(rows.length).toBe(0);
	});

	test("an oversized toolArgs body still returns 200, and the stored tool_input is the capped value, not the raw oversized one", async () => {
		const app = buildApp();
		const sessionId = `copilot-oversized-${Date.now()}`;
		const CAP = 64 * 1024;
		const oversized = `{"command":"${"x".repeat(CAP + 500)}"}`;
		await postCopilotHook(app, "sessionStart", { sessionId, cwd: "/tmp" });
		const res = await postCopilotHook(app, "postToolUse", {
			sessionId,
			cwd: "/tmp",
			toolName: "shell",
			toolArgs: oversized,
			toolResponse: "ok",
		});
		expect(res.status).toBe(200);
		await waitForQuiescence();

		const rows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId))
			.execute();
		const toolRow = rows.find((r) => r.eventType === "PostToolUse");
		expect(toolRow).toBeDefined();
		if (!toolRow) throw new Error("unreachable");
		expect(toolRow.toolInput).toEqual({ raw: oversized.slice(0, CAP), truncated: true });
	});
});
