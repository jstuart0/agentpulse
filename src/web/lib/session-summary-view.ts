import {
	STALE_EVENT_COUNT_CAP,
	type SessionSummaryView,
} from "../../shared/session-summary-view.js";
/**
 * AGEN-69 phase 7: everything the Summary panel decides, as pure functions. No React, no
 * fetching, no storage. Every model-authored string stays a string here; the panel renders it
 * as a text node. The markdown builders are for the clipboard only and are never rendered.
 */
import {
	SUMMARY_OUTCOME_LABELS,
	type SessionSummary,
	type StoredEvidenceFact,
	type StoredSessionSummary,
	type SummaryOutcomeStatus,
	type SummaryProvenance,
} from "../../shared/session-summary.js";
import { aiSettingsHref } from "../pages/settings-panels.js";
import type { AiStatusResponse, SummaryRefusal } from "./api.js";
import { parseDate } from "./utils.js";

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

/**
 * Whether the Summary tab exists: the flag is on and AI is built in. AI paused or switched off
 * does not hide it (a stored summary stays readable). A failed load of either source is
 * "unavailable", never "pending" forever.
 */
export function summaryAvailability(input: AvailabilityInput): Availability {
	if (input.labsLoadFailed || input.aiLoadFailed) return "unavailable";
	if (input.flag === null || input.aiBuild === null) return "pending";
	return input.flag && input.aiBuild ? "available" : "unavailable";
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

export function availabilityFromStores(labs: LabsSlice, ai: AiStatusSlice): Availability {
	return summaryAvailability({
		flag: labs.flags === null ? null : labs.flags[SESSION_SUMMARY_FLAG] === true,
		labsLoadFailed: labs.flags === null && labs.error !== null && !labs.loading,
		aiBuild: ai.status === null ? null : ai.status.build,
		aiLoadFailed: ai.status === null && ai.loadState === "error",
	});
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

export function visibleWorkspaceTabs(availability: Availability): WorkspaceTabId[] {
	return WORKSPACE_TAB_ORDER.filter((tab) => tab !== "summary" || availability === "available");
}

export type ResolvedWorkspaceTab =
	| { kind: "tab"; tab: WorkspaceTabId; fellBack: boolean }
	| { kind: "pending" };

/**
 * The tab to show for `?tab=`. Derived at render, so it follows availability both ways: a
 * summary link waits (no bounce) while the flags and status load, and falls to the default
 * the moment the tab is known not to exist.
 */
export function resolveWorkspaceTab(
	requested: string | null,
	availability: Availability,
): ResolvedWorkspaceTab {
	const known = WORKSPACE_TAB_ORDER.find((tab) => tab === requested);
	if (!known) return { kind: "tab", tab: DEFAULT_WORKSPACE_TAB, fellBack: false };
	if (known !== "summary") return { kind: "tab", tab: known, fellBack: false };
	if (availability === "pending") return { kind: "pending" };
	if (availability === "available") return { kind: "tab", tab: "summary", fellBack: false };
	return { kind: "tab", tab: DEFAULT_WORKSPACE_TAB, fellBack: true };
}

export function summaryHref(sessionId: string): string {
	return `/sessions/${encodeURIComponent(sessionId)}?tab=summary`;
}

// ── formatting ──────────────────────────────────────────────────────────────

export interface ClockOptions {
	now?: Date;
	/** IANA zone; the browser's when absent. */
	timeZone?: string;
	locale?: string;
}

const DEFAULT_LOCALE = "en-GB";
const UNDER_A_CENT = "under $0.01";

function wholeCents(cents: number): number {
	return Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
}

/** "$4.20", always two decimals, integer arithmetic. */
export function formatMoney(cents: number): string {
	const n = wholeCents(cents);
	return `$${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** What a call cost: a free provider says so; a paid one that rounds to nothing says "under $0.01". */
export function formatCost(cents: number, freeProvider = false): string {
	if (freeProvider) return "no cost recorded";
	return wholeCents(cents) === 0 ? UNDER_A_CENT : formatMoney(cents);
}

function dayKey(date: Date, clock: ClockOptions): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: clock.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/** "06:41", with a weekday ("Tue 06:41") when the instant is not today in the clock's zone; "" if unparsable. */
export function formatMoment(iso: string, clock: ClockOptions = {}): string {
	const at = parseDate(iso);
	if (Number.isNaN(at)) return "";
	const date = new Date(at);
	const locale = clock.locale ?? DEFAULT_LOCALE;
	const time = new Intl.DateTimeFormat(locale, {
		timeZone: clock.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(date);
	const now = clock.now ?? new Date();
	if (dayKey(date, clock) === dayKey(now, clock)) return time;
	const weekday = new Intl.DateTimeFormat(locale, {
		timeZone: clock.timeZone,
		weekday: "short",
	}).format(date);
	return `${weekday} ${time}`;
}

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86400;

export function relativeAgo(iso: string, clock: ClockOptions = {}): string {
	const at = parseDate(iso);
	if (Number.isNaN(at)) return "";
	const seconds = Math.floor(((clock.now ?? new Date()).getTime() - at) / 1000);
	if (seconds < MINUTE_S) return "just now";
	if (seconds < HOUR_S) return `${Math.floor(seconds / MINUTE_S)} min ago`;
	if (seconds < DAY_S) return `${Math.floor(seconds / HOUR_S)}h ago`;
	return `${Math.floor(seconds / DAY_S)}d ago`;
}

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

// ── copy ────────────────────────────────────────────────────────────────────

export interface SummaryViewer {
	/** From `ownershipUi().adminSettingsLocked`: a team member who can't change settings. */
	adminSettingsLocked: boolean;
	/** From `ownershipUi().showSummarySharedNote`. */
	showSummarySharedNote: boolean;
}

export const GENERIC_FAILURE_COPY = "Something went wrong. Try again.";

const ASK_ADMIN_TO_CHECK_PROVIDER = "Ask an admin to check the provider.";

const FAILURE_COPY: Record<string, string> = {
	provider_rate_limit: "The provider is rate-limiting. Try again shortly.",
	provider_timeout: "The provider took too long to answer. Try again.",
	provider_error:
		"The provider returned an error. Try again; if it keeps happening, check the provider's status.",
	provider_refused:
		"The model declined to summarize this session. A different model may do better.",
	parse_failed: "The model's answer wasn't usable. Try again; a different model may do better.",
	output_truncated:
		"The model ran out of room before finishing its answer. Try again; a different default model may do better.",
	ai_inactive: "AI was paused before this finished. Resume it in Settings to try again.",
	busy: "Something went wrong on the server. Try again.",
	internal_error: "Something went wrong on the server. Try again.",
	interrupted: "The server restarted mid-way. Try again.",
};

/**
 * One plain sentence per failure code. Only a code from the contract picks copy; no server text
 * is ever shown. `resetsAt` finishes the budget sentence for `spend_cap`.
 */
export function failureCopy(
	code: string | null,
	viewer: Pick<SummaryViewer, "adminSettingsLocked">,
	resetsAt?: string | null,
	clock?: ClockOptions,
): string {
	switch (code) {
		case "provider_auth":
			return `The provider rejected the API key. ${
				viewer.adminSettingsLocked ? ASK_ADMIN_TO_CHECK_PROVIDER : "Check it in Settings."
			}`;
		case "provider_key_unreadable":
			return `The provider's API key can't be read. ${
				viewer.adminSettingsLocked ? ASK_ADMIN_TO_CHECK_PROVIDER : "Enter it again in Settings."
			}`;
		case "spend_cap": {
			const reset = resetsAt ? formatMoment(resetsAt, clock) : "";
			return `The first answer wasn't usable, and a retry would have gone over today's AI budget. Nothing was saved; the first call was still charged.${
				reset ? ` The budget resets at ${reset}.` : ""
			}`;
		}
		default:
			return (
				(code !== null && Object.hasOwn(FAILURE_COPY, code) && FAILURE_COPY[code]) ||
				GENERIC_FAILURE_COPY
			);
	}
}

export type RefusalRefetch = "view" | "availability" | "ai_status";

export interface RefusalCopy {
	/** Inline text beside the button; null when the refusal only asks for a refetch. */
	text: string | null;
	refetch: RefusalRefetch | null;
	/** Set when the text carries a countdown the hook should tick down. */
	countdownSeconds: number | null;
}

const REFETCH_ONLY: RefusalCopy = { text: null, refetch: "view", countdownSeconds: null };

function inline(text: string, refetch: RefusalRefetch | null = null): RefusalCopy {
	return { text, refetch, countdownSeconds: null };
}

/** What a refused click says, and what to re-read afterwards. Keyed on the contract's code, not the status. */
export function refusalCopy(
	refusal: Pick<SummaryRefusal, "status" | "code" | "retryAfterSeconds">,
	viewer: Pick<SummaryViewer, "adminSettingsLocked"> = { adminSettingsLocked: false },
): RefusalCopy {
	switch (refusal.code) {
		case "summary_rate_limited": {
			const seconds = refusal.retryAfterSeconds;
			return {
				text:
					seconds !== null && seconds > 0
						? `Too many summary requests. Try again in ${seconds}s.`
						: "Too many summary requests. Try again shortly.",
				refetch: null,
				countdownSeconds: seconds !== null && seconds > 0 ? seconds : null,
			};
		}
		case "caller_generation_running":
			return inline("You already have a summary being made. Wait for it to finish.");
		case "shutting_down":
			return inline("The server is restarting. Try again in a moment.");
		case "busy":
			return inline("The server is busy with other summaries. Try again in a few seconds.");
		case "session_summary_disabled":
			return inline("Session summaries were just turned off.", "availability");
		case "ai_disabled":
			return inline("AI was just turned off.", "ai_status");
		case "ai_paused":
			return inline("AI was just paused.", "ai_status");
		case "provider_key_unreadable":
			return inline(failureCopy("provider_key_unreadable", viewer), "view");
		case "no_provider":
		case "too_little_activity":
		case "spend_cap_reached":
		case "summary_cooldown":
			return REFETCH_ONLY;
		case "session_not_found":
			return inline("This session no longer exists.");
		default:
			if (refusal.status === 404) return inline("This session no longer exists.");
			return inline(GENERIC_FAILURE_COPY, "view");
	}
}

/** The over-budget sentence, from the view's own numbers and the server's reset instant. */
export function budgetSentence(spend: SessionSummaryView["spend"], clock?: ClockOptions): string {
	const reset = formatMoment(spend.resetsAt, clock);
	return `Not enough of today's AI budget left for a summary: ${formatMoney(spend.spentCents)} of ${formatMoney(spend.capCents)} used, and one can cost up to ${formatCost(spend.maxCostCents)}, or ${formatCost(spend.maxCostWithRetryCents)} if the answer has to be retried.${
		reset ? ` The budget resets at ${reset}.` : ""
	}`;
}

const isFreeProvider = (spend: SessionSummaryView["spend"]) => spend.maxCostCents === 0;

/** The fine print under "Summarize this session". Null when there is no provider to name. */
export function finePrint(
	view: SessionSummaryView,
	viewer: Pick<SummaryViewer, "showSummarySharedNote">,
): string | null {
	if (!view.provider) return null;
	const { spend } = view;
	const where = `${view.provider.kind} · ${view.provider.model}`;
	const cost = isFreeProvider(spend)
		? "No cost is recorded for this provider."
		: `Up to ${formatCost(spend.maxCostCents)}, or ${formatCost(spend.maxCostWithRetryCents)} if the answer has to be retried; ${formatMoney(spend.spentCents)} of today's ${formatMoney(spend.capCents)} used.`;
	const shared = viewer.showSummarySharedNote ? " Everyone on this instance can read it." : "";
	return `Sends this session's prompts, agent replies, notes, commands and file paths to ${where}. Command output is sent only for tests, builds and failures. Known secret patterns are removed first. ${cost}${shared}`;
}

// ── evidence ────────────────────────────────────────────────────────────────

const EVIDENCE_NOUNS: Record<string, string> = {
	prompt: "prompt",
	agent_message: "agent message",
	command: "command",
	edit: "edit",
	tool: "tool call",
	permission: "permission prompt",
	plan: "plan update",
	status: "status update",
	progress: "progress update",
};
const NEUTRAL_NOUN = "activity";

function evidenceNoun(fact: StoredEvidenceFact): string {
	const base = Object.hasOwn(EVIDENCE_NOUNS, fact.kind) ? EVIDENCE_NOUNS[fact.kind] : NEUTRAL_NOUN;
	if (base === "edit" && (fact.count ?? 1) > 1) return `${fact.count} edits`;
	return fact.result === "failed" ? `failed ${base}` : base;
}

/** A link's text from stored facts only ("command 10:07"), never an event id. */
export function evidenceLabel(fact: StoredEvidenceFact | undefined, clock?: ClockOptions): string {
	if (!fact) return NEUTRAL_NOUN;
	const suffix =
		fact.result === "unknown"
			? " (result unclear)"
			: fact.result === "completed"
				? " (finished)"
				: "";
	const time = fact.at ? formatMoment(fact.at, clock) : "";
	return [`${evidenceNoun(fact)}${suffix}`, time].filter(Boolean).join(" ");
}

export function evidenceAccessibleName(
	fact: StoredEvidenceFact | undefined,
	clock?: ClockOptions,
): string {
	if (!fact) return `Open the ${NEUTRAL_NOUN} in Activity`;
	const noun = evidenceNoun(fact);
	const time = fact.at ? formatMoment(fact.at, clock) : "";
	if ((fact.count ?? 1) > 1 && fact.kind === "edit") {
		return `Open the ${noun}${time ? ` from ${time}` : ""} in Activity`;
	}
	return `Open the ${time ? `${time} ` : ""}${noun} in Activity`;
}

export interface ResultCounts {
	ok: number;
	failed: number;
	unknown: number;
	completed: number;
}

/** Each of the four recorded results is its own bucket: a finished command with no failure signal is not a pass. */
export function evidenceResultCounts(facts: readonly StoredEvidenceFact[]): ResultCounts {
	const counts: ResultCounts = { ok: 0, failed: 0, unknown: 0, completed: 0 };
	for (const fact of facts) if (fact.result) counts[fact.result]++;
	return counts;
}

// ── sections ────────────────────────────────────────────────────────────────

const VALIDATION_WORDS: Array<[SessionSummary["validation"][number]["result"], string]> = [
	["passed", "passed"],
	["failed", "failed"],
	["unknown", "unknown"],
	["not_run", "not run"],
];

/** "2 passed · 1 failed", in words. */
export function validationTally(validation: SessionSummary["validation"]): string {
	return VALIDATION_WORDS.map(([result, word]) => {
		const n = validation.filter((v) => v.result === result).length;
		return n > 0 ? `${n} ${word}` : null;
	})
		.filter((part) => part !== null)
		.join(" · ");
}

const NO_VALIDATION_FOUND = "Unknown: no test or build command found for this";
const NOT_CONFIRMED = "Unknown: the recorded activity doesn't confirm this";

export function validationResultText(
	item: SessionSummary["validation"][number],
	index: number,
	provenance: SummaryProvenance,
): string {
	switch (item.result) {
		case "passed":
			return "Passed";
		case "failed":
			return "Failed";
		case "not_run":
			return "Not run";
		case "unknown": {
			if (!item.adjusted) return "Unknown";
			const adjustment = provenance.adjustments.find(
				(a) => a.code === "validation_adjusted" && a.index === index,
			);
			if (adjustment && adjustment.code === "validation_adjusted") {
				return adjustment.reason === "no_validation_cited" ? NO_VALIDATION_FOUND : NOT_CONFIRMED;
			}
			return NO_VALIDATION_FOUND;
		}
	}
}

/** Past half "agent's claim only": one note for the section instead of one per item. */
export function claimOnlyMode(
	items: readonly { unverified: boolean }[],
): "none" | "per_item" | "section" {
	const unverified = items.filter((item) => item.unverified).length;
	if (unverified === 0) return "none";
	return unverified * 2 > items.length ? "section" : "per_item";
}

export type OutcomeFamily = "green" | "blue" | "amber" | "red" | "slate";

const OUTCOME_FAMILY: Record<SummaryOutcomeStatus, OutcomeFamily> = {
	completed: "green",
	mostly_completed: "green",
	partially_completed: "blue",
	in_progress: "blue",
	blocked: "amber",
	failed: "red",
	abandoned: "slate",
	unclear: "slate",
};

function sentenceCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export function outcomeChip(status: SummaryOutcomeStatus): {
	label: string;
	family: OutcomeFamily;
	dashed: boolean;
} {
	return {
		label: sentenceCase(SUMMARY_OUTCOME_LABELS[status]),
		family: OUTCOME_FAMILY[status],
		dashed: status === "unclear",
	};
}

/** The sentences under the outcome row for what the server changed or noted. */
export function outcomeNotes(stored: StoredSessionSummary): string[] {
	const notes: string[] = [];
	for (const adjustment of stored.provenance.adjustments) {
		if (adjustment.code === "outcome_clamped") {
			const why =
				adjustment.reason === "working"
					? "the session is still running"
					: "the session is waiting on a permission prompt";
			notes.push(
				`The model said ${outcomeChip(adjustment.from).label}. Shown as In progress because ${why}.`,
			);
		} else if (adjustment.code === "note_lifecycle_failed") {
			notes.push("The session itself ended as failed.");
		} else if (adjustment.code === "note_completed_with_failed_validation") {
			notes.push("A validation step failed (see Validation).");
		}
	}
	return notes;
}

/** Two cases: the scan stopped before the first event (a time), or something inside was dropped (a count). */
export function partialEvidenceNotice(
	coverage: SummaryProvenance["coverage"],
	clock?: ClockOptions,
): string | null {
	if (coverage.status === "full") return null;
	const cutoff = coverage.cutoffAt ? formatMoment(coverage.cutoffAt, clock) : "";
	if (cutoff) return `Based on part of this session: activity before ${cutoff} was left out.`;
	const dropped = coverage.droppedByCap + coverage.droppedByBudget;
	if (dropped > 0) {
		return `Some activity was left out (${dropped} ${plural(dropped, "tool call", "tool calls")}).`;
	}
	return "Some activity was left out.";
}

export function footerText(
	view: SessionSummaryView,
	clock?: ClockOptions,
): { line: string; masked: string | null; retention: string | null } | null {
	const stored = view.stored;
	if (!stored) return null;
	const { provenance } = stored;
	const through = view.throughAt ? formatMoment(view.throughAt, clock) : "";
	const generated = view.generatedAt ? relativeAgo(view.generatedAt, clock) : "";
	const line = [
		`Based on ${provenance.eventsTotal} events${through ? ` through ${through}` : ""}`,
		provenance.provider.model,
		formatCost(provenance.costCents, isFreeProvider(view.spend)),
		...(generated ? [`generated ${generated}`] : []),
	].join(" · ");
	const hits = provenance.redactionHits;
	return {
		line,
		masked:
			hits > 0
				? `${hits} known ${plural(hits, "pattern", "patterns")} masked before sending.`
				: null,
		retention:
			view.retentionDays === undefined
				? null
				: `Removed along with this session's events after ${view.retentionDays} ${plural(view.retentionDays, "day", "days")}.`,
	};
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

const SUSPECT_NOTICE =
	"This summary contains text that looks like instructions. Read it before pasting it into an agent.";
const SHRUNK_CONFIRM =
	"Older events have been removed. A new summary would be based on less evidence and replaces this one.";
const GENERATING_STATUS =
	"Summarizing. This can take a couple of minutes on a long session. You can leave this page; it keeps going.";

function copyLabels(suspect: boolean): SummaryViewModel["copyLabels"] {
	const anyway = suspect ? " anyway" : "";
	return {
		handoff: `Copy handoff${anyway}`,
		summary: `Copy summary${anyway}`,
		context: `Copy context${anyway}`,
	};
}

function staleText(newEvents: number): string {
	const count =
		newEvents >= STALE_EVENT_COUNT_CAP ? `${STALE_EVENT_COUNT_CAP}+` : String(newEvents);
	const what = newEvents === 1 ? "prompt or tool call" : "prompts and tool calls";
	return `This session has moved on since this summary (${count} ${what} later).`;
}

function blocked(
	reason: BlockedReason,
	text: string,
	link: { href: string; label: string } | null = null,
): ActionState {
	return { kind: "blocked", reason, text, link };
}

function deriveAction(
	view: SessionSummaryView,
	ai: AiStatusResponse,
	viewer: SummaryViewer,
	content: ContentState,
	clock?: ClockOptions,
): ActionState {
	if (view.attempt.status === "generating") {
		return {
			kind: "generating",
			label: "Summarizing…",
			statusText: GENERATING_STATUS,
			startedAt: view.attempt.startedAt,
		};
	}
	if (!ai.build || !ai.runtime) {
		return blocked("ai_off", "Summaries are unavailable while AI is turned off.");
	}
	if (ai.killSwitch) return blocked("ai_paused", "Summaries are unavailable while AI is paused.");
	switch (view.blocked) {
		case "too_little_activity":
			return blocked(
				"too_little_activity",
				"There's nothing to summarize yet. This fills in once the session has a prompt or some tool activity.",
			);
		case "no_provider":
			return viewer.adminSettingsLocked
				? blocked("no_provider", "No AI provider is set up. Ask an admin to add one.")
				: blocked("no_provider", "No AI provider is set up.", {
						href: aiSettingsHref(ai.build),
						label: "Open AI settings",
					});
		case "summary_cooldown":
			return blocked("cooling_down", `Available in ${view.cooldownSeconds ?? 1}s`);
		case "spend_cap_reached":
			return blocked("over_budget", budgetSentence(view.spend, clock));
		case null:
			break;
	}
	const variant =
		content.kind === "none" ? "summarize" : content.kind === "stale" ? "update_stale" : "update";
	return {
		kind: "available",
		variant,
		label:
			variant === "summarize"
				? "Summarize this session"
				: variant === "update_stale"
					? "Update summary"
					: "Update",
		confirm: view.evidenceShrunk && view.stored ? SHRUNK_CONFIRM : null,
		finePrint: variant === "summarize" ? finePrint(view, viewer) : null,
	};
}

function deriveNotice(
	view: SessionSummaryView,
	viewer: SummaryViewer,
	clock?: ClockOptions,
): NoticeState {
	if (view.attempt.status !== "failed") return { kind: "none" };
	const startedAt = view.attempt.startedAt;
	return {
		kind: "failed",
		tone: view.stored ? "muted" : "error",
		lead: startedAt
			? `Last attempt, ${relativeAgo(startedAt, clock)}, didn't finish:`
			: "Last attempt didn't finish:",
		reason: failureCopy(view.attempt.errorCode, viewer, view.spend.resetsAt, clock),
		startedAt,
	};
}

function stateTag(content: ContentState, action: ActionState, notice: NoticeState): string {
	const actionTag = action.kind === "blocked" ? `blocked:${action.reason}` : action.kind;
	const noticeTag = notice.kind === "failed" ? `failed-${notice.tone}` : "none";
	return `${content.kind}/${actionTag}/${noticeTag}`;
}

/**
 * The panel's whole state as three independent pieces (content, action, last-attempt notice),
 * plus the suspect notice and the copy labels. Null when the panel shouldn't render at all
 * (availability said unavailable, or the AI status isn't known).
 */
export function deriveSummaryView(
	load: SummaryLoad,
	aiStatus: AiStatusResponse | null,
	viewer: SummaryViewer,
	clock?: ClockOptions,
): SummaryViewModel | null {
	if (load.status === "unavailable" || aiStatus === null) return null;
	if (load.status !== "ready") {
		const content: ContentState =
			load.status === "loading" ? { kind: "loading" } : { kind: "load_failed" };
		const action: ActionState = { kind: "none" };
		const notice: NoticeState = { kind: "none" };
		return {
			content,
			action,
			notice,
			suspectNotice: null,
			copyLabels: copyLabels(false),
			stateTag: stateTag(content, action, notice),
		};
	}
	const { view } = load;
	const { stored } = view;
	const content: ContentState = !stored
		? { kind: "none" }
		: view.staleEvents > 0
			? { kind: "stale", stored, newEvents: view.staleEvents, text: staleText(view.staleEvents) }
			: { kind: "ready", stored };
	const action = deriveAction(view, aiStatus, viewer, content, clock);
	const notice = deriveNotice(view, viewer, clock);
	const suspect = stored?.provenance.suspect === true;
	return {
		content,
		action,
		notice,
		suspectNotice: suspect ? SUSPECT_NOTICE : null,
		copyLabels: copyLabels(suspect),
		stateTag: stateTag(content, action, notice),
	};
}

// ── tab badge and Labs pointer ──────────────────────────────────────────────

export function tabBadge(state: {
	generating: boolean;
	newResult: boolean;
	tabActive: boolean;
}): "Summarizing" | "New" | null {
	if (state.generating) return "Summarizing";
	return state.newResult && !state.tabActive ? "New" : null;
}

export type LabsPointer =
	| { visible: false }
	| {
			visible: true;
			text: string;
			canTurnOn: boolean;
			learnMoreHref: string | null;
	  };

const POINTER_TEXT = "Session summaries are a Labs feature and are off.";

/**
 * The line at the top of the AI tab while the flag is off. Reads `flags` as the store holds
 * them, so nothing shows before they load. A person who can change Labs gets the toggle; a team
 * member is told whom to ask.
 */
export function labsPointer(
	flags: Readonly<Record<string, boolean>> | null,
	viewer: Pick<SummaryViewer, "adminSettingsLocked">,
	aiBuilt: boolean | null = null,
): LabsPointer {
	if (flags === null || flags[SESSION_SUMMARY_FLAG] !== false || aiBuilt === false) {
		return { visible: false };
	}
	const canTurnOn = !viewer.adminSettingsLocked;
	return {
		visible: true,
		text: canTurnOn
			? POINTER_TEXT
			: `${POINTER_TEXT} Ask an admin to turn on Session summary in Settings → Labs.`,
		canTurnOn,
		learnMoreHref: canTurnOn ? "/settings?panel=labs" : null,
	};
}

// ── clipboard builders (never rendered) ─────────────────────────────────────

export const VERIFY_LINE = "AI-generated from session activity. Verify before acting on it.";
export const NO_UNFINISHED_WORK = "No significant unfinished work identified.";
const NOTHING_RECORDED = "None recorded.";
const META_FIELD_MAX = 200;

export interface CopyMeta {
	name: string | null;
	branch: string | null;
	cwd: string | null;
}

/** A fence longer than any backtick or tilde run in the text, so nothing inside can close it. */
function fence(text: string): string {
	const longest = (text.match(/`+|~+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	const marker = "`".repeat(Math.max(3, longest + 1));
	return `${marker}\n${text}\n${marker}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").replaceAll("`", "'").trim().slice(0, META_FIELD_MAX);
}

function metaLine(meta: CopyMeta): string {
	const parts = [
		`Session: ${oneLine(meta.name ?? "") || "(unnamed)"}`,
		...(meta.branch ? [`Branch: ${oneLine(meta.branch)}`] : []),
		...(meta.cwd ? [`Directory: ${oneLine(meta.cwd)}`] : []),
	];
	return parts.join(" | ");
}

const bullets = (texts: string[]) => texts.map((t) => `- ${t}`).join("\n");
const numbered = (texts: string[]) => texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

function section(heading: string, body: string | null, fallback = NOTHING_RECORDED): string[] {
	return [`## ${heading}`, body === null ? fallback : body, ""];
}

function wrap(lines: string[]): string {
	return [VERIFY_LINE, "", ...lines, VERIFY_LINE, ""].join("\n");
}

export function buildHandoffMarkdown(stored: StoredSessionSummary, meta: CopyMeta): string {
	const { summary } = stored;
	return wrap([
		metaLine(meta),
		"",
		"## Outcome",
		SUMMARY_OUTCOME_LABELS[summary.outcome.status],
		fence(summary.outcome.explanation),
		"",
		...section(
			"Unfinished Work",
			summary.unfinished.length ? fence(bullets(summary.unfinished.map((i) => i.text))) : null,
			NO_UNFINISHED_WORK,
		),
		...section(
			"Recommended Next Actions",
			summary.nextActions.length ? fence(numbered(summary.nextActions.map((i) => i.text))) : null,
		),
		...section("Key Context", fence(summary.handoff)),
	]);
}

export function buildSummaryMarkdown(stored: StoredSessionSummary, meta: CopyMeta): string {
	const { summary, provenance } = stored;
	const list = <T>(items: T[], line: (item: T, index: number) => string) =>
		items.length ? fence(items.map(line).join("\n")) : null;
	const claimNote = (items: { unverified: boolean }[]) => {
		const which = items.flatMap((item, i) => (item.unverified ? [i + 1] : []));
		return which.length
			? [
					`Items marked agent's claim only (not backed by recorded tool activity): ${which.join(", ")}.`,
				]
			: [];
	};
	const claimSection = (heading: string, body: string | null, items: { unverified: boolean }[]) => [
		`## ${heading}`,
		body === null ? NOTHING_RECORDED : body,
		...claimNote(items),
		"",
	];
	return wrap([
		metaLine(meta),
		"",
		...section("Overview", fence(summary.overview)),
		"## Outcome",
		SUMMARY_OUTCOME_LABELS[summary.outcome.status],
		fence(summary.outcome.explanation),
		"",
		...claimSection(
			"Accomplishments",
			list(summary.accomplishments, (i) => `- ${i.text}`),
			summary.accomplishments,
		),
		...claimSection(
			"Changes",
			list(summary.changes, (c) => `- [${c.kind}] ${c.text}`),
			summary.changes,
		),
		...section(
			"Decisions & Assumptions",
			list(summary.decisions, (d) => `- ${d.text}\n  Why: ${d.why}`),
		),
		...section(
			"Validation",
			list(
				summary.validation,
				(v, i) =>
					`- ${v.what}: ${validationResultText(v, i, provenance)}${v.detail ? ` (${v.detail})` : ""}`,
			),
		),
		...section(
			"Problems & Risks",
			list(summary.problems, (p) => `- ${p.text}`),
		),
		...section(
			"Unfinished Work",
			list(summary.unfinished, (u) => `- ${u.text}`),
			NO_UNFINISHED_WORK,
		),
		...section(
			"Recommended Next Actions",
			list(summary.nextActions, (n, i) => `${i + 1}. ${n.text}`),
		),
		...section("Key Context", fence(summary.handoff)),
	]);
}

export function buildContextMarkdown(stored: StoredSessionSummary): string {
	return wrap([...section("Key Context", fence(stored.summary.handoff))]);
}
