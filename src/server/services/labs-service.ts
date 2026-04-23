import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";

/**
 * Labs flag registry. Every AI / experimental surface gets its own
 * boolean here so a feature can be graduated individually (flip default
 * to true in the registry, strip the Labs badge in the UI) without
 * touching a master gate.
 *
 * Default values reflect what is currently shipped for existing users —
 * turning on Labs today should not regress visible surfaces. New
 * never-shipped experimental features land with default false.
 */

export const LABS_SETTINGS_KEY = "labs";

export interface LabsFlagDefinition {
	key: LabsFlag;
	label: string;
	description: string;
	defaultEnabled: boolean;
}

export type LabsFlag =
	| "inbox"
	| "digest"
	| "aiSessionTab"
	| "intelligenceBadges"
	| "aiSettingsPanel"
	| "templateDistillation"
	| "launchRecommendation"
	| "riskClasses"
	| "telegramChannel"
	| "askAssistant";

export const LABS_REGISTRY: readonly LabsFlagDefinition[] = [
	{
		key: "inbox",
		label: "Operator inbox",
		description: "Consolidated HITL / stuck / risky / failed-proposal queue at /inbox.",
		defaultEnabled: true,
	},
	{
		key: "digest",
		label: "Project digest",
		description: "Daily per-repo roll-up at /digest.",
		defaultEnabled: true,
	},
	{
		key: "aiSessionTab",
		label: "AI tab in session detail",
		description: "Per-session watcher config + HITL panel.",
		defaultEnabled: true,
	},
	{
		key: "intelligenceBadges",
		label: "Session intelligence badges",
		description: "Health chip (healthy / stuck / risky / blocked / done?) on dashboard cards.",
		defaultEnabled: true,
	},
	{
		key: "aiSettingsPanel",
		label: "AI settings panel",
		description: "Provider CRUD, redactor preview, spend, classifier flags in Settings.",
		defaultEnabled: true,
	},
	{
		key: "templateDistillation",
		label: "Template distillation",
		description: "Generate reviewable template drafts from successful sessions (API only).",
		defaultEnabled: false,
	},
	{
		key: "launchRecommendation",
		label: "Launch recommendation",
		description: "AI-assisted agent/model/host recommendation on launch preview (API only).",
		defaultEnabled: false,
	},
	{
		key: "riskClasses",
		label: "Risk classes + ask_on_risk policy",
		description: "Configurable risk-class evaluation for auto/ask_on_risk policies (API only).",
		defaultEnabled: false,
	},
	{
		key: "telegramChannel",
		label: "Telegram HITL channel",
		description:
			"Deliver HITL requests to a Telegram chat with inline Approve / Decline buttons. Requires TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET.",
		defaultEnabled: false,
	},
	{
		key: "askAssistant",
		label: "Ask assistant",
		description:
			"Global chat that answers questions about your running sessions. Uses the default LLM provider configured in AI settings.",
		defaultEnabled: false,
	},
] as const;

export type LabsFlags = Record<LabsFlag, boolean>;

export function defaultLabsFlags(): LabsFlags {
	const out = {} as LabsFlags;
	for (const def of LABS_REGISTRY) {
		out[def.key] = def.defaultEnabled;
	}
	return out;
}

export async function getLabsFlags(): Promise<LabsFlags> {
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, LABS_SETTINGS_KEY))
		.limit(1);
	const defaults = defaultLabsFlags();
	if (!row || !row.value || typeof row.value !== "object") return defaults;
	const stored = row.value as Partial<LabsFlags>;
	// Merge so a newly-added feature flag picks up its default instead
	// of being missing from a pre-existing settings row.
	return { ...defaults, ...stored };
}

export async function isLabsFlagEnabled(flag: LabsFlag): Promise<boolean> {
	const flags = await getLabsFlags();
	return flags[flag];
}

export async function setLabsFlag(flag: LabsFlag, enabled: boolean): Promise<LabsFlags> {
	const current = await getLabsFlags();
	const next = { ...current, [flag]: enabled };
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key: LABS_SETTINGS_KEY, value: next, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: next, updatedAt: now },
		});
	return next;
}
