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
	ClaudePeerTurnNotice,
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

// ── whose requests these are ────────────────────────────────────────────────

/**
 * The agent a card speaks about. Every function that names one takes it as its last parameter and defaults to
 * Codex, so a Codex session reads exactly as it did. A takeover fork of a Claude Code session is `claude`.
 */
export type ApprovalAgent = "codex" | "claude";
/** The mode the fork runs in, from its stored `forkPermissionBranch`: what applied to this session. */
export type ApprovalForkMode = "ask" | "restricted";

export function agentOfSession(agentType: string | null | undefined): ApprovalAgent {
	return agentType === "claude_code" ? "claude" : "codex";
}

export function forkModeOf(
	metadata: Record<string, unknown> | null | undefined,
): ApprovalForkMode | undefined {
	const value = metadata?.forkPermissionBranch;
	return value === "ask" || value === "restricted" ? value : undefined;
}

const AGENT_NAME: Record<ApprovalAgent, string> = { codex: "Codex", claude: "Claude" };
export const agentName = (agent: ApprovalAgent = "codex"): string => AGENT_NAME[agent];

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
	agent: ApprovalAgent = "codex",
): string | null {
	const name = hostLabel(host);
	const value = snapshot?.agentpulseApprovals;
	// A takeover fork's host proved Claude Code's version before it started, and says nothing in a snapshot.
	if (agent === "claude") return null;
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

export function teamNotOwnerHeading(
	owner: string | null | undefined,
	agent: ApprovalAgent = "codex",
): string {
	return `${agentName(agent)} is asking ${ownerLabelOr(owner)} for approval.`;
}
export function teamNotOwnerLine(owner: string | null | undefined): string {
	const name = ownerLabelOr(owner);
	return `Only ${name} or an admin can answer.`;
}

// ── not approvable ──────────────────────────────────────────────────────────

const NOT_APPROVABLE_COPY: Record<
	NotApprovableReason,
	(ctx: { root: string; name: string; host: string }) => string
> = {
	redacted: () =>
		"AgentPulse hid something that looks like a secret, so you can't see exactly what would run.",
	invisible_chars: () =>
		"This had hidden characters, removed from what's shown here. What would run isn't what you see.",
	padded_text: () =>
		"This has a long run of spaces or blank lines that could push part of it out of sight, so you can't be sure you're seeing all of it.",
	lookalike_text: () =>
		"This has characters that look like other characters or don't draw at all, so what you read may not be what would run.",
	too_long: () => "This is too long to review in full here.",
	no_diff: ({ name }) => `${name} didn't share the changes, so there's nothing to review.`,
	no_command: ({ name }) => `${name} didn't say what it would run, so there's nothing to review.`,
	no_cwd: ({ name }) => `${name} didn't say which directory this would run in.`,
	write_stdin: ({ name }) =>
		`${name} wants to type into a running process. AgentPulse doesn't approve that.`,
	network: ({ name }) =>
		`${name} is asking for network access, which is a different question from running this. AgentPulse doesn't grant that.`,
	grant_root: ({ root, name }) =>
		`${name} is asking to write anywhere under ${root} for the rest of the session. AgentPulse doesn't grant that.`,
	unknown_param: () =>
		"This request includes something AgentPulse doesn't recognize, so it can't show what approving would mean.",
	accept_not_offered: ({ name }) => `${name} isn't offering approval for this one.`,
	unknown_tool: () =>
		"AgentPulse hasn't seen this tool, so it can't show what approving would mean.",
	requires_interaction: () =>
		"This tool needs someone at the machine to work with it, which AgentPulse can't do.",
	symlink_target: ({ host }) => `This path points somewhere else on ${host}.`,
	input_not_stable: () =>
		"AgentPulse can't be sure it would send this back exactly as it arrived, so it can't show what approving would mean.",
	agent_memory: () => "Claude can't save memories in this session.",
	path_not_absolute: () =>
		"This path isn't a full path, so AgentPulse can't tell which file it means.",
};

const GRANT_ROOT_FALLBACK = "a directory";

/** Why this can't be approved, in a sentence. A reason this build doesn't know still says it can't be. */
export function notApprovableReasonCopy(
	reason: NotApprovableReason | null,
	grantRoot?: string | null,
	agent: ApprovalAgent = "codex",
	host?: string | null,
): string {
	if (reason === null || !Object.hasOwn(NOT_APPROVABLE_COPY, reason)) {
		return "AgentPulse can't show this in a way that's safe to approve.";
	}
	return NOT_APPROVABLE_COPY[reason]({
		root: grantRoot?.trim() || GRANT_ROOT_FALLBACK,
		name: agentName(agent),
		host: hostLabel(host),
	});
}

/** The card's text for a row that can only be declined: the reason, then what to do about it. */
export function notApprovableText(
	reason: NotApprovableReason | null,
	host: string | null | undefined,
	grantRoot?: string | null,
	agent: ApprovalAgent = "codex",
): string {
	const why = `${notApprovableReasonCopy(reason, grantRoot, agent, host)} You can only decline it here.`;
	// A Claude fork's reasons are mostly about what AgentPulse won't do for Claude (memories, tools it hasn't seen),
	// where "run it yourself" would be advice to bypass them.
	return agent === "claude"
		? why
		: `${why} If you want it done, run it yourself on ${hostLabel(host)}.`;
}

// ── outcomes ────────────────────────────────────────────────────────────────

interface OutcomeCtx {
	host: string;
	time: string | null;
	decision: ApprovalDecision | null;
	agent: ApprovalAgent;
	mode?: ApprovalForkMode;
}

/** The first words of the line for an answer that may have run. The card draws them in bold. */
export const MAY_HAVE_RUN_LEAD = "This may have run.";

const at = (time: string | null): string => (time ? ` at ${time}` : "");

const OUTCOME_LINES: Record<CodexApprovalOutcome, (ctx: OutcomeCtx) => string> = {
	// The accept is stored and may already have been issued, so this never says "sending".
	sending_accept: ({ host }) =>
		`Approved and on its way to ${host}. It may already be running. The result appears in the timeline.`,
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
	revision_changed: ({ agent }) =>
		`${agentName(agent)} changed what it's asking after you approved, so it was declined. Nothing ran.`,
	may_have_run: ({ host }) =>
		`${MAY_HAVE_RUN_LEAD} Approved, but ${host} never confirmed. Check the machine before asking again.`,
	turn_ended: ({ decision }) =>
		decision === "accept"
			? "You approved this, but the turn ended before it was sent. Nothing ran."
			: "The turn ended before this was answered. Nothing ran.",
	codex_shut_down: ({ decision, agent }) => {
		// The outcome keeps its stored name (a rename would break every client that decodes it); a Claude
		// fork says it stopped running.
		if (agent === "claude") {
			return decision === "accept"
				? "You approved this, but Claude stopped running before it was sent. That request didn't run."
				: "Claude stopped running before this was answered. That request didn't run.";
		}
		return decision === "accept"
			? "You approved this, but Codex shut down before it was sent. Nothing ran."
			: "Codex shut down before this was answered. Nothing ran.";
	},
	session_stopped: () => "The session stopped before this was answered. Nothing ran.",
	approved_then_stopped: () =>
		"You approved this, but the session was stopped before it was sent. Nothing ran.",
	// A rule, a hook or the harness decided before the person did; whether it ran is unknown (AGEN-117 T10).
	decided_elsewhere: ({ host, mode }) =>
		mode === "restricted"
			? `${MAY_HAVE_RUN_LEAD} Something on ${host} answered before you did. Check the machine before asking again.`
			: `${MAY_HAVE_RUN_LEAD} Something on ${host} answered before you did, most likely a rule or hook in your Claude settings. Check the machine before asking again.`,
};

export function outcomeLine(
	outcome: CodexApprovalOutcome,
	host: string | null | undefined,
	time: string | null,
	decision: ApprovalDecision | null = null,
	agent: ApprovalAgent = "codex",
	mode?: ApprovalForkMode,
): string {
	// An outcome this build doesn't know (a newer server) still reads whole, and claims nothing about what ran.
	if (!Object.hasOwn(OUTCOME_LINES, outcome))
		return "This request has closed. Check the machine before asking again.";
	return OUTCOME_LINES[outcome]({ host: hostLabel(host), time, decision, agent, mode });
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
	agent: ApprovalAgent = "codex",
): string {
	const name = agentName(agent);
	if (approval.requestKind === "command") return `${name} asks to run a command`;
	if (approval.requestKind === "claude_tool") {
		const target = approval.preview?.target;
		const verb = approval.preview?.tool === "Read" ? "read" : "fetch";
		return target ? `${name} asks to ${verb} ${target}` : `${name} asks to ${verb} something`;
	}
	const n = approval.preview?.fileCount ?? 0;
	return n > 0
		? `${name} asks to change ${plural(n, "file", "files")}`
		: `${name} asks to change files`;
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

export function statsText(lines: number, characters: number): string {
	return `${plural(lines, "line", "lines")}, ${plural(characters, "character", "characters")}`;
}

export function commandStats(command: string): string {
	return statsText(command === "" ? 0 : command.split("\n").length, command.length);
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
export const TAIL_MAX_CHARS = 600;

export interface CommandTail {
	/** Never more than `TAIL_MAX_CHARS` plus the leading mark, so the box needs no scrolling. */
	text: string;
	/** Says how much of the command this is, or null when it is all of it. */
	label: string | null;
}

/** The end of a command, as the confirm step shows it: the last lines, and no more than the last 600 characters of them. */
export function commandTail(command: string): CommandTail {
	// Mark the blank runs first, so a gap of forty lines reads as a gap and doesn't use up the tail.
	const lines = markBlankRuns(command).split("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	const cut = tail.length > TAIL_MAX_CHARS;
	const text = cut ? `…${tail.slice(-TAIL_MAX_CHARS)}` : tail;
	if (cut)
		return { text, label: lines.length === 1 ? "End of the line:" : "End of the last lines:" };
	return {
		text,
		label: lines.length > TAIL_LINES ? `Last ${TAIL_LINES} of ${lines.length} lines:` : null,
	};
}

export const NON_ASCII_HINT = "Contains characters outside plain English text.";

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
	// A takeover fork's Write: over an existing file, or with no way to tell (the check on the machine failed).
	write: "Replace",
	write_unchecked: "Write",
};

/** What a Claude Write does to its file, in a sentence, for the card under the path. Null for any other kind. */
export function writeKindNote(kind: string): string | null {
	switch (kind.trim()) {
		case "write":
			return "Replaces this file. What it replaces isn't shown.";
		case "add":
			return "New file.";
		case "write_unchecked":
			return "Writes this file, replacing it if it exists.";
		default:
			return null;
	}
}

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
	if (k === "add" || k === "write" || k === "write_unchecked")
		return lines.map((line) => `+${line}`);
	if (k === "delete") return lines.map((line) => `-${line}`);
	return lines.map((line) => (/^[+\- @\\]/.test(line) || line === "" ? line : `?${line}`));
}

export const OUTSIDE_LABEL = "Outside the working directory";
export const OUTSIDE_MARK = `${OUTSIDE_LABEL}:`;

/** Display order of the changed files: the ones outside the working directory first, otherwise as sent. */
export function outsideFirst(count: number, outsideCwd: readonly boolean[] | null): number[] {
	const order = Array.from({ length: count }, (_, i) => i);
	if (!outsideCwd || outsideCwd.length !== count) return order;
	return [
		...order.filter((i) => outsideCwd[i] === true),
		...order.filter((i) => outsideCwd[i] !== true),
	];
}

/** The one line for a changed file; one the server says is outside the working directory says so first. */
export function changeLine(
	change: Pick<CodexApprovalPresentationChange, "path" | "kind" | "movePath">,
	outside: boolean,
): string {
	return outside ? `${OUTSIDE_MARK} ${changeSummary(change)}` : changeSummary(change);
}

/**
 * The files the confirm step lists, the ones outside the working directory first, so a risky file
 * is never the one behind "and N more". `outsideCwd` is the detail's per-file flags; absent
 * (an older server) or of another length, nothing is marked or moved.
 */
export function filesSummary(
	changes: readonly Pick<CodexApprovalPresentationChange, "path" | "kind" | "movePath">[],
	outsideCwd: readonly boolean[] | null = null,
	shown = 5,
): { listed: string[]; more: string | null } {
	const flags = outsideCwd && outsideCwd.length === changes.length ? outsideCwd : null;
	const listed = outsideFirst(changes.length, flags)
		.slice(0, shown)
		.map((i) => changeLine(changes[i] as (typeof changes)[number], flags?.[i] === true));
	const rest = changes.length - listed.length;
	return { listed, more: rest > 0 ? `and ${rest} more` : null };
}

/** Added and removed lines of a change, counted on what the card draws. */
export function diffDelta(kind: string, diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of signedDiffLines(kind, diff)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** `+12 −3`, or null for a change that carries no diff. */
export function diffDeltaLabel(kind: string, diff: string): string | null {
	if (diff === "") return null;
	const { added, removed } = diffDelta(kind, diff);
	return `+${added} \u2212${removed}`;
}

export const OPEN_ALL_MAX_FILES = 3;
export const OPEN_ALL_MAX_DIFF_CHARS = 2000;

/**
 * Which diffs start open. A person can't approve what they haven't been shown, so a short request
 * opens everything; a long one opens the first and says how much each of the others changes.
 */
export function defaultDiffsOpen(
	changes: readonly Pick<CodexApprovalPresentationChange, "diff">[],
): boolean[] {
	const total = changes.reduce((sum, change) => sum + change.diff.length, 0);
	const all = changes.length <= OPEN_ALL_MAX_FILES || total <= OPEN_ALL_MAX_DIFF_CHARS;
	return changes.map((_, i) => all || i === 0);
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
	/** Per file, from the detail; null when the server didn't say (an older one). */
	outsideCwd: boolean[] | null;
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
		outsideCwd: Array.isArray(detail.outsideCwd) ? [...detail.outsideCwd] : null,
	};
}

export type MidConfirmEvent = "time_up" | "revision_changed" | "closed";

/**
 * What changed under an open confirm, judged against the latest list. `null` means nothing did.
 * `current` is null when the row is no longer listed. The page's clock reaching zero is `time_up`
 * and claims nothing about what happened: only the server's row says an answer was declined.
 */
export function midConfirmEvent(
	frozen: Pick<FrozenConfirm, "hash" | "revision">,
	current: Pick<CodexApprovalSummary, "state" | "presentationHash" | "revision"> | null,
	secondsRemaining: number,
): MidConfirmEvent | null {
	if (current === null || current.state !== "pending") return "closed";
	if (current.presentationHash !== frozen.hash || current.revision !== frozen.revision) {
		return "revision_changed";
	}
	if (secondsRemaining <= 0) return "time_up";
	return null;
}

export interface MidConfirmView {
	text: string;
	/** The dialog's cancel button; confirm is disabled for every one of these. */
	cancelLabel: "Close" | "Back";
}

export const TIME_UP_TEXT = "Time ran out. Checking what happened.";
export const CLOSED_TEXT = "This request is no longer open.";

/** The dialog's line for each event. A closed row speaks in its own outcome, never in a guess. */
export function midConfirmView(
	event: MidConfirmEvent,
	row: Pick<CodexApprovalSummary, "outcome" | "decision" | "answeredAt" | "expiresAt"> | null,
	host: string | null | undefined,
	time: (stored: string | null) => string | null,
	agent: ApprovalAgent = "codex",
	mode?: ApprovalForkMode,
): MidConfirmView {
	switch (event) {
		case "time_up":
			return { text: TIME_UP_TEXT, cancelLabel: "Close" };
		case "revision_changed":
			return {
				text: `${agentName(agent)} changed what it's asking. Nothing was sent. Review the new version.`,
				cancelLabel: "Back",
			};
		case "closed":
			return {
				text: row?.outcome
					? outcomeLine(
							row.outcome,
							host,
							time(outcomeTimeSource(row.outcome, row)),
							row.decision,
							agent,
							mode,
						)
					: CLOSED_TEXT,
				cancelLabel: "Close",
			};
	}
}

/** Taps on a confirm button or a card's buttons are ignored this long after it appears. */
export const ARM_AFTER_MS = 700;

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
	/** A Claude request's tool, for a `claude_tool` card. */
	tool?: string;
	/** The kind of the one file a Claude Write changes (`write`, `add`, `write_unchecked`), for its title. */
	writeKind?: string | null;
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
	if (input.requestKind === "claude_tool") {
		const read = input.tool === "Read";
		return {
			title: read ? "Let Claude read this file?" : `Fetch this URL from ${host}?`,
			confirmLabel: read ? "Allow reading it" : "Fetch it",
			cancelLabel: "Back",
			closing: read
				? ["Claude will see what's in it. Runs once.", ...closing.slice(1)]
				: ["A URL can carry data out. Runs once.", ...closing.slice(1)],
		};
	}
	if (
		input.writeKind === "write" ||
		input.writeKind === "add" ||
		input.writeKind === "write_unchecked"
	) {
		const [title, confirmLabel] =
			input.writeKind === "write"
				? [`Replace this file on ${host}?`, "Replace it"]
				: input.writeKind === "add"
					? [`Create this file on ${host}?`, "Create it"]
					: [`Write this file on ${host}?`, "Write it"];
		return { title, confirmLabel, cancelLabel: "Back", closing };
	}
	if (input.fileCount <= 0) {
		return {
			title: `Change files on ${host}?`,
			confirmLabel: "Change files",
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
export const stopConfirmBody = (agent: ApprovalAgent = "codex"): string =>
	`${agentName(agent)} stops what it's doing.`;

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
		if (
			(row.outcome === "may_have_run" || row.outcome === "decided_elsewhere") &&
			!dismissed.has(row.id)
		)
			next.set(row.id, row);
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
	agent?: ApprovalAgent;
	/** A `claude_tool` request's tool: spoken without its target, which can be a long URL or path. */
	tool?: string;
}): string {
	if (input.pendingCount > 1) return `${input.pendingCount} requests need an answer.`;
	const name = agentName(input.agent ?? "codex");
	const asks =
		input.requestKind === "command"
			? `${name} asks to run a command.`
			: input.requestKind === "claude_tool"
				? `${name} asks to ${input.tool === "Read" ? "read a file" : "fetch a URL"}.`
				: `${name} asks to change ${plural(input.fileCount, "file", "files")}.`;
	return input.declinesAt ? `${asks} Declines at ${input.declinesAt}.` : asks;
}

export function twoMinuteAnnouncement(declinesAt: string | null): string {
	return `Two minutes left to answer.${declinesAt ? ` Declines at ${declinesAt}.` : ""}`;
}

export const approvalOutcomeFocusId = (id: string): string => `codex-approval-outcome-${id}`;
export const approvalHeadingId = (id: string): string => `codex-approval-heading-${id}`;

export const REVISION_CHANGED_LINE = "Codex changed what it's asking. Read it again.";
export const revisionChangedLine = (agent: ApprovalAgent = "codex"): string =>
	`${agentName(agent)} changed what it's asking. Read it again.`;
export const NEXT_REQUEST_LINE = "Next request. The last one is shown below.";
export const CHECK_FAILED_TEXT =
	"AgentPulse couldn't confirm your answer went through, and couldn't check either. Check again before answering.";
export const STILL_OPEN_TEXT =
	"AgentPulse checked. This is still open, so your answer didn't go through. Nothing was sent.";

/**
 * "2 of 3": the request's place among those seen in this run of requests. `seen` is every id shown
 * pending since the run began; an answered one still counts, so the number only moves forward.
 */
export function queuePosition(
	seen: ReadonlySet<string>,
	pendingIds: readonly string[],
): { index: number; total: number; universe: Set<string> } {
	const universe = new Set([...seen, ...pendingIds]);
	return { index: universe.size - pendingIds.length + 1, total: universe.size, universe };
}

// ── what the person already dismissed ───────────────────────────────────────

const DISMISSED_KEEP = 100;
export const dismissedStorageKey = (sessionId: string): string =>
	`agentpulse.codexApprovals.dismissed.${sessionId}`;

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;

/** Ids dismissed on this browser; anything unreadable is nothing dismissed. */
export function readDismissed(store: ReadStore | null, sessionId: string): Set<string> {
	try {
		const parsed: unknown = JSON.parse(store?.getItem(dismissedStorageKey(sessionId)) ?? "[]");
		return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
	} catch {
		return new Set();
	}
}

/** Remembers the newest hundred; a store that refuses is ignored, since the dismissal still holds for this page. */
export function writeDismissed(
	store: WriteStore | null,
	sessionId: string,
	ids: Iterable<string>,
): void {
	try {
		store?.setItem(dismissedStorageKey(sessionId), JSON.stringify([...ids].slice(-DISMISSED_KEEP)));
	} catch {
		// Private mode or a full quota: the page still hides it.
	}
}

/**
 * Whether the card may say the host can't answer approvals ("update the supervisor"). Not while the session is
 * being taken over or resumed (`pending`) or has lost its process (`degraded`): its state is the slot's to say,
 * and the host's capability snapshot describes a runtime that isn't there.
 */
export function showsAvailabilityHint(
	managedSession: { managedState?: string | null } | null | undefined,
): boolean {
	const state = managedSession?.managedState;
	return state !== "pending" && state !== "degraded";
}

// ── focus when a request closes by itself ───────────────────────────────────

/**
 * Where focus goes when a request closes while it was inside the card (the server's row, a cancel, the turn
 * ending): the focused button is gone, so focus would fall to the page. The outcome line of the first request
 * that closed takes it, else the heading of the one now showing; nothing when focus wasn't inside, when an
 * answer already asked for a landing, or when focus is still somewhere real. Pure, so it is tested without a
 * DOM; the card passes in what it can see and looks the ids up.
 */
export function focusAfterClose(input: {
	previousPendingIds: readonly string[];
	pendingIds: readonly string[];
	focusWasInside: boolean;
	landingRequested: boolean;
	focusLost: boolean;
	currentId: string | null;
}): { outcomeId: string; fallbackHeadingId: string | null } | null {
	const closed = input.previousPendingIds.filter((id) => !input.pendingIds.includes(id));
	if (closed.length === 0 || input.landingRequested || !input.focusWasInside || !input.focusLost) {
		return null;
	}
	return {
		outcomeId: approvalOutcomeFocusId(closed[0] as string),
		fallbackHeadingId: input.currentId ? approvalHeadingId(input.currentId) : null,
	};
}

// ── a message something else sent the session ───────────────────────────────

/**
 * The lines for a fork that was stopped because something other than AgentPulse sent it a message (T3): the
 * owner's or an admin's read only, since that is who the server returns the notice to. The text is whatever
 * the server kept after redaction, or, if redaction changed anything, nothing but the reason it is hidden.
 */
export function peerTurnLines(
	peer: ClaudePeerTurnNotice | undefined | null,
	host: string | null | undefined,
): string[] | null {
	if (!peer) return null;
	const lead = `Something else on ${hostLabel(host)} sent this session a message, so AgentPulse stopped it.`;
	if (peer.hidden || peer.text === null) {
		return [lead, "AgentPulse is hiding it because it may hold a secret."];
	}
	return [lead, `The message: ${peer.text}`];
}
