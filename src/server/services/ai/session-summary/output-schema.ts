/**
 * AGEN-69: the model's answer, parsed, normalised and validated; and the fixed
 * words the server says when it asks for a second try.
 *
 * Nothing the model wrote reaches a trailer, a path or a log: a failed parse
 * yields only a schema path built from this file's own key names. The only
 * runtime zod import on the server lives here; `src/shared` stays zod-free so
 * the web bundle carries none.
 */
import { z } from "zod";
import {
	SUMMARY_CHANGE_KINDS,
	SUMMARY_OUTCOME_STATUSES,
	SUMMARY_SECTION_KEYS,
	SUMMARY_VALIDATION_RESULTS,
	type SummaryDraft,
} from "../../../../shared/session-summary.js";
import type { LlmStopReason } from "../llm/types.js";
import { stripThinkTag } from "../parser.js";
import {
	HANDOFF_MAX_CHARS,
	ITEM_MAX_CHARS,
	MAX_EVIDENCE_PER_ITEM,
	MAX_NEXT_ACTIONS,
	MAX_SECTION_ITEMS,
	OVERVIEW_MAX_CHARS,
	TRUNCATION_TRAILER,
} from "./prompt-limits.js";

// ── the schema ───────────────────────────────────────────────────────────────

const evidenceSchema = z.array(z.string().regex(/^E\d+$/));
const claimSchema = z.object({ text: z.string().min(1), evidence: evidenceSchema });

const summaryDraftSchema = z.object({
	overview: z.string().min(1),
	outcome: z.object({ status: z.enum(SUMMARY_OUTCOME_STATUSES), explanation: z.string() }),
	accomplishments: z.array(claimSchema),
	changes: z.array(claimSchema.extend({ kind: z.enum(SUMMARY_CHANGE_KINDS) })),
	decisions: z.array(claimSchema.extend({ why: z.string() })),
	validation: z.array(
		z.object({
			what: z.string().min(1),
			result: z.enum(SUMMARY_VALIDATION_RESULTS),
			detail: z.string(),
			evidence: evidenceSchema,
		}),
	),
	problems: z.array(claimSchema),
	unfinished: z.array(claimSchema),
	nextActions: z.array(claimSchema),
	handoff: z.string().min(1),
});

/** Every key name a schema path may contain; a path with anything else is reported as the top level. */
const PATH_KEYS = new Set<string>([
	...SUMMARY_SECTION_KEYS,
	"status",
	"explanation",
	"text",
	"evidence",
	"kind",
	"why",
	"what",
	"result",
	"detail",
]);
const TOP_LEVEL = "top level";

// ── nonce ────────────────────────────────────────────────────────────────────

/** Removes every occurrence of the fence nonce (any case), repeatedly, so pieces cannot rebuild one. */
export function removeNonce(text: string, nonce: string): string {
	if (!nonce) return text;
	const needle = nonce.toLowerCase();
	const re = new RegExp(nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	let out = text;
	while (out.toLowerCase().includes(needle)) out = out.replace(re, "");
	return out;
}

// ── finding the object ───────────────────────────────────────────────────────

const MAX_CANDIDATES = 50;
const SUMMARY_MARKER_KEYS = ["overview", "outcome", "handoff"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function stripFence(text: string): string {
	const match = text.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/);
	return match ? (match[1] as string) : text;
}

/** End index of the balanced object starting at `start`, string-aware; -1 when unterminated. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
		} else if (ch === "\\") {
			escaped = inString;
		} else if (ch === '"') {
			inString = !inString;
		} else if (!inString) {
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) return i;
		}
	}
	return -1;
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The summary object in a messy answer. A whole-text parse wins; otherwise the
 * first balanced object that parses and carries a summary key. An inner item
 * (`{"text": ..., "evidence": [...]}`) has none of those keys, so it is never
 * mistaken for the summary.
 */
function findSummaryObject(body: string): Record<string, unknown> | undefined {
	const whole = tryParse(body);
	if (isRecord(whole)) return whole;
	if (whole !== undefined) return undefined;
	let from = 0;
	for (let tried = 0; tried < MAX_CANDIDATES; tried++) {
		const start = body.indexOf("{", from);
		if (start === -1) return undefined;
		from = start + 1;
		const end = balancedEnd(body, start);
		if (end === -1) continue;
		const parsed = tryParse(body.slice(start, end + 1));
		if (isRecord(parsed) && SUMMARY_MARKER_KEYS.some((k) => Object.hasOwn(parsed, k)))
			return parsed;
	}
	return undefined;
}

// ── normalisation (never throws, never invents a value for a required field) ─

/** The first `max` code points; never a lone surrogate. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	return Array.from(text.slice(0, max * 2))
		.slice(0, max)
		.join("");
}

function str(value: unknown, max: number): string {
	return typeof value === "string" ? cut(value.trim(), max) : "";
}

function enumWord(value: unknown): string | undefined {
	return typeof value === "string"
		? value
				.trim()
				.toLowerCase()
				.replace(/[\s-]+/g, "_")
		: undefined;
}

const EVIDENCE_ID_RE = /^E\d+$/;
const EVIDENCE_SCAN_LIMIT = 200;

/** Integers become `E<n>`; only exact `E<digits>` strings are kept; nothing else is coerced. */
function evidenceIds(raw: unknown): string[] {
	const list =
		typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : ([] as unknown[]);
	const out = new Set<string>();
	for (const value of list.slice(0, EVIDENCE_SCAN_LIMIT)) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
			out.add(`E${value}`);
		else if (typeof value === "string" && EVIDENCE_ID_RE.test(value)) out.add(value);
		if (out.size >= MAX_EVIDENCE_PER_ITEM) break;
	}
	return [...out];
}

