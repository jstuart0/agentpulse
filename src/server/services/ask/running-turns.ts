/**
 * Ask turns that have a slot and are streaming, so the person who asked can stop one. A turn that
 * a closed stream left running (its reply is saved for the phone) is still listed here until it
 * ends. Held in memory: a restart ends the turns anyway.
 */
import type { Actor } from "../../auth/actor.js";

interface RunningTurn {
	/** users.id of the requester, null for a key or auth-off caller. */
	userId: string | null;
	/** The API key it was asked with, null for a cookie or SSO caller. */
	keyId: string | null;
	cancelled: boolean;
}

const running = new Map<string, RunningTurn>();

/** Is a turn streaming on this thread right now? */
export function isThreadRunning(threadId: string): boolean {
	return running.has(threadId);
}

/**
 * Lists a turn so its asker can stop it. One turn per thread: a second registration on a thread that
 * already has one is REFUSED (null), not queued, so a thread never has two turns whose owner is unclear.
 * The route turns that into a "thread busy" answer before the second turn starts, and stops it if two
 * arrive at once.
 */
export function registerRunningTurn(threadId: string, who: Pick<RunningTurn, "userId" | "keyId">) {
	if (running.has(threadId)) return null;
	const turn: RunningTurn = { ...who, cancelled: false };
	running.set(threadId, turn);
	return {
		isCancelled: () => turn.cancelled,
		finish: () => {
			if (running.get(threadId) === turn) running.delete(threadId);
		},
	};
}

/**
 * Stops the turn on this thread if `caller` asked it (or is an admin in team mode; anyone in solo,
 * where there is one person). `ownOnly` (a respond key, the same flag the thread read rule uses) drops
 * that admin/solo shortcut: such a caller stops only a turn it asked itself, by user or by key.
 * Returns false for no such turn and for someone else's, so a caller can't learn that another
 * person's thread is busy.
 */
export function cancelRunningTurn(
	threadId: string,
	caller: { actor: Actor; keyId: string | null; ownOnly?: boolean },
): boolean {
	const turn = running.get(threadId);
	if (!turn) return false;
	const { actor, keyId, ownOnly } = caller;
	const mine =
		(!ownOnly && (actor.mode === "solo" || actor.role === "admin")) ||
		(turn.userId !== null && actor.userId === turn.userId) ||
		(turn.userId === null && keyId !== null && keyId === turn.keyId);
	if (!mine) return false;
	turn.cancelled = true;
	return true;
}
