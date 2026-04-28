import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase, sqlite } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema.js");
const { sessionBus } = await import("../notifier.js");
const { emitAiEvent } = await import("./ai-events.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	// Cascade FK from DB-1 wipes events when session is deleted.
	await db.delete(sessions).execute();
	await db
		.insert(sessions)
		.values({ sessionId: "s-ai-evt", agentType: "claude_code" })
		.onConflictDoNothing();
});

describe("emitAiEvent (Slice AI-EVT-1)", () => {
	test("persists with the caller-provided source (regression for C-3)", async () => {
		// Old behavior hardcoded source: "observed_hook" regardless of caller.
		// Watcher emissions must land as "managed_control" so the event
		// authority comparator in event-processor sees the correct priority.
		const ev = await emitAiEvent({
			sessionId: "s-ai-evt",
			source: "managed_control",
			category: "ai_proposal",
			eventType: "AiProposal",
			content: "test proposal",
			rawPayload: { proposal_id: "p1" },
		});
		expect(ev).not.toBeNull();
		expect(ev?.source).toBe("managed_control");

		const rows = await db.select().from(events);
		expect(rows).toHaveLength(1);
		expect(rows[0].source).toBe("managed_control");
		expect(rows[0].eventType).toBe("AiProposal");
	});

	test("respects observed_hook for HITL/proposal continuations from observed-side", async () => {
		const ev = await emitAiEvent({
			sessionId: "s-ai-evt",
			source: "observed_hook",
			category: "ai_hitl_response",
			eventType: "AiHitlResponse",
			content: "Approved.",
			rawPayload: { proposal_id: "p2", action: "approve" },
		});
		expect(ev?.source).toBe("observed_hook");
	});

	test("dedups identical events within EVENT_DUPLICATE_WINDOW_MS (regression for M-4)", async () => {
		// Old behavior bypassed insertNormalizedEvents and double-inserted
		// when the runner re-emitted the same event after a debounce-edge race.
		const payload = {
			sessionId: "s-ai-evt",
			source: "managed_control" as const,
			category: "ai_error" as const,
			eventType: "ParseFailure",
			content: "bad json",
			rawPayload: { sub_type: "parse_failure" },
		};
		const first = await emitAiEvent(payload);
		const second = await emitAiEvent(payload);
		expect(first).not.toBeNull();
		// Dedup should reject the second insert; emitAiEvent returns null
		// when insertNormalizedEvents drops the row.
		expect(second).toBeNull();

		const rows = await db.select().from(events);
		expect(rows).toHaveLength(1);
	});

	test("FTS row count matches events count for AI-emitted kinds (no double-insert)", async () => {
		// The FTS5 trigger on `events` only fires for a whitelist of event_types,
		// which includes AiProposal/AiReport/AiHitlRequest. If emitAiEvent
		// were to bypass insertNormalizedEvents and double-insert, FTS would
		// see one row per insert (potentially duplicated) for those kinds.
		await emitAiEvent({
			sessionId: "s-ai-evt",
			source: "managed_control",
			category: "ai_proposal",
			eventType: "AiProposal",
			content: "p1",
			rawPayload: { proposal_id: "p1" },
		});
		await emitAiEvent({
			sessionId: "s-ai-evt",
			source: "managed_control",
			category: "ai_report",
			eventType: "AiReport",
			content: "r1",
			rawPayload: { proposal_id: "p1", summary: "done" },
		});
		await emitAiEvent({
			sessionId: "s-ai-evt",
			source: "managed_control",
			category: "ai_hitl_request",
			eventType: "AiHitlRequest",
			content: "h1",
			rawPayload: { proposal_id: "p1" },
		});

		const eventsRows = await db.select().from(events);
		expect(eventsRows).toHaveLength(3);

		// Hit FTS through raw SQL since drizzle doesn't model the virtual table.
		const ftsCount = (
			sqlite
				.prepare(
					`SELECT COUNT(*) AS n FROM search_events_fts WHERE event_type IN ('AiProposal','AiReport','AiHitlRequest')`,
				)
				.get() as { n: number }
		).n;
		expect(ftsCount).toBe(3);
	});

	test("broadcasts to sessionBus so the WS channel fires", async () => {
		const received: Array<{ sessionId: string; eventType: string }> = [];
		const handler = ({
			sessionId,
			event,
		}: {
			sessionId: string;
			event: { eventType: string };
		}) => {
			received.push({ sessionId, eventType: event.eventType });
		};
		sessionBus.on("session_event", handler);
		try {
			await emitAiEvent({
				sessionId: "s-ai-evt",
				source: "managed_control",
				category: "ai_report",
				eventType: "AiReport",
				content: "broadcast me",
				rawPayload: { summary: "ok" },
			});
		} finally {
			sessionBus.off("session_event", handler);
		}
		expect(received).toHaveLength(1);
		expect(received[0].sessionId).toBe("s-ai-evt");
		expect(received[0].eventType).toBe("AiReport");
	});
});
