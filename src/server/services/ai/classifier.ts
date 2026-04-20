import type { Session, SessionEvent } from "../../../shared/types.js";
import type { HitlRequestRecord } from "./hitl-service.js";

/**
 * Session intelligence classifier. Reads recent events, session metadata,
 * and open HITL state to produce a deterministic health assessment the
 * dashboard, inbox, and (optionally) the watcher runner can use.
 *
 * The classifier is advisory: it never mutates lifecycle state. Its only
 * output is a SessionIntelligence record the UI renders and the runner
 * optionally consumes via the `ai.classifierAffectsRunner` settings flag.
 */

export type HealthState = "healthy" | "blocked" | "stuck" | "risky" | "complete_candidate";

export type HealthReasonCode =
	| "working"
	| "recently_active"
	| "idle_with_progress"
	| "hitl_pending_long"
	| "supervisor_offline"
	| "repeated_tool_failure"
	| "repeated_control_action_failure"
	| "consecutive_ai_errors"
	| "assistant_complete_hint"
	| "idle_after_plan_complete"
	| "no_signal";

export interface SessionIntelligence {
	health: HealthState;
	reasonCode: HealthReasonCode;
	explanation: string;
	confidence: number;
	evidence: string[];
	updatedAt: string;
}

export interface ClassifierInput {
	session: Pick<
		Session,
		"sessionId" | "status" | "isWorking" | "currentTask" | "planSummary" | "lastActivityAt"
	>;
	recentEvents: SessionEvent[];
	openHitl?: HitlRequestRecord | null;
	supervisorConnected?: boolean;
	now?: Date;
	/** Consider HITL "blocked" after this many ms. Default: 10 minutes. */
	hitlBlockedAfterMs?: number;
	/** Consider session idle after this many ms. Default: 2 minutes. */
	idleAfterMs?: number;
}

const DEFAULT_HITL_BLOCKED_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;

const COMPLETE_HINTS = [
	"all tests pass",
	"all tests passing",
	"implementation complete",
	"ready for review",
	"done implementing",
	"task complete",
];

