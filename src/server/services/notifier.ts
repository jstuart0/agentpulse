import { EventEmitter } from "node:events";
import type { Session, SessionEvent, WsMessageType } from "../../shared/types.js";
import { broadcast, broadcastToSession } from "../ws/handler.js";

type SessionLike = object;

// In-process event bus. Backend services (the AI watcher runner, future
// metrics collectors, etc.) subscribe here instead of polling. Kept
// separate from the websocket broadcast channel so client-connection
// counts / filtering don't affect backend consumers.
type SessionBusEvents = {
	session_updated: [Session];
	session_event: [{ sessionId: string; event: SessionEvent }];
};

class SessionBus extends EventEmitter<SessionBusEvents> {}
export const sessionBus = new SessionBus();
sessionBus.setMaxListeners(50);

export function notifyChannel(type: WsMessageType, data: unknown, channel = "sessions") {
	broadcast(type, data, channel);
}

export function notifySessionCreated(session: SessionLike) {
	broadcast("session_created", { session });
	sessionBus.emit("session_updated", session as Session);
}

export function notifySessionUpdated(session: SessionLike) {
	broadcast("session_updated", { session });
	sessionBus.emit("session_updated", session as Session);
}

export function notifySessionEvents(sessionId: string, events: SessionEvent[]) {
	for (const event of events) {
		broadcastToSession(sessionId, "new_event", event);
		sessionBus.emit("session_event", { sessionId, event });
	}
}
