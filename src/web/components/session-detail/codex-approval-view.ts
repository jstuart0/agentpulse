/**
 * What the Codex approval card says and offers (AGEN-87), as plain functions of
 * what the server sent. There is no DOM harness for components here, so every
 * rule is a function with a test: the one state table (D6), the copy for every
 * outcome, reason and refusal code, the countdown, the confirm step's frozen
 * snapshot and what can change under it, and which rows stay on screen.
 *
 * Text from the agent (commands, paths, diffs, Codex's reason) is only ever
 * handed on as strings for React to draw as text nodes. Nothing here builds
 * HTML or Markdown.
 *
 * `{host}`, `{owner}`, `{time}` and `{n}` are always fields. The copy never
 * says "working", "waiting", "idle" or "error" as a state: the operational
 * badge is the one place a state is said.
 */
import type {
	ApprovalDecision,
	CodexApprovalDetail,
	CodexApprovalHost,
	CodexApprovalOutcome,
	CodexApprovalPresentation,
	CodexApprovalPresentationChange,
	CodexApprovalPreview,
	CodexApprovalSummary,
	NotApprovableReason,
} from "../../../shared/codex-approvals.js";

// ── names ───────────────────────────────────────────────────────────────────

export const HOST_FALLBACK = "this session's machine";
export const OWNER_FALLBACK = "the session's owner";

export function hostLabel(name: string | null | undefined): string {
	return name?.trim() || HOST_FALLBACK;
}