export function classifySession(input: ClassifierInput): SessionIntelligence {
	const now = input.now ?? new Date();
	const nowMs = now.getTime();
	const hitlBlockedMs = input.hitlBlockedAfterMs ?? DEFAULT_HITL_BLOCKED_MS;
	const idleMs = input.idleAfterMs ?? DEFAULT_IDLE_MS;

	const evidence: string[] = [];

	// 1. Blocked on human — HITL has been open long enough that this is
	// probably an operator oversight rather than expected review latency.
	if (input.openHitl) {
		const openedAt = parseTime(input.openHitl.createdAt);
		const age = nowMs - openedAt;
		evidence.push(`hitl_open_for_${Math.floor(age / 1000)}s`);
		if (age >= hitlBlockedMs) {
			return make(
				"blocked",
				"hitl_pending_long",
				`Open HITL request is ${humanizeMs(age)} old`,
				0.9,
				evidence,
				now,
			);
		}
	}

	// 2. Supervisor offline on a managed session — dispatch is blocked even
	// if the session is otherwise fine.
	if (input.supervisorConnected === false) {
		evidence.push("supervisor_offline");
		return make(
			"blocked",
			"supervisor_offline",
			"Managed session's supervisor is not connected",
			0.85,
			evidence,
			now,
		);
	}

	// 3. Repeated tool failures — the classic "stuck" pattern.
	const toolFailures = countToolFailures(input.recentEvents);
	if (toolFailures.total >= 3 && toolFailures.distinctTools <= 2) {
		evidence.push(`${toolFailures.total}_tool_failures_across_${toolFailures.distinctTools}_tools`);
		return make(
			"stuck",
			"repeated_tool_failure",
			`${toolFailures.total} recent tool failures on ${toolFailures.distinctTools} tool(s)`,
			0.8,
			evidence,
			now,
		);
	}

	// 4. Consecutive AI errors — provider trouble, parse failures, etc.
	const aiErrors = countRecentAiErrors(input.recentEvents);
	if (aiErrors >= 3) {
		evidence.push(`${aiErrors}_consecutive_ai_errors`);
		return make(
			"risky",
			"consecutive_ai_errors",
			`${aiErrors} consecutive AI errors in recent history`,
			0.75,
			evidence,
			now,
		);
	}

	// 5. Repeated control-action failures — the managed equivalent of (3).
	const controlFailures = countControlActionFailures(input.recentEvents);
	if (controlFailures >= 2) {
		evidence.push(`${controlFailures}_control_action_failures`);
		return make(
			"risky",
			"repeated_control_action_failure",
			`${controlFailures} recent managed control-action failures`,
			0.7,
			evidence,
			now,
		);
	}

	// 6. Complete-candidate — assistant reported a "done" hint and no
	// further activity landed.
	const completeHint = findCompleteHint(input.recentEvents);
	const lastActivityAge = nowMs - parseTime(input.session.lastActivityAt);
	if (completeHint && lastActivityAge >= idleMs && !input.session.isWorking) {
		evidence.push(`assistant_hint: ${completeHint}`);
		return make(
			"complete_candidate",
			"assistant_complete_hint",
			`Assistant signaled completion ("${completeHint}") and session is idle`,
			0.6,
			evidence,
			now,
		);
	}

	// 7. Plan completed + no further work — second complete-candidate
	// shape, separate reason code so operators can distinguish.
	const hasPlanCompletion = input.recentEvents.some(
		(e) => e.category === "plan_update" && /complete|all items done/i.test(e.content ?? ""),
	);
	if (hasPlanCompletion && !input.session.isWorking && lastActivityAge >= idleMs) {
		evidence.push("plan_completed");
		return make(
			"complete_candidate",
			"idle_after_plan_complete",
			"Plan completion signaled and session is idle",
			0.55,
			evidence,
			now,
		);
	}

	// 8. Actively working — nothing suspicious, evidence of progress.
	if (input.session.isWorking) {
		evidence.push("is_working");
		return make("healthy", "working", "Session is actively working", 0.7, evidence, now);
	}

	if (lastActivityAge < idleMs) {
		evidence.push(`recent_activity_${Math.floor(lastActivityAge / 1000)}s_ago`);
		return make(
			"healthy",
			"recently_active",
			"Session has had activity recently",
			0.6,
			evidence,
			now,
		);
	}

	if ((input.session.planSummary?.length ?? 0) > 0) {
		evidence.push("has_plan_summary");
		return make(
			"healthy",
			"idle_with_progress",
			"Session is idle but has an established plan",
			0.45,
			evidence,
			now,
		);
	}

	return make("healthy", "no_signal", "No classification signal available", 0.3, evidence, now);
}

// -- Helpers ------------------------------------------------------------

function make(
	health: HealthState,
	reasonCode: HealthReasonCode,
	explanation: string,
	confidence: number,
	evidence: string[],
	now: Date,
): SessionIntelligence {
	return { health, reasonCode, explanation, confidence, evidence, updatedAt: now.toISOString() };
}

function parseTime(value: string): number {
	if (!value) return 0;
	if (value.includes("T")) return new Date(value).getTime();
	return new Date(`${value.replace(" ", "T")}Z`).getTime();
}

function humanizeMs(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h`;
}

function countToolFailures(events: SessionEvent[]): { total: number; distinctTools: number } {
	const failures = events.filter((e) => isToolFailure(e));
	const tools = new Set(failures.map((e) => e.toolName ?? "unknown"));
	return { total: failures.length, distinctTools: tools.size };
}

function isToolFailure(event: SessionEvent): boolean {
	if (event.category !== "tool_event") return false;
	if (!event.toolResponse) return false;
	const text = event.toolResponse.toLowerCase();
	return (
		text.includes("error") ||
		text.includes("failed") ||
		text.includes("exception") ||
		text.includes("non-zero exit")
	);
}

function countRecentAiErrors(events: SessionEvent[]): number {
	// Count consecutive ai_error events from the tail.
	let count = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.category === "ai_error") count++;
		else if (e.category?.startsWith("ai_")) continue;
		else break;
	}
	return count;
}

function countControlActionFailures(events: SessionEvent[]): number {
	return events.filter(
		(e) =>
			e.source === "managed_control" &&
			(e.content?.toLowerCase().includes("failed") || /failure/i.test(e.eventType ?? "")),
	).length;
}

function findCompleteHint(events: SessionEvent[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.category !== "assistant_message") continue;
		const content = (e.content ?? "").toLowerCase();
		for (const hint of COMPLETE_HINTS) {
			if (content.includes(hint)) return hint;
		}
	}
	return null;
}
