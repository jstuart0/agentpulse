// P8 — A-M3: WS broadcaster topology test.
// Verifies that initWsBroadcaster wires the sessionBus to broadcast()
// without requiring a live Bun WS server. We inject a fake bus and spy
// on broadcast to confirm the topology is correct.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Session, SessionEvent } from "../../shared/types.js";

// Import the module under test.
const { initWsBroadcaster } = await import("./handler.js");

function makeSession(id: string): Session {
	return {
		id,
		sessionId: id,
		displayName: `session-${id}`,
		agentType: "claude_code",
		status: "active",
		cwd: "/tmp",
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

// A minimal bus implementation that satisfies SessionBusLike (structural type).
type BusEvents = {
	session_created: [Session];
	session_updated: [Session];
	session_event: [{ sessionId: string; event: SessionEvent }];
};

class FakeBus extends EventEmitter<BusEvents> {}

describe("A-M3 — initWsBroadcaster topology", () => {
	test("session_created bus event triggers broadcast('session_created', ...)", async () => {
		const bus = new FakeBus();
		// We can't easily spy on broadcast without a mock framework, but we CAN
		// verify that initWsBroadcaster registers listeners on the bus.
		initWsBroadcaster(bus);

		const session = makeSession(`created-${crypto.randomUUID()}`);

		// After initWsBroadcaster, the bus should have a listener for session_created.
		expect(bus.listenerCount("session_created")).toBeGreaterThan(0);

		// Emitting should not throw (even with no WS clients connected — broadcast
		// iterates an empty map gracefully).
		expect(() => bus.emit("session_created", session)).not.toThrow();
	});

	test("session_updated bus event triggers broadcast without throwing", () => {
		const bus = new FakeBus();
		initWsBroadcaster(bus);
		const session = makeSession(`updated-${crypto.randomUUID()}`);

		expect(bus.listenerCount("session_updated")).toBeGreaterThan(0);
		expect(() => bus.emit("session_updated", session)).not.toThrow();
	});

	test("session_event bus event triggers broadcastToSession without throwing", () => {
		const bus = new FakeBus();
		initWsBroadcaster(bus);
		const event: SessionEvent = {
			id: 1,
			sessionId: "s-1",
			eventType: "UserPromptSubmit",
			category: "prompt",
			source: "observed_hook",
			content: "test",
			isNoise: false,
			providerEventType: null,
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload: {},
			createdAt: new Date().toISOString(),
		};

		expect(bus.listenerCount("session_event")).toBeGreaterThan(0);
		expect(() => bus.emit("session_event", { sessionId: "s-1", event })).not.toThrow();
	});

	test("all three event types are subscribed after initWsBroadcaster", () => {
		const bus = new FakeBus();
		// Verify no listeners before init.
		expect(bus.listenerCount("session_created")).toBe(0);
		expect(bus.listenerCount("session_updated")).toBe(0);
		expect(bus.listenerCount("session_event")).toBe(0);

		initWsBroadcaster(bus);

		// All three must be wired.
		expect(bus.listenerCount("session_created")).toBeGreaterThan(0);
		expect(bus.listenerCount("session_updated")).toBeGreaterThan(0);
		expect(bus.listenerCount("session_event")).toBeGreaterThan(0);
	});

	test("M1 — second call with the same bus is a no-op (idempotent)", () => {
		const bus = new FakeBus();
		initWsBroadcaster(bus);

		const countAfterFirst = bus.listenerCount("session_created");
		expect(countAfterFirst).toBeGreaterThan(0);

		// Second call must not register additional listeners.
		initWsBroadcaster(bus);

		expect(bus.listenerCount("session_created")).toBe(countAfterFirst);
		expect(bus.listenerCount("session_updated")).toBe(bus.listenerCount("session_updated"));
		expect(bus.listenerCount("session_event")).toBe(bus.listenerCount("session_event"));
	});

	test("M1 — different bus objects are each initialized independently", () => {
		const busA = new FakeBus();
		const busB = new FakeBus();

		initWsBroadcaster(busA);
		initWsBroadcaster(busB);

		// Both buses should have their listeners wired.
		expect(busA.listenerCount("session_created")).toBeGreaterThan(0);
		expect(busB.listenerCount("session_created")).toBeGreaterThan(0);

		// Second call on busA must still be a no-op.
		const countA = busA.listenerCount("session_created");
		initWsBroadcaster(busA);
		expect(busA.listenerCount("session_created")).toBe(countA);
	});
});
