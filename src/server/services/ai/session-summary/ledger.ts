/**
 * AGEN-69: turns the rows the evidence loader read into the "ledger" the model
 * sees: one line per entry, each line starting with the ids a summary may cite.
 * Pure. Hides labelling (OBSERVED vs CLAIMED), command classification,
 * collapsing, redact-then-cap, the character budget's drop order and the
 * coverage arithmetic.
 *
 * Every field that reaches the text is allowlisted by construction: this file
 * reads only the named columns of `EvidenceRow`, and each one goes through
 * `field()` (invisible characters stripped, redacted, neutralised, capped; in
 * that order).
 */
import { parseDbTimestamp } from "../../util/db-time.js";
import { type RedactionRule, stripAndRedact } from "../redactor.js";
import { formatUntrustedInline } from "../untrusted-text.js";
import {
	type CommandClass,
	classifyCommand,
	passSummaryLine,
	patchFilesOf,
	validationResult,
} from "./command-class.js";
import {
	AGENT_MESSAGE_CAP,
	COMMAND_CAP,
	DESCRIPTION_CAP,
	EDIT_TOOLS,
	FAILURE_EVENT_AGENTS,
	FIRST_PROMPT_CAP,
	FIRST_PROMPT_COUNT,
	LAST_AGENT_MESSAGE_CAP,
	LEDGER_CHAR_BUDGET,
	LEDGER_PROTECTED_TAIL,
	LEDGER_SLICE_ROWS,
	MAX_IDS_PER_ENTRY,
	ONE_LINER_CAP,
	OUTPUT_HEAD,
	OUTPUT_TAIL,
	PATH_CAP,
	PROMPT_CAP,
	READ_CLASS_TOOLS,
	SHELL_TOOLS,
	TOP_FILES,
} from "./limits.js";
import { readResponse } from "./response-text.js";

// ── types ────────────────────────────────────────────────────────────────────

/** One event as the loader selected it; every text field is already cut in SQL. */
export interface EvidenceRow {
	id: number;
	createdAt: string;
	eventType: string;
	category: string | null;
	toolName: string | null;
	/**
	 * Narrative text as SQL cut it: PROMPT_CAP / AGENT_MESSAGE_CAP / ONE_LINER_CAP plus
	 * SQL_REDACTION_MARGIN code points (first prompts: FIRST_PROMPT_CAP plus the margin). The
	 * ledger caps it further and never mutates the row, so a caller holding the bundle sees
	 * this longer, still-unredacted text (phase 4 extracts typed URLs from it). Redact before sending.
	 */
	content: string | null;
	filePath: string | null;
	command: string | null;
	description: string | null;
	/** The stored response (cut to 2,000 characters in SQL), only for a shell-tool row. */
	response: string | null;
	/** The last 2,000 characters of the response, or the failure's `error` text, only for a failed tool row. */
	responseTail: string | null;
}

/** What the scan did, for the coverage arithmetic. */
export interface ScanSummary {
	eventsTotal: number;
	eventsRead: number;
	/** Rows the scan read that belong in a ledger (not read-class, not `user_ack`, not system noise). */
	eligibleRead: number;
	/** Eligible rows a row cap (spine 300, action 800, 350 per chunk) left out. */
	droppedByCap: number;
	reachedFirstEvent: boolean;
	/** The time of the oldest event the scan read; used only when it ended early. */
	oldestReadAt: string | null;
}

export interface LedgerInput {
	rows: EvidenceRow[];
	firstPromptRows: EvidenceRow[];
	scan: ScanSummary;
	/**
	 * The session's agent type. An agent with a failure event (claude_code,
	 * copilot_cli) makes PostToolUse evidence of success; for any other value, or
	 * none, a result is ok or FAILED only when the response carries an exit code.
	 */
	agentType?: string | null;
	/** The operator's own redaction rules, applied after the defaults (as the watcher does). */
	redactionRules?: RedactionRule[];
}

export type FactKind =
	| "prompt"
	| "agent_message"
	| "edit"
	| "command"
	| "validation"
	| "tool"
	| "event";

/**
 * What may be said about a cited id: no text, ever. `completed` is the result
 * of a call the evidence does not show to have succeeded or failed.
 */
export interface EvidenceFact {
	kind: FactKind;
	at: string | null;
	result?: "ok" | "failed" | "unknown" | "completed";
	count?: number;
}

