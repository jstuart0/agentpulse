/**
 * When a supervisor whose heartbeat has gone stale should give up and exit so the service manager restarts
 * it. A stale heartbeat usually means the server is unreachable, which is not a reason to stop the agents the
 * user has running here: the supervisor exits only when it is stale AND holds nothing to look after. Queued
 * reports do not keep it alive; they are on disk, and the restarted supervisor reloads and replays them.
 *
 * `bridges` is the number of live interactive terminal bridges, or null when that could not be learned (an
 * error, or no answer in time): unknown counts as "something may be running", so the answer is not to exit.
 */
export function shouldExitOnStaleHeartbeat(input: {
	staleMs: number;
	thresholdMs: number;
	codex: number;
	headless: number;
	bridges: number | null;
}): boolean {
	if (input.staleMs <= input.thresholdMs) return false;
	if (input.codex > 0 || input.headless > 0) return false;
	return input.bridges === 0;
}

/** The line logged once per stale period when the supervisor stays up. */
export function keepAliveLine(staleMs: number, running: number): string {
	return `server unreachable for ${Math.round(staleMs / 1000)}s; keeping ${running} managed sessions running; their events are queued on this host`;
}
