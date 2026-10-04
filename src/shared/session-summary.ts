/**
 * AGEN-69: the shape of a session summary, shared by the server and the web.
 * Plain TypeScript types and constants only. This file (and anything it
 * imports under src/shared) must never import zod: the web bundle would carry
 * it. The validating schema lives in the server's `output-schema.ts`.
 */

/** The eight outcome statuses, in snake_case as the model writes them. */
export const SUMMARY_OUTCOME_STATUSES = [
	"completed",
	"mostly_completed",
	"partially_completed",
	"blocked",
	"failed",
	"in_progress",
	"abandoned",
	"unclear",
] as const;
export type SummaryOutcomeStatus = (typeof SUMMARY_OUTCOME_STATUSES)[number];

export const SUMMARY_OUTCOME_LABELS: Record<SummaryOutcomeStatus, string> = {
	completed: "Completed",
	mostly_completed: "Mostly completed",
	partially_completed: "Partially completed",
	blocked: "Blocked",
	failed: "Failed",
	in_progress: "In progress",
	abandoned: "Abandoned",
	unclear: "Unclear",
};

export const SUMMARY_VALIDATION_RESULTS = ["passed", "failed", "not_run", "unknown"] as const;
export type SummaryValidationResult = (typeof SUMMARY_VALIDATION_RESULTS)[number];

export const SUMMARY_CHANGE_KINDS = [
	"created",
	"modified",
	"deleted",
	"config",
	"dependency",
	"schema",
	"infrastructure",
	"git",
	"other",
] as const;
export type SummaryChangeKind = (typeof SUMMARY_CHANGE_KINDS)[number];

/** The ten sections, in the order the model is asked for them. */
export const SUMMARY_SECTION_KEYS = [
	"overview",
	"outcome",
	"accomplishments",
	"changes",
	"decisions",
	"validation",
	"problems",
	"unfinished",
	"nextActions",
	"handoff",
] as const;
export type SummarySectionKey = (typeof SUMMARY_SECTION_KEYS)[number];

// ── the model's answer after parsing, before the server has checked it ──────

export interface DraftItem {
	text: string;
	/** Evidence ids as `E<n>`, in the form the model cited them. */
	evidence: string[];
}
export interface DraftChange extends DraftItem {
	kind: SummaryChangeKind;
}
export interface DraftDecision extends DraftItem {
	why: string;
}
export interface DraftValidation {
	what: string;
	result: SummaryValidationResult;
	detail: string;
	evidence: string[];
}
export interface SummaryDraft {
	overview: string;
	outcome: { status: SummaryOutcomeStatus; explanation: string };
	accomplishments: DraftItem[];
	changes: DraftChange[];
	decisions: DraftDecision[];
	validation: DraftValidation[];
	problems: DraftItem[];
	unfinished: DraftItem[];
	nextActions: DraftItem[];
	handoff: string;
}

// ── the verified summary: what is stored and shown ──────────────────────────

export interface SummaryClaimItem extends DraftItem {
	/** True when no surviving citation points at an OBSERVED entry ("Agent's claim only"). */
	unverified: boolean;
}
export interface SummaryChange extends SummaryClaimItem {
	kind: SummaryChangeKind;
}
export interface SummaryValidation extends DraftValidation {
	/** True when the server replaced the model's result (always with "unknown"). */
	adjusted: boolean;
	/** Classes (`bun test`, `tsc`) of the cited validation commands, server-chosen; absent when none was cited. */
	classes?: string[];
}
export interface SessionSummary {
	overview: string;
	outcome: { status: SummaryOutcomeStatus; explanation: string };
	accomplishments: SummaryClaimItem[];
	changes: SummaryChange[];
	decisions: DraftDecision[];
	validation: SummaryValidation[];
	problems: DraftItem[];
	unfinished: DraftItem[];
	nextActions: DraftItem[];
	handoff: string;
}

export type ValidationAdjustReason =
	/** An edit recorded after the newest cited validation: the pass does not cover the final code. */
	| "edited_after_validation"
	/** Nothing was cited, or nothing cited is a recorded test or build command. */
	| "no_validation_cited"
	/** A cited validation ran but its output did not show a pass or a failure. */
	| "cited_unknown"
	/** The model said passed; every cited validation failed. */
	| "cited_failed"
	/** The cited validations disagree. */
	| "mixed"
	/** The model said failed; no cited validation failed. */
	| "not_failed";

