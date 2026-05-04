import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { invalidateAiFlagsCache } from "./ai/feature.js";

// ADD new user-facing settings keys here — requires review.
// These are the keys the dashboard UI writes via PUT /api/v1/settings.
// Service-internal keys (ai.*, vectorSearch.*, telegram:credentials,
// workspace.*, git_clone.*, auth.*, telemetry:*, installation_id) are NOT
// listed here; their callers pass { allowProtected: true } explicitly.
const USER_SETTABLE_KEYS: ReadonlySet<string> = new Set([
	"theme",
	"sessionIdleTimeoutMinutes",
	"sessionEndTimeoutMinutes",
	"eventsRetentionDays",
]);

// Cache invalidation is implemented as a post-write hook keyed on prefix.
// Adding a new cache means adding one entry here — no churn through every
// settings call site. The AI feature-flag cache is the only consumer today;
// vectorSearch.* shares it because both flow through the same `isAiActive`
// path.
const CACHE_INVALIDATING_PREFIXES: Array<{ prefix: string; invalidate: (key: string) => void }> = [
	{ prefix: "ai.", invalidate: (k) => invalidateAiFlagsCache(k) },
	{ prefix: "vectorSearch.", invalidate: (k) => invalidateAiFlagsCache(k) },
];

export class ProtectedSettingError extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`Setting key '${key}' is not user-settable.`);
		this.name = "ProtectedSettingError";
		this.key = key;
	}
}

export interface UpsertSettingOptions {
	/**
	 * Trusted callers (e.g. handlers behind `requireAiBuild`, the
	 * auth bootstrap, telemetry) set this to write keys not in
	 * USER_SETTABLE_KEYS. External callers (PUT /api/v1/settings) must
	 * leave it unset so attempts to mutate internal keys throw a typed
	 * {@link ProtectedSettingError}.
	 */
	allowProtected?: boolean;
}

/**
 * Atomically upsert a key/value pair into the `settings` table. Used by
 * every settings-write code path so the allowlist + timestamp behavior
 * lives in exactly one place.
 *
 * After a successful write, any cache whose key-prefix matches gets
 * invalidated synchronously — keeps `ai.enabled`-style flips visible to
 * the next request without waiting for the TTL.
 */
export async function upsertSetting(
	key: string,
	value: unknown,
	opts: UpsertSettingOptions = {},
): Promise<void> {
	if (!opts.allowProtected && !USER_SETTABLE_KEYS.has(key)) {
		throw new ProtectedSettingError(key);
	}
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: now },
		});

	for (const { prefix, invalidate } of CACHE_INVALIDATING_PREFIXES) {
		if (key.startsWith(prefix)) invalidate(key);
	}
}
