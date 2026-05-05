import { Hono } from "hono";
import {
	AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY,
	AI_CLASSIFIER_AFFECTS_RUNNER_KEY,
	AI_CLASSIFIER_ENABLED_KEY,
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	classifierAffectsRunner,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
	shouldAutoEnableWatcherForAsk,
} from "../services/ai/feature.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiBuild } from "./ai-gates.js";

const aiStatusRouter = new Hono();

// Shared helper: write a protected setting (AI control-plane keys) without
// requiring callers to repeat the options bag at every call site.
const upsert = (key: string, value: unknown) => upsertSetting(key, value, { allowProtected: true });

// --------------------------------------------------------------------------
// Feature status (always available, so UI can decide whether to show AI)
// --------------------------------------------------------------------------

aiStatusRouter.get("/ai/status", async (c) => {
	const build = isAiBuildEnabled();
	const runtime = await isAiRuntimeEnabled();
	const killSwitch = await isKillSwitchActive();
	const active = await isAiActive();
	const classifierEnabled = await isClassifierEnabled();
	const classifierRunnerInput = await classifierAffectsRunner();
	const autoEnableWatcherForAsk = await shouldAutoEnableWatcherForAsk();
	return c.json({
		build,
		runtime,
		killSwitch,
		active,
		classifierEnabled,
		classifierAffectsRunner: classifierRunnerInput,
		autoEnableWatcherForAsk,
	});
});

aiStatusRouter.put("/ai/status", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{
		enabled?: boolean;
		killSwitch?: boolean;
		classifierEnabled?: boolean;
		classifierAffectsRunner?: boolean;
		autoEnableWatcherForAsk?: boolean;
	}>();

	if (body.enabled !== undefined) await upsert(AI_RUNTIME_ENABLED_KEY, body.enabled);
	if (body.killSwitch !== undefined) await upsert(AI_KILL_SWITCH_KEY, body.killSwitch);
	if (body.classifierEnabled !== undefined) {
		await upsert(AI_CLASSIFIER_ENABLED_KEY, body.classifierEnabled);
	}
	if (body.classifierAffectsRunner !== undefined) {
		await upsert(AI_CLASSIFIER_AFFECTS_RUNNER_KEY, body.classifierAffectsRunner);
	}
	if (body.autoEnableWatcherForAsk !== undefined) {
		await upsert(AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY, body.autoEnableWatcherForAsk);
	}

	return c.json({
		build: isAiBuildEnabled(),
		runtime: await isAiRuntimeEnabled(),
		killSwitch: await isKillSwitchActive(),
		active: await isAiActive(),
		classifierEnabled: await isClassifierEnabled(),
		classifierAffectsRunner: await classifierAffectsRunner(),
		autoEnableWatcherForAsk: await shouldAutoEnableWatcherForAsk(),
	});
});

export default aiStatusRouter;
