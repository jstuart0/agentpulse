/**
 * Only the watcher writes `ai_*` events and `Ai*` event types. Neither a hook
 * (an ingest key can choose its hook's name) nor a supervisor (it can choose a
 * category) may write one: a forged AiContinueSent would read as proof that a
 * prompt was sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";
import { seedLiveManagedSession } from "../test-utils/watcher-fixtures.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const { events, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { ingest } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { normalizeHookEvent } = await import("../services/event-normalizer.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");

const originalDisableAuth = config.disableAuth;
const hooksApp = new Hono().route("/api/v1", ingest);

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(() => {
	_resetBucketsForTest();
	_resetCountersForTest();
});

async function settled() {
	for (let i = 0; i < 300 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
}
let n = 0;
const newSessionId = () => `res-${++n}-${crypto.randomUUID().slice(0, 6)}`;

async function postHook(body: Record<string, unknown>) {
	const res = await hooksApp.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await settled();
}
async function storedEvents(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

describe("a hook may not be named like one of the watcher's events", () => {
	test("AiContinueSent stores nothing; a normal hook on the same session still does (positive control)", async () => {
		const sessionId = newSessionId();
		await postHook({ session_id: sessionId, hook_event_name: "AiContinueSent", prompt: "x" });
		expect(await storedEvents(sessionId)).toEqual([]);
		await postHook({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hello" });
		const rows = await storedEvents(sessionId);
		expect(rows.map((r) => r.eventType)).toEqual(["UserPromptSubmit"]);
	});

	test("a leading space, any case, and the provider's own name are caught too", async () => {
		const sessionId = newSessionId();
		await postHook({ session_id: sessionId, hook_event_name: " aicontinuesent" });
		await postHook({ session_id: sessionId, hook_event_name: "AIREPORT" });
		await postHook({
			session_id: sessionId,
			hook_event_name: "PreToolUse",
			provider_event_name: "AiProposal",
			tool_name: "Bash",
			tool_use_id: "forged-tu",
		});
		expect(await storedEvents(sessionId)).toEqual([]);
	});

	test("an oversize delivery named AiReport, whose identity is recoverable from its prefix, stores no stub", async () => {
		const sessionId = newSessionId();
		const body = JSON.stringify({
			session_id: sessionId,
			hook_event_name: "AiReport",
			cwd: "x".repeat(17 * 1024 * 1024),
		});
		const res = await hooksApp.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		await settled();
		expect(await storedEvents(sessionId)).toEqual([]);

		// The same oversize delivery under a real name does store its stub.
		const real = newSessionId();
		const realBody = JSON.stringify({
			session_id: real,
			hook_event_name: "Stop",
			cwd: "x".repeat(17 * 1024 * 1024),
		});
		await hooksApp.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: realBody,
		});
		await settled();
		expect((await storedEvents(real)).length).toBeGreaterThan(0);
	});

	test("no hook type the normalizer knows ever produces an ai_ category", () => {
		const names = [
			"SessionStart",
			"SessionEnd",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Stop",
			"SubagentStart",
			"SubagentStop",
			"Notification",
			"PreCompact",
			"PostCompact",
			"ErrorOccurred",
			"TaskCreated",
			"TaskCompleted",
			"Interrupt",
			"PermissionRequest",
			"PermissionDenied",
			"UserAcknowledge",
			"UserUnacknowledge",
			"SomethingTheNormalizerNeverHeardOf",
		];
		for (const hook_event_name of names) {
			const rows = normalizeHookEvent(
				{
					session_id: "s",
					hook_event_name,
					prompt: "p",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_response: "ok",
					message: "m",
				} as never,
				"claude_code",
			);
			for (const row of rows) {
				expect({ hook_event_name, category: row.category }).not.toMatchObject({
					category: expect.stringMatching(/^ai_/),
				});
			}
		}
	});
});

describe("a supervisor may not write them either", () => {
	async function supervisorWorld() {
		const sessionId = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(sessionId);
		const { token } = await createSupervisorCredential(supervisorId, "reserved-test");
		const post = (eventsBody: unknown[]) =>
			app.request(`/api/v1/supervisors/${supervisorId}/managed-sessions/${sessionId}/events`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agentpulse-supervisor-token": token,
				},
				body: JSON.stringify({ events: eventsBody }),
			});
		return { sessionId, post };
	}

	test("a batch with an ai_ category or an Ai event type is 400 reserved_event_type and stores nothing, not even its honest events", async () => {
		const { sessionId, post } = await supervisorWorld();
		for (const forged of [
			{ eventType: "Whatever", category: "ai_report" },
			{ eventType: "AiContinueSent", category: "system_event" },
			{ eventType: " aiError", category: "system_event" },
		]) {
			const res = await post([{ eventType: "HeadlessStatus", category: "system_event" }, forged]);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("reserved_event_type");
		}
		expect(await storedEvents(sessionId)).toEqual([]);
	});

	test("an honest batch is stored (positive control)", async () => {
		const { sessionId, post } = await supervisorWorld();
		const res = await post([
			{ eventType: "HeadlessPromptSubmitted", category: "prompt", content: "go" },
			{ eventType: "HeadlessPromptCompleted", category: "system_event" },
		]);
		expect(res.status).toBe(200);
		expect((await storedEvents(sessionId)).map((e) => e.eventType)).toEqual([
			"HeadlessPromptSubmitted",
			"HeadlessPromptCompleted",
		]);
	});
});

describe("hygiene", () => {
	test("test tables are cleaned between files", async () => {
		await getDb().delete(events);
		await getDb().delete(managedSessions);
		await getDb().delete(launchRequests);
		await getDb().delete(sessions);
		await getDb().delete(supervisors);
		expect(await getDb().select().from(events)).toEqual([]);
	});
});