/** A cited id as the ledger knows it: the fact, and whether it records something the system saw. */
export interface LedgerIdInfo extends EvidenceFact {
	/** OBSERVED (true) or CLAIMED (false). Not part of the stored fact: see `storedFact`. */
	observed: boolean;
}

/** The evidence fact to store for an id: the fields of the fact, without `observed`. */
export function storedFact(info: LedgerIdInfo | EvidenceFact): EvidenceFact {
	const { observed: _observed, ...fact } = info as LedgerIdInfo;
	return fact;
}

export type EntryKind = "user_prompt" | "agent_message" | "edit" | "command" | "tool" | "one_liner";

export interface LedgerEntry {
	kind: EntryKind;
	/** The line, ids first. */
	text: string;
	/** Every event this entry stands for. */
	eventCount: number;
	/** The ids printed in `text`, and so the ids a summary may cite. */
	shownIds: number[];
	/** OBSERVED (the system saw or did it) versus CLAIMED (a person or a model said it). */
	observed: boolean;
}

/**
 * An interior omission is described by `droppedByCap` and `droppedByBudget`
 * (tool calls or events the summary may say were left out), never by "n of m
 * events read": once the scan reached the first event, `eventsRead` is the
 * total. `eventsRead` is a measure of the scan, not wording for the summary.
 */
export interface Coverage {
	status: "full" | "partial";
	eventsTotal: number;
	/** Events the scan covered; a scan measure, not a description. */
	eventsRead: number;
	eventsRepresented: number;
	droppedByCap: number;
	droppedByBudget: number;
	/** ISO-8601, set only when the scan ended before the session's first event; null for an interior omission. */
	cutoffAt: string | null;
}

export interface LedgerCounts {
	prompts: number;
	commands: number;
	failedCommands: number;
	permissionRequests: number;
	editedFiles: number;
	editsByFile: Array<{ path: string; count: number }>;
}

export interface Ledger {
	/** The entry lines, newest last, joined by newlines. Not fenced. */
	text: string;
	ids: Map<string, LedgerIdInfo>;
	entries: LedgerEntry[];
	coverage: Coverage;
	counts: LedgerCounts;
	/** Redactions in the text that is in `text` (not in entries the budget dropped), once per collapsed entry. */
	redactionHits: number;
	/** True when the protected entries alone exceed the budget (not reachable at the limits' defaults). */
	overBudget: boolean;
	diagnostics: { buildMs: number; slices: number; maxSliceMs: number };
}

// ── text handling ────────────────────────────────────────────────────────────

const MARK_RE = /^\p{M}$/u;

/** The first `n` code points; an astral character or a mark sequence is kept or dropped whole. */
function takeStart(text: string, n: number): { text: string; cut: boolean } {
	const points = Array.from(text);
	if (points.length <= n) return { text, cut: false };
	let end = n;
	while (end > 0 && MARK_RE.test(points[end] as string)) end--;
	return { text: points.slice(0, end).join(""), cut: true };
}

function takeEnd(text: string, n: number): { text: string; cut: boolean } {
	const points = Array.from(text);
	if (points.length <= n) return { text, cut: false };
	let start = points.length - n;
	while (start < points.length && MARK_RE.test(points[start] as string)) start++;
	return { text: points.slice(start).join(""), cut: true };
}

interface Ctx {
	hits: number;
	rules: RedactionRule[];
}

/** The closing-quote lookalike put in place of a `"` inside a quoted field. */
const QUOTE_LOOKALIKE = "”";

/**
 * Strip invisibles, redact (defaults, then the operator's rules), neutralise
 * (one line, no angle brackets). The order is required: redacting first lets a
 * secret split by an invisible character through (see `stripAndRedact`). Every
 * text field reaches the ledger through here and nowhere else, so nothing taken
 * from a tool's input or response is ever written unredacted. A `"` becomes a
 * lookalike in every field that is printed between double quotes, so a field
 * cannot close its own quotes and forge the rest of the line; a command is
 * printed between backticks (replaced here) and keeps its quotes.
 */
