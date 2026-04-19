import type { SessionEvent, WsMessageType } from "../../shared/types.js";
import { broadcast, broadcastToSession } from "../ws/handler.js";

type SessionLike = object;

export function notifyChannel(type: WsMessageType, data: unknown, channel = "sessions") {
	broadcast(type, data, channel);
}

export function notifySessionCreated(session: SessionLike) {
	broadcast("session_created", { session });
}

export function notifySessionUpdated(session: SessionLike) {
	broadcast("session_updated", { session });
}

export function notifySessionEvents(sessionId: string, events: SessionEvent[]) {
	for (const event of events) {
		broadcastToSession(sessionId, "new_event", event);
	}
}
