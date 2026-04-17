import { useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "../stores/session-store.js";
import { useEventStore } from "../stores/event-store.js";

function sendNotification(title: string, body: string) {
	if (!("Notification" in window)) return;
	if (Notification.permission === "granted") {
		new Notification(title, { body, icon: "/assets/agentpulse-social.jpg" });
	}
}

export function useNotificationPermission() {
	useEffect(() => {
		if ("Notification" in window && Notification.permission === "default") {
			Notification.requestPermission();
		}
	}, []);
}

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const updateSession = useSessionStore((s) => s.updateSession);
	const addSession = useSessionStore((s) => s.addSession);
	const addLiveEvent = useEventStore((s) => s.addLiveEvent);

	// Track previous isWorking state to detect transitions
	const workingRef = useRef<Map<string, boolean>>(new Map());

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
						sendNotification(
							"New session",
							`${msg.data.session.displayName || "Session"} started in ${msg.data.session.cwd?.split("/").pop() || "unknown"}`,
						);
						break;
					case "session_updated": {
						const session = msg.data.session;
						const wasWorking = workingRef.current.get(session.sessionId);
						const name = session.displayName || session.sessionId?.slice(0, 8);

						// Notify when agent stops working (finished a turn)
						if (wasWorking && !session.isWorking && document.hidden) {
							sendNotification(
								`${name} finished`,
								session.currentTask || `Done in ${session.cwd?.split("/").pop() || "unknown"}`,
							);
						}

						workingRef.current.set(session.sessionId, session.isWorking);
						updateSession(session);
						break;
					}
					case "session_ended":
						updateSession(msg.data.session);
						break;
					case "new_event":
						addLiveEvent(msg.data);
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
