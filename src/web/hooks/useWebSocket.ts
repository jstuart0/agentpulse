import { useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useEventStore } from "../stores/event-store.js";

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const updateSession = useSessionStore((s) => s.updateSession);
	const addSession = useSessionStore((s) => s.addSession);
	const addLiveEvent = useEventStore((s) => s.addLiveEvent);

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.host;
		const url = `${protocol}//${host}/api/v1/ws`;

		const ws = new WebSocket(url);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[ws] Connected");
			ws.send(JSON.stringify({ type: "subscribe", channels: ["sessions"] }));
		};

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);

				switch (msg.type) {
					case "session_created":
						addSession(msg.data.session);
						break;
					case "session_updated":
						updateSession(msg.data.session);
						break;
					case "session_ended":
						updateSession(msg.data.session);
						break;
					case "new_event":
						addLiveEvent({
							sessionId: msg.data.sessionId,
							eventType: msg.data.eventType,
							toolName: msg.data.toolName || null,
							prompt: msg.data.prompt || null,
							toolInput: msg.data.toolInput || null,
							createdAt: msg.data.createdAt || new Date().toISOString(),
						});
						break;
					case "heartbeat":
						break;
				}
			} catch {
				// Ignore parse errors
			}
		};

		ws.onclose = () => {
			console.log("[ws] Disconnected, reconnecting in 3s...");
			reconnectTimeoutRef.current = setTimeout(connect, 3000);
		};

		ws.onerror = () => {
			ws.close();
		};
	}, [updateSession, addSession, addLiveEvent]);

	useEffect(() => {
		connect();
		return () => {
			if (wsRef.current) {
				wsRef.current.close();
			}
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
		};
	}, [connect]);

	return wsRef;
}