export function ownerLabelOr(name: string | null | undefined): string {
	return name?.trim() || OWNER_FALLBACK;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

// ── availability on a managed Codex session ─────────────────────────────────

/**
 * The hint under the card when this host can't answer approvals: from
 * `providerCapabilitySnapshot.agentpulseApprovals`. `supported` says nothing; a value this build
 * doesn't know says nothing either (a hint that claims too much is worse than none); absent means
 * a supervisor from before approvals existed.
 */
export function availabilityHint(
	snapshot: Record<string, unknown> | null | undefined,
	host: string | null | undefined,
): string | null {
	const name = hostLabel(host);
	const value = snapshot?.agentpulseApprovals;
	switch (value) {
		case undefined:
		case null:
			return `Update the AgentPulse supervisor on ${name} to answer Codex approvals here.`;
		case "supported":
			return null;
		case "unsupported":
			return `Codex on ${name} isn't a version AgentPulse can answer approvals for, so its approval requests are declined automatically.`;
		case "insecure_transport":
			return `${name} doesn't reach AgentPulse over https, so its approval requests are declined automatically.`;
		default:
			return null;
	}
}

// ── the state table (D6) ────────────────────────────────────────────────────

export type CardStateKind =
	| "team_not_owner"
	| "host_offline"
	| "host_gone"
	| "not_approvable"
	| "cannot_accept"
	| "pending_approvable";

export interface ListContext {
	/** The list answered 403 `not_owner`. */
	notOwner: boolean;
	host: CodexApprovalHost | null;
	viewer: { canAccept: boolean } | null;
}

/** First match wins. Only for a row nobody has answered. */
export function cardStateOf(
	ctx: ListContext,
	approval: Pick<CodexApprovalSummary, "approvable">,
): CardStateKind {
	if (ctx.notOwner) return "team_not_owner";
	if (ctx.host?.state === "offline") return "host_offline";
	if (ctx.host?.state === "gone") return "host_gone";
	if (!approval.approvable) return "not_approvable";
	if (ctx.viewer && !ctx.viewer.canAccept) return "cannot_accept";
	return "pending_approvable";
}

export interface CardOffers {
	approve: boolean;
	decline: boolean;
	/** "Decline and stop the turn", behind More. */
	stop: boolean;
}

const OFFERS: Record<CardStateKind, { approve: boolean; decline: boolean }> = {
	team_not_owner: { approve: false, decline: false },
	host_offline: { approve: false, decline: false },
	host_gone: { approve: false, decline: false },
	not_approvable: { approve: false, decline: true },
	cannot_accept: { approve: false, decline: true },
	pending_approvable: { approve: true, decline: true },
};

export function offersOf(state: CardStateKind, canCancel: boolean): CardOffers {
	const base = OFFERS[state];
	return { ...base, stop: base.decline && canCancel };
}

export function hostOfflineText(host: string | null | undefined, time: string | null): string {
	const when = time ? ` You can answer if it's back before ${time}.` : "";
	return `${hostLabel(host)} is offline, so an answer can't reach it.${when} After that, this is declined automatically.`;
}

export const HOST_GONE_TEXT =
	"This session's host was removed from AgentPulse, so this can't be answered here.";
export const CANNOT_ACCEPT_TEXT =
	"Nobody owns this session, so only an admin can approve this. You can decline it.";

export function teamNotOwnerHeading(owner: string | null | undefined): string {
	return `Codex is asking ${ownerLabelOr(owner)} to approve a command.`;
}
export function teamNotOwnerLine(owner: string | null | undefined): string {
	const name = ownerLabelOr(owner);
	return `Only ${name} or an admin can answer.`;
}

// ── not approvable ──────────────────────────────────────────────────────────

const NOT_APPROVABLE_COPY: Record<NotApprovableReason, (ctx: { root: string }) => string> = {
	redacted: () =>
		"AgentPulse hid something that looks like a secret, so you can't see exactly what would run.",
	invisible_chars: () =>
		"This had hidden characters, removed from what's shown here. What would run isn't what you see.",
	padded_text: () =>
		"This has a long run of spaces or blank lines that could push part of it out of sight, so you can't be sure you're seeing all of it.",
	lookalike_text: () =>
		"This has characters that look like other characters or don't draw at all, so what you read may not be what would run.",
	too_long: () =>
		"This is too long to review in full here, so you can't approve it from this page.",
	no_diff: () => "Codex didn't share the changes, so there's nothing to review.",
	no_command: () => "Codex didn't say what it would run, so there's nothing to review.",
	no_cwd: () => "Codex didn't say which directory this would run in.",
	write_stdin: () => "Codex wants to type into a running process. AgentPulse doesn't approve that.",
	network: () =>
		"Codex is asking for network access, which is a different question from running this. AgentPulse doesn't grant that.",
	grant_root: ({ root }) =>
		`Codex is asking to write anywhere under ${root} for the rest of the session. AgentPulse doesn't grant that.`,
	unknown_param: () =>
		"This request includes something AgentPulse doesn't recognize, so it can't show what approving would mean.",
	accept_not_offered: () => "Codex isn't offering approval for this one.",
};

const GRANT_ROOT_FALLBACK = "a directory";

/** Why this can't be approved, in a sentence. A reason this build doesn't know still says it can't be. */
export function notApprovableReasonCopy(
	reason: NotApprovableReason | null,
	grantRoot?: string | null,
): string {
	if (reason === null || !Object.hasOwn(NOT_APPROVABLE_COPY, reason)) {
		return "AgentPulse can't show this in a way that's safe to approve.";
	}
	return NOT_APPROVABLE_COPY[reason]({ root: grantRoot?.trim() || GRANT_ROOT_FALLBACK });
}

/** The card's text for a row that can only be declined: the reason, then what to do about it. */
export function notApprovableText(
	reason: NotApprovableReason | null,
	host: string | null | undefined,
	grantRoot?: string | null,
): string {
	return `${notApprovableReasonCopy(reason, grantRoot)} You can only decline it here. If you want it done, run it yourself on ${hostLabel(host)}.`;
}

// ── outcomes ────────────────────────────────────────────────────────────────

interface OutcomeCtx {
	host: string;
	time: string | null;
}

const at = (time: string | null): string => (time ? ` at ${time}` : "");

const OUTCOME_LINES: Record<CodexApprovalOutcome, (ctx: OutcomeCtx) => string> = {
	sending_accept: ({ host }) => `Approved. Sending to ${host}…`,
	sending_decline: ({ host }) => `Declined. Telling ${host}…`,
	approved_sent: ({ host, time }) =>
		`Approved${at(time)} and sent to ${host}. The result appears in the timeline.`,
	declined: ({ time }) => `Declined${at(time)}. Nothing ran.`,
	declined_stopped: ({ time }) => `Declined${at(time)}, and the turn was stopped. Nothing ran.`,
	expired: ({ time }) =>
		`Nobody answered${time ? ` by ${time}` : ""}, so this was declined. Nothing ran.`,
	answer_lapsed: ({ host }) =>
		`You approved this, but it didn't reach ${host} in time, so it was declined. Nothing ran.`,
	answer_withdrawn: () =>
		"This was approved, but the approver's access ended before it was sent, so it was declined. Nothing ran.",
	revision_changed: () =>
		"Codex changed what it's asking after you approved, so it was declined. Nothing ran.",
	may_have_run: ({ host }) =>
		`Approved, but ${host} never confirmed. This may have run. Check the machine before asking again.`,
	turn_ended: () => "The turn ended before this was answered. Nothing ran.",
	codex_shut_down: () => "Codex shut down before this was answered. Nothing ran.",
	session_stopped: () => "The session stopped before this was answered. Nothing ran.",
	approved_then_stopped: () =>
		"You approved this, but the session was stopped before it was sent. Nothing ran.",
};

export function outcomeLine(
	outcome: CodexApprovalOutcome,
	host: string | null | undefined,
	time: string | null,
): string {
	return OUTCOME_LINES[outcome]({ host: hostLabel(host), time });
}

/** Which timestamp an outcome line quotes: when it was answered, or when the time ran out. */
export function outcomeTimeSource(
	outcome: CodexApprovalOutcome,
	approval: Pick<CodexApprovalSummary, "answeredAt" | "expiresAt">,
): string | null {
	switch (outcome) {
		case "approved_sent":
		case "declined":
		case "declined_stopped":
			return approval.answeredAt;
		case "expired":
			return approval.expiresAt;
		default:
			return null;
	}
}

/** The outcomes that are still being delivered; everything else is final. */
export function isOutcomeFinal(outcome: CodexApprovalOutcome): boolean {
	return outcome !== "sending_accept" && outcome !== "sending_decline";
}

// ── countdown ───────────────────────────────────────────────────────────────

/**
 * Seconds left, from the server's `expiresInSeconds` at the moment it was fetched. Both clocks are
 * `performance.now()` readings, because a phone's wall clock can be wrong by minutes.
 */
export function secondsLeft(expiresInSeconds: number, fetchedAtMs: number, nowMs: number): number {
	const left = expiresInSeconds - (nowMs - fetchedAtMs) / 1000;
	return Number.isFinite(left) ? Math.max(0, Math.ceil(left)) : 0;
}

export const SECONDS_UNDER_MINUTES = 2;

export function remainingLabel(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < SECONDS_UNDER_MINUTES * 60) return plural(seconds, "second", "seconds");
	return `${Math.ceil(seconds / 60)} min`;
}

