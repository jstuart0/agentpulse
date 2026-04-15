import type { ServerWebSocket } from "bun";
import type { WsMessage, WsMessageType } from "../../shared/types.js";
import { WS_HEARTBEAT_INTERVAL_MS } from "../../shared/constants.js";

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
