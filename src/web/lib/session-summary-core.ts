/**
 * AGEN-69: the part of the Summary logic the session page itself needs (is the tab there, which
 * tab a link opens, the Labs pointer, the words for a refused click, the time and money
 * formatting those use). The rest lives in `session-summary-view.ts`, which the lazily loaded
 * panel imports, so the page chunk doesn't carry it.
 */
import type {
	SessionSummaryView,
	SummaryErrorCode,
	SummaryRefusalCode,
} from "../../shared/session-summary-view.js";
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
	return summaryAvailabilityDetail(input).availability;
}

/** Why the Summary tab is missing: a load failed, AI isn't built in, or the Labs flag is off (in that order). */
export type UnavailableReason = "flag_off" | "not_built" | "load_failed";

export interface AvailabilityDetail {
	availability: Availability;
	/** Non-null exactly when `availability` is "unavailable". */
	reason: UnavailableReason | null;
}

export function summaryAvailabilityDetail(input: AvailabilityInput): AvailabilityDetail {
	if (input.labsLoadFailed || input.aiLoadFailed) {
		return { availability: "unavailable", reason: "load_failed" };
	}
	if (input.flag === null || input.aiBuild === null)
		return { availability: "pending", reason: null };
	if (!input.aiBuild) return { availability: "unavailable", reason: "not_built" };
	if (!input.flag) return { availability: "unavailable", reason: "flag_off" };
	return { availability: "available", reason: null };
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

/**
 * The four primitives the availability rule reads, as pure selectors. The hook subscribes to
 * each through them (so an unrelated store change re-renders nothing) and `availabilityFromStores`
 * applies them to whole slices: one implementation, so a test of either is a test of both.
 */
export const selectSummaryFlag = (labs: Pick<LabsSlice, "flags">): boolean | null =>
	labs.flags === null ? null : labs.flags[SESSION_SUMMARY_FLAG] === true;
export const selectLabsLoadFailed = (labs: LabsSlice): boolean =>
	labs.flags === null && labs.error !== null && !labs.loading;
export const selectAiBuild = (ai: Pick<AiStatusSlice, "status">): boolean | null =>
	ai.status === null ? null : ai.status.build;
export const selectAiLoadFailed = (ai: AiStatusSlice): boolean =>
	ai.status === null && ai.loadState === "error";

export function availabilityFromStores(labs: LabsSlice, ai: AiStatusSlice): Availability {
	return summaryAvailability({
		flag: selectSummaryFlag(labs),
		labsLoadFailed: selectLabsLoadFailed(labs),
		aiBuild: selectAiBuild(ai),
		aiLoadFailed: selectAiLoadFailed(ai),
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
	| { kind: "tab"; tab: WorkspaceTabId; fellBack: false }
	/** `reason` is null only when the caller didn't pass one. */
	| { kind: "tab"; tab: WorkspaceTabId; fellBack: true; reason: UnavailableReason | null }
	| { kind: "pending" };

/**
 * The tab to show for `?tab=`. Derived at render, so it follows availability both ways: a
 * summary link waits (no bounce) while the flags and status load, and falls to the default
 * the moment the tab is known not to exist.
 */
export function resolveWorkspaceTab(
	requested: string | null,
	availability: Availability,
	reason: UnavailableReason | null = null,
): ResolvedWorkspaceTab {
	const known = WORKSPACE_TAB_ORDER.find((tab) => tab === requested);
	if (!known) return { kind: "tab", tab: DEFAULT_WORKSPACE_TAB, fellBack: false };
	if (known !== "summary") return { kind: "tab", tab: known, fellBack: false };
	if (availability === "pending") return { kind: "pending" };
	if (availability === "available") return { kind: "tab", tab: "summary", fellBack: false };
	return { kind: "tab", tab: DEFAULT_WORKSPACE_TAB, fellBack: true, reason };
}

/** The one line shown above Activity when a `?tab=summary` link fell back; null when the reason is unknown. */
export function fellBackCopy(reason: UnavailableReason | null): string | null {
	switch (reason) {
		case "flag_off":
			return "Session summaries are off, so this link opened Activity.";
		case "not_built":
			return "This server doesn't include AI features, so there is no Summary tab.";
		case "load_failed":
			return "Couldn't check whether summaries are available.";
		case null:
			return null;
	}
}

/** "2:05" since the generation began; clamped at zero, because the optimistic start uses the browser clock. */
/** A wait as a person reads it: "9s", "9:42", "1:00:00". Whole seconds, rounded up. */
export function formatWait(seconds: number): string {
	const total = Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 1));
	if (total < MINUTE_S) return `${total}s`;
	const m = Math.floor(total / MINUTE_S) % 60;
	const sec = String(total % MINUTE_S).padStart(2, "0");
	if (total < HOUR_S) return `${m}:${sec}`;
	return `${Math.floor(total / HOUR_S)}:${String(m).padStart(2, "0")}:${sec}`;
}

export function formatElapsed(startedAt: string | null, now: Date): string {
	if (!startedAt) return "";
	const at = parseDate(startedAt);
	if (Number.isNaN(at)) return "";
	const total = Math.max(0, Math.floor((now.getTime() - at) / 1000));
	return `${Math.floor(total / MINUTE_S)}:${String(total % MINUTE_S).padStart(2, "0")}`;
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

export function wholeCents(cents: number): number {
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A weekday names a day unambiguously only inside a week; further out the date is shown. */
const WEEKDAY_WINDOW_DAYS = 6;

function calendarDay(date: Date, clock: ClockOptions): number {
	const [year, month, day] = dayKey(date, clock).split("-").map(Number);
	return Date.UTC(year, month - 1, day) / (DAY_S * 1000);
}

interface MomentParts {
	/** Null for today: the time alone says enough. */
	day: string | null;
	time: string;
}

function momentParts(iso: string, clock: ClockOptions): MomentParts | null {
	const at = parseDate(iso);
	if (Number.isNaN(at)) return null;
	const date = new Date(at);
	const locale = clock.locale ?? DEFAULT_LOCALE;
	const time = new Intl.DateTimeFormat(locale, {
		timeZone: clock.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(date);
	const apart = calendarDay(date, clock) - calendarDay(clock.now ?? new Date(), clock);
	if (apart === 0) return { day: null, time };
	if (Math.abs(apart) <= WEEKDAY_WINDOW_DAYS) {
		const weekday = new Intl.DateTimeFormat(locale, {
			timeZone: clock.timeZone,
			weekday: "short",
		}).format(date);
		return { day: weekday, time };
	}
	const [, month, day] = dayKey(date, clock).split("-").map(Number);
	return { day: `${day} ${MONTHS[month - 1]}`, time };
}

/** "06:41" today, "Tue 06:41" within six days, "29 Sep 06:41" beyond; "" if unparsable. */
export function formatMoment(iso: string, clock: ClockOptions = {}): string {
	const parts = momentParts(iso, clock);
	if (!parts) return "";
	return parts.day ? `${parts.day} ${parts.time}` : parts.time;
}

/** The same instant for use in a sentence: "at 06:41", "Tue at 06:41", "29 Sep at 06:41". */
export function atMoment(iso: string, clock: ClockOptions): string {
	const parts = momentParts(iso, clock);
	if (!parts) return "";
	return parts.day ? `${parts.day} at ${parts.time}` : `at ${parts.time}`;
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
	if (seconds < DAY_S) return `${Math.floor(seconds / HOUR_S)} h ago`;
	return `${Math.floor(seconds / DAY_S)} d ago`;
}

export function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

// ── copy ────────────────────────────────────────────────────────────────────

export interface SummaryViewer {
	/** From `ownershipUi().adminSettingsLocked`: a team member who can't change settings. */
	adminSettingsLocked: boolean;
	/** From `ownershipUi().showSummarySharedNote`. */
	showSummarySharedNote: boolean;
	/** Whether Settings has an AI section: the Labs flag `aiSettingsPanel`, read the way the Settings page reads it. */
	aiPanelAvailable: boolean;
}

export const GENERIC_FAILURE_COPY = "Something went wrong. Try again.";

const ASK_ADMIN_TO_CHECK_PROVIDER = "Ask an admin to check the provider.";

type PlainFailureCode = Exclude<
	SummaryErrorCode,
	"provider_auth" | "provider_key_unreadable" | "spend_cap"
>;

/** Keyed by the contract's codes: a new error code without copy here fails the typecheck. */
const FAILURE_COPY: Record<PlainFailureCode, string> = {
	provider_rate_limit: "The provider is rate-limiting. Try again shortly.",
	provider_timeout: "The provider took too long to answer. Try again.",
	provider_error:
		"The provider returned an error. Try again; if it keeps happening, check the provider's status.",
	provider_refused:
		"The model declined to summarize this session. A different model may do better.",
	parse_failed: "The model's answer wasn't usable. Try again; a different model may do better.",
	output_truncated:
		"The model ran out of room before finishing its answer. Try again; a different default model may do better.",
	ai_inactive: "AI was paused or turned off before this finished.",
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
				viewer.adminSettingsLocked
					? "Ask an admin to enter it again in AI settings."
					: "An admin needs to enter it again in AI settings."
			}`;
		case "spend_cap": {
			const reset = resetsAt ? atMoment(resetsAt, clock ?? {}) : "";
			return `The first answer wasn't usable, and a retry would have gone over today's AI budget. Nothing was saved; the first call was still charged.${
				reset ? ` The budget resets ${reset}.` : ""
			}`;
		}
		default:
			return (
				(code !== null && Object.hasOwn(FAILURE_COPY, code)
					? FAILURE_COPY[code as PlainFailureCode]
					: null) ?? GENERIC_FAILURE_COPY
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

type RefusalInput = Pick<SummaryRefusal, "status" | "code" | "retryAfterSeconds">;

/** A `busy` that asks for longer than this is the failure breaker, not load. */
const BUSY_BREAKER_MIN_SECONDS = 15;

/** Keyed by the contract's codes: a new refusal code without copy here fails the typecheck. */
const REFUSAL_COPY: Record<
	SummaryRefusalCode,
	(refusal: RefusalInput, viewer: Pick<SummaryViewer, "adminSettingsLocked">) => RefusalCopy
> = {
	summary_rate_limited: (refusal) => {
		const seconds = refusal.retryAfterSeconds;
		const whole =
			seconds !== null && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
		return {
			text:
				whole !== null
					? `Too many summary requests. Try again in ${whole}s.`
					: "Too many summary requests. Try again shortly.",
			refetch: null,
			countdownSeconds: whole,
		};
	},
	caller_generation_running: () =>
		inline("You already have a summary being made. Wait for it to finish."),
	shutting_down: () => inline("The server is restarting. Try again in a moment."),
	busy: (refusal) => {
		const wait = refusal.retryAfterSeconds;
		// A long wait is the caller's own failure breaker, not load on the server.
		return wait !== null && wait > BUSY_BREAKER_MIN_SECONDS
			? {
					text: `Several of your summaries failed recently. You can try again in ${formatWait(wait)}.`,
					refetch: "view",
					countdownSeconds: null,
				}
			: inline("The server is busy with other summaries. Try again in a few seconds.");
	},
	session_summary_disabled: () => inline("Session summaries were just turned off.", "availability"),
	ai_disabled: () => inline("AI was just turned off.", "ai_status"),
	ai_paused: () => inline("AI was just paused.", "ai_status"),
	provider_key_unreadable: (_refusal, viewer) =>
		inline(failureCopy("provider_key_unreadable", viewer), "view"),
	no_provider: () => REFETCH_ONLY,
	too_little_activity: () => REFETCH_ONLY,
	spend_cap_reached: () => REFETCH_ONLY,
	summary_cooldown: () => REFETCH_ONLY,
	session_not_found: () => inline("This session no longer exists."),
};

/** What a refused click says, and what to re-read afterwards. Keyed on the contract's code, not the status. */
export function refusalCopy(
	refusal: RefusalInput,
	viewer: Pick<SummaryViewer, "adminSettingsLocked"> = { adminSettingsLocked: false },
): RefusalCopy {
	if (refusal.code !== null && Object.hasOwn(REFUSAL_COPY, refusal.code)) {
		return REFUSAL_COPY[refusal.code](refusal, viewer);
	}
	if (refusal.status === 404) return inline("This session no longer exists.");
	return inline(GENERIC_FAILURE_COPY, "view");
}

/** The one rule for when Update asks first: the model supplies the wording, the hook asks. */
export function needsShrinkConfirmation(
	view: Pick<SessionSummaryView, "evidenceShrunk" | "stored">,
) {
	return view.evidenceShrunk && view.stored !== null;
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

const BADGE_ACCESSIBLE_NAMES = {
	Summarizing: "summarizing now",
	New: "new summary ready",
} as const;

/** What a screen reader says for the badge's visible word. */
export function tabBadgeAccessibleName(badge: "Summarizing" | "New" | null): string | null {
	return badge === null ? null : BADGE_ACCESSIBLE_NAMES[badge];
}

/** After your own generation ends: move focus to the panel heading, but only if focus is still inside the panel. */
export function shouldFocusHeading(
	announcement: "Summarizing" | "Summary ready" | "Summary failed" | null,
	focusInsidePanel: boolean,
): boolean {
	return (
		focusInsidePanel && (announcement === "Summary ready" || announcement === "Summary failed")
	);
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
