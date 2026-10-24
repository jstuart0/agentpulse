/**
 * What the session AI tab says and offers, as plain functions of the server's
 * answer: the delivery notice, the automatic-send counter, which controls a
 * suggestion gets, and the words for a report and why one wasn't written.
 * Kept out of the components so each rule is one testable sentence.
 */
import type {
	AiProposal,
	AiReportVerdict,
	AiWatcherConfig,
	AiWatcherReport,
	PromptDelivery,
} from "../../lib/api.js";

export const CONTINUE_LABEL =
	"Continue: suggest the next prompt (sends on approval for sessions AgentPulse launched)";
export const NOTIFY_LABEL = "Notify: report when a turn ends";
export const BOTH_MODES_OFF = "Both modes are off, so the watcher does nothing for this session.";

/** When Continue is on, why a suggestion can only be copied. Null when nothing needs saying. */
export function promptDeliveryNotice(
	continueEnabled: boolean,
	delivery: PromptDelivery | null,
): string | null {
	if (!continueEnabled || delivery === null || delivery.deliverable) return null;
	switch (delivery.reason) {
		case "observed":
			return "AgentPulse didn't launch this session, so it can't type into it. Continue will suggest prompts for you to copy.";
		case "supervisor_offline":
			return "The machine running this session isn't connected right now, so AgentPulse can't type into it. Continue will suggest prompts; reconnect the machine to send them.";
		case "managed_state":
			return "This session isn't in a state that can take a prompt right now. Continue will suggest prompts for you to copy.";
		case "control_busy":
			return "AgentPulse is already sending something to this session. Try again in a moment.";
	}
}

export interface AutoCounter {
	text: string;
	capReached: boolean;
}

/** The automatic-send counter. Human approvals never count toward it. */
export function autoCounter(
	config: Pick<AiWatcherConfig, "continuationsUsed" | "maxContinuations">,
): AutoCounter {
	const { continuationsUsed: used, maxContinuations: max } = config;
	return used >= max
		? { text: `Auto cap reached, ${used} of ${max}`, capReached: true }
		: { text: `Automatic sends: ${used} of ${max}`, capReached: false };
}

export const AUTO_COUNTER_NOTE = "Approving a suggestion yourself doesn't count.";

/** What the confirmation says before `auto` is turned on. */
export function autoConfirmationPoints(maxContinuations: number): string[] {
	return [
		"It sends only three fixed nudges: retry the failed step, run the tests, or summarize status. It never sends text the model wrote.",
		"It never sends when the agent asked a question or a permission prompt is open. Those wait for you.",
		`At most 6 an hour for this session, and ${maxContinuations} in total.`,
		"It works only while “Pause automatic prompt sending” is off in Settings, AI. That setting starts on.",
		"Changing the system prompt, the provider or the limit asks you to confirm again.",
	];
}

export type SuggestionControls =
	| { primary: "send"; copy: boolean; edit: boolean; note: null }
	| { primary: "copy"; copy: true; edit: boolean; note: string | null };

export const NOT_APPROVABLE_NOTE =
	"This suggestion contained hidden or unsafe characters; edit it to send.";

/**
 * Which buttons a suggestion gets. It can be sent only when the session can
 * take a prompt and the stored text passed the sanitiser unchanged. Otherwise
 * the person copies it; editing it first is offered only when the session could
 * take the edited text.
 */
export function suggestionControls(
	proposal: Pick<AiProposal, "approvable">,
	delivery: PromptDelivery,
): SuggestionControls {
	const approvable = proposal.approvable !== false;
	if (delivery.deliverable && approvable) {
		return { primary: "send", copy: false, edit: true, note: null };
	}
	return {
		primary: "copy",
		copy: true,
		edit: delivery.deliverable,
		note: approvable ? null : NOT_APPROVABLE_NOTE,
	};
}

const CONTINUE_KIND_LABEL: Record<NonNullable<AiProposal["continueKind"]>, string> = {
	proceed: "keep going",
	retry_failed_step: "retry the failed step",
	run_tests: "run the tests",
	summarize_status: "summarize status",
};

export function continueKindLabel(kind: AiProposal["continueKind"]): string | null {
	return kind ? CONTINUE_KIND_LABEL[kind] : null;
}

export const VERDICT_LABEL: Record<AiReportVerdict, string> = {
	finished: "Finished",
	stuck: "Looks stuck",
	needs_you: "Waiting for you",
};

const FAILURE_LABEL: Record<string, string> = {
	provider_timeout: "the model timed out",
	provider_transient: "the provider was busy",
	evidence_read: "the session couldn't be read",
	abandoned: "interrupted by a restart",
	empty_output: "the model returned nothing",
	length: "the answer was cut off",
	refusal: "the model declined",
	parse: "the answer wasn't usable",
	citation: "the answer cited evidence that isn't there",
	suspect_text: "the note looked unsafe and was held back",
	spend_cap: "the daily spend cap was reached",
	no_new_evidence: "nothing new since the last report",
	stale: "the session moved on before it was ready",
};

/** Why a report row isn't a delivered one, in words. */
export function failureLabel(code: string | null): string {
	if (!code) return "unknown reason";
	if (FAILURE_LABEL[code]) return FAILURE_LABEL[code];
	return code.startsWith("provider_") ? "the provider refused the request" : "unknown reason";
}

const TELEGRAM_LABEL: Record<NonNullable<AiWatcherReport["telegramStatus"]>, string> = {
	sent: "Sent to Telegram",
	skipped_rate_limit: "Not sent to Telegram (rate limit)",
	skipped_no_channel: "In the inbox only",
	failed: "Telegram delivery failed",
};

export function telegramLabel(status: AiWatcherReport["telegramStatus"]): string | null {
	return status ? TELEGRAM_LABEL[status] : null;
}

/** The line under a report: how it went, in order of what a reader cares about. */
export function reportStatusLine(report: AiWatcherReport): string {
	if (report.status === "delivered") return telegramLabel(report.telegramStatus) ?? "In the inbox";
	if (report.status === "claimed") return "Writing…";
	const word = report.status === "failed" ? "No report" : "Skipped";
	return `${word}: ${failureLabel(report.failureCode)}`;
}
