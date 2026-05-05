// P8 — A-M3: verify that sessionBus is the source of truth for WS broadcasts.
// We test that subscribing to sessionBus receives every event that would
// previously have been delivered via a direct broadcast() call.
import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "../../shared/types.js";

const { sessionBus, notifySessionCreated, notifySessionUpdated, notifySessionEvents } =
	await import("../services/notifier.js");

function makeSession(id: string): Session {
	return {
		id,
		sessionId: id,
		displayName: `session-${id}`,
		agentType: "claude_code",
		status: "active",
		cwd: "/tmp/test",
		transcriptPath: null,
		model: "claude-sonnet-4-6",
		startedAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
		endedAt: null,
		semanticStatus: null,
		currentTask: null,
		planSummary: [],
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		gitBranch: null,
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		projectId: null,
		isArchived: false,
	};
}

function makeEvent(sessionId: string): SessionEvent {
	return {
		id: 1,
		sessionId,
		eventType: "UserPromptSubmit",
		category: "prompt",
		source: "observed_hook",
		content: "hello",
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: new Date().toISOString(),
	};
}

describe("A-M3 — sessionBus is source of truth for broadcasts", () => {
	test("notifySessionCreated emits session_created on sessionBus", async () => {
		const session = makeSession(`create-${crypto.randomUUID()}`);
		const received = await new Promise<Session>((resolve) => {
			sessionBus.once("session_created", resolve);
			notifySessionCreated(session);
		});
		expect(received.sessionId).toBe(session.sessionId);
	});

	test("notifySessionUpdated emits session_updated on sessionBus", async () => {
		const session = makeSession(`update-${crypto.randomUUID()}`);
		const received = await new Promise<Session>((resolve) => {
			sessionBus.once("session_updated", resolve);
			notifySessionUpdated(session);
		});
		expect(received.sessionId).toBe(session.sessionId);
	});

	test("notifySessionEvents emits session_event on sessionBus for each event", async () => {
		const sessionId = `events-${crypto.randomUUID()}`;
		const event = makeEvent(sessionId);
		const received = await new Promise<{ sessionId: string; event: SessionEvent }>((resolve) => {
			sessionBus.once("session_event", resolve);
			notifySessionEvents(sessionId, [event]);
		});
		expect(received.sessionId).toBe(sessionId);
		expect(received.event.eventType).toBe("UserPromptSubmit");
	});

	test("multiple events emit multiple session_event bus events", async () => {
		const sessionId = `multi-${crypto.randomUUID()}`;
		const events = [makeEvent(sessionId), { ...makeEvent(sessionId), id: 2, content: "second" }];
		const collected: Array<{ sessionId: string; event: SessionEvent }> = [];

		await new Promise<void>((resolve) => {
			let count = 0;
			sessionBus.on("session_event", (payload) => {
				if (payload.sessionId === sessionId) {
					collected.push(payload);
					count++;
					if (count === events.length) resolve();
				}
			});
			notifySessionEvents(sessionId, events);
		});

		expect(collected.length).toBe(2);
	});
});