function clean(raw: string, ctx: Ctx, inQuotes: boolean): string {
	const redacted = stripAndRedact(raw, ctx.rules);
	ctx.hits += redacted.hits.length;
	const line = formatUntrustedInline(redacted.text).replace(/`/g, "'");
	return inQuotes ? line.replace(/"/g, QUOTE_LOOKALIKE) : line;
}

/** `clean`, then cut to `cap` code points; a longer value ends in an ellipsis. */
function field(raw: string | null | undefined, cap: number, ctx: Ctx, inQuotes = true): string {
	if (!raw) return "";
	const { text, cut } = takeStart(clean(raw, ctx, inQuotes), cap);
	return cut ? `${text}…` : text;
}

function excerpt(raw: string, ctx: Ctx): string {
	const text = clean(raw, ctx, true).trim();
	if (Array.from(text).length <= OUTPUT_HEAD + OUTPUT_TAIL) return text;
	return `${takeStart(text, OUTPUT_HEAD).text} … ${takeEnd(text, OUTPUT_TAIL).text}`;
}

function clock(createdAt: string): { hhmm: string; iso: string | null } {
	const ms = parseDbTimestamp(createdAt);
	if (ms === null) return { hhmm: "--:--", iso: null };
	const date = new Date(ms);
	return { hhmm: date.toISOString().slice(11, 16), iso: date.toISOString() };
}

// ── classification ───────────────────────────────────────────────────────────

type RowClass =
	| { kind: "skip" }
	| { kind: "prompt" }
	| { kind: "agent_message" }
	| { kind: "one_liner"; label: string; observed: boolean }
	| { kind: "edit" }
	| { kind: "shell" }
	| { kind: "tool"; name: string };

// OBSERVED is what the system itself did or saw; CLAIMED is what a person or a
// model wrote (ruling R-C). The `ai_*` rows, one by one:
//   ai_proposal_pending  CLAIMED   model-written proposal text
//   ai_proposal          CLAIMED   model-written proposal text
//   ai_report            CLAIMED   model-written report
//   ai_hitl_request      CLAIMED   model-written question to the operator
//   ai_hitl_response     OBSERVED  the operator's recorded decision
//   ai_continue_sent     CLAIMED   model-written continuation prompt
//   ai_continue_blocked  OBSERVED  the system's own refusal
//   ai_error             OBSERVED  the system's own error
//   any other ai_*       CLAIMED   unknown content is not observation
const AI_CATEGORY_OBSERVED: Record<string, boolean> = {
	ai_hitl_response: true,
	ai_continue_blocked: true,
	ai_error: true,
};

const ONE_LINER_LABELS: Record<string, { label: string; observed: boolean }> = {
	permission_event: { label: "permission", observed: true },
	plan_update: { label: "plan", observed: false },
	status_update: { label: "status", observed: false },
	progress_update: { label: "progress", observed: false },
};

const READ_CLASS = new Set(READ_CLASS_TOOLS);
const EDITS = new Set(EDIT_TOOLS);
const SHELLS = new Set(SHELL_TOOLS);

function classifyRow(row: EvidenceRow): RowClass {
	const category =
		row.category ??
		(row.eventType === "UserPromptSubmit"
			? "prompt"
			: row.eventType === "PostToolUse" || row.eventType === "PostToolUseFailure"
				? "tool_event"
				: row.eventType === "AssistantMessage"
					? "assistant_message"
					: null);
	if (category === "prompt") return { kind: "prompt" };
	if (category === "assistant_message") return { kind: "agent_message" };
	const oneLiner = category ? ONE_LINER_LABELS[category] : undefined;
	if (oneLiner) return { kind: "one_liner", ...oneLiner };
	if (category?.startsWith("ai_")) {
		return {
			kind: "one_liner",
			label: "ai event",
			observed: AI_CATEGORY_OBSERVED[category] === true,
		};
	}
	if (category === "tool_event") {
		if (row.eventType !== "PostToolUse" && row.eventType !== "PostToolUseFailure") {
			return { kind: "skip" };
		}
		const name = (row.toolName ?? "").toLowerCase();
		if (READ_CLASS.has(name)) return { kind: "skip" };
		if (EDITS.has(name)) return { kind: "edit" };
		if (SHELLS.has(name)) return { kind: "shell" };
		return { kind: "tool", name: row.toolName ?? "" };
	}
	return { kind: "skip" };
}

// ── entries ──────────────────────────────────────────────────────────────────

type Status = "ok" | "failed" | "completed";

interface Draft {
	kind: EntryKind;
	rowIds: number[];
	at: ReturnType<typeof clock>;
	/** Everything after "<ids> <time> ". */
	body: string;
	fact: Omit<EvidenceFact, "at">;
	observed: boolean;
	/** Edits collapse only with the same file and the same status. */
	collapseKey: string | null;
	firstPrompt: boolean;
	/** The cleaned paths an edit names, for the per-file counts. */
	editPaths: string[];
	/** Redactions made in this entry's text. */
	hits: number;
	isCommand: boolean;
	failed: boolean;
}

function resultWord(result: Status | "ok" | "failed" | "unknown" | "completed"): string {
	return result === "failed" ? "FAILED" : result;
}

/**
 * ok or FAILED only when the evidence says so. A failure event is failed; for an
 * agent that has failure events, a PostToolUse is evidence of success. For any
 * other agent the response must carry an exit code; without one the call is
 * `completed`, which claims nothing.
 */
function statusOf(row: EvidenceRow, hasFailureEvent: boolean): Status {
	if (row.eventType === "PostToolUseFailure") return "failed";
	if (hasFailureEvent) return "ok";
	const { exitCode } = readResponse(row.response);
	if (exitCode === null) return "completed";
	return exitCode === 0 ? "ok" : "failed";
}

interface Rendered {
	body: string;
	fact: Draft["fact"];
}

function commandFact(kind: FactKind, result: EvidenceFact["result"]): Draft["fact"] {
	return { kind, result };
}

function renderShell(row: EvidenceRow, status: Status, cls: CommandClass, ctx: Ctx): Rendered {
	if (cls.kind === "withheld") {
		return {
			body: `OBSERVED command [withheld: reads credentials] -> ${resultWord(status)}`,
			fact: commandFact("command", status),
		};
	}
	if (cls.kind === "not_shown" || cls.kind === "patch") {
		return {
			body: `OBSERVED command [not shown] -> ${resultWord(status)}`,
			fact: commandFact("command", status),
		};
	}
	const command = field(row.command, COMMAND_CAP, ctx, false);
	const description = row.description
		? ` (desc "${field(row.description, DESCRIPTION_CAP, ctx)}")`
		: "";
	const read = readResponse(row.response ?? row.responseTail);
	if (cls.kind === "validation") {
		const result = validationResult(
			read.text,
			status === "failed",
			cls.masked,
			status === "completed",
		);
		let out = "";
		if (result === "failed" && read.text) out = `: "${excerpt(read.text, ctx)}"`;
		else if (result === "ok") {
			const line = passSummaryLine(read.text);
			if (line) out = `: "${line}"`;
		}
		return {
			body: `OBSERVED command [validation] \`${command}\`${description} -> ${resultWord(result)}${out}`,
			fact: commandFact("validation", result),
		};
	}
	return {
		body: `OBSERVED command \`${command}\`${description} -> ${resultWord(status)}`,
		fact: commandFact("command", status),
	};
}

