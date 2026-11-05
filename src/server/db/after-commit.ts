/**
 * Work that must happen only once a transaction has committed, such as telling sockets and phones that a row
 * moved. `withTransaction` and `withAdminLock` open a scope; code anywhere inside registers a callback with
 * `afterCommit`; the callbacks run once the outermost transaction has committed, in order, and are dropped if
 * it rolled back. A callback that throws is logged and never undoes the commit or stops the others.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Callback = () => void | Promise<void>;

const scope = new AsyncLocalStorage<Callback[]>();

/** Runs `run` (a whole transaction) and, if it resolves, the callbacks registered while it ran. */
export async function withAfterCommit<T>(run: () => Promise<T>): Promise<T> {
	if (scope.getStore()) return run();
	const callbacks: Callback[] = [];
	const result = await scope.run(callbacks, run);
	for (const callback of callbacks) {
		try {
			await callback();
		} catch (error) {
			console.error(
				JSON.stringify({
					kind: "after_commit_failed",
					level: "error",
					error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
				}),
			);
		}
	}
	return result;
}

/** Registers `callback` to run after the surrounding transaction commits. False when there is no transaction scope: the caller then runs it itself. */
export function afterCommit(callback: Callback): boolean {
	const callbacks = scope.getStore();
	if (!callbacks) return false;
	callbacks.push(callback);
	return true;
}
