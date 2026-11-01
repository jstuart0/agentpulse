/**
 * Caps how many replay deliveries (reports a supervisor sends late, from its
 * offline queue, marked with the replay header) the server works on at once:
 * MAX_CONCURRENT_REPLAYS in the process, and at most MAX_REPLAYS_PER_SUPERVISOR
 * of those from one supervisor, so a single host with a long queue can't take
 * every slot from the rest of the fleet. A fleet reconnecting together would
 * otherwise turn every queue into simultaneous writes. Live reports are never
 * counted or refused.
 *
 * Per process, in memory, like the other limiters (N replicas admit N times as
 * many).
 */

export const MAX_CONCURRENT_REPLAYS = 4;
export const MAX_REPLAYS_PER_SUPERVISOR = 2;
/** What a refused replay is told to wait, in seconds. */
export const REPLAY_RETRY_AFTER_SECONDS = 2;

let inFlight = 0;
const perSupervisor = new Map<string, number>();

/** Takes a slot for `supervisorId`, or returns null when the process or that supervisor is at its cap. Release the returned function exactly once. */
export function tryAcquireReplay(supervisorId: string): (() => void) | null {
	const mine = perSupervisor.get(supervisorId) ?? 0;
	if (inFlight >= MAX_CONCURRENT_REPLAYS || mine >= MAX_REPLAYS_PER_SUPERVISOR) return null;
	inFlight++;
	perSupervisor.set(supervisorId, mine + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		inFlight = Math.max(0, inFlight - 1);
		const left = (perSupervisor.get(supervisorId) ?? 1) - 1;
		if (left <= 0) perSupervisor.delete(supervisorId);
		else perSupervisor.set(supervisorId, left);
	};
}

export function replaysInFlight(): number {
	return inFlight;
}

/** Test seam: forgets every slot still held. */
export function __resetReplayLimiterForTests(): void {
	inFlight = 0;
	perSupervisor.clear();
}