function toolLabel(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
	return safe || "unknown";
}

const MAX_PATCH_FILES_SHOWN = 10;

/** The cleaned, capped paths an edit entry names (at most MAX_PATCH_FILES_SHOWN), and the rest counted. */
function cleanPaths(paths: string[], ctx: Ctx): { shown: string[]; more: number } {
	const shown = paths
		.slice(0, MAX_PATCH_FILES_SHOWN)
		.map((p) => field(p, PATH_CAP, ctx) || "[path not shown]");
	return { shown, more: paths.length - shown.length };
}

function editDraft(
	base: Omit<Draft, "kind" | "body" | "fact" | "observed" | "collapseKey" | "editPaths" | "failed">,
	paths: string[],
	failed: boolean,
	ctx: Ctx,
): Draft {
	const { shown, more } = cleanPaths(paths, ctx);
	const text =
		shown.length === 0
			? "[path not shown]"
			: `${shown.map((p) => `"${p}"`).join(", ")}${more > 0 ? ` (+${more} files)` : ""}`;
	return {
		...base,
		kind: "edit",
		body: `OBSERVED edit ${text}${failed ? " -> FAILED" : ""}`,
		fact: failed ? { kind: "edit", result: "failed" } : { kind: "edit" },
		observed: true,
		collapseKey: `${failed ? "failed" : "ok"}\u0000${text}`,
		editPaths: shown.length === 0 ? ["[path not shown]"] : shown,
		failed,
	};
}

interface RowEnv {
	hasFailureEvent: boolean;
	ctx: Ctx;
}

