import { useCallback, useEffect, useRef } from "react";
import { BROWSER_WS_PATH } from "../lib/paths.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useEventStore } from "../stores/event-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";
import { currentOwnershipUi } from "./useOwnershipUi.js";
import {
	type SocketContext,
	planSessionMessage,
	shouldAcceptLiveEvent,
} from "./ws-owner-filter.js";

function sendNotification(title: string, body: string) {
	if (!("Notification" in window)) return;
	if (Notification.permission === "granted") {
		new Notification(title, { body, icon: "/assets/agentpulse-social.jpg" });
	}
}

/** What the dashboard is showing and who is looking, read at the moment a message arrives. */
function socketContext(): SocketContext {
	return {
		owner: useDashboardScopeStore.getState().owner,
		viewerUserId: useUserStore.getState().userId,
		teamMode: currentOwnershipUi().showTeamCopy,
		watchedSessionId: useEventStore.getState().watchedSessionId,
	};
}

export function useNotificationPermission() {
	useEffect(() => {
		if ("Notification" in window && Notification.permission === "default") {
			Notification.requestPermission();
		}
	}, []);
}

/**
 * Live updates over the dashboard socket. Pass `enabled: false` until the
 * viewer may use the app: a signed-out or must-change-password viewer is
 * refused at the upgrade, and retrying would only burn the failure budget.
 */
export function useWebSocket(enabled = true) {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	// A-M6: use the shared applySessionUpdate reducer so WS and polling
	// paths share identical add-or-update semantics.
	const applySessionUpdate = useSessionStore((s) => s.applySessionUpdate);
	const addLiveEvent = useEventStore((s) => s.addLiveEvent);
	const markConnected = useConnectionStore((s) => s.markConnected);
	const setWsState = useConnectionStore((s) => s.setWsState);

	// Track previous isWorking state to detect transitions
	const workingRef = useRef<Map<string, boolean>>(new Map());
	// Count of consecutive WS failures with no successful open between
	// them. After a few in a row we assume the SSO session expired and
	// ask the app to reload (top-level nav completes the reauth dance).
	const consecutiveFailuresRef = useRef(0);
	const FAILURE_RELOAD_THRESHOLD = 3;

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.host;
		const url = `${protocol}//${host}${BROWSER_WS_PATH}`;

		const ws = new WebSocket(url);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[ws] Connected");
			consecutiveFailuresRef.current = 0;
			markConnected();
			ws.send(JSON.stringify({ type: "subscribe", channels: ["sessions"] }));
		};

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);

				switch (msg.type) {
					case "session_created": {
						const newSession = msg.data.session;
						// The store keeps out a row the view doesn't show; the plan says
						// whether it may also raise a notification (the viewer's own sessions
						// in team mode, everything in solo).
						const plan = planSessionMessage(newSession, false, socketContext());
						applySessionUpdate(newSession);
						if (plan.notify) {
							sendNotification(
								"New session",
								`${newSession.displayName || "Session"} started in ${newSession.cwd?.split("/").pop() || "unknown"}`,
							);
						}
						break;
					}
					case "session_updated": {
						const session = msg.data.session;
						const wasWorking = workingRef.current.get(session.sessionId);
						const name = session.displayName || session.sessionId?.slice(0, 8);

						const wasInStore = useSessionStore
							.getState()
							.sessions.some((existing) => existing.sessionId === session.sessionId);
						const plan = planSessionMessage(session, wasInStore, socketContext());

						// Notify when agent stops working (finished a turn)
						if (wasWorking && !session.isWorking && document.hidden && plan.notify) {
							sendNotification(
								`${name} finished`,
								session.currentTask || `Done in ${session.cwd?.split("/").pop() || "unknown"}`,
							);
						}

						workingRef.current.set(session.sessionId, session.isWorking);
						applySessionUpdate(session);
						break;
					}
					case "session_ended":
						applySessionUpdate(msg.data.session);
						break;
					case "new_event":
						// Only a session id comes with it: ask the store who owns that session.
						if (
							shouldAcceptLiveEvent(
								msg.data.sessionId,
								useSessionStore.getState().sessions,
								socketContext(),
							)
						) {
							addLiveEvent(msg.data);
						}
						break;
					case "heartbeat":
						break;
				}
			} catch {
				// Ignore parse errors
			}
		};

		ws.onclose = () => {
			consecutiveFailuresRef.current += 1;
			if (consecutiveFailuresRef.current >= FAILURE_RELOAD_THRESHOLD) {
				// Give up on WS; polling is the fallback update path.
				// Do NOT reload here — the paused state is the user's signal that
				// live updates have degraded. If auth is genuinely expired, the
				// polling path will surface that via its own error handling.
				setWsState("paused");
				return;
			}
			setWsState("reconnecting");
			console.log(
				`[ws] Disconnected (attempt ${consecutiveFailuresRef.current}), reconnecting in 3s…`,
			);
			reconnectTimeoutRef.current = setTimeout(connect, 3000);
		};

		ws.onerror = () => {
			ws.close();
		};
	}, [applySessionUpdate, addLiveEvent, markConnected, setWsState]);

	useEffect(() => {
		if (!enabled) return;
		consecutiveFailuresRef.current = 0;
		connect();
		return () => {
			if (wsRef.current) {
				// Closing on purpose (sign-out, a gate that closed): no reconnect.
				wsRef.current.onclose = null;
				wsRef.current.close();
			}
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
		};
	}, [connect, enabled]);

	return wsRef;
}
