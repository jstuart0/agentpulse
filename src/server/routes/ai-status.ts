import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthUser } from "../auth/middleware.js";
import { getRequestActor, isHumanCaller, refuseBadOrigin } from "../auth/route-scope-policy.js";
import {
	AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY,
	AI_CLASSIFIER_AFFECTS_RUNNER_KEY,
	AI_CLASSIFIER_ENABLED_KEY,
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	AI_WATCHER_AUTO_SEND_PAUSED_KEY,
	AI_WATCHER_DEFAULTS_KEY,
	type WatcherDefaults,
	classifierAffectsRunner,
	getWatcherDefaults,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
	isWatcherAutoSendPaused,
	shouldAutoEnableWatcherForAsk,
} from "../services/ai/feature.js";
import { logAdminAction } from "../services/audit-log.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiBuild } from "./ai-gates.js";

const aiStatusRouter = new Hono();

// Shared helper: write a protected setting (AI control-plane keys) without
// requiring callers to repeat the options bag at every call site.
const upsert = (key: string, value: unknown) => upsertSetting(key, value, { allowProtected: true });

/** The boolean switches, by request field. */
const BOOLEAN_FIELDS = {
	enabled: AI_RUNTIME_ENABLED_KEY,
	killSwitch: AI_KILL_SWITCH_KEY,
	classifierEnabled: AI_CLASSIFIER_ENABLED_KEY,
	classifierAffectsRunner: AI_CLASSIFIER_AFFECTS_RUNNER_KEY,
	autoEnableWatcherForAsk: AI_AUTO_ENABLE_WATCHER_FOR_ASK_KEY,
	watcherAutoSendPaused: AI_WATCHER_AUTO_SEND_PAUSED_KEY,
} as const;
type BooleanField = keyof typeof BOOLEAN_FIELDS;

// Fields where turning the safeguard OFF is something only a person at the
// dashboard may do. Turning it on is open to any caller the route admits.
const HUMAN_TO_CLEAR: ReadonlySet<BooleanField> = new Set(["killSwitch", "watcherAutoSendPaused"]);

async function currentStatus() {
	return {
		build: isAiBuildEnabled(),
		runtime: await isAiRuntimeEnabled(),
		killSwitch: await isKillSwitchActive(),
		active: await isAiActive(),
		classifierEnabled: await isClassifierEnabled(),
		classifierAffectsRunner: await classifierAffectsRunner(),
		autoEnableWatcherForAsk: await shouldAutoEnableWatcherForAsk(),
		watcherDefaults: await getWatcherDefaults(),
		watcherAutoSendPaused: await isWatcherAutoSendPaused(),
	};
}

type Status = Awaited<ReturnType<typeof currentStatus>>;

/** The effective value of each switch, as the dashboard would show it. */
function effectiveValue(field: BooleanField, status: Status): boolean {
	switch (field) {
		case "enabled":
			return status.runtime;
		case "killSwitch":
			return status.killSwitch;
		case "classifierEnabled":
			return status.classifierEnabled;
		case "classifierAffectsRunner":
			return status.classifierAffectsRunner;
		case "autoEnableWatcherForAsk":
			return status.autoEnableWatcherForAsk;
		case "watcherAutoSendPaused":
			return status.watcherAutoSendPaused;
	}
}

function isWatcherDefaults(value: unknown): value is WatcherDefaults {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	const candidate = value as Record<string, unknown>;
	return (
		keys.length === 2 &&
		typeof candidate.notify === "boolean" &&
		typeof candidate.continue === "boolean"
	);
}

type StatusParse =
	| { ok: true; booleans: Array<[BooleanField, boolean]>; watcherDefaults?: WatcherDefaults }
	| { ok: false; error: "invalid_body" | "unknown_field"; field?: string };

/** Every field is checked before any is written, so a bad request changes nothing. */
function parseStatusBody(body: unknown): StatusParse {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "invalid_body" };
	}
	const record = body as Record<string, unknown>;
	const booleans: Array<[BooleanField, boolean]> = [];
	let watcherDefaults: WatcherDefaults | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;
		if (key === "watcherDefaults") {
			if (!isWatcherDefaults(value)) return { ok: false, error: "invalid_body", field: key };
			watcherDefaults = { notify: value.notify, continue: value.continue };
		} else if (key in BOOLEAN_FIELDS) {
			if (typeof value !== "boolean") return { ok: false, error: "invalid_body", field: key };
			booleans.push([key as BooleanField, value]);
		} else {
			return { ok: false, error: "unknown_field", field: key };
		}
	}
	return { ok: true, booleans, watcherDefaults };
}

function authUserOf(c: Context): AuthUser | undefined {
	return c.get("authUser") as AuthUser | undefined;
}

// --------------------------------------------------------------------------
// Feature status (always available, so UI can decide whether to show AI)
// --------------------------------------------------------------------------

aiStatusRouter.get("/ai/status", async (c) => {
	return c.json(await currentStatus());
});

aiStatusRouter.put("/ai/status", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "invalid_body" }, 400);
	}
	const parsed = parseStatusBody(raw);
	if (!parsed.ok) {
		return c.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, 400);
	}

	const before = await currentStatus();
	const authUser = authUserOf(c);
	for (const [field, value] of parsed.booleans) {
		if (HUMAN_TO_CLEAR.has(field) && value === false && effectiveValue(field, before)) {
			if (!(authUser && isHumanCaller(authUser))) {
				return c.json({ error: "human_required", field }, 403);
			}
		}
	}

	const actor = await getRequestActor(c);
	for (const [field, value] of parsed.booleans) {
		const was = effectiveValue(field, before);
		await upsert(BOOLEAN_FIELDS[field], value);
		if (was !== value) {
			logAdminAction("ai_config_changed", actor, {
				key: BOOLEAN_FIELDS[field],
				before: was,
				after: value,
			});
		}
	}
	if (parsed.watcherDefaults) {
		await upsert(AI_WATCHER_DEFAULTS_KEY, parsed.watcherDefaults);
		logAdminAction("ai_config_changed", actor, {
			key: AI_WATCHER_DEFAULTS_KEY,
			before: before.watcherDefaults,
			after: parsed.watcherDefaults,
		});
	}

	return c.json(await currentStatus());
});

export default aiStatusRouter;
