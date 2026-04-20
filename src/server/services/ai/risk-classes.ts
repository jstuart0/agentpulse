import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

/**
 * Phase 7 risk class configuration. The watcher consults this list at
 * wake time when the user's policy is `ask_on_risk` — any matching class
 * flips the decision to a HITL request rather than auto-dispatch. The
 * list is product-versioned settings, NOT model-authored: model reasoning
 * must stay inside the envelope defined here.
 */

export const AI_RISK_CLASSES_KEY = "ai.riskClasses";

export type RiskMatchRule =
	| { type: "regex"; pattern: string; flags?: string }
	| { type: "heuristic"; rule: "test_failure_last_5" | "recent_control_failure" };

export type RiskPolicyOverride = "ask" | "stop";

export interface RiskClass {
	id: string;
	label: string;
	match: RiskMatchRule;
	policyOverride: RiskPolicyOverride;
}

export interface RiskClassesConfig {
	version: number;
	classes: RiskClass[];
}

const DEFAULT_CONFIG: RiskClassesConfig = {
	version: 1,
	classes: [
		{
			id: "destructive_command",
			label: "Destructive command pattern",
			match: { type: "regex", pattern: "rm -rf|git push -f|git reset --hard" },
			policyOverride: "ask",
		},
		{
			id: "credential_touch",
			label: "Credential or secret reference",
			match: {
				type: "regex",
				pattern: "\\b(api[_-]?key|secret|password|token)\\b",
				flags: "i",
			},
			policyOverride: "ask",
		},
		{
			id: "test_failure_recent",
			label: "Recent test failures",
			match: { type: "heuristic", rule: "test_failure_last_5" },
			policyOverride: "ask",
		},
	],
};

export async function getRiskClasses(): Promise<RiskClassesConfig> {
	const [row] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, AI_RISK_CLASSES_KEY))
		.limit(1);
	if (!row) return DEFAULT_CONFIG;
	const value = row.value as RiskClassesConfig | undefined;
	if (!value || !Array.isArray(value.classes)) return DEFAULT_CONFIG;
	return value;
}

export async function setRiskClasses(config: RiskClassesConfig): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ key: AI_RISK_CLASSES_KEY, value: config, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: config, updatedAt: now },
		});
}

export interface RiskEvaluationInput {
	proposedPrompt: string | null;
	recentToolEvents?: Array<{
		category: string | null;
		toolResponse: string | null;
		source: string;
		eventType: string;
	}>;
}

export interface RiskHit {
	classId: string;
	label: string;
	policyOverride: RiskPolicyOverride;
	reason: string;
}

/**
 * Evaluate a proposed prompt + recent event context against the configured
 * risk classes. Returns all hits; the runner decides what to do based on
 * the user's policy.
 */
export function evaluateRisk(config: RiskClassesConfig, input: RiskEvaluationInput): RiskHit[] {
	const hits: RiskHit[] = [];
	for (const cls of config.classes) {
		const hit = evaluateOne(cls, input);
		if (hit) hits.push(hit);
	}
	return hits;
}

function evaluateOne(cls: RiskClass, input: RiskEvaluationInput): RiskHit | null {
	if (cls.match.type === "regex") {
		if (!input.proposedPrompt) return null;
		try {
			const re = new RegExp(cls.match.pattern, cls.match.flags ?? "");
			if (re.test(input.proposedPrompt)) {
				return {
					classId: cls.id,
					label: cls.label,
					policyOverride: cls.policyOverride,
					reason: `Prompt matched ${cls.id}`,
				};
			}
		} catch {
			// Bad regex in settings — silently skip that class.
		}
		return null;
	}
	if (cls.match.type === "heuristic") {
		if (cls.match.rule === "test_failure_last_5") {
			const last = (input.recentToolEvents ?? []).slice(-5);
			const failed = last.filter(
				(e) =>
					e.category === "tool_event" &&
					!!e.toolResponse &&
					/fail|error|exit [1-9]/i.test(e.toolResponse),
			);
			if (failed.length >= 2) {
				return {
					classId: cls.id,
					label: cls.label,
					policyOverride: cls.policyOverride,
					reason: `${failed.length} test failures in last 5 tool events`,
				};
			}
		}
		if (cls.match.rule === "recent_control_failure") {
			const control = (input.recentToolEvents ?? []).filter(
				(e) => e.source === "managed_control" && /failure/i.test(e.eventType),
			);
			if (control.length >= 1) {
				return {
					classId: cls.id,
					label: cls.label,
					policyOverride: cls.policyOverride,
					reason: "Recent managed control-action failure",
				};
			}
		}
	}
	return null;
}