export function countdownText(time: string | null, seconds: number): string {
	if (seconds <= 0) return "Declining now";
	return `Declines${time ? ` at ${time}` : ""} (${remainingLabel(seconds)})`;
}

/** Colour is never the only signal: this is true when the text should also read as urgent. */
export function isUrgent(seconds: number): boolean {
	return seconds < SECONDS_UNDER_MINUTES * 60;
}

/** The two-minute announcement fires once, on the tick that crosses the line. */
export function crossedTwoMinutes(previous: number, now: number): boolean {
	return previous > SECONDS_UNDER_MINUTES * 60 && now <= SECONDS_UNDER_MINUTES * 60 && now > 0;
}

// ── what a request says about itself ────────────────────────────────────────

export function requestHeading(
	approval: Pick<CodexApprovalSummary, "requestKind" | "preview">,
): string {
	if (approval.requestKind === "command") return "Codex asks to run a command";
	const n = approval.preview?.fileCount ?? 0;
	return n > 0
		? `Codex asks to change ${plural(n, "file", "files")}`
		: "Codex asks to change files";
}

/** `{host} · …/{dir}`: one truncated line for a phone. The full path is in the dialog. */
export function metaLine(host: string | null | undefined, cwd: string | null): string {
	const name = hostLabel(host);
	if (!cwd) return name;
	const parts = cwd.split(/[/\\]+/).filter(Boolean);
	if (parts.length === 0) return `${name} · ${cwd}`;
	const dir = parts[parts.length - 1];
	return parts.length === 1 ? `${name} · ${cwd}` : `${name} · …/${dir}`;
}

