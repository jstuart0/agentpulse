/**
 * Phase 1 canonicalizer-seam regression harness (D5, F21). Both current
 * agents' canonicalizers are identity (Phase 1); this proves the new
 * canonicalizeHookPayload() call wired into ingest.ts before the
 * missing-fields check doesn't change a single byte of what lands in the
 * DB for Claude or Codex.
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

describe("POST /api/v1/hooks — canonicalizer seam is a no-op for claude_code and codex_cli", () => {
	for (const agentType of ["claude_code", "codex_cli"] as const) {
		test(`${agentType} PostToolUse lands field-for-field unchanged`, async () => {
			const app = buildApp();
			const sessionId = `canon-${agentType}-${Date.now()}`;
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Agent-Type": agentType },
				body: JSON.stringify({
					session_id: sessionId,
					hook_event_name: "PostToolUse",
					cwd: "/tmp",
					tool_name: "Bash",
					tool_input: { command: "echo hi" },
					tool_response: "hi\n",
				}),
			});
			expect(res.status).toBe(200);
			await waitForQuiescence();

			const [session] = await getDb()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, sessionId))
				.execute();
			expect(session.agentType).toBe(agentType);

			const rows = await getDb().select().from(events).execute();
			const row = rows.find((r) => r.sessionId === sessionId);
			expect(row).toBeDefined();
			if (!row) throw new Error("unreachable");
			expect(row.toolInput).toEqual({ command: "echo hi" });
			expect(row.toolResponse).toBe("hi\n");
			expect(row.providerEventType).toBe("PostToolUse");
		});
	}
});
