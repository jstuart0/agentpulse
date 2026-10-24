import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { TtlCache } from "../util/ttl-cache.js";

// Runtime setting key for the AI watcher's runtime toggle. The build-time
// flag (config.aiEnabled) must also be true for the feature to run.
export const AI_RUNTIME_ENABLED_KEY = "ai.enabled";
export const AI_KILL_SWITCH_KEY = "ai.killSwitch"; // true = paused
// Phase 2: classifier flags. Classifier computation is cheap and safe to
// enable independently from the classifier's influence over the runner.
export const AI_CLASSIFIER_ENABLED_KEY = "ai.classifierEnabled";
export const AI_CLASSIFIER_AFFECTS_RUNNER_KEY = "ai.classifierAffectsRunner";
// When true, sessions launched by the Ask flow get a watcher row written
// at correlation time (enabled, ask_on_risk policy, default provider).
// Default true: if Ask launched the session, AI was already in the loop.
export const AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY = "ai.autoEnableWatcherForAsk";
// Optional provider id for the small, latency-sensitive calls (see
// fast-provider.ts). Unset or empty means the default provider.
export const AI_FAST_PROVIDER_ID_KEY = "ai.fastProviderId";
// What a newly created watcher config starts with when the creator names no
// modes: {notify: boolean, continue: boolean}. Existing configs are untouched.
export const AI_WATCHER_DEFAULTS_KEY = "ai.watcherDefaults";
// While true (and while unset), the `auto` policy never sends: it opens a
// HITL instead. Human approvals are unaffected.
export const AI_WATCHER_AUTO_SEND_PAUSED_KEY = "ai.watcherAutoSendPaused";

export interface WatcherDefaults {
	notify: boolean;
	continue: boolean;
}

/** What a new watcher starts with when nothing is stored: report to me, don't type for me. */
export const SHIPPED_WATCHER_DEFAULTS: WatcherDefaults = { notify: true, continue: false };

// All AI feature-flag reads share one cache. Keying by settings-row key keeps
// the helper generic and lets `invalidateAiFlagsCache(key)` target a single
// flag when we know which one moved (e.g. via the settings-service write
// hook). 5 seconds is short enough that operator flips propagate fast and
// long enough to absorb the burst of `requireAiActive(c)` calls every AI
// mutation endpoint and the alert-rule sweep loop trigger.
//
// The cache stores the raw `settings.value` JSON blob (or `undefined` for an
// absent row) — each reader applies its own default-on/default-off rule.
const AI_FLAGS_TTL_MS = 5_000;
const aiFlagsCache = new TtlCache<string, unknown>(AI_FLAGS_TTL_MS);

async function readSettingValue(key: string): Promise<unknown> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
	return row?.value;
}

async function getCachedFlag(key: string): Promise<unknown> {
	return aiFlagsCache.getOrLoad(key, () => readSettingValue(key));
}

/**
 * Drop the cached value(s). Called from settings-service after any write
 * to a key whose prefix is `ai.` or `vectorSearch.` so subsequent reads
 * see the new value within one round-trip rather than waiting for the
 * TTL to expire.
 */
export function invalidateAiFlagsCache(key?: string): void {
	if (key === undefined) {
		aiFlagsCache.invalidate();
	} else {
		aiFlagsCache.invalidate(key);
	}
}

/** The provider chosen for small calls, or null for "use the default". */
export async function getFastProviderId(): Promise<string | null> {
	const value = await getCachedFlag(AI_FAST_PROVIDER_ID_KEY);
	return typeof value === "string" && value !== "" ? value : null;
}

/** Is the AI feature compiled into this build (and secrets configured)? */
export function isAiBuildEnabled(): boolean {
	return config.aiEnabled && config.secretsKey.length > 0;
}

/** Read the runtime toggle value from settings. */
export async function isAiRuntimeEnabled(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	return (await getCachedFlag(AI_RUNTIME_ENABLED_KEY)) === true;
}

/**
 * The kill switch from a stored value, failing closed: an absent row is "not
 * killed" (today's default), but a value that is neither true nor false (a
 * corrupted write) counts as killed rather than as "not killed".
 */
export function interpretKillSwitch(value: unknown): boolean {
	if (value === undefined || value === false) return false;
	return true;
}

/** Auto-send pause from a stored value: only an explicit `false` un-pauses it. */
export function interpretAutoSendPaused(value: unknown): boolean {
	return value !== false;
}

/** A settings read through some handle: the value (undefined for no row), or unreadable. */
export type AiFlagRead = { ok: true; value: unknown } | { ok: false };

/**
 * Reads one flag straight from the settings table through `db` (a transaction
 * handle inside a dispatch), bypassing the cache so a kill can't be delayed by
 * its TTL or by the invalidate-during-load race. An unreadable value is
 * reported as such so the caller can fail closed.
 */
