/**
 * Which sessions have a watcher worth waking: enabled, with Notify or Continue
 * on. A leaf module (it reads only `watcher_configs`, and imports no AI-runtime
 * code) so hook ingest can ask it from its background task without pulling the
 * runner in.
 *
 * One cached set, refreshed at most once per TTL. A config write invalidates it
 * synchronously; a generation counter makes sure a load that started before an
 * invalidation can't store its (now stale) result, and the coalescing key
 * carries the generation, so a call made after an invalidation never joins a
 * load that started before it. A cascade-deleted config needs no invalidation:
 * it ages out with the TTL.
 */
import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { watcherConfigs } from "../../db/schema/index.js";
import { createInFlight } from "../../util/in-flight.js";

const WATCHED_TTL_MS = 30_000;

interface CacheEntry {
	sessionIds: Set<string>;
	expiresAt: number;
}

let generation = 0;
let cache: CacheEntry | null = null;
let now: () => number = Date.now;
let loader: () => Promise<Set<string>> = loadWatchedSessionIds;
const coalesce = createInFlight<Set<string>>();

/** Session ids whose config is enabled with at least one mode on. Throws on a DB error. */
export async function loadWatchedSessionIds(): Promise<Set<string>> {
	const rows = await getDb()
		.select({ sessionId: watcherConfigs.sessionId })
		.from(watcherConfigs)
		.where(
			and(
				eq(watcherConfigs.enabled, true),
				or(eq(watcherConfigs.notifyEnabled, true), eq(watcherConfigs.continueEnabled, true)),
			),
		);
	return new Set(rows.map((r) => r.sessionId));
}

async function currentSet(): Promise<Set<string>> {
	if (cache && cache.expiresAt > now()) return cache.sessionIds;
	const startedIn = generation;
	return coalesce(`watched:${startedIn}`, async () => {
		const sessionIds = await loader();
		// An invalidation landed while the query was running: the caller still
		// gets this answer, but nothing stores it, so the next call reloads.
		if (generation === startedIn) {
			cache = { sessionIds, expiresAt: now() + WATCHED_TTL_MS };
		}
		return sessionIds;
	});
}

/**
 * Is this session watched? Never throws: a DB error logs and answers false
 * (fail closed: no wake, never churn).
 */
export async function isWatched(sessionId: string): Promise<boolean> {
	try {
		return (await currentSet()).has(sessionId);
	} catch (err) {
		console.error("[ai-watcher] watched-sessions load failed:", err);
		return false;
	}
}

/** Call after every write to watcher_configs. */
export function invalidateWatchedSessions(): void {
	generation += 1;
	cache = null;
}

/** Test seam: replace the clock. Pass null to restore the real one. */
export function setWatchedSessionsClockForTest(clock: (() => number) | null): void {
	now = clock ?? Date.now;
}

/** Test seam: replace the query, to hold a load open. Pass null to restore the real one. */
export function setWatchedSessionsLoaderForTest(
	replacement: (() => Promise<Set<string>>) | null,
): void {
	loader = replacement ?? loadWatchedSessionIds;
}

/** Test seam: forget everything, including the generation. */
export function resetWatchedSessionsForTest(): void {
	generation = 0;
	cache = null;
	now = Date.now;
	loader = loadWatchedSessionIds;
}
