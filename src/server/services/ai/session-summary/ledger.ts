/**
 * AGEN-69: turns the rows the evidence loader read into the "ledger" the model
 * sees: one line per entry, each line starting with the ids a summary may cite.
 * Pure. Hides labelling (OBSERVED vs CLAIMED), command classification,
 * collapsing, redact-then-cap, the character budget's drop order and the
 * coverage arithmetic.
 *
 * Every field that reaches the text is allowlisted by construction: this file
 * reads only the named columns of `EvidenceRow`, and each one goes through
 * `field()` (invisible characters stripped, redacted, neutralised, capped).
 */
import { parseDbTimestamp } from "../../util/db-time.js";
import { redact } from "../redactor.js";
import { formatUntrustedInline, stripInvisibleKeepNewlines } from "../untrusted-text.js";
import { type CommandClass, classifyCommand, validationResult } from "./command-class.js";
import {
	AGENT_MESSAGE_CAP,
	COMMAND_CAP,
	DESCRIPTION_CAP,
	EDIT_TOOLS,
	FIRST_PROMPT_CAP,
	FIRST_PROMPT_COUNT,
	LAST_AGENT_MESSAGE_CAP,
	LEDGER_CHAR_BUDGET,
	LEDGER_PROTECTED_TAIL,
	MAX_IDS_PER_ENTRY,
	ONE_LINER_CAP,
	OUTPUT_HEAD,
	OUTPUT_TAIL,
	PATH_CAP,
	PROMPT_CAP,
	READ_CLASS_TOOLS,
	SHELL_TOOLS,
	TOOL_INPUT_FIELD_SQL_CAP,
	TOP_FILES,
} from "./limits.js";

// ── types ────────────────────────────────────────────────────────────────────

/** One event as the loader selected it; every text field is already cut in SQL. */
export interface EvidenceRow {
	id: number;
	createdAt: string;
	eventType: string;
	category: string | null;
	toolName: string | null;
	content: string | null;
	filePath: string | null;
	command: string | null;
	description: string | null;
	/** The stored response, only for a command that looks like a validation. */
	response: string | null;
	/** The last 556 characters of the response, only for a failed tool row. */
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
}

export type FactKind =
	| "prompt"
	| "agent_message"
	| "edit"
	| "command"
	| "validation"
	| "tool"
	| "event";

/** What may be said about a cited id: no text, ever. */
export interface EvidenceFact {
	kind: FactKind;
	at: string | null;
	result?: "ok" | "failed" | "unknown";
	count?: number;
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
}

export interface Coverage {
	status: "full" | "partial";
	eventsTotal: number;
	eventsRead: number;
	eventsRepresented: number;
	droppedByCap: number;
	droppedByBudget: number;
	/** Set only when the scan ended before the session's first event; null for an interior omission. */
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
	ids: Map<string, EvidenceFact>;
	entries: LedgerEntry[];
	coverage: Coverage;
	counts: LedgerCounts;
	redactionHits: number;
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
}

