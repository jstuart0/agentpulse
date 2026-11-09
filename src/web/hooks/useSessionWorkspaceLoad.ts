import { useCallback, useRef } from "react";
import { api } from "../lib/api.js";
import { createRequestOrder } from "../lib/request-order.js";

export type SessionWorkspaceData = Awaited<ReturnType<typeof api.getSession>>;

export interface SessionWorkspaceHandlers {
	/** An answer that may be shown. */
	loaded(data: SessionWorkspaceData): void;
	/** A failure worth reporting (nothing newer has landed). Logs only. */
	failed(err: unknown): void;
	/** The first load for the shown session is over: an answer was applied, or nothing is pending. */
	settled(): void;
}

/**
 * Loads the session the page shows, and orders the answers.
 *
 * An answer for a session no longer shown, or older than one already applied (or than a local write
 * marked with `markApplied`), is dropped. `settled` ends the loading skeleton: when an answer is
 * applied, or when every request begun since the last session change has finished. A request begun
 * under an earlier session never counts, so A to B to A can't end A's skeleton on A's old failure.
 */
export function useSessionWorkspaceLoad(
	sessionId: string | undefined,
	handlers: SessionWorkspaceHandlers,
) {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const orderRef = useRef(createRequestOrder());
	const shownRef = useRef(sessionId);
	const epochRef = useRef(0);
	const pendingRef = useRef(0);

	if (shownRef.current !== sessionId) {
		shownRef.current = sessionId;
		epochRef.current++;
		pendingRef.current = 0;
		orderRef.current.markApplied();
	}

	const load = useCallback(async () => {
		if (!sessionId) return;
		const ticket = orderRef.current.begin();
		const epoch = epochRef.current;
		pendingRef.current++;
		let applied = false;
		try {
			const data = await api.getSession(sessionId);
			if (shownRef.current !== sessionId) return;
			if (!ticket.claim()) return;
			applied = true;
			handlersRef.current.loaded(data);
		} catch (err) {
			if (shownRef.current !== sessionId) return;
			if (ticket.peek()) handlersRef.current.failed(err);
		} finally {
			const current = epochRef.current === epoch;
			if (current) pendingRef.current--;
			if (shownRef.current === sessionId && current && (applied || pendingRef.current === 0)) {
				handlersRef.current.settled();
			}
		}
	}, [sessionId]);

	const markApplied = useCallback(() => orderRef.current.markApplied(), []);

	return { load, markApplied };
}
