import type { ServerWebSocket } from "bun";
import { WS_HEARTBEAT_INTERVAL_MS } from "../../shared/constants.js";
import type { Session, SessionEvent, WsMessage, WsMessageType } from "../../shared/types.js";

interface WsClient {
	ws: ServerWebSocket<unknown>;
	channels: Set<string>;
}

const clients = new Map<ServerWebSocket<unknown>, WsClient>();

// Handle new WebSocket connection
export function handleWsOpen(ws: ServerWebSocket<unknown>) {
	clients.set(ws, { ws, channels: new Set(["sessions"]) });
	console.log(`[ws] Client connected (${clients.size} total)`);
}

// Handle incoming WebSocket message
export function handleWsMessage(ws: ServerWebSocket<unknown>, message: string | Buffer) {
	try {
		const msg = JSON.parse(typeof message === "string" ? message : message.toString()) as WsMessage;

		const client = clients.get(ws);
		if (!client) return;

		if (msg.type === "subscribe" && msg.channels) {
			for (const channel of msg.channels) {
				client.channels.add(channel);
			}
		}

		if (msg.type === "unsubscribe" && msg.channels) {
			for (const channel of msg.channels) {
				client.channels.delete(channel);
			}
		}
	} catch {
		// Ignore malformed messages
	}
}

// Handle WebSocket close
export function handleWsClose(ws: ServerWebSocket<unknown>) {
	clients.delete(ws);
	console.log(`[ws] Client disconnected (${clients.size} total)`);
}

// Broadcast a message to all connected clients subscribed to relevant channels
export function broadcast(type: WsMessageType, data: unknown, channel = "sessions") {
	const message = JSON.stringify({ type, data });

	for (const client of clients.values()) {
		if (client.channels.has(channel) || client.channels.has("*")) {
			try {
				client.ws.send(message);
			} catch {
				// Client disconnected, will be cleaned up on close
			}
		}
	}
}

// Broadcast to a specific session channel
export function broadcastToSession(sessionId: string, type: WsMessageType, data: unknown) {
	broadcast(type, data, `session:${sessionId}`);
	broadcast(type, data, "sessions"); // Also broadcast to the sessions list channel
}

// Send heartbeats to keep connections alive
export function startHeartbeat() {
	setInterval(() => {
		const message = JSON.stringify({ type: "heartbeat", data: { timestamp: Date.now() } });
		for (const client of clients.values()) {
			try {
				client.ws.send(message);
			} catch {
				// Will be cleaned up on close
			}
		}
	}, WS_HEARTBEAT_INTERVAL_MS);
}

// Get current connection count
export function getConnectionCount(): number {
	return clients.size;
}

// A-M3: sessionBus-subscriber interface. This interface is the minimal
// subset of EventEmitter<SessionBusEvents> that initWsBroadcaster needs,
// expressed as a structural type so ws/handler has no import dependency on
// notifier (which imports broadcast from here — keeping the graph acyclic).
interface SessionBusLike {
	on(event: "session_created", listener: (session: Session) => void): void;
	on(event: "session_updated", listener: (session: Session) => void): void;
	on(
		event: "session_event",
		listener: (payload: { sessionId: string; event: SessionEvent }) => void,
	): void;
}

// M1: track which bus instances have already been wired. Using a WeakSet so
// each distinct bus object can be initialized exactly once — this allows tests
// to use independent FakeBus instances while still preventing double-init of
// the production singleton.
const initializedBuses = new WeakSet<object>();

/**
 * Wire up the WS broadcaster as a single subscriber on the in-process
 * session bus. Call once at startup (index.ts). notifier.ts only emits
 * to sessionBus; this function fans those events out to WS clients.
 *
 * A-M3: sessionBus is now the single source of truth for WS broadcasts.
 * notifier.ts no longer calls broadcast() or broadcastToSession() directly
 * for session-state events — only notifyChannel() retains a direct call
 * for channel-typed messages that have no session-state semantics.
 *
 * M1: idempotent — calling with the same bus object a second time is a no-op
 * (logs a warning). Prevents listener accumulation on hot-reload or accidental
 * double-init.
 */
export function initWsBroadcaster(bus: SessionBusLike): void {
	if (initializedBuses.has(bus)) {
		console.warn(JSON.stringify({ kind: "ws_broadcaster_double_init", level: "warn" }));
		return;
	}
	initializedBuses.add(bus);

	bus.on("session_created", (session) => {
		broadcast("session_created", { session });
	});

	bus.on("session_updated", (session) => {
		broadcast("session_updated", { session });
	});

	bus.on("session_event", ({ sessionId, event }) => {
		broadcastToSession(sessionId, "new_event", event);
	});
}
