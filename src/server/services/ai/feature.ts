import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
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
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
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

/** Is the AI feature compiled into this build (and secrets configured)? */
export function isAiBuildEnabled(): boolean {
	return config.aiEnabled && config.secretsKey.length > 0;
}

/** Read the runtime toggle value from settings. */
export async function isAiRuntimeEnabled(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	return (await getCachedFlag(AI_RUNTIME_ENABLED_KEY)) === true;
}

/** Is the global kill switch active? When true, AI behavior is paused. */
export async function isKillSwitchActive(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	return (await getCachedFlag(AI_KILL_SWITCH_KEY)) === true;
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
