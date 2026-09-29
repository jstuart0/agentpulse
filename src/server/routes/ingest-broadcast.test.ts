// Phase 6 (AGEN-16): broadcast every stored hook row with its real id,
// never an unstored row, and never a dedup_key leak — across every live
// path (the hook WS broadcast, the supervisor managed-session-events
// response, and sessionBus-routed AI/transcript events).
//
// Harness rules: unique session id per test/scenario, app.request (wraps
// app.fetch), config.disableAuth=true, _resetBucketsForTest() per test,
// wait with until(inFlight===0). Fake WS via handleWsOpen/handleWsClose,
// filtered by type === "new_event" && data.sessionId === sid.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

import type { SessionEvent } from "../../shared/types.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { ingest } = await import("./ingest.js");
const { sessionsRouter } = await import("./sessions.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { handleWsOpen, handleWsClose } = await import("../ws/handler.js");
const { notifySessionEvents, sessionBus } = await import("../services/notifier.js");
const { insertNormalizedEvents } = await import("../services/event-processor.js");
const { createAssistantTranscriptEvent } = await import("../services/event-normalizer.js");
const { emitAiEvent } = await import("../services/ai/ai-events.js");
const { appendManagedSessionEvents } = await import("../services/managed-session-state.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");

const originalDisableAuth = config.disableAuth;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", ingest);
	app.route("/api/v1", sessionsRouter);
	return app;
}
const app = buildApp();

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

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
		})
		.execute();
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

type WsMsg = { type: string; data: Record<string, unknown> };

function attachFakeWs(): { messages: WsMsg[]; close: () => void } {
	const messages: WsMsg[] = [];
	const ws = {
		send: (raw: string) => {
			messages.push(JSON.parse(raw));
		},
	} as unknown as ServerWebSocket<unknown>;
	handleWsOpen(ws);
	return { messages, close: () => handleWsClose(ws) };
}

async function postHook(body: Record<string, unknown>): Promise<void> {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await until(() => getInFlightCount() === 0, 10_000);
}

function newEventEvents(ws: { messages: WsMsg[] }, sid: string) {
	return ws.messages.filter((m) => m.type === "new_event" && m.data.sessionId === sid);
}

