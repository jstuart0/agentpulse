import type { Session, SessionEvent } from "../../../shared/types.js";

export type WatcherEligibility =
	| { eligibleToContinue: true; eligibleToReport: true; reason: "managed_quiet" }
	| { eligibleToContinue: false; eligibleToReport: true; reason: "observed_only" }
	| { eligibleToContinue: false; eligibleToReport: true; reason: "recent_user_prompt_report_ok" }
	| { eligibleToContinue: false; eligibleToReport: true; reason: "recent_ai_continue_report_ok" }
	| { eligibleToContinue: false; eligibleToReport: false; reason: "still_working" }
	| { eligibleToContinue: false; eligibleToReport: false; reason: "no_trigger" }
	| { eligibleToContinue: false; eligibleToReport: false; reason: "supervisor_offline" };

export interface ContinuabilityInput {
	session: Session;
	recentEvents: SessionEvent[];
	/** Present only for supervisor-managed sessions. */
	managedSession?: { managedState: string } | null;
	/** Whether the session's supervisor is currently connected. */
	supervisorConnected?: boolean;
	/** ms window during which a user prompt blocks dispatch. */
	userPromptLockoutMs?: number;
	/** ms window during which a prior ai_continue_sent blocks another. */
	aiContinueLockoutMs?: number;
}

const DEFAULT_USER_PROMPT_LOCKOUT_MS = 30_000;
const DEFAULT_AI_CONTINUE_LOCKOUT_MS = 30_000;

const CONTINUABLE_MANAGED_STATES = new Set(["interactive_terminal", "headless", "managed"]);

/**
 * Classify whether the watcher is allowed to continue vs. report vs. do nothing.
 *
 * Hierarchy of checks (cheap → expensive):
 * 1. Session is still working — wait, no decision.
 * 2. No trigger event in the recent window — wait, no decision.
 * 3. A user prompt or prior ai_continue landed recently — downgrade to report.
 * 4. Managed + supervisor connected + dispatch-capable state → continue ok.
 * 5. Otherwise (observed, or managed in terminal state) → report only.
 */
export function classifyContinuability(input: ContinuabilityInput): WatcherEligibility {
	const {
		session,
		recentEvents,
		managedSession,
		supervisorConnected = true,
		userPromptLockoutMs = DEFAULT_USER_PROMPT_LOCKOUT_MS,
		aiContinueLockoutMs = DEFAULT_AI_CONTINUE_LOCKOUT_MS,
	} = input;

	if (session.isWorking) {
		return { eligibleToContinue: false, eligibleToReport: false, reason: "still_working" };
	}

	// We need some recent signal that the session just handed off.
	const hasTriggerEvent = recentEvents.some(
		(e) =>
			e.eventType === "Stop" ||
			e.eventType === "SessionEnd" ||
			e.category === "assistant_message" ||
			e.category === "plan_update",
	);
	if (!hasTriggerEvent) {
		return { eligibleToContinue: false, eligibleToReport: false, reason: "no_trigger" };
	}

	const now = Date.now();
	const recentUserPrompt = recentEvents.some(
		(e) => e.category === "prompt" && now - parseTime(e.createdAt) < userPromptLockoutMs,
	);
	const recentAiContinue = recentEvents.some(
		(e) => e.category === "ai_continue_sent" && now - parseTime(e.createdAt) < aiContinueLockoutMs,
	);

	// Observed session (no managedSession row) — report-only by architecture.
	if (!managedSession) {
		if (recentUserPrompt) {
			return {
				eligibleToContinue: false,
				eligibleToReport: true,
				reason: "recent_user_prompt_report_ok",
			};
		}
		return { eligibleToContinue: false, eligibleToReport: true, reason: "observed_only" };
	}

	// Managed session but supervisor is offline → can't safely dispatch.
	if (!supervisorConnected) {
		return {
			eligibleToContinue: false,
			eligibleToReport: false,
			reason: "supervisor_offline",
		};
	}

	// Managed state must be dispatch-capable.
	if (!CONTINUABLE_MANAGED_STATES.has(managedSession.managedState)) {
		return {
			eligibleToContinue: false,
			eligibleToReport: true,
			reason: "observed_only",
		};
	}

	if (recentUserPrompt) {
		return {
			eligibleToContinue: false,
			eligibleToReport: true,
			reason: "recent_user_prompt_report_ok",
		};
	}
	if (recentAiContinue) {
		return {
			eligibleToContinue: false,
			eligibleToReport: true,
			reason: "recent_ai_continue_report_ok",
		};
	}

	return { eligibleToContinue: true, eligibleToReport: true, reason: "managed_quiet" };
}

function parseTime(value: string): number {
	if (value.includes("T")) return new Date(value).getTime();
	return new Date(`${value.replace(" ", "T")}Z`).getTime();
}
