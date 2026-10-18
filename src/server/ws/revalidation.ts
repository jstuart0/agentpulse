/**
 * The seam between "someone's authority just changed" and "re-judge every open
 * socket now". A service that changes ownership, a role, the instance mode or a
 * key's liveness calls requestWsRevalidation() once its change has committed; the
 * socket handler registers the one listener that re-runs its authorization sweep.
 * The 30 s heartbeat sweep stays the backstop for a replica that missed the call.
 *
 * A leaf on purpose: services import this, never ws/handler.ts (which imports the
 * services), so the graph stays acyclic.
 */
type Revalidate = () => Promise<void>;

let listener: Revalidate | null = null;

export function setWsRevalidationListener(next: Revalidate | null): void {
	listener = next;
}

/**
 * Resolves once the sweep has run, and never rejects: a failed sweep is logged
 * by the listener and retried by the next heartbeat, and must not fail the
 * change that asked for it.
 */
export async function requestWsRevalidation(): Promise<void> {
	const pending = [...observers].map((observe) => observe().catch(() => undefined));
	if (listener) pending.push(listener().catch(() => undefined));
	await Promise.all(pending);
}

const observers = new Set<Revalidate>();

/**
 * Another consumer of the same signal (the Live Activity publisher): it runs
 * alongside the socket sweep and cannot displace it. Returns the unsubscribe.
 */
export function observeWsRevalidation(observer: Revalidate): () => void {
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}