/** Strip invisibles, redact, neutralise (one line, no angle brackets). */
function clean(raw: string, ctx: Ctx): string {
	const redacted = redact(stripInvisibleKeepNewlines(raw));
	ctx.hits += redacted.hits.length;
	return formatUntrustedInline(redacted.text).replace(/`/g, "'");
}

/** `clean`, then cut to `cap` code points; a longer value ends in an ellipsis. */
function field(raw: string | null | undefined, cap: number, ctx: Ctx): string {
	if (!raw) return "";
	const { text, cut } = takeStart(clean(raw, ctx), cap);
	return cut ? `${text}…` : text;
}

function tailField(raw: string, cap: number, ctx: Ctx): string {
	const { text, cut } = takeEnd(clean(raw, ctx), cap);
	return cut ? `…${text}` : text;
}

function excerpt(raw: string, ctx: Ctx): string {
	const text = clean(raw, ctx);
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
	| { kind: "edit"; failed: boolean }
	| { kind: "shell"; failed: boolean }
	| { kind: "tool"; failed: boolean; name: string };

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
	if (category?.startsWith("ai_")) return { kind: "one_liner", label: "ai event", observed: true };
	if (category === "tool_event") {
		if (row.eventType !== "PostToolUse" && row.eventType !== "PostToolUseFailure") {
			return { kind: "skip" };
		}
		const failed = row.eventType === "PostToolUseFailure";
		const name = (row.toolName ?? "").toLowerCase();
		if (READ_CLASS.has(name)) return { kind: "skip" };
		if (EDITS.has(name)) return { kind: "edit", failed };
		if (SHELLS.has(name)) return { kind: "shell", failed };
		return { kind: "tool", failed, name: row.toolName ?? "" };
	}
	return { kind: "skip" };
}

// ── entries ──────────────────────────────────────────────────────────────────

interface Draft {
	kind: EntryKind;
	rowIds: number[];
	at: ReturnType<typeof clock>;
	/** Everything after "<ids> <time> ". */
	body: string;
	fact: Omit<EvidenceFact, "at">;
	/** Edits collapse only with the same file and the same status. */
	collapseKey: string | null;
	firstPrompt: boolean;
	editPath: string | null;
}

function resultWord(result: "ok" | "failed" | "unknown"): string {
	return result === "failed" ? "FAILED" : result;
}

function renderShell(
	row: EvidenceRow,
	failed: boolean,
	ctx: Ctx,
): { body: string; fact: Draft["fact"] } {
	const status = failed ? "failed" : "ok";
	const tooLong = Array.from(row.command ?? "").length >= TOOL_INPUT_FIELD_SQL_CAP;
	const cls: CommandClass =
		row.command === null || tooLong ? { kind: "not_shown" } : classifyCommand(row.command);
	const fact = (kind: FactKind, result?: EvidenceFact["result"]): Draft["fact"] =>
		result ? { kind, result } : { kind };

	if (cls.kind === "withheld") {
		return {
			body: `OBSERVED command [withheld: reads credentials] -> ${resultWord(status)}`,
			fact: fact("command", status),
		};
	}
	if (cls.kind === "not_shown") {
		return {
			body: `OBSERVED command [not shown] -> ${resultWord(status)}`,
			fact: fact("command", status),
		};
	}
	const command = field(row.command, COMMAND_CAP, ctx);
	const description = row.description
		? ` (desc "${field(row.description, DESCRIPTION_CAP, ctx)}")`
		: "";
	if (cls.kind === "validation") {
		const result = validationResult(row.response, failed, cls.masked);
		const out = row.response ? `: "${excerpt(row.response, ctx)}"` : "";
		return {
			body: `OBSERVED command [validation] \`${command}\`${description} -> ${resultWord(result)}${out}`,
			fact: fact("validation", result),
		};
	}
	let out = "";
	if (failed && !cls.hasViewer && row.responseTail) {
		out = `: "${tailField(row.responseTail, OUTPUT_TAIL, ctx)}"`;
	}
	return {
		body: `OBSERVED command \`${command}\`${description} -> ${resultWord(status)}${out}`,
		fact: fact("command", status),
	};
}

function toolLabel(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
	return safe || "unknown";
}