export function commandStats(command: string): string {
	const lines = command === "" ? 0 : command.split("\n").length;
	return `${plural(lines, "line", "lines")}, ${plural(command.length, "character", "characters")}`;
}

export const BLANK_RUN_MIN = 3;

/** Runs of blank lines drawn as a marker, so a gap can't push text out of sight. Nothing but blanks is replaced. */
export function markBlankRuns(text: string): string {
	const out: string[] = [];
	let run = 0;
	const flush = () => {
		if (run >= BLANK_RUN_MIN) out.push(`[${run} blank lines]`);
		else for (let i = 0; i < run; i++) out.push("");
		run = 0;
	};
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			run++;
		} else {
			flush();
			out.push(line);
		}
	}
	flush();
	return out.join("\n");
}

export const TAIL_LINES = 3;

/** The last lines of a command, as the confirm step shows them. */
export function commandTail(command: string): string {
	// Mark the blank runs first, so a gap of forty lines reads as a gap and doesn't use up the tail.
	return markBlankRuns(command).split("\n").slice(-TAIL_LINES).join("\n");
}

export const NON_ASCII_HINT = "Contains non-English letters";

export function outsideCwdText(cwd: string | null): string {
	return cwd
		? `This changes files outside ${cwd}.`
		: "This changes files outside the directory the request names.";
}

// ── file changes ────────────────────────────────────────────────────────────

const KIND_WORDS: Record<string, string> = {
	add: "New file",
	update: "Edit",
	delete: "Delete",
};

export function kindWord(kind: string): string {
	const k = kind.trim();
	return Object.hasOwn(KIND_WORDS, k) ? (KIND_WORDS[k] as string) : k || "Change";
}

/** `Edit /a/b`, or `Edit /a/b, moved to /a/c`. */
export function changeSummary(
	change: Pick<CodexApprovalPresentationChange, "path" | "kind" | "movePath">,
): string {
	const moved = change.movePath ? `, moved to ${change.movePath}` : "";
	return `${kindWord(change.kind)} ${change.path}${moved}`;
}

/**
 * Every line of a diff with its sign. A new file's content is all additions and a deleted file's is
 * all removals, so those lines get the sign here; an edit already carries its own signs (`+`, `-`,
 * a space for context, `@@` for a position), and a line with none of them gets a `?` so it can't pass
 * for context.
 */
export function signedDiffLines(kind: string, diff: string): string[] {
	if (diff === "") return [];
	const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
	const lines = body.split("\n");
	const k = kind.trim();
	if (k === "add") return lines.map((line) => `+${line}`);
	if (k === "delete") return lines.map((line) => `-${line}`);
	return lines.map((line) => (/^[+\- @\\]/.test(line) || line === "" ? line : `?${line}`));
}

export function filesSummary(
	changes: readonly Pick<CodexApprovalPresentationChange, "path" | "kind" | "movePath">[],
	shown = 5,
): { listed: string[]; more: string | null } {
	const listed = changes.slice(0, shown).map(changeSummary);
	const rest = changes.length - listed.length;
	return { listed, more: rest > 0 ? `and ${rest} more` : null };
}

// ── what is on screen: a pending row's frozen confirm ───────────────────────

/** What the person confirmed: the version they read, its hash and its revision. Only this hash is sent. */
export interface FrozenConfirm {
	approvalId: string;
	hash: string;
	revision: number;
	presentation: CodexApprovalPresentation;
	preview: CodexApprovalPreview | null;
	requestKind: CodexApprovalSummary["requestKind"];
}

/** The detail answers for the version the list just named; false means "reload before approving". */
export function detailMatchesRow(
	detail: CodexApprovalDetail | null,
	row: Pick<CodexApprovalSummary, "id" | "presentationHash" | "revision">,
): detail is CodexApprovalDetail & { presentation: CodexApprovalPresentation } {
	return (
		detail !== null &&
		detail.presentation !== null &&
		detail.approval.id === row.id &&
		detail.approval.presentationHash === row.presentationHash &&
		detail.approval.revision === row.revision
	);
}

