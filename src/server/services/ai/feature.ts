import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

// Runtime setting key for the AI watcher's runtime toggle. The build-time
// flag (config.aiEnabled) must also be true for the feature to run.
export const AI_RUNTIME_ENABLED_KEY = "ai.enabled";
export const AI_KILL_SWITCH_KEY = "ai.killSwitch"; // true = paused
// Phase 2: classifier flags. Classifier computation is cheap and safe to
// enable independently from the classifier's influence over the runner.
export const AI_CLASSIFIER_ENABLED_KEY = "ai.classifierEnabled";
export const AI_CLASSIFIER_AFFECTS_RUNNER_KEY = "ai.classifierAffectsRunner";

/** Is the AI feature compiled into this build (and secrets configured)? */
export function isAiBuildEnabled(): boolean {
	return config.aiEnabled && config.secretsKey.length > 0;
}

/** Read the runtime toggle value from settings. */
export async function isAiRuntimeEnabled(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, AI_RUNTIME_ENABLED_KEY))
		.limit(1);
	return row?.value === true;
}

/** Is the global kill switch active? When true, AI behavior is paused. */
export async function isKillSwitchActive(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, AI_KILL_SWITCH_KEY))
		.limit(1);
	return row?.value === true;
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
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, VECTOR_SEARCH_ENABLED_KEY))
		.limit(1);
	return row?.value === true;
}

/** Read the classifier runtime toggle. Default: true (badges are cheap). */
export async function isClassifierEnabled(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, AI_CLASSIFIER_ENABLED_KEY))
		.limit(1);
	// Absent setting defaults to true so new installs get UI badges.
	return row?.value !== false;
}

/** Does classifier output influence runner decisions? Default: false. */
export async function classifierAffectsRunner(): Promise<boolean> {
	if (!isAiBuildEnabled()) return false;
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, AI_CLASSIFIER_AFFECTS_RUNNER_KEY))
		.limit(1);
	return row?.value === true;
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