const SCAN_ENTRY_LIMIT = 200;

/** Builds up to `max` items, dropping entries `build` refuses. A bare string stands for `{ text }`. */
function section(
	raw: unknown,
	max: number,
	build: (record: Record<string, unknown>) => object | null,
): object[] {
	if (!Array.isArray(raw)) return [];
	const out: object[] = [];
	for (const entry of raw.slice(0, SCAN_ENTRY_LIMIT)) {
		const record = isRecord(entry) ? entry : typeof entry === "string" ? { text: entry } : null;
		const item = record ? build(record) : null;
		if (item) out.push(item);
		if (out.length >= max) break;
	}
	return out;
}

function claim(record: Record<string, unknown>): { text: string; evidence: string[] } | null {
	const text = str(own(record, "text"), ITEM_MAX_CHARS);
	return text ? { text, evidence: evidenceIds(own(record, "evidence")) } : null;
}

function normalise(root: Record<string, unknown>): unknown {
	const outcomeRaw = own(root, "outcome");
	const list = (key: string, max: number, build: (r: Record<string, unknown>) => object | null) =>
		section(own(root, key), max, build);
	return {
		overview: str(own(root, "overview"), OVERVIEW_MAX_CHARS),
		outcome: isRecord(outcomeRaw)
			? {
					status: enumWord(own(outcomeRaw, "status")),
					explanation: str(own(outcomeRaw, "explanation"), ITEM_MAX_CHARS),
				}
			: undefined,
		accomplishments: list("accomplishments", MAX_SECTION_ITEMS, claim),
		changes: list("changes", MAX_SECTION_ITEMS, (r) => {
			const base = claim(r);
			if (!base) return null;
			const kind = enumWord(own(r, "kind"));
			const known = SUMMARY_CHANGE_KINDS.find((k) => k === kind);
			return { ...base, kind: known ?? "other" };
		}),
		decisions: list("decisions", MAX_SECTION_ITEMS, (r) => {
			const base = claim(r);
			return base ? { ...base, why: str(own(r, "why"), ITEM_MAX_CHARS) } : null;
		}),
		validation: list("validation", MAX_SECTION_ITEMS, (r) => {
			const what = str(own(r, "what"), ITEM_MAX_CHARS);
			if (!what) return null;
			return {
				what,
				result: enumWord(own(r, "result")),
				detail: str(own(r, "detail"), ITEM_MAX_CHARS),
				evidence: evidenceIds(own(r, "evidence")),
			};
		}),
		problems: list("problems", MAX_SECTION_ITEMS, claim),
		unfinished: list("unfinished", MAX_SECTION_ITEMS, claim),
		nextActions: list("nextActions", MAX_NEXT_ACTIONS, claim),
		handoff: str(own(root, "handoff"), HANDOFF_MAX_CHARS),
	};
}

// ── parse ────────────────────────────────────────────────────────────────────

export type ParseResult = { ok: true; draft: SummaryDraft } | { ok: false; path: string };

/** A path built from this file's own schema keys and array indices; never from the answer. */
function schemaPath(path: ReadonlyArray<string | number>): string {
	return path.length === 0 ? TOP_LEVEL : path.join(".");
}

/**
 * Parses and validates the model's answer. The fence `nonce` is scrubbed first.
 * A failure carries only a schema path (or "top level"); no model text.
 */
export function parseAnswer(raw: string, nonce: string): ParseResult {
	try {
		if (typeof raw !== "string") return { ok: false, path: TOP_LEVEL };
		const text = stripFence(stripThinkTag(removeNonce(raw, nonce)).trim());
		const root = findSummaryObject(text);
		if (!root) return { ok: false, path: TOP_LEVEL };
		const checked = summaryDraftSchema.safeParse(normalise(root));
		if (!checked.success) {
			return { ok: false, path: schemaPath(checked.error.issues[0]?.path ?? []) };
		}
		return { ok: true, draft: checked.data };
	} catch {
		return { ok: false, path: TOP_LEVEL };
	}
}

// ── repair ───────────────────────────────────────────────────────────────────

export type RepairKind = { kind: "parse"; path: string } | { kind: "truncated" };

function safePath(path: string): string {
	if (path === TOP_LEVEL) return path;
	const segments = path.split(".");
	return segments.every((s) => /^\d{1,3}$/.test(s) || PATH_KEYS.has(s)) ? path : TOP_LEVEL;
}

/** Fixed, server-authored words appended to the prompt for the one repair call. */
export function repairTrailer(repair: RepairKind): string {
	if (repair.kind === "truncated") return TRUNCATION_TRAILER;
	return `RESPONSE PARSE ERROR at ${safePath(repair.path)}. Respond with exactly one JSON object per the schema. No prose.`;
}

/**
 * What the service does with a stop reason: a refusal ends the run, `length`
 * asks for a shorter answer, and `end`, `other` or absent are parsed alike.
 */
export function classifyStopReason(
	stop: LlmStopReason | undefined,
): "refusal" | "length" | "parse" {
	if (stop === "refusal") return "refusal";
	if (stop === "length") return "length";
	return "parse";
}