function draftFor(
	row: EvidenceRow,
	cls: RowClass,
	firstPrompt: boolean,
	lastAgent: boolean,
	env: RowEnv,
): Draft | null {
	if (cls.kind === "skip") return null;
	const { ctx } = env;
	const hitsBefore = ctx.hits;
	const at = clock(row.createdAt);
	const base = {
		rowIds: [row.id],
		at,
		firstPrompt: false,
		hits: 0,
		isCommand: false,
	};
	const done = (draft: Draft): Draft => ({ ...draft, hits: ctx.hits - hitsBefore });
	switch (cls.kind) {
		case "prompt": {
			const cap = firstPrompt ? FIRST_PROMPT_CAP : PROMPT_CAP;
			return done({
				...base,
				kind: "user_prompt",
				firstPrompt,
				body: `CLAIMED user prompt: "${field(row.content, cap, ctx)}"`,
				fact: { kind: "prompt" },
				observed: false,
				collapseKey: null,
				editPaths: [],
				failed: false,
			});
		}
		case "agent_message": {
			const cap = lastAgent ? LAST_AGENT_MESSAGE_CAP : AGENT_MESSAGE_CAP;
			return done({
				...base,
				kind: "agent_message",
				body: `CLAIMED agent message: "${field(row.content, cap, ctx)}"`,
				fact: { kind: "agent_message" },
				observed: false,
				collapseKey: null,
				editPaths: [],
				failed: false,
			});
		}
		case "one_liner":
			return done({
				...base,
				kind: "one_liner",
				body: `${cls.observed ? "OBSERVED" : "CLAIMED"} ${cls.label}: "${field(row.content, ONE_LINER_CAP, ctx)}"`,
				fact: { kind: "event" },
				observed: cls.observed,
				collapseKey: null,
				editPaths: [],
				failed: false,
			});
		case "edit": {
			const status = statusOf(row, env.hasFailureEvent);
			let paths = row.filePath ? [row.filePath] : [];
			if (paths.length === 0 && row.command) {
				const command = classifyCommand(row.command);
				// The apply_patch tool holds the patch text itself; a shell form is classified.
				paths = command.kind === "patch" ? command.files : patchFilesOf(row.command);
			}
			return done(editDraft(base, paths, status === "failed", ctx));
		}
		case "shell": {
			const status = statusOf(row, env.hasFailureEvent);
			const command: CommandClass =
				row.command === null ? { kind: "not_shown" } : classifyCommand(row.command);
			if (command.kind === "patch")
				return done(editDraft(base, command.files, status === "failed", ctx));
			const rendered = renderShell(row, status, command, ctx);
			return done({
				...base,
				kind: "command",
				body: rendered.body,
				fact: rendered.fact,
				observed: true,
				collapseKey: null,
				editPaths: [],
				isCommand: true,
				failed: status === "failed",
			});
		}
		case "tool": {
			const status = statusOf(row, env.hasFailureEvent);
			return done({
				...base,
				kind: "tool",
				body: `OBSERVED tool ${toolLabel(cls.name)} -> ${resultWord(status)}`,
				fact: { kind: "tool", result: status },
				observed: true,
				collapseKey: null,
				editPaths: [],
				failed: status === "failed",
			});
		}
	}
}

interface Collapsed {
	draft: Draft;
	rowIds: number[];
}

function collapse(drafts: Draft[]): Collapsed[] {
	const out: Collapsed[] = [];
	for (const draft of drafts) {
		const last = out[out.length - 1];
		if (last && draft.collapseKey !== null && last.draft.collapseKey === draft.collapseKey) {
			last.rowIds.push(...draft.rowIds);
			// The entry keeps the first row's text and redaction count: the rows share one path.
			last.draft = { ...last.draft, at: draft.at };
			continue;
		}
		out.push({ draft, rowIds: [...draft.rowIds] });
	}
	return out;
}

function shownIdsOf(rowIds: number[]): number[] {
	if (rowIds.length <= MAX_IDS_PER_ENTRY) return rowIds;
	const half = MAX_IDS_PER_ENTRY / 2;
	return [...rowIds.slice(0, half), ...rowIds.slice(-half)];
}

export interface Built extends LedgerEntry {
	firstPrompt: boolean;
	rowIds: number[];
	at: string | null;
	fact: Draft["fact"];
	editPaths: string[];
	/** Redactions in this entry's text. */
	hits: number;
}

