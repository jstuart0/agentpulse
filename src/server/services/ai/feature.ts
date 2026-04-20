import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";

// Runtime setting key for the AI watcher's runtime toggle. The build-time
// flag (config.aiEnabled) must also be true for the feature to run.
export const AI_RUNTIME_ENABLED_KEY = "ai.enabled";
export const AI_KILL_SWITCH_KEY = "ai.killSwitch"; // true = paused

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
