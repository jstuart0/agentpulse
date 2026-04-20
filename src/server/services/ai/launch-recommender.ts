import { desc, eq } from "drizzle-orm";
import type { AgentType, LaunchMode, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessions, supervisors } from "../../db/schema.js";

/**
 * Launch recommendation service. Advisory only: produces a
 * RecommendedLaunch object the launch preview can show alongside the
 * user's chosen values. Recommendations are never silently applied —
 * the existing launch validator remains the resolver of record.
 */

export interface RecommendedLaunch {
	agentType: AgentType;
	model: string | null;
	launchMode: LaunchMode;
	suggestedSupervisorId: string | null;
	suggestedSupervisorHost: string | null;
	rationale: string[];
	warnings: string[];
	alternatives: Array<{
		agentType?: AgentType;
		model?: string | null;
		launchMode?: LaunchMode;
		reason: string;
	}>;
	confidence: number;
}

export interface RecommenderInput {
	template: SessionTemplateInput;
	preferredSupervisorId?: string | null;
	now?: Date;
}

export async function recommendLaunch(input: RecommenderInput): Promise<RecommendedLaunch> {
	const _now = input.now ?? new Date();
	const rationale: string[] = [];
	const warnings: string[] = [];
	const alternatives: RecommendedLaunch["alternatives"] = [];

	// Default the template's own choices.
	const agentType = input.template.agentType;
	const model: string | null = input.template.model ?? null;
	const launchMode: LaunchMode = "interactive_terminal";

	// 1. Learn from prior sessions at the same cwd. Which agent + model
	// completed recently? That is the strongest signal we have.
	const cwd = input.template.cwd;
	const priorAtCwd = cwd
		? await db
				.select()
				.from(sessions)
				.where(eq(sessions.cwd, cwd))
				.orderBy(desc(sessions.lastActivityAt))
				.limit(20)
		: [];

	const completedAtCwd = priorAtCwd.filter((s) => s.status === "completed");
	if (completedAtCwd.length > 0) {
		// Pick the most common (agentType, model) pair.
		const score = new Map<string, { agent: AgentType; model: string | null; count: number }>();
		for (const s of completedAtCwd) {
			const key = `${s.agentType}|${s.model ?? ""}`;
			const cur = score.get(key) ?? {
				agent: s.agentType as AgentType,
				model: s.model ?? null,
				count: 0,
			};
			cur.count++;
			score.set(key, cur);
		}
		const best = Array.from(score.values()).sort((a, b) => b.count - a.count)[0];
		if (best) {
			if (best.agent !== agentType) {
				alternatives.push({
					agentType: best.agent,
					reason: `Past completions at this cwd favored ${best.agent}`,
				});
			} else {
				rationale.push(
					`Same agentType (${best.agent}) completed ${best.count} prior session(s) at this cwd`,
				);
			}
			if (best.model && best.model !== model) {
				alternatives.push({
					model: best.model,
					reason: `${best.count} successful run(s) used model ${best.model} here`,
				});
			} else if (best.model) {
				rationale.push(`Model ${best.model} has prior success at this cwd`);
			}
		}
	} else if (priorAtCwd.length > 0) {
		warnings.push(
			`Prior sessions at this cwd exist but none completed — tune template before dispatch`,
		);
	} else if (cwd) {
		rationale.push(`No prior sessions at ${cwd} — starting with template defaults`);
	}

	// 2. Supervisor capability check. Prefer a connected supervisor that
	// claims the requested agent. The launch validator will re-resolve
	// authoritatively — we just surface a suggestion.
	const live = await db.select().from(supervisors).where(eq(supervisors.status, "connected"));
	let suggested: (typeof live)[number] | null = null;
	if (input.preferredSupervisorId) {
		suggested = live.find((s) => s.id === input.preferredSupervisorId) ?? null;
		if (!suggested) {
			warnings.push(
				`Preferred supervisor ${input.preferredSupervisorId} not connected; falling back to first capable`,
			);
		}
	}
	if (!suggested) {
		for (const s of live) {
			const caps = s.capabilities as {
				agentTypes?: AgentType[];
				launchModes?: LaunchMode[];
			};
			if (caps.agentTypes?.includes(agentType)) {
				suggested = s;
				break;
			}
		}
	}

	if (suggested) {
		rationale.push(`Host ${suggested.hostName} is connected and claims ${agentType}`);
		const caps = suggested.capabilities as {
			agentTypes?: AgentType[];
			launchModes?: LaunchMode[];
		};
		if (caps.launchModes?.includes("headless")) {
			alternatives.push({
				launchMode: "headless",
				reason: `${suggested.hostName} supports headless mode`,
			});
		}
	} else {
		warnings.push("No connected supervisor advertises support for this agent type");
	}

	// 3. Confidence derivation. Lots of prior completions + a host match
	// → high confidence. No host match → low.
	let confidence = 0.3;
	if (completedAtCwd.length >= 3) confidence += 0.3;
	else if (completedAtCwd.length >= 1) confidence += 0.15;
	if (suggested) confidence += 0.25;
	confidence = Math.min(1, Math.round(confidence * 100) / 100);

	return {
		agentType,
		model,
		launchMode,
		suggestedSupervisorId: suggested?.id ?? null,
		suggestedSupervisorHost: suggested?.hostName ?? null,
		rationale,
		warnings,
		alternatives,
		confidence,
	};
}
