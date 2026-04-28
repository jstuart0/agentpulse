import { isAiActive, shouldAutoEnableWatcherForAsk } from "./feature.js";
import { getDefaultProvider } from "./providers-service.js";
import { getWatcherConfig, upsertWatcherConfig } from "./watcher-config-service.js";

/**
 * Auto-enable an AI watcher on a freshly-correlated session if it was
 * launched from an Ask thread. Called from associateObservedSession after
 * provenance has been copied to sessions.metadata.
 *
 * The function is intentionally silent on every "skip" branch — auto-watcher
 * is a convenience, not a contract. A launch should never fail because we
 * couldn't attach a watcher.
 *
 * Skip conditions (in order of cheapest check):
 *   - launchMetadata?.aiInitiated !== true (not from Ask)
 *   - AI feature is not active (build off, runtime off, or kill switch)
 *   - the user opted out via the auto-enable setting
 *   - the session already has a watcher_configs row (don't clobber manual
 *     configuration on re-correlation)
 *   - no default provider configured (Ask wouldn't have worked either, but
 *     we double-check to avoid an FK error mid-launch)
 */
export async function applyAskInitiatedWatcher(
	sessionId: string,
	launchMetadata: Record<string, unknown> | null,
): Promise<void> {
	if (!launchMetadata) return;
	if (launchMetadata.aiInitiated !== true) return;

	if (!(await isAiActive())) return;
	if (!(await shouldAutoEnableWatcherForAsk())) return;

	const existing = await getWatcherConfig(sessionId);
	if (existing) return;

	const provider = await getDefaultProvider();
	if (!provider) return;

	await upsertWatcherConfig({
		sessionId,
		enabled: true,
		providerId: provider.id,
		policy: "ask_on_risk",
	});
}
