/**
 * Postgres-only: holds a row lock open in its own transaction while the operations under test are
 * started and parked on it, then lets them all go at once. Every operation has done all of its reads
 * against the same state, which is the worst interleaving, and the order they take the lock in is the
 * order given, so the outcome no longer depends on timing.
 *
 * Fails, rather than hangs, if the operations never park, or if one settles while the lock is held.
 * Pattern from services/ai/hitl-decision-races.test.ts.
 */
import postgres from "postgres";

export async function behindRowLock<T>(
	lockSql: string,
	params: unknown[],
	start: Array<() => Promise<T>>,
	/** Run in the holder's transaction after every operation is parked and before it commits. */
	beforeCommit?: (holder: ReturnType<typeof postgres>) => Promise<void>,
): Promise<T[]> {
	const url = process.env.DATABASE_URL ?? "";
	const holder = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
	const monitor = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
	try {
		await holder.unsafe("BEGIN");
		await holder.unsafe(lockSql, params as never[]);
		const running: Promise<T>[] = [];
		const settled: boolean[] = [];
		const waitUntilParked = async (n: number) => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const [{ count }] = (await monitor`
					SELECT count(*)::int AS count FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'`) as Array<{
					count: number;
				}>;
				if (count >= n) return;
				if (Date.now() > deadline) {
					throw new Error(`only ${count} of ${n} operations parked on the row lock`);
				}
				if (settled.some(Boolean)) {
					throw new Error("an operation finished while the row lock was still held");
				}
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		for (const [i, begin] of start.entries()) {
			const promise = begin();
			running.push(promise);
			settled.push(false);
			promise.then(
				() => {
					settled[i] = true;
				},
				() => {
					settled[i] = true;
				},
			);
			await waitUntilParked(i + 1);
		}
		await beforeCommit?.(holder);
		await holder.unsafe("COMMIT");
		return await Promise.all(running);
	} finally {
		await holder.unsafe("ROLLBACK").catch(() => undefined);
		await holder.end({ timeout: 1 });
		await monitor.end({ timeout: 1 });
	}
}
