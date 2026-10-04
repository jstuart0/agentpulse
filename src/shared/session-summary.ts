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
	mostly_completed: "Mostly Completed",
	partially_completed: "Partially Completed",
	blocked: "Blocked",
	failed: "Failed",
	in_progress: "In Progress",
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
	/** Nothing was cited, or nothing cited is a recorded test or build command. */
	| "no_validation_cited"
	/** A cited validation ran but its output did not show a pass or a failure. */
	| "cited_unknown"
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

export type SummarySuspectReason =
	| "role_marker"
	| "override_phrase"
	| "unexpected_url"
	| "pipe_to_shell";

/** What may be said about a cited id: a kind, a time, a result, a count. No text, ever. */
export interface StoredEvidenceFact {
	kind: string;
	at: string | null;
	result?: "ok" | "failed" | "unknown" | "completed";
	count?: number;
}

export interface SummaryProvenance {
	promptVersion: string;
	/** Provider kind and model only: never an id, a name or an endpoint. */
	provider: { kind: string; model: string };
	inputTokens: number;
	outputTokens: number;
	usageEstimated: boolean;
	costCents: number;
	calls: number;
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
	};
	firstEventId: number | null;
	adjustments: SummaryAdjustment[];
	suspect: boolean;
	/** Facts for the ids the summary cites, keyed by id. */
	evidence: Record<string, StoredEvidenceFact>;
}

export interface StoredSessionSummary {
	summary: SessionSummary;
	provenance: SummaryProvenance;
}