export function freezeConfirm(detail: CodexApprovalDetail): FrozenConfirm | null {
	if (detail.presentation === null) return null;
	return {
		approvalId: detail.approval.id,
		hash: detail.approval.presentationHash,
		revision: detail.approval.revision,
		presentation: detail.presentation,
		preview: detail.approval.preview,
		requestKind: detail.approval.requestKind,
	};
}

export type MidConfirmEvent = "expired" | "revision_changed" | "answered_elsewhere" | "stopped";

/**
 * What changed under an open confirm, judged against the latest list. `null` means nothing did.
 * `current` is null when the row is no longer listed.
 */
export function midConfirmEvent(
	frozen: Pick<FrozenConfirm, "hash" | "revision">,
	current: Pick<CodexApprovalSummary, "state" | "outcome" | "presentationHash" | "revision"> | null,
	secondsRemaining: number,
): MidConfirmEvent | null {
	if (current === null) return "answered_elsewhere";
	if (current.state !== "pending") {
		if (current.outcome === "expired") return "expired";
		if (current.outcome === "session_stopped" || current.outcome === "approved_then_stopped") {
			return "stopped";
		}
		return "answered_elsewhere";
	}
	if (current.presentationHash !== frozen.hash || current.revision !== frozen.revision) {
		return "revision_changed";
	}
	if (secondsRemaining <= 0) return "expired";
	return null;
}

export interface MidConfirmView {
	text: string;
	/** The dialog's cancel button; confirm is disabled for every one of these. */
	cancelLabel: "Close" | "Back";
}

const MID_CONFIRM: Record<MidConfirmEvent, MidConfirmView> = {
	expired: {
		text: "Time ran out, so this was declined automatically. Nothing ran.",
		cancelLabel: "Close",
	},
	revision_changed: {
		text: "Codex changed what it's asking. Nothing was sent. Review the new version.",
		cancelLabel: "Back",
	},
	answered_elsewhere: { text: "This was already answered.", cancelLabel: "Close" },
	stopped: { text: "This session was stopped, so nothing was sent.", cancelLabel: "Close" },
};

export function midConfirmView(event: MidConfirmEvent): MidConfirmView {
	return MID_CONFIRM[event];
}

export interface ConfirmCopy {
	title: string;
	confirmLabel: string;
	cancelLabel: "Back";
	/** The lines under the command or the paths, in order. */
	closing: string[];
}

/** The confirm step's fixed words (6.4). `owner` is set only for an admin answering someone else's session. */
export function confirmCopy(input: {
	requestKind: CodexApprovalSummary["requestKind"];
	fileCount: number;
	host: string | null | undefined;
	declinesAt: string | null;
	owner?: string | null;
}): ConfirmCopy {
	const named = Boolean(input.host?.trim());
	const host = hostLabel(input.host);
	const closing = [
		"Runs once. AgentPulse can't undo it.",
		input.declinesAt
			? `If nobody answers, it's declined at ${input.declinesAt}.`
			: "If nobody answers, it's declined.",
	];
	if (input.owner) closing.unshift(`This is ${input.owner}'s session.`);
	if (input.requestKind === "command") {
		return {
			title: `Run this on ${host}?`,
			confirmLabel: named ? `Run on ${host}` : "Run it",
			cancelLabel: "Back",
			closing,
		};
	}
	const files = plural(input.fileCount, "file", "files");
	return {
		title: `Change ${files} on ${host}?`,
		confirmLabel: `Change ${files}`,
		cancelLabel: "Back",
		closing,
	};
}

export const STOP_CONFIRM_TITLE = "Decline and stop this turn?";
export const STOP_CONFIRM_BODY = "Codex stops what it's doing.";

/** The body of an answer: only an accept carries the hash, and it is the frozen one. */
export function decisionBody(
	decision: ApprovalDecision,
	frozen: Pick<FrozenConfirm, "hash"> | null,
): { decision: ApprovalDecision; presentationHash?: string } {
	return decision === "accept" && frozen
		? { decision, presentationHash: frozen.hash }
		: { decision };
}

