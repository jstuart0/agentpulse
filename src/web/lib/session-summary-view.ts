import type {
	SessionSummaryView,
	SummaryErrorCode,
	SummaryRefusalCode,
} from "../../shared/session-summary-view.js";
/**
 * AGEN-69 phase 7: everything the Summary panel decides, as pure functions. No React, no
 * fetching, no storage. Every model-authored string stays a string here; the panel renders it
 * as a text node. The markdown builders are for the clipboard only and are never rendered.
 */
import type {
	SessionSummary,
	StoredEvidenceFact,
	StoredSessionSummary,
	SummaryOutcomeStatus,
	SummaryProvenance,
} from "../../shared/session-summary.js";
import type { AiStatusResponse, SummaryRefusal } from "./api.js";

function notImplemented(): never {
	throw new Error("not implemented");
}

// ── availability and tabs ───────────────────────────────────────────────────

/** The Labs flag's key. `LabsFlag` gains it in phase 5; until then it is read through a loose map. */
export const SESSION_SUMMARY_FLAG = "sessionSummary";

export type Availability = "pending" | "available" | "unavailable";

export interface AvailabilityInput {
	/** The Labs flag as the store holds it: null until the flags have loaded (never `isEnabled()`, which is true before that). */
	flag: boolean | null;
	labsLoadFailed: boolean;
	/** `build` from the AI status; null until the status has loaded. */
	aiBuild: boolean | null;
	aiLoadFailed: boolean;
}

export function summaryAvailability(_input: AvailabilityInput): Availability {
	return notImplemented();
}

export interface LabsSlice {
	flags: Readonly<Record<string, boolean>> | null;
	error: string | null;
	loading: boolean;
}
export interface AiStatusSlice {
	status: AiStatusResponse | null;
	loadState: "idle" | "loading" | "loaded" | "error";
}

export function availabilityFromStores(_labs: LabsSlice, _ai: AiStatusSlice): Availability {
	return notImplemented();
}

export type WorkspaceTabId =
	| "overview"
	| "summary"
	| "activity"
	| "notes"
	| "instructions"
	| "launch"
	| "ai";

export const WORKSPACE_TAB_ORDER: readonly WorkspaceTabId[] = [
	"overview",
	"summary",
	"activity",
	"notes",
	"instructions",
	"launch",
	"ai",
];

export const DEFAULT_WORKSPACE_TAB: WorkspaceTabId = "activity";

export function visibleWorkspaceTabs(_availability: Availability): WorkspaceTabId[] {
	return notImplemented();
}

export type ResolvedWorkspaceTab =
	| { kind: "tab"; tab: WorkspaceTabId; fellBack: boolean }
	| { kind: "pending" };

export function resolveWorkspaceTab(
	_requested: string | null,
	_availability: Availability,
): ResolvedWorkspaceTab {
	return notImplemented();
}

export function summaryHref(_sessionId: string): string {
	return notImplemented();
}

// ── formatting ──────────────────────────────────────────────────────────────

export interface ClockOptions {
	now?: Date;
	/** IANA zone; the browser's when absent. */
	timeZone?: string;
	locale?: string;
}

export function formatCost(_cents: number, _freeProvider?: boolean): string {
	return notImplemented();
}

export function formatMoney(_cents: number): string {
	return notImplemented();
}

/** "06:41", with a weekday ("Tue 06:41") when the instant is not today in the clock's zone. */
export function formatMoment(_iso: string, _clock?: ClockOptions): string {
	return notImplemented();
}

export function relativeAgo(_iso: string, _clock?: ClockOptions): string {
	return notImplemented();
}

// ── copy ────────────────────────────────────────────────────────────────────

export interface SummaryViewer {
	/** From `ownershipUi().adminSettingsLocked`: a team member who can't change settings. */
	adminSettingsLocked: boolean;
	/** From `ownershipUi().showSummarySharedNote`. */
	showSummarySharedNote: boolean;
}

export const GENERIC_FAILURE_COPY = "Something went wrong. Try again.";

export function failureCopy(
	_code: string | null,
	_viewer: Pick<SummaryViewer, "adminSettingsLocked">,
	_resetsAt?: string | null,
	_clock?: ClockOptions,
): string {
	return notImplemented();
}

export type RefusalRefetch = "view" | "availability" | "ai_status";

export interface RefusalCopy {
	/** Inline text beside the button; null when the refusal only asks for a refetch. */
	text: string | null;
	refetch: RefusalRefetch | null;
	/** Set when the text carries a countdown the hook should tick down. */
	countdownSeconds: number | null;
}

export function refusalCopy(
	_refusal: Pick<SummaryRefusal, "status" | "code" | "retryAfterSeconds">,
	_viewer?: Pick<SummaryViewer, "adminSettingsLocked">,
): RefusalCopy {
	return notImplemented();
}

export function budgetSentence(_spend: SessionSummaryView["spend"], _clock?: ClockOptions): string {
	return notImplemented();
}

