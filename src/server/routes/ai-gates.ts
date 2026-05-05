import type { Context } from "hono";
import {
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isKillSwitchActive,
} from "../services/ai/feature.js";

/**
 * Gate: reject requests when the AI build flag is off (feature not compiled in).
 * Returns a Response when the gate fires, null when the caller may proceed.
 */
export async function requireAiBuild(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled", message: "AI feature not compiled in" }, 404);
	}
	return null;
}

/**
 * Gate: reject requests when AI is disabled at runtime or the kill switch is active.
 * Implicitly also checks the build flag (build flag off → runtime is never enabled).
 * Returns a Response when the gate fires, null when the caller may proceed.
 */
export async function requireAiActive(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled", message: "AI feature not compiled in" }, 404);
	}
	if (!(await isAiRuntimeEnabled())) {
		return c.json(
			{ error: "ai_disabled", message: "AI feature disabled. Enable in Settings." },
			409,
		);
	}
	if (await isKillSwitchActive()) {
		return c.json(
			{ error: "ai_paused", message: "All watchers are paused via the kill switch." },
			409,
		);
	}
	return null;
}