describe("P3.1-P3.3, F103: Scenario B′ — distinct tool names, all 41 rows stored and broadcast", () => {
	const sid = newSessionId("scenario-bprime");
	let ws: ReturnType<typeof attachFakeWs>;

	beforeAll(async () => {
		ws = attachFakeWs();
		for (let i = 0; i < 41; i++) {
			await postHook({
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: `Tool${i}`,
				tool_use_id: `tu${i}`,
				tool_response: "ok",
			});
		}
	});
	afterAll(() => ws.close());

	test("P3.1: broadcast ids have no duplicates, equal the DB id set, size 41, include tu7, all > 0", async () => {
		const dbRows = await rowsFor(sid);
		expect(dbRows).toHaveLength(41);

		const broadcast = newEventEvents(ws, sid);
		expect(broadcast).toHaveLength(41);
		const ids = broadcast.map((m) => m.data.id as number);
		expect(new Set(ids).size).toBe(41);
		expect(ids.every((id) => id > 0)).toBe(true);
		expect(new Set(ids)).toEqual(new Set(dbRows.map((r) => r.id)));

		const tu7Row = dbRows.find(
			(r) => (r.rawPayload as Record<string, unknown>).tool_use_id === "tu7",
		);
		expect(tu7Row).toBeDefined();
		if (!tu7Row) throw new Error("unreachable");
		expect(ids).toContain(tu7Row.id);
	});

	test("P3.2: each broadcast row equals the DB row with that id, byte-for-byte on createdAt", async () => {
		const dbRows = await rowsFor(sid);
		const byId = new Map(dbRows.map((r) => [r.id, r]));
		const broadcast = newEventEvents(ws, sid);

		for (const msg of broadcast) {
			const dbRow = byId.get(msg.data.id as number);
			expect(dbRow, `no DB row for broadcast id ${msg.data.id}`).toBeDefined();
			expect(msg.data.eventType).toBe(dbRow?.eventType);
			expect(msg.data.category).toBe(dbRow?.category);
			expect(msg.data.source).toBe(dbRow?.source);
			expect(msg.data.content).toBe(dbRow?.content);
			expect((msg.data.rawPayload as Record<string, unknown>).tool_use_id).toBe(
				(dbRow?.rawPayload as Record<string, unknown>).tool_use_id,
			);
			expect(msg.data.createdAt).toBe(dbRow?.createdAt);
		}
	});

	test("F103: the broadcast row's createdAt is byte-identical to the next REST poll of the same row", async () => {
		const broadcast = newEventEvents(ws, sid);
		const sample = broadcast[0];
		expect(sample).toBeDefined();

		const res = await app.request(`/api/v1/sessions/${sid}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: Array<{ id: number; createdAt: string }> };
		const polled = body.events.find((e) => e.id === sample?.data.id);
		expect(polled, `no polled row for id ${sample?.data.id}`).toBeDefined();
		expect(polled?.createdAt).toBe(sample?.data.createdAt as string);
	});

	test("P3.3: re-posting tu7's PostToolUse verbatim leaves the DB and broadcast counts at 41", async () => {
		const beforeDb = await rowsFor(sid);
		const beforeBroadcastCount = newEventEvents(ws, sid).length;

		await postHook({
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Tool7",
			tool_use_id: "tu7",
			tool_response: "ok",
		});

		const afterDb = await rowsFor(sid);
		expect(afterDb).toHaveLength(beforeDb.length);
		expect(newEventEvents(ws, sid)).toHaveLength(beforeBroadcastCount);
	});
});

describe("P3.1b: broadcast population under real scenario B (all Bash, tu0..tu19)", () => {
	// Real scenario B (F131/repro.ts's B): every tool call shares the same
	// tool_name, so the *content window* alone would have collapsed most of
	// it (that's the AGEN-16 bug) — only t:-keyed identity on tool_use_id
	// keeps all 41 rows distinct. P3.1 uses B′ (distinct tool names per
	// call), which never exercises that collision at all.
	test("broadcast ids have no duplicates, equal the DB id set, size 41, include tu7, all > 0", async () => {
		const sid = newSessionId("scenario-b-real");
		const ws = attachFakeWs();
		try {
			await postHook({
				session_id: sid,
				hook_event_name: "UserPromptSubmit",
				prompt: "run the build",
			});
			for (let i = 0; i < 20; i++) {
				await postHook({
					session_id: sid,
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command: `npm run step${i}` },
					tool_use_id: `tu${i}`,
				});
				await postHook({
					session_id: sid,
					hook_event_name: "PostToolUse",
					tool_name: "Bash",
					tool_input: { command: `npm run step${i}` },
					tool_response: { stdout: `out ${i}` },
					tool_use_id: `tu${i}`,
				});
			}

			const dbRows = await rowsFor(sid);
			expect(dbRows).toHaveLength(41);

			const broadcast = newEventEvents(ws, sid);
			expect(broadcast).toHaveLength(41);
			const ids = broadcast.map((m) => m.data.id as number);
			expect(new Set(ids).size).toBe(41);
			expect(ids.every((id) => id > 0)).toBe(true);
			expect(new Set(ids)).toEqual(new Set(dbRows.map((r) => r.id)));

			const tu7Row = dbRows.find(
				(r) => (r.rawPayload as Record<string, unknown>).tool_use_id === "tu7",
			);
			expect(tu7Row, JSON.stringify(dbRows.map((r) => r.rawPayload))).toBeDefined();
			if (!tu7Row) throw new Error("unreachable");
			expect(ids).toContain(tu7Row.id);
		} finally {
			ws.close();
		}
	});
});

describe("P3.4: transcript authority supersedes the hook assistant row before it's ever broadcast", () => {
	test("a seeded transcript 'hi', then a Codex Stop with last_assistant_message 'hi', broadcasts exactly the Stop", async () => {
		const sid = newSessionId("p34-authority");
		await mkSession(sid);
		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent("hi", { transcript_uuid: "p34-tu" }, "claude_transcript_text"),
		]);

		const ws = attachFakeWs();
		try {
			await postHook({
				session_id: sid,
				hook_event_name: "Stop",
				last_assistant_message: "hi",
			});

			const broadcast = newEventEvents(ws, sid);
			expect(broadcast).toHaveLength(1);
			expect(broadcast[0]?.data.eventType).toBe("Stop");
		} finally {
			ws.close();
		}
	});
});

describe("P3.5: hook rows never emit a sessionBus session_event (GUARD)", () => {
	test("posting a hook fires 0 session_event emissions on sessionBus", async () => {
		const sid = newSessionId("p35-nobus");
		let sessionEventCount = 0;
		const listener = (payload: { sessionId: string }) => {
			if (payload.sessionId === sid) sessionEventCount++;
		};
		sessionBus.on("session_event", listener);
		try {
			await postHook({
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "p35-tu",
				tool_response: "ok",
			});
			expect(sessionEventCount).toBe(0);
		} finally {
			sessionBus.off("session_event", listener);
		}
	});
});

describe("P6-dto: no dedupKey on any live path", () => {
	test("captured new_event WS data (hook path) has no dedupKey key", async () => {
		const sid = newSessionId("p6dto-ws");
		const ws = attachFakeWs();
		try {
			await postHook({
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "p6dto-tu",
				tool_response: "ok",
			});
			const broadcast = newEventEvents(ws, sid);
			expect(broadcast.length).toBeGreaterThan(0);
			for (const msg of broadcast) {
				expect(msg.data).not.toHaveProperty("dedupKey");
			}
		} finally {
			ws.close();
		}
	});

	test("appendManagedSessionEvents (the supervisor route's data source) response rows have no dedupKey key", async () => {
		const sid = newSessionId("p6dto-managed");
		await mkSession(sid);
		const supervisorId = crypto.randomUUID();
		await seedOwnedLaunch(sid, supervisorId);
		const inserted = await appendManagedSessionEvents(supervisorId, sid, [
			{ eventType: "ManagedMessage", category: "assistant_message", content: "hi from supervisor" },
		]);
		expect(inserted.length).toBeGreaterThan(0);
		for (const row of inserted) {
			expect(row).not.toHaveProperty("dedupKey");
		}
	});

	// F110: the above exercises appendManagedSessionEvents at the service
	// level only — nothing had posted through the real route with a real
	// supervisor credential. Route the same assertion through
	// POST /api/v1/supervisors/:id/managed-sessions/:sid/events over HTTP.
	test("POST /api/v1/supervisors/:id/managed-sessions/:sid/events (real route, real supervisor credential) response has no dedupKey key", async () => {
		const { supervisorsAgentRouter } = await import("./supervisors.js");
		const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
		const supervisorApp = new Hono().route("/api/v1", supervisorsAgentRouter);

		const originalDisableAuthLocal = config.disableAuth;
		config.disableAuth = false;
		try {
			const { token } = await createSupervisorEnrollmentToken("f110-supervisor", null, null);
			const supervisorId = crypto.randomUUID();
			const registerRes = await supervisorApp.request("/api/v1/supervisors/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					hostName: "f110-host",
					platform: "linux",
					arch: "x64",
					version: "1.0.0",
					enrollmentToken: token,
					id: supervisorId,
				}),
			});
			expect(registerRes.status).toBe(200);
			const { supervisorCredential } = (await registerRes.json()) as {
				supervisorCredential: string;
			};
			expect(typeof supervisorCredential).toBe("string");

			const sid = newSessionId("p6dto-managed-http");
			await mkSession(sid);
			// AGEN-15: the route now enforces ownership — this supervisor must
			// be the owner of record before it can post events for the session.
			await seedOwnedLaunch(sid, supervisorId);
			const eventsRes = await supervisorApp.request(
				`/api/v1/supervisors/${supervisorId}/managed-sessions/${sid}/events`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${supervisorCredential}`,
					},
					body: JSON.stringify({
						events: [
							{
								eventType: "ManagedMessage",
								category: "assistant_message",
								content: "hi over http",
							},
						],
					}),
				},
			);
			expect(eventsRes.status).toBe(200);
			const body = (await eventsRes.json()) as { events: unknown[] };
			expect(body.events.length).toBeGreaterThan(0);
			for (const row of body.events) {
				expect(row).not.toHaveProperty("dedupKey");
			}
		} finally {
			config.disableAuth = originalDisableAuthLocal;
		}
	});

	test("insertNormalizedEvents (the transcript path's data source) rows have no dedupKey key, then broadcasting them produces no dedupKey on sessionBus", async () => {
		const sid = newSessionId("p6dto-transcript");
		await mkSession(sid);
		const inserted = await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent(
				"transcript body",
				{ transcript_uuid: "p6dto-tu" },
				"claude_transcript_text",
			),
		]);
		expect(inserted.length).toBeGreaterThan(0);
		for (const row of inserted) {
			expect(row).not.toHaveProperty("dedupKey");
		}

		// transcript-sync.ts (the actual caller) passes this same return
		// value straight into notifySessionEvents; reproduce that call and
		// verify the sessionBus listener sees the identical clean shape.
		const received: SessionEvent[] = [];
		const listener = (payload: { sessionId: string; event: SessionEvent }) => {
			if (payload.sessionId === sid) received.push(payload.event);
		};
		sessionBus.on("session_event", listener);
		try {
			notifySessionEvents(sid, inserted);
			expect(received).toHaveLength(inserted.length);
			for (const event of received) {
				expect(event).not.toHaveProperty("dedupKey");
			}
		} finally {
			sessionBus.off("session_event", listener);
		}
	});

	test("a sessionBus session_event listener sees no dedupKey, for emitAiEvent", async () => {
		const sid = newSessionId("p6dto-ai");
		await mkSession(sid);
		const received: Array<{ sessionId: string; event: SessionEvent }> = [];
		const listener = (payload: { sessionId: string; event: SessionEvent }) => {
			if (payload.sessionId === sid) received.push(payload);
		};
		sessionBus.on("session_event", listener);
		try {
			await emitAiEvent({
				sessionId: sid,
				source: "launch_system",
				category: "system_event",
				eventType: "AiReport",
				content: "ai report body",
			});
			expect(received).toHaveLength(1);
			expect(received[0]?.event).not.toHaveProperty("dedupKey");
		} finally {
			sessionBus.off("session_event", listener);
		}
	});
});
