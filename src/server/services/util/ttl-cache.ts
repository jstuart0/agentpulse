/**
 * Generic in-process TTL cache. Used to amortize repeated reads of values
 * whose source-of-truth is expensive to query (DB rows for feature flags,
 * cred-blob decrypts, etc.) but cheap to recompute.
 *
 * Single-process assumption is fine for the homelab deployment. Multi-instance
 * deployments need an external invalidation signal — flagged as a future
 * concern, not a blocker.
 *
 * The clock is injectable so tests can advance time deterministically without
 * fighting `Date.now()` mocks; production code passes nothing and gets the
 * real wall clock.
 */
export type NowFn = () => number;

interface Entry<V> {
	value: V;
	expiresAt: number;
}

export class TtlCache<K, V> {
	private readonly ttlMs: number;
	private readonly now: NowFn;
	private readonly store = new Map<K, Entry<V>>();

	constructor(ttlMs: number, nowFn: NowFn = Date.now) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error(`TtlCache ttlMs must be a positive finite number, got ${ttlMs}`);
		}
		this.ttlMs = ttlMs;
		this.now = nowFn;
	}

	/**
	 * Return the cached value if fresh; otherwise call `loader`, store the
	 * result with a fresh TTL, and return it. Concurrent callers for the
	 * same key during a load each invoke the loader independently — no
	 * built-in singleflight, since loaders here are idempotent reads.
	 */
	async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
		const entry = this.store.get(key);
		if (entry && entry.expiresAt > this.now()) {
			return entry.value;
		}
		const value = await loader();
		this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
		return value;
	}

	/**
	 * Drop a single entry (when `key` is provided) or wipe the entire cache
	 * (when called without arguments). Use after a write to the underlying
	 * source-of-truth so the next read pulls fresh data.
	 */
	invalidate(key?: K): void {
		if (key === undefined) {
			this.store.clear();
		} else {
			this.store.delete(key);
		}
	}

	/**
	 * Synchronously seed a value into the cache, bypassing any loader.
	 * Mostly useful in tests; production callers should prefer `getOrLoad`.
	 */
	setNow(key: K, value: V): void {
		this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
	}

	/** Cheap probe for tests/diagnostics; does not consult `now`. */
	hasFresh(key: K): boolean {
		const entry = this.store.get(key);
		return entry !== undefined && entry.expiresAt > this.now();
	}
}
