import { EventEmitter } from "node:events";
import type { Session, SessionEvent, WsMessageType } from "../../shared/types.js";
import { broadcast } from "../ws/handler.js";
import { mapSessionDto } from "./session-dto.js";

// A raw sessions row (or a row-shaped object with the extra fields a
// caller has already merged in, e.g. managedSession) — or an already-mapped
// Session. Every caller passes this; mapSessionDto (D14/F48) computes
// nameSource/nativeName here, at the single choke point every WebSocket
// session broadcast passes through, so no caller can forget it. Declared as
// a generic constraint (rather than `& Record<string, unknown>`) so both a
// bare object literal with extra fields (tests) and the `Session` interface
// (which has no index signature) satisfy it.
type SessionLike = { displayName: string | null; metadata: unknown };

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

export function notifySessionCreated<T extends SessionLike>(session: T) {
	// Bus-only. initWsBroadcaster (ws/handler.ts) broadcasts "session_created"
	// when it receives this event. No direct broadcast() call here.
	sessionBus.emit("session_created", mapSessionDto(session) as unknown as Session);
}

export function notifySessionUpdated<T extends SessionLike>(session: T) {
	// Bus-only. initWsBroadcaster broadcasts "session_updated".
	sessionBus.emit("session_updated", mapSessionDto(session) as unknown as Session);
}

export function notifySessionEvents(sessionId: string, events: SessionEvent[]) {
	for (const event of events) {
		// Bus-only. initWsBroadcaster handles the broadcastToSession call.
		sessionBus.emit("session_event", { sessionId, event });
	}
}
