/**
 * Per-API-key token-bucket rate limiter for hook ingest endpoints.
 *
 * Design constraints (from CLAUDE.md + audit finding S-M6):
 *  - Runs AFTER requireApiKey() — apiKeyId is guaranteed on context.
 *  - Hooks must NEVER return 429 post-auth. Rate-limited events are
 *    silently dropped (200 returned, no downstream work enqueued).
 *  - The always-200 post-auth boundary: pre-auth 401/403 from requireApiKey()
 *    are unaffected and continue to fire before this middleware runs.
 *
 * Token bucket:
 *  - Capacity = rate (tokens) per second.
 *  - Each HTTP request consumes 1 token.
 *  - Tokens refill continuously based on elapsed wall-clock time.
 *  - Default: 100 req/s per key. Override with AGENTPULSE_HOOK_RATE_LIMIT=N.
 *
 * Rate-limited drops are counted in rateLimitedDropped (ingest-counters.ts)
 * and surfaced via GET /api/v1/health so operators can observe the drop rate.
 */

import type { Context, Next } from "hono";
import { incrementRateLimitedDropped } from "../routes/ingest-counters.js";

const RATE_LIMIT = Math.max(1, Number(process.env.AGENTPULSE_HOOK_RATE_LIMIT ?? "100"));

interface Bucket {
	tokens: number;
	lastRefillMs: number;
}

// In-memory per-key buckets. One entry per API key id; cleared on process
// restart (intentional — state is ephemeral, not persisted).
const buckets = new Map<string, Bucket>();

/**
 * Consume one token for `keyId`.
 * Returns true if the request is allowed, false if it should be dropped.
 */
function tryConsume(keyId: string): boolean {
	const now = Date.now();
	let bucket = buckets.get(keyId);

	if (!bucket) {
		bucket = { tokens: RATE_LIMIT, lastRefillMs: now };
		buckets.set(keyId, bucket);
	}

	// Refill tokens proportional to elapsed time (continuous refill).
	const elapsedSec = (now - bucket.lastRefillMs) / 1000;
	bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + elapsedSec * RATE_LIMIT);
	bucket.lastRefillMs = now;

	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return true;
	}
	return false;
}

export interface HookRateLimitOptions {
	/**
	 * Prefixes the bucket key so this call site gets its own token bucket,
	 * independent of `/hooks`'s default (unprefixed) buckets. D20:
	 * `/native-name` uses `"native-name:"`.
	 */
	bucketPrefix?: string;
	/**
	 * `/hooks` must never return 429 post-auth (CLAUDE.md mandate) — the
	 * default "200-silent" drops the request silently. D20's `/native-name`
	 * limiter opts into a real 429 via "429" instead.
	 */
	onLimit?: "200-silent" | "429";
}

/**
 * Hono middleware factory for hook-shaped rate limiting.
 *
 * Bucket key: api_key callers use their key id (`<bucketPrefix><id>`, one
 * bucket per key — D20). Non-api_key callers (forwardauth/local/
 * DISABLE_AUTH) use `<bucketPrefix><source>:<sessionId>`, keyed per session
 * rather than one shared bucket, since a dashboard operator resetting many
 * different sessions' names shouldn't be throttled as a single caller.
 *
 * On rate-limit hit: `onLimit:"200-silent"` (default) increments
 * rateLimitedDropped and returns 200 immediately, no downstream handler —
 * the /hooks always-200 contract. `onLimit:"429"` returns
 * 429 { error: "rate_limited" } instead.
 */
export function hookRateLimit(options: HookRateLimitOptions = {}) {
	const bucketPrefix = options.bucketPrefix ?? "";
	const onLimit = options.onLimit ?? "200-silent";
	return async (c: Context, next: Next): Promise<Response | undefined> => {
		// authUser is set by requireApiKey()/requireAuth() before this
		// middleware runs. authUser.id is the API key's database id (unique
		// per key). In DISABLE_AUTH mode id is "anonymous" — one shared
		// bucket, which is fine since there's no per-key isolation to enforce.
		const authUser = c.get("authUser") as { id?: string; source?: string } | undefined;
		const bucketKey =
			authUser?.source === "api_key" || authUser === undefined
				? `${bucketPrefix}${authUser?.id ?? "anonymous"}`
				: `${bucketPrefix}${authUser.source}:${c.req.param("sessionId") ?? "none"}`;

		if (!tryConsume(bucketKey)) {
			if (onLimit === "429") {
				return c.json({ error: "rate_limited" }, 429);
			}
			incrementRateLimitedDropped();
			// Return 200 — never 429 post-auth (CLAUDE.md mandate).
			return c.json({ ok: true });
		}

		await next();
	};
}

/**
 * Exported for unit tests that need to inspect or reset bucket state.
 * Do NOT use in production code.
 */
export function _resetBucketsForTest(): void {
	buckets.clear();
}
