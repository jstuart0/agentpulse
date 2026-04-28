import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { invalidateAiFlagsCache } from "./ai/feature.js";

/**
 * Keys whose semantics belong to internal subsystems (AI control plane,
 * vector search, secret credentials). The generic `PUT /settings` endpoint
 * is exposed to any authenticated dashboard user and previously had no
 * key namespacing — a caller who knew the internal key names could flip
 * `ai.enabled`, `ai.killSwitch`, vector-search flags, or overwrite
 * `telegram:credentials`, bypassing the AI build-gate that the dedicated
 * `PUT /ai/status` and credential-management endpoints enforce.
 *
 * Trusted call sites (the AI router, telegram credential service) pass
 * `{ allowProtected: true }` so they can still mutate these keys.
 */
const PROTECTED_KEY_PREFIXES = ["ai.", "vectorSearch."] as const;
const PROTECTED_EXACT_KEYS = new Set<string>(["telegram:credentials"]);

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
		super(`Setting key '${key}' is reserved for internal use.`);
		this.name = "ProtectedSettingError";
		this.key = key;
	}
}

export function isProtectedSettingKey(key: string): boolean {
	if (PROTECTED_EXACT_KEYS.has(key)) return true;
	for (const prefix of PROTECTED_KEY_PREFIXES) {
		if (key.startsWith(prefix)) return true;
	}
	return false;
}

export interface UpsertSettingOptions {
	/**
	 * Trusted callers (e.g. handlers behind `requireAiBuild`) set this to
	 * write keys covered by the protected denylist. External callers must
	 * leave it unset so attempts to mutate internal keys throw a typed
	 * {@link ProtectedSettingError}.
	 */
	allowProtected?: boolean;
}

/**
 * Atomically upsert a key/value pair into the `settings` table. Used by
 * every settings-write code path so the denylist + timestamp behavior
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
	if (!opts.allowProtected && isProtectedSettingKey(key)) {
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