function draftFor(
	row: EvidenceRow,
	cls: RowClass,
	firstPrompt: boolean,
	lastAgent: boolean,
	ctx: Ctx,
): Draft | null {
	const at = clock(row.createdAt);
	const base = { rowIds: [row.id], at, collapseKey: null, firstPrompt: false, editPath: null };
	switch (cls.kind) {
		case "skip":
			return null;
		case "prompt": {
			const cap = firstPrompt ? FIRST_PROMPT_CAP : PROMPT_CAP;
			return {
				...base,
				kind: "user_prompt",
				firstPrompt,
				body: `CLAIMED user prompt: "${field(row.content, cap, ctx)}"`,
				fact: { kind: "prompt" },
			};
		}
		case "agent_message": {
			const cap = lastAgent ? LAST_AGENT_MESSAGE_CAP : AGENT_MESSAGE_CAP;
			return {
				...base,
				kind: "agent_message",
				body: `CLAIMED agent message: "${field(row.content, cap, ctx)}"`,
				fact: { kind: "agent_message" },
			};
		}
		case "one_liner":
			return {
				...base,
				kind: "one_liner",
				body: `${cls.observed ? "OBSERVED" : "CLAIMED"} ${cls.label}: "${field(row.content, ONE_LINER_CAP, ctx)}"`,
				fact: { kind: "event" },
			};
		case "edit": {
			const path = field(row.filePath, PATH_CAP, ctx) || "[path not shown]";
			const status = cls.failed ? " -> FAILED" : "";
			return {
				...base,
				kind: "edit",
				body: `OBSERVED edit ${path}${status}`,
				fact: cls.failed ? { kind: "edit", result: "failed" } : { kind: "edit" },
				collapseKey: `${cls.failed ? "failed" : "ok"}\u0000${path}`,
				editPath: path,
			};
		}
		case "shell": {
			const rendered = renderShell(row, cls.failed, ctx);
			return { ...base, kind: "command", body: rendered.body, fact: rendered.fact };
		}
		case "tool": {
			const result = cls.failed ? "failed" : "ok";
			return {
				...base,
				kind: "tool",
				body: `OBSERVED tool ${toolLabel(cls.name)} -> ${resultWord(result)}`,
				fact: { kind: "tool", result },
			};
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

interface Built extends LedgerEntry {
	firstPrompt: boolean;
	rowIds: number[];
	at: string | null;
	fact: Draft["fact"];
	editPath: string | null;
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
		firstPrompt: draft.firstPrompt,
		rowIds,
		at: draft.at.iso,
		fact: count > 1 ? { ...draft.fact, count } : draft.fact,
		editPath: draft.editPath,
	};
}

// ── budget ───────────────────────────────────────────────────────────────────

function bodyLength(entries: Built[]): number {
	return entries.reduce((sum, e) => sum + e.text.length, 0) + Math.max(0, entries.length - 1);
}

const ACTION_KINDS = new Set<EntryKind>(["edit", "command", "tool"]);

/** Drops the oldest action entries, then the oldest agent messages, then the rest, until it fits. */
function applyBudget(entries: Built[]): { kept: Built[]; droppedEvents: number } {
	if (bodyLength(entries) <= LEDGER_CHAR_BUDGET) return { kept: entries, droppedEvents: 0 };
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
		for (let i = 0; i < entries.length && length > LEDGER_CHAR_BUDGET; i++) {
			const entry = entries[i] as Built;
			if (dropped.has(i) || isProtected(entry, i) || !wanted(entry)) continue;
			dropped.add(i);
			length -= entry.text.length + 1;
		}
	}
	const kept = entries.filter((_, i) => !dropped.has(i));
	const droppedEvents = entries.reduce((n, e, i) => n + (dropped.has(i) ? e.eventCount : 0), 0);
	return { kept, droppedEvents };
}

// ── build ────────────────────────────────────────────────────────────────────

export function buildLedger(input: LedgerInput): Ledger {
	const ctx: Ctx = { hits: 0 };

	const byId = new Map<number, EvidenceRow>();
	for (const row of input.rows) byId.set(row.id, row);
	// A first-prompt row was read with the larger prompt margin; prefer it.
	for (const row of input.firstPromptRows) byId.set(row.id, row);
	const rows = [...byId.values()].sort((a, b) => a.id - b.id);

	const classes = new Map<number, RowClass>(rows.map((r) => [r.id, classifyRow(r)]));
	const promptIds = rows.filter((r) => classes.get(r.id)?.kind === "prompt").map((r) => r.id);
	const firstPromptIds = new Set(promptIds.slice(0, FIRST_PROMPT_COUNT));
	const lastAgentId = [...rows]
		.reverse()
		.find((r) => classes.get(r.id)?.kind === "agent_message")?.id;

	const drafts: Draft[] = [];
	for (const row of rows) {
		const cls = classes.get(row.id) as RowClass;
		const isFirst = promptIds[0] === row.id;
		const draft = draftFor(row, cls, isFirst, row.id === lastAgentId, ctx);
		if (draft) {
			draft.firstPrompt = firstPromptIds.has(row.id);
			drafts.push(draft);
		}
	}

	const built = collapse(drafts).map(finish);
	const counts = countsOf(rows, classes, built);
	const { kept, droppedEvents } = applyBudget(built);

	const ids = new Map<string, EvidenceFact>();
	for (const entry of kept) {
		for (const id of entry.shownIds) {
			ids.set(`E${id}`, { ...entry.fact, at: entry.at });
		}
	}
	const represented = kept.reduce((n, e) => n + e.eventCount, 0);
	const scan = input.scan;
	const cutoffAt = scan.reachedFirstEvent ? null : scan.oldestReadAt;
	const partial = !scan.reachedFirstEvent || scan.droppedByCap > 0 || droppedEvents > 0;

	return {
		text: kept.map((e) => e.text).join("\n"),
		ids,
		entries: kept.map(({ kind, text, eventCount, shownIds }) => ({
			kind,
			text,
			eventCount,
			shownIds,
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
		redactionHits: ctx.hits,
	};
}

function countsOf(
	rows: EvidenceRow[],
	classes: Map<number, RowClass>,
	built: Built[],
): LedgerCounts {
	let prompts = 0;
	let commands = 0;
	let failedCommands = 0;
	let permissionRequests = 0;
	for (const row of rows) {
		const cls = classes.get(row.id);
		if (cls?.kind === "prompt") prompts++;
		if (cls?.kind === "shell") {
			commands++;
			if (cls.failed) failedCommands++;
		}
		if (row.eventType === "PermissionRequest") permissionRequests++;
	}
	const perFile = new Map<string, number>();
	for (const entry of built) {
		if (entry.kind !== "edit") continue;
		const path = entry.editPath ?? "[path not shown]";
		perFile.set(path, (perFile.get(path) ?? 0) + entry.eventCount);
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
