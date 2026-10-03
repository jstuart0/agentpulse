import type { ServerWebSocket } from "bun";
import { WS_HEARTBEAT_INTERVAL_MS } from "../../shared/constants.js";
import type { Session, SessionEvent, WsMessage, WsMessageType } from "../../shared/types.js";
import { getInactiveApiKeyIds } from "../auth/api-key.js";
import { getUserGateStates } from "../services/user-identity.js";
import type { WsConnectionData } from "./ws-auth.js";

/** Close code for a socket the server ends because its identity stopped being allowed. */
const WS_CLOSE_IDENTITY_REVOKED = 4001;

interface WsClient {
	ws: ServerWebSocket<unknown>;
	channels: Set<string>;
	/** The user the connection is acting as: the cookie/SSO user, or an API key's owner. Null for DISABLE_AUTH, a service key, a supervisor credential. */
	userId: string | null;
	/** The API key the connection authenticated with, null when it didn't use one. */
	keyId: string | null;
}

const clients = new Map<ServerWebSocket<unknown>, WsClient>();

// Handle new WebSocket connection. The identity was resolved at upgrade
// time (guardWsUpgrade) and rides on `ws.data`; a socket opened without it
// (none in production) is treated as having no user and no key.
export function handleWsOpen(ws: ServerWebSocket<unknown>) {
	const data = ws.data as Partial<WsConnectionData> | undefined;
	clients.set(ws, {
		ws,
		channels: new Set(["sessions"]),
		userId: data?.userId ?? null,
		keyId: data?.keyId ?? null,
	});
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
		void heartbeatTick();
	}, WS_HEARTBEAT_INTERVAL_MS);
}

function closeClient(client: WsClient, reason: string): void {
	try {
		client.ws.close(WS_CLOSE_IDENTITY_REVOKED, reason);
	} catch {
		// Already closed/closing — nothing left to do.
	}
	clients.delete(client.ws);
}

/**
 * Close every open socket belonging to a user. Runs on disable and
 * whenever must_change_password is set. Idempotent — a user with no open
 * sockets is a no-op.
 */
export function closeSocketsForUser(userId: string): void {
	for (const client of [...clients.values()]) {
		if (client.userId === userId) closeClient(client, "account_disabled");
	}
}

/**
 * One heartbeat-interval sweep: re-checks, in two batched queries, every
 * connected user's disabled/must-change-password state and every
 * connected key's active flag, and closes any socket whose identity is now
 * gated. This is what bounds "a replica that didn't handle the disable" to
 * one heartbeat interval. Never rejects: a database error is logged and the
 * sweep is retried on the next tick (sockets stay as they were). Exported
 * separately from startHeartbeat's setInterval wrapper so a test can invoke
 * exactly one sweep instead of waiting WS_HEARTBEAT_INTERVAL_MS.
 */
export async function heartbeatTick(): Promise<void> {
	try {
		await sweepGatedIdentities();
	} catch (err) {
		console.error(
			JSON.stringify({
				kind: "ws_heartbeat_failed",
				level: "error",
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}
}

async function sweepGatedIdentities(): Promise<void> {
	const userIds = new Set<string>();
	const keyIds = new Set<string>();
	for (const client of clients.values()) {
		if (client.userId) userIds.add(client.userId);
		if (client.keyId) keyIds.add(client.keyId);
	}
	if (userIds.size === 0 && keyIds.size === 0) return;

	const [userStates, inactiveKeyIds] = await Promise.all([
		getUserGateStates([...userIds]),
		getInactiveApiKeyIds([...keyIds]),
	]);

	for (const client of [...clients.values()]) {
		if (client.keyId && inactiveKeyIds.has(client.keyId)) {
			closeClient(client, "api_key_revoked");
			continue;
		}
		const state = client.userId ? userStates.get(client.userId) : undefined;
		if (!state) continue; // no user, or a deleted one — nothing to reconcile here
		if (state.disabled) closeClient(client, "account_disabled");
		else if (state.mustChangePassword) closeClient(client, "password_change_required");
	}
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