function finish(collapsed: Collapsed): Built {
	const { draft, rowIds } = collapsed;
	const shownIds = shownIdsOf(rowIds);
	const count = rowIds.length;
	const suffix = draft.kind === "edit" && count > 1 ? ` (x${count})` : "";
	const body =
		draft.kind === "edit" && draft.body.endsWith(" -> FAILED")
			? draft.body.replace(/ -> FAILED$/, `${suffix} -> FAILED`)
			: `${draft.body}${suffix}`;
	return {
		kind: draft.kind,
		text: `${shownIds.map((id) => `E${id}`).join(",")} ${draft.at.hhmm} ${body}`,
		eventCount: count,
		shownIds,
		observed: draft.observed,
		firstPrompt: draft.firstPrompt,
		rowIds,
		at: draft.at.iso,
		fact: count > 1 ? { ...draft.fact, count } : draft.fact,
		editPaths: draft.editPaths,
		hits: draft.hits,
	};
}

// ── budget ───────────────────────────────────────────────────────────────────

function bodyLength(entries: Array<{ text: string }>): number {
	return entries.reduce((sum, e) => sum + e.text.length, 0) + Math.max(0, entries.length - 1);
}

const ACTION_KINDS = new Set<EntryKind>(["edit", "command", "tool"]);

/**
 * Drops the oldest action entries, then the oldest agent messages, then the
 * rest, until the text fits `budget`. The first prompts and the newest
 * LEDGER_PROTECTED_TAIL entries are never dropped; if they alone exceed the
 * budget the result says so (`overBudget`) instead of overflowing silently.
 */
export function applyBudget(
	entries: Built[],
	budget = LEDGER_CHAR_BUDGET,
): { kept: Built[]; droppedEvents: number; overBudget: boolean } {
	if (bodyLength(entries) <= budget) return { kept: entries, droppedEvents: 0, overBudget: false };
	const protectedFrom = Math.max(0, entries.length - LEDGER_PROTECTED_TAIL);
	const isProtected = (entry: Built, index: number) => entry.firstPrompt || index >= protectedFrom;
	const dropped = new Set<number>();
	let length = bodyLength(entries);
	const passes: Array<(e: Built) => boolean> = [
		(e) => ACTION_KINDS.has(e.kind),
		(e) => e.kind === "agent_message",
		() => true,
	];
	for (const wanted of passes) {
		for (let i = 0; i < entries.length && length > budget; i++) {
			const entry = entries[i] as Built;
			if (dropped.has(i) || isProtected(entry, i) || !wanted(entry)) continue;
			dropped.add(i);
			length -= entry.text.length + 1;
		}
	}
	const kept = entries.filter((_, i) => !dropped.has(i));
	const droppedEvents = entries.reduce((n, e, i) => n + (dropped.has(i) ? e.eventCount : 0), 0);
	return { kept, droppedEvents, overBudget: bodyLength(kept) > budget };
}

// ── build ────────────────────────────────────────────────────────────────────

interface BuildState {
	rows: EvidenceRow[];
	classes: Map<number, RowClass>;
	firstPromptIds: Set<number>;
	firstPromptId: number | undefined;
	lastAgentId: number | undefined;
	drafts: Draft[];
	env: RowEnv;
	slices: number;
	maxSliceMs: number;
	sliceMsTotal: number;
	next: number;
}

function prepare(input: LedgerInput): BuildState {
	const byId = new Map<number, EvidenceRow>();
	for (const row of input.rows) byId.set(row.id, row);
	// A first-prompt row was read with the larger prompt margin; prefer it.
	for (const row of input.firstPromptRows) byId.set(row.id, row);
	const rows = [...byId.values()].sort((a, b) => a.id - b.id);
	const classes = new Map<number, RowClass>(rows.map((r) => [r.id, classifyRow(r)]));
	const promptIds = rows.filter((r) => classes.get(r.id)?.kind === "prompt").map((r) => r.id);
	return {
		rows,
		classes,
		firstPromptIds: new Set(promptIds.slice(0, FIRST_PROMPT_COUNT)),
		firstPromptId: promptIds[0],
		lastAgentId: [...rows].reverse().find((r) => classes.get(r.id)?.kind === "agent_message")?.id,
		drafts: [],
		env: {
			hasFailureEvent: FAILURE_EVENT_AGENTS.includes(input.agentType ?? ""),
			ctx: { hits: 0, rules: input.redactionRules ?? [] },
		},
		slices: 0,
		maxSliceMs: 0,
		sliceMsTotal: 0,
		next: 0,
	};
}

