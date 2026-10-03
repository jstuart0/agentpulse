/**
 * A session pushed over the socket carries its effective machine, read the way
 * the list reads it, so the dashboard can include or leave out a live row by the
 * same rule it applies to a listed one. The push can't carry it unaided: a
 * supervisor-launched session's host lives on the managed row, which the pushed
 * row never joins. Order is part of the contract: a session's creation must still
 * reach the dashboard before its first event, whatever each lookup costs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import "../db/__test_db.js";
import { machineMatchesHost } from "../../shared/machine-scope.js";
import type { Session, SessionEvent } from "../../shared/types.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, managedSessions } = await import("../db/schema/index.js");
const { stampMachine } = await import("../services/effective-machine.js");
const { getSessions } = await import("../services/session-tracker.js");
const { handleWsClose, handleWsOpen, handleWsMessage, initWsBroadcaster } = await import(
	"./handler.js"
);

type BusEvents = {
	session_created: [Session];
	session_updated: [Session];
	session_event: [{ sessionId: string; event: SessionEvent }];
};
class TestBus extends EventEmitter<BusEvents> {}

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

function openSocket() {
	const received: Array<{ type: string; data: Record<string, unknown> }> = [];
	const ws = {
		data: { userId: null, keyId: null },
		send: (message: string) => received.push(JSON.parse(message)),
		close: () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	handleWsOpen(ws as any);
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	handleWsMessage(ws as any, JSON.stringify({ type: "subscribe", channels: ["sessions"] }));
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	return { received, close: () => handleWsClose(ws as any) };
}

const pushed = (sessionId: string) =>
	({ sessionId, displayName: sessionId, metadata: {} }) as unknown as Session;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function seed(
	sessionId: string,
	reportedHost: string | null,
	supervisorHost?: string | null,
) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", reportedHost });
	if (supervisorHost !== undefined) {
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: `launch-${sessionId}`,
				supervisorId: "supervisor-1",
				hostName: supervisorHost,
			});
	}
}

describe("stampMachine", () => {
	test("reads the machine the way the list does: supervisor first, then reported, blank is none", async () => {
		await seed("s-reported", "alice-mbp");
		await seed("s-supervised", "reported-name", "edge-02");
		await seed("s-supervised-blank", "alice-mbp", "  ");
		await seed("s-none", null);
		await seed("s-blank", "   ");
		const stamped = async (id: string) => (await stampMachine(pushed(id))).machine;
		expect(await stamped("s-reported")).toBe("alice-mbp");
		expect(await stamped("s-supervised")).toBe("edge-02");
		expect(await stamped("s-supervised-blank")).toBe("alice-mbp");
		expect(await stamped("s-none")).toBeNull();
		expect(await stamped("s-blank")).toBeNull();
	});

	test("a session that is no longer stored is passed on unstamped, not invented", async () => {
		const row = await stampMachine(pushed("gone"));
		expect("machine" in row).toBe(false);
	});

	test("the stamp agrees with the list's own machine, and with the client's rule, for every filter", async () => {
		await seed("p-1", "alice-mbp");
		await seed("p-2", "build-01", "edge-02");
		await seed("p-3", null, null);
		await seed("p-4", "  build-01 ");
		await seed("p-5", null);
		const listed = (await getSessions({ limit: 100 })).sessions;
		expect(listed.length).toBe(5);
		for (const row of listed) {
			expect((await stampMachine(pushed(row.sessionId))).machine).toBe(
				row.machine as string | null,
			);
		}
		for (const scope of [
			{ kind: "host", host: "build-01" },
			{ kind: "host", host: "edge-02" },
			{ kind: "unknown" },
		] as const) {
			const byServer = (await getSessions({ host: scope, limit: 100 })).sessions
				.map((s) => s.sessionId)
				.sort();
			const byClient = listed
				.filter((s) => machineMatchesHost(scope, s.machine as string | null))
				.map((s) => s.sessionId)
				.sort();
			expect({ scope, byClient }).toEqual({ scope, byClient: byServer });
		}
	});
});

describe("initWsBroadcaster with an annotator", () => {
	test("session_created and session_updated reach a socket stamped, event pushes untouched", async () => {
		await seed("live-1", "alice-mbp");
		const bus = new TestBus();
		initWsBroadcaster(bus, { annotate: stampMachine });
		const socket = openSocket();
		try {
			bus.emit("session_created", pushed("live-1"));
			bus.emit("session_updated", pushed("live-1"));
			await flush();
			const sessionPushes = socket.received.filter((m) => m.type.startsWith("session_"));
			expect(sessionPushes.map((m) => m.type)).toEqual(["session_created", "session_updated"]);
			for (const push of sessionPushes) {
				expect((push.data.session as { machine?: string }).machine).toBe("alice-mbp");
			}
		} finally {
			socket.close();
		}
	});

	test("a session's own pushes keep their order when an earlier lookup is the slowest, and its event waits for its creation", async () => {
		const bus = new TestBus();
		const gates = new Map<string, () => void>();
		initWsBroadcaster(bus, {
			annotate: (session) =>
				new Promise((resolve) => {
					gates.set(session.sessionId, () => resolve({ ...session, machine: "m" }));
				}),
		});
		const socket = openSocket();
		try {
			bus.emit("session_created", pushed("ord-1"));
			bus.emit("session_event", {
				sessionId: "ord-1",
				event: { id: 1 } as unknown as SessionEvent,
			});
			await flush();
			expect(socket.received).toEqual([]);
			gates.get("ord-1")?.();
			await flush();
			expect(socket.received.map((m) => m.type)).toEqual(["session_created", "new_event"]);
		} finally {
			socket.close();
		}
	});

	test("one session's slow lookup never holds up another session's push, or an event for a session with nothing pending", async () => {
		const bus = new TestBus();
		initWsBroadcaster(bus, {
			annotate: (session) =>
				session.sessionId === "slow"
					? new Promise<Session>(() => {})
					: Promise.resolve({ ...session, machine: "m" }),
			annotateTimeoutMs: 10_000,
		});
		const socket = openSocket();
		try {
			bus.emit("session_updated", pushed("slow"));
			bus.emit("session_updated", pushed("fast"));
			bus.emit("session_event", { sessionId: "idle", event: { id: 1 } as unknown as SessionEvent });
			await flush();
			expect(
				socket.received.map(
					(m) =>
						`${m.type}:${(m.data.session as { sessionId?: string } | undefined)?.sessionId ?? ""}`,
				),
			).toEqual(["session_updated:fast", "new_event:"]);
		} finally {
			socket.close();
		}
	});

	test("a lookup that never answers is given up on: the row goes out unstamped after the timeout, and the session's later push follows it", async () => {
		const bus = new TestBus();
		let calls = 0;
		initWsBroadcaster(bus, {
			annotate: (session) => {
				calls += 1;
				return calls === 1
					? new Promise<Session>(() => {})
					: Promise.resolve({ ...session, machine: "m" });
			},
			annotateTimeoutMs: 30,
		});
		const socket = openSocket();
		try {
			bus.emit("session_updated", pushed("hung"));
			bus.emit("session_updated", pushed("hung"));
			await new Promise((resolve) => setTimeout(resolve, 15));
			expect(socket.received).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 60));
			const rows = socket.received.map((m) => m.data.session as { machine?: string });
			expect(rows.length).toBe(2);
			expect("machine" in rows[0]).toBe(false);
			expect(rows[1].machine).toBe("m");
		} finally {
			socket.close();
		}
	});

	test("lookups in flight are bounded: past the bound a push is sent unstamped without asking, and the bound frees as lookups settle", async () => {
		const bus = new TestBus();
		const gates: Array<() => void> = [];
		let asked = 0;
		initWsBroadcaster(bus, {
			annotate: (session) => {
				asked += 1;
				return new Promise<Session>((resolve) =>
					gates.push(() => resolve({ ...session, machine: "m" })),
				);
			},
			annotateTimeoutMs: 10_000,
			annotateMaxInFlight: 3,
		});
		const socket = openSocket();
		try {
			for (let i = 0; i < 6; i++) bus.emit("session_updated", pushed(`b-${i}`));
			await flush();
			expect(asked).toBe(3);
			expect(
				socket.received.map((m) => (m.data.session as { sessionId: string }).sessionId).sort(),
			).toEqual(["b-3", "b-4", "b-5"]);
			for (const open of gates) open();
			await flush();
			expect(socket.received.length).toBe(6);
			bus.emit("session_updated", pushed("b-after"));
			await flush();
			expect(asked).toBe(4);
		} finally {
			socket.close();
		}
	});

	test("a lookup that fails still delivers the row, unstamped, and later pushes still flow", async () => {
		const bus = new TestBus();
		let calls = 0;
		initWsBroadcaster(bus, {
			annotate: async (session) => {
				calls += 1;
				if (calls === 1) throw new Error("db unavailable");
				return { ...session, machine: "m" };
			},
		});
		const socket = openSocket();
		try {
			bus.emit("session_updated", pushed("f-1"));
			bus.emit("session_updated", pushed("f-2"));
			await flush();
			const sessionsSeen = socket.received.map(
				(m) => m.data.session as { sessionId: string; machine?: string },
			);
			expect(sessionsSeen.map((s) => s.sessionId)).toEqual(["f-1", "f-2"]);
			expect("machine" in sessionsSeen[0]).toBe(false);
			expect(sessionsSeen[1].machine).toBe("m");
		} finally {
			socket.close();
		}
	});

	test("without an annotator a push is sent at once and untouched, as before", () => {
		const bus = new TestBus();
		initWsBroadcaster(bus);
		const socket = openSocket();
		try {
			bus.emit("session_updated", pushed("sync-1"));
			expect(socket.received.length).toBe(1);
			expect("machine" in (socket.received[0].data.session as object)).toBe(false);
		} finally {
			socket.close();
		}
	});
});
