/**
 * When a supervisor whose heartbeat has gone stale should give up and exit so the service manager restarts
 * it. A stale heartbeat usually means the server is unreachable, which is not a reason to stop the agents the
 * user has running here: the supervisor exits only when it is stale AND holds nothing to look after. Queued
 * reports do not keep it alive; they are on disk, and the restarted supervisor reloads and replays them.
 *
 * `bridges` is the number of live interactive terminal bridges, or null when that could not be learned (an
 * error, or no answer in time): unknown counts as "something may be running", so the answer is not to exit.
 */
/**
 * Counts live bridges, but never waits longer than `timeoutMs` and never throws: an error or no answer in
 * time is null ("unknown"), which the caller treats as "something may be running". The timer is cleared
 * once the count settles. `schedule` is `setTimeout`-shaped, injectable for tests.
 */
export async function countBridgesBounded(
	count: () => Promise<number>,
	timeoutMs: number,
	schedule: (fn: () => void, ms: number) => unknown = setTimeout,
	cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): Promise<number | null> {
	let handle: unknown;
	const timeout = new Promise<null>((resolve) => {
		handle = schedule(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([count().catch(() => null), timeout]);
	} finally {
		cancel(handle);
	}
}

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