/** Drafts the next LEDGER_SLICE_ROWS rows: the classifier and the redactor run here, so one slice bounds one tick. */
function runSlice(state: BuildState): boolean {
	const started = performance.now();
	const end = Math.min(state.rows.length, state.next + LEDGER_SLICE_ROWS);
	for (; state.next < end; state.next++) {
		const row = state.rows[state.next] as EvidenceRow;
		const cls = state.classes.get(row.id) as RowClass;
		const draft = draftFor(
			row,
			cls,
			state.firstPromptId === row.id,
			row.id === state.lastAgentId,
			state.env,
		);
		if (draft) {
			draft.firstPrompt = state.firstPromptIds.has(row.id);
			state.drafts.push(draft);
		}
	}
	const elapsed = performance.now() - started;
	state.slices++;
	state.maxSliceMs = Math.max(state.maxSliceMs, elapsed);
	state.sliceMsTotal += elapsed;
	return state.next < state.rows.length;
}

function conclude(input: LedgerInput, state: BuildState): Ledger {
	const started = performance.now();
	const built = collapse(state.drafts).map(finish);
	const counts = countsOf(state.rows, state.drafts, built);
	const { kept, droppedEvents, overBudget } = applyBudget(built);

	const ids = new Map<string, LedgerIdInfo>();
	for (const entry of kept) {
		for (const id of entry.shownIds) {
			ids.set(`E${id}`, { ...entry.fact, at: entry.at, observed: entry.observed });
		}
	}
	const represented = kept.reduce((n, e) => n + e.eventCount, 0);
	const scan = input.scan;
	const cutoffAt =
		scan.reachedFirstEvent || !scan.oldestReadAt ? null : clock(scan.oldestReadAt).iso;
	const partial = !scan.reachedFirstEvent || scan.droppedByCap > 0 || droppedEvents > 0;
	const concludeMs = performance.now() - started;
	const buildMs = state.sliceMsTotal + concludeMs;

	return {
		text: kept.map((e) => e.text).join("\n"),
		ids,
		entries: kept.map(({ kind, text, eventCount, shownIds, observed }) => ({
			kind,
			text,
			eventCount,
			shownIds,
			observed,
		})),
		coverage: {
			status: partial ? "partial" : "full",
			eventsTotal: scan.eventsTotal,
			eventsRead: scan.eventsRead,
			eventsRepresented: represented,
			droppedByCap: scan.droppedByCap,
			droppedByBudget: droppedEvents,
			cutoffAt,
		},
		counts,
		redactionHits: kept.reduce((n, e) => n + e.hits, 0),
		overBudget,
		diagnostics: {
			buildMs,
			slices: state.slices,
			maxSliceMs: Math.max(state.maxSliceMs, concludeMs),
		},
	};
}

/** The ledger, built in one go. Pure. See `buildLedgerAsync` for a build that yields the event loop. */
export function buildLedger(input: LedgerInput): Ledger {
	const state = prepare(input);
	while (runSlice(state));
	return conclude(input, state);
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The same ledger, built in slices of LEDGER_SLICE_ROWS rows with the event loop
 * given a turn between slices, so a long session's classification and redaction
 * never hold a tick longer than one slice (P3-36). `diagnostics` records the build.
 */
export async function buildLedgerAsync(input: LedgerInput): Promise<Ledger> {
	const state = prepare(input);
	while (runSlice(state)) await nextTurn();
	return conclude(input, state);
}

function countsOf(rows: EvidenceRow[], drafts: Draft[], built: Built[]): LedgerCounts {
	let prompts = 0;
	let commands = 0;
	let failedCommands = 0;
	for (const draft of drafts) {
		if (draft.kind === "user_prompt") prompts++;
		if (draft.isCommand) {
			commands++;
			if (draft.failed) failedCommands++;
		}
	}
	const permissionRequests = rows.filter((r) => r.eventType === "PermissionRequest").length;
	const perFile = new Map<string, number>();
	for (const entry of built) {
		if (entry.kind !== "edit") continue;
		for (const path of entry.editPaths) {
			perFile.set(path, (perFile.get(path) ?? 0) + entry.eventCount);
		}
	}
	const sorted = [...perFile.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([path, count]) => ({ path, count }));
	return {
		prompts,
		commands,
		failedCommands,
		permissionRequests,
		editedFiles: sorted.length,
		editsByFile: sorted.slice(0, TOP_FILES),
	};
}