export function finePrint(
	_view: SessionSummaryView,
	_viewer: Pick<SummaryViewer, "showSummarySharedNote">,
): string | null {
	return notImplemented();
}

export function evidenceLabel(
	_fact: StoredEvidenceFact | undefined,
	_clock?: ClockOptions,
): string {
	return notImplemented();
}

export function evidenceAccessibleName(
	_fact: StoredEvidenceFact | undefined,
	_clock?: ClockOptions,
): string {
	return notImplemented();
}

export interface ResultCounts {
	ok: number;
	failed: number;
	unknown: number;
	completed: number;
}
export function evidenceResultCounts(_facts: readonly StoredEvidenceFact[]): ResultCounts {
	return notImplemented();
}

export function validationTally(_validation: SessionSummary["validation"]): string {
	return notImplemented();
}

export function validationResultText(
	_item: SessionSummary["validation"][number],
	_index: number,
	_provenance: SummaryProvenance,
): string {
	return notImplemented();
}

export function claimOnlyMode(
	_items: readonly { unverified: boolean }[],
): "none" | "per_item" | "section" {
	return notImplemented();
}

export type OutcomeFamily = "green" | "blue" | "amber" | "red" | "slate";
export function outcomeChip(_status: SummaryOutcomeStatus): {
	label: string;
	family: OutcomeFamily;
	dashed: boolean;
} {
	return notImplemented();
}

export function outcomeNotes(_stored: StoredSessionSummary): string[] {
	return notImplemented();
}

export function partialEvidenceNotice(
	_coverage: SummaryProvenance["coverage"],
	_clock?: ClockOptions,
): string | null {
	return notImplemented();
}

export function footerText(
	_view: SessionSummaryView,
	_clock?: ClockOptions,
): { line: string; masked: string | null; retention: string | null } | null {
	return notImplemented();
}

// ── the three-piece model ───────────────────────────────────────────────────

export type SummaryLoad =
	| { status: "unavailable" }
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; view: SessionSummaryView };

export type ContentState =
	| { kind: "loading" }
	| { kind: "load_failed" }
	| { kind: "none" }
	| { kind: "ready"; stored: StoredSessionSummary }
	| { kind: "stale"; stored: StoredSessionSummary; newEvents: number; text: string };

export type BlockedReason =
	| "too_little_activity"
	| "no_provider"
	| "ai_paused"
	| "ai_off"
	| "over_budget"
	| "cooling_down";

export type ActionState =
	| { kind: "none" }
	| {
			kind: "available";
			variant: "summarize" | "update" | "update_stale";
			label: string;
			/** Confirmation text when the evidence has shrunk; null otherwise. */
			confirm: string | null;
			finePrint: string | null;
	  }
	| { kind: "generating"; label: string; statusText: string; startedAt: string | null }
	| {
			kind: "blocked";
			reason: BlockedReason;
			text: string;
			link: { href: string; label: string } | null;
	  };

export type NoticeState =
	| { kind: "none" }
	| {
			kind: "failed";
			tone: "error" | "muted";
			lead: string;
			reason: string;
			startedAt: string | null;
	  };

export interface SummaryViewModel {
	content: ContentState;
	action: ActionState;
	notice: NoticeState;
	/** Non-null when the tripwire fired. */
	suspectNotice: string | null;
	copyLabels: { handoff: string; summary: string; context: string };
	/** `content/action/notice`, for the panel's `data-summary-state`. */
	stateTag: string;
}

export function deriveSummaryView(
	_load: SummaryLoad,
	_aiStatus: AiStatusResponse | null,
	_viewer: SummaryViewer,
	_clock?: ClockOptions,
): SummaryViewModel | null {
	return notImplemented();
}

// ── tab badge and Labs pointer ──────────────────────────────────────────────

export function tabBadge(_state: {
	generating: boolean;
	newResult: boolean;
	tabActive: boolean;
}): "Summarizing" | "New" | null {
	return notImplemented();
}

export type LabsPointer =
	| { visible: false }
	| {
			visible: true;
			text: string;
			canTurnOn: boolean;
			learnMoreHref: string | null;
	  };

export function labsPointer(
	_flags: Readonly<Record<string, boolean>> | null,
	_viewer: Pick<SummaryViewer, "adminSettingsLocked">,
	_aiBuilt?: boolean | null,
): LabsPointer {
	return notImplemented();
}

// ── clipboard builders (never rendered) ─────────────────────────────────────

export const VERIFY_LINE = "AI-generated from session activity. Verify before acting on it.";
export const NO_UNFINISHED_WORK = "No significant unfinished work identified.";

export interface CopyMeta {
	name: string | null;
	branch: string | null;
	cwd: string | null;
}

export function buildHandoffMarkdown(_stored: StoredSessionSummary, _meta: CopyMeta): string {
	return notImplemented();
}

export function buildSummaryMarkdown(_stored: StoredSessionSummary, _meta: CopyMeta): string {
	return notImplemented();
}

export function buildContextMarkdown(_stored: StoredSessionSummary): string {
	return notImplemented();
}

export type { SummaryErrorCode, SummaryRefusalCode };
