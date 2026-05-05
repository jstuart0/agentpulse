import { EventEmitter } from "node:events";
import type { Session, SessionEvent, WsMessageType } from "../../shared/types.js";
import { broadcast } from "../ws/handler.js";

type SessionLike = object;

// In-process event bus. Backend services (the AI watcher runner, future
// metrics collectors, etc.) subscribe here instead of polling. Kept
// separate from the websocket broadcast channel so client-connection
// counts / filtering don't affect backend consumers.
//
// A-M3: sessionBus is the single source of truth for session state changes.
// WS broadcast is a subscriber on this bus (wired in ws/handler.ts via
// initWsBroadcaster). notifySession* functions only emit to sessionBus;
// they do NOT call broadcast() directly. The exception is notifyChannel()
// which forwards typed channel messages — it has no session-state semantics
// and is not bus-routed.
type SessionBusEvents = {
	session_created: [Session];
	session_updated: [Session];
	session_event: [{ sessionId: string; event: SessionEvent }];
};

class SessionBus extends EventEmitter<SessionBusEvents> {}
export const sessionBus = new SessionBus();
sessionBus.setMaxListeners(50);

// Export the type so ws/handler can reference it structurally without
// importing the concrete class (avoids the circular dep).
export type { SessionBus };

export function notifyChannel(type: WsMessageType, data: unknown, channel = "sessions") {
	// Direct broadcast: channel-routed messages don't go through sessionBus
	// because they carry arbitrary WsMessageType payloads, not session state.
	broadcast(type, data, channel);
}

export function notifySessionCreated(session: SessionLike) {
	// Bus-only. initWsBroadcaster (ws/handler.ts) broadcasts "session_created"
	// when it receives this event. No direct broadcast() call here.
	sessionBus.emit("session_created", session as Session);
}

export function notifySessionUpdated(session: SessionLike) {
	// Bus-only. initWsBroadcaster broadcasts "session_updated".
	sessionBus.emit("session_updated", session as Session);
}

export function notifySessionEvents(sessionId: string, events: SessionEvent[]) {
	for (const event of events) {
		// Bus-only. initWsBroadcaster handles the broadcastToSession call.
		sessionBus.emit("session_event", { sessionId, event });
	}
}