/** What the server changed or noted. Codes and enum values only, never model text. */
export type SummaryAdjustment =
	| {
			code: "outcome_clamped";
			from: SummaryOutcomeStatus;
			to: "in_progress";
			reason: "working" | "permission_wait";
	  }
	| { code: "note_lifecycle_failed" }
	| { code: "note_completed_with_failed_validation" }
	| {
			code: "validation_adjusted";
			index: number;
			from: SummaryValidationResult;
			reason: ValidationAdjustReason;
	  };

/**
 * Every rule of the instruction tripwire has its own code, in the order they are
 * stored. `pipe_to_shell` covers both a pipe into a shell or interpreter and a
 * download followed by a run step (also across the fields one copy action emits).
 * `risky_command`: an address the user never typed, or a command the session
 * never ran, inside a command whose verb reaches the network or runs or deletes
 * things (`curl`, `git clone`, `npm install`, `rm`, `sudo`, ...).
 * `malformed_url`: an address with a shape no honest summary has (a backslash or
 * percent sign in the host, `javascript:`, `data:`, `file:`, userinfo, a numeric
 * or hex host).
 */
export const SUMMARY_SUSPECT_REASONS = [
	"role_marker",
	"override_phrase",
	"pipe_to_shell",
	"unexpected_url",
	"unrecorded_command",
	"risky_command",
	"malformed_url",
] as const;
export type SummarySuspectReason = (typeof SUMMARY_SUSPECT_REASONS)[number];

/**
 * `warning`: text that addresses an agent, runs downloaded code, or tells the
 * reader to run a network or exec command that the session never ran (or to open
 * a malformed address); the page uses its warning wording and the "... anyway"
 * buttons. `note`: an address the user never typed, or a command the session
 * never ran, when its verb is harmless; a neutral line, normal buttons.
 */
export const SUSPECT_REASON_TIER: Record<SummarySuspectReason, "warning" | "note"> = {
	role_marker: "warning",
	override_phrase: "warning",
	pipe_to_shell: "warning",
	unexpected_url: "note",
	unrecorded_command: "note",
	risky_command: "warning",
	malformed_url: "warning",
};

/** The kinds of fact a ledger id can be: what the summary's citations may point at. */
export const EVIDENCE_FACT_KINDS = [
	"prompt",
	"agent_message",
	"edit",
	"command",
	"validation",
	"tool",
	"event",
] as const;
export type EvidenceFactKind = (typeof EVIDENCE_FACT_KINDS)[number];

/** How a recorded call ended. `completed`: the call finished and nothing recorded says whether it worked. */
export const EVIDENCE_FACT_RESULTS = ["ok", "failed", "unknown", "completed"] as const;
export type EvidenceFactResult = (typeof EVIDENCE_FACT_RESULTS)[number];

/** What may be said about a cited id: a kind, a time, a result, a count. No text, ever. */
export interface StoredEvidenceFact {
	kind: EvidenceFactKind;
	at: string | null;
	result?: EvidenceFactResult;
	count?: number;
	/** For a validation: its class (`bun test`, `tsc`), a label the server chose, never the command text. */
	validationClass?: string;
}

/** The stored shape of a summary changes only with this number. */
export const SUMMARY_SCHEMA_VERSION = 1;

export interface SummaryProvenance {
	schemaVersion: number;
	promptVersion: string;
	/** Provider kind and model only: never an id, a name or an endpoint. */
	provider: { kind: string; model: string };
	inputTokens: number;
	outputTokens: number;
	usageEstimated: boolean;
	costCents: number;
	calls: number;
	/** Rule matches in what was sent (one secret can match two rules): known patterns masked, not a count of secrets. */
	redactionHits: number;
	eventsTotal: number;
	eventsRead: number;
	eventsRepresented: number;
	coverage: {
		status: "full" | "partial";
		droppedByCap: number;
		droppedByBudget: number;
		/** ISO time; null when the scan reached the session's first event (an interior omission has no cut-off). */
		cutoffAt: string | null;
		/** The protected entries alone exceeded the budget (not reachable at the current limits). */
		overBudget: boolean;
	};
	firstEventId: number | null;
	/** ISO time of the newest event the summary covers, from the rows the loader returned (null when none carried a time). */
	throughAt: string | null;
	adjustments: SummaryAdjustment[];
	/** The tripwire's reason codes (no matched text), de-duplicated, in `SUMMARY_SUSPECT_REASONS` order. */
	suspectReasons: SummarySuspectReason[];
	/** `suspectReasons.length > 0`. */
	suspect: boolean;
	/** Facts for the ids the summary cites, keyed by id. */
	evidence: Record<string, StoredEvidenceFact>;
}

export interface StoredSessionSummary {
	summary: SessionSummary;
	provenance: SummaryProvenance;
}
