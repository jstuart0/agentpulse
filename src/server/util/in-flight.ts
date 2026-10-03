/**
 * Concurrent callers asking for the same thing share one computation.
 *
 * Nothing outlives the computation: the entry is removed when it settles,
 * success or failure, so a later call always recomputes and a failure never
 * poisons the next caller. Callers that join an in-flight computation all
 * receive its result (or its error) and must treat the value as read-only.
 *
 * The key must contain everything that changes the answer; two different
 * questions that share a key would be served each other's result.
 */
export function createInFlight<T>(): (key: string, compute: () => Promise<T>) => Promise<T> {
	const pending = new Map<string, Promise<T>>();
	return (key, compute) => {
		const existing = pending.get(key);
		if (existing) return existing;
		// Deferred to a microtask so the entry is registered before `compute`
		// can run, even if it throws synchronously.
		const started: Promise<T> = Promise.resolve()
			.then(compute)
			.finally(() => {
				if (pending.get(key) === started) pending.delete(key);
			});
		pending.set(key, started);
		return started;
	};
}