export async function readAiFlagUncached(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	key: string,
): Promise<AiFlagRead> {
	try {
		const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
		return { ok: true, value: row?.value };
	} catch {
		return { ok: false };
	}
}

async function readCachedFlagOrUnreadable(key: string): Promise<AiFlagRead> {
	try {
		return { ok: true, value: await getCachedFlag(key) };
	} catch {
		return { ok: false };
	}
}

/** Is the global kill switch active? When true, AI behavior is paused. */
export async function isKillSwitchActive(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	const read = await readCachedFlagOrUnreadable(AI_KILL_SWITCH_KEY);
	return read.ok ? interpretKillSwitch(read.value) : true;
}

/** Is automatic prompt sending paused? Unset, non-boolean and unreadable all read as paused. */
export async function isWatcherAutoSendPaused(): Promise<boolean> {
	const read = await readCachedFlagOrUnreadable(AI_WATCHER_AUTO_SEND_PAUSED_KEY);
	return read.ok ? interpretAutoSendPaused(read.value) : true;
}

/** The stored watcher defaults, or the shipped ones when the value is absent or malformed. */
export function interpretWatcherDefaults(value: unknown): WatcherDefaults {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const candidate = value as Record<string, unknown>;
		const keys = Object.keys(candidate);
		if (
			keys.length === 2 &&
			typeof candidate.notify === "boolean" &&
			typeof candidate.continue === "boolean"
		) {
			return { notify: candidate.notify, continue: candidate.continue };
		}
	}
	return { ...SHIPPED_WATCHER_DEFAULTS };
}

export async function getWatcherDefaults(): Promise<WatcherDefaults> {
	const read = await readCachedFlagOrUnreadable(AI_WATCHER_DEFAULTS_KEY);
	return read.ok ? interpretWatcherDefaults(read.value) : { ...SHIPPED_WATCHER_DEFAULTS };
}

/** Is the AI feature both built-in AND runtime-enabled AND not paused? */
export async function isAiActive(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	if (!(await isAiRuntimeEnabled())) return false;
	if (await isKillSwitchActive()) return false;
	return true;
}

/**
 * Vector-search opt-in. Three-tier gate, mirroring the AI watcher pattern:
 *   1. Build flag — config.vectorSearchEnabled (env AGENTPULSE_VECTOR_SEARCH).
 *      When false, no embeddings table, no UI, no embed calls.
 *   2. AI feature must be active (provider configured / runtime on).
 *   3. Settings toggle — `vectorSearch.enabled`.
 */
export const VECTOR_SEARCH_ENABLED_KEY = "vectorSearch.enabled";
export const VECTOR_SEARCH_MODEL_KEY = "vectorSearch.model";
export const VECTOR_SEARCH_PROVIDER_ID_KEY = "vectorSearch.providerId";

/** Default embedding model — best balance of quality vs. embed-time on a
 *  Mac Studio. mxbai-embed-large is top-5 MTEB English in its weight class. */
export const DEFAULT_EMBEDDING_MODEL = "mxbai-embed-large";

export function isVectorSearchBuildEnabled(): boolean {
	return config.vectorSearchEnabled;
}

export async function isVectorSearchActive(): Promise<boolean> {
	if (!isVectorSearchBuildEnabled()) return false;
	if (!(await isAiActive())) return false;
	return (await getCachedFlag(VECTOR_SEARCH_ENABLED_KEY)) === true;
}

/** Read the classifier runtime toggle. Default: true (badges are cheap). */
export async function isClassifierEnabled(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	// Absent setting defaults to true so new installs get UI badges.
	return (await getCachedFlag(AI_CLASSIFIER_ENABLED_KEY)) !== false;
}

/** Should Ask-initiated sessions auto-enable a watcher? Default: true. */
export async function shouldAutoEnableWatcherForAsk(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	// Absent setting defaults to true — if Ask launched it, we watch it.
	return (await getCachedFlag(AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY)) !== false;
}

/** Does classifier output influence runner decisions? Default: false. */
export async function classifierAffectsRunner(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	return (await getCachedFlag(AI_CLASSIFIER_AFFECTS_RUNNER_KEY)) === true;
}

/** Startup validation — fail-fast if AI is enabled without a secrets key. */
export function validateAiStartupConfig(): void {
	if (!config.aiEnabled) return;
	if (!config.secretsKey) {
		throw new Error(
			"AGENTPULSE_AI_ENABLED=true requires AGENTPULSE_SECRETS_KEY to be set " +
				"(a 32+ character random string used to encrypt provider credentials).",
		);
	}
	if (config.secretsKey.length < 32) {
		throw new Error(
			"AGENTPULSE_SECRETS_KEY must be at least 32 characters for AES-256-GCM key derivation.",
		);
	}
}