// ── which rows stay on screen ───────────────────────────────────────────────

export interface RowSets {
	pending: CodexApprovalSummary[];
	settled: CodexApprovalSummary[];
}

/** Oldest first, so the card a person is looking at is the one that has waited longest and new ones queue behind it. */
export function splitRows(
	rows: readonly CodexApprovalSummary[],
	kept: ReadonlyMap<string, CodexApprovalSummary>,
	dismissed: ReadonlySet<string>,
): RowSets {
	const byId = new Map<string, CodexApprovalSummary>();
	for (const row of kept.values()) byId.set(row.id, row);
	for (const row of rows) byId.set(row.id, row);
	const pending: CodexApprovalSummary[] = [];
	const settled: CodexApprovalSummary[] = [];
	for (const row of byId.values()) {
		if (row.state === "pending") pending.push(row);
		else if (!dismissed.has(row.id)) settled.push(row);
	}
	const byAge = (a: CodexApprovalSummary, b: CodexApprovalSummary) =>
		a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
	return { pending: pending.sort(byAge), settled: settled.sort(byAge) };
}

/**
 * The rows the page keeps even after the server stops listing them. The server lists a closed row for
 * a few minutes; a `may_have_run` one is the one outcome a person must act on (go and look at the
 * machine), so it stays until they dismiss it.
 */
export function updateKept(
	kept: ReadonlyMap<string, CodexApprovalSummary>,
	rows: readonly CodexApprovalSummary[],
	dismissed: ReadonlySet<string>,
): Map<string, CodexApprovalSummary> {
	const next = new Map(kept);
	for (const row of rows) {
		if (row.outcome === "may_have_run" && !dismissed.has(row.id)) next.set(row.id, row);
		else if (next.has(row.id)) next.delete(row.id);
	}
	for (const id of dismissed) next.delete(id);
	return next;
}

/** Ids not seen pending before, in order. */
export function newlyPending(
	announced: ReadonlySet<string>,
	pending: readonly CodexApprovalSummary[],
): CodexApprovalSummary[] {
	return pending.filter((row) => !announced.has(row.id));
}

// ── refresh ─────────────────────────────────────────────────────────────────

export const REFRESH_DEBOUNCE_MS = 2000;

/** How long to hold a fetch so there is at most one every 2 s; 0 means go now. A forced fetch never waits. */
export function fetchDelayMs(sinceLastFetchMs: number, force: boolean): number {
	return force ? 0 : Math.max(0, REFRESH_DEBOUNCE_MS - sinceLastFetchMs);
}

/**
 * Whether a change to the session row (the 10 s poll, a live update) is a reason to fetch the list:
 * the open approval ids changed, or there is something on the list that could change. Never per tool call.
 */
export function shouldRefetchOnSession(input: {
	previousIds: readonly string[];
	ids: readonly string[];
	listHasRows: boolean;
	notOwner: boolean;
}): boolean {
	if (input.notOwner) return false;
	if (input.listHasRows) return true;
	return (
		input.previousIds.length !== input.ids.length ||
		input.previousIds.some((id, i) => id !== input.ids[i])
	);
}

// ── announcements and focus ─────────────────────────────────────────────────

export function arrivalAnnouncement(input: {
	requestKind: CodexApprovalSummary["requestKind"];
	fileCount: number;
	declinesAt: string | null;
	pendingCount: number;
}): string {
	if (input.pendingCount > 1) return `${input.pendingCount} requests need an answer.`;
	const asks =
		input.requestKind === "command"
			? "Codex asks to run a command."
			: `Codex asks to change ${plural(input.fileCount, "file", "files")}.`;
	return input.declinesAt ? `${asks} Declines at ${input.declinesAt}.` : asks;
}

export function twoMinuteAnnouncement(declinesAt: string | null): string {
	return `Two minutes left to answer.${declinesAt ? ` Declines at ${declinesAt}.` : ""}`;
}

export const approvalOutcomeFocusId = (id: string): string => `codex-approval-outcome-${id}`;
export const approvalHeadingId = (id: string): string => `codex-approval-heading-${id}`;
