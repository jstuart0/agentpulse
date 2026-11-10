import { MAX_EVENT_CONTENT_CHARS } from "../../shared/managed-report-limits.js";
import type { HookEventPayload } from "../../shared/types.js";
import {
	FAIL_CLOSED_MARKER_PATTERN,
	type RedactionJob,
	createRedactionJob,
	isPlaceholderValue,
	isSecretKeyName,
	redact,
} from "./ai/redactor.js";
import {
	type NormalizedEvent,
	TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP,
	isServerOnlyEventName,
	isSupervisorOnlyEventName,
} from "./event-normalizer.js";

/**
 * Secret redaction for text on its way into storage (AGEN-146).
 *
 * Everything an agent sends is copied here before it is written: the copy is built
 * from the built-in redaction rules, so a key pasted into a prompt, a command or a
 * tool's output is masked in `events`, `sessions` and everything that reads them. The
 * input is never mutated, the same input gives the same output, nothing here does
 * I/O, and nothing throws: a failure becomes a marker in place of the text.
 *
 * Cost is bounded three ways. Work runs in slices of at most 4 ms or 16 Ki characters,
 * one slice per event-loop turn, round-robin across senders, so a large event cannot
 * hold the loop. A leaf over `MAX_EVENT_CONTENT_CHARS` keeps its head and tail around
 * a marker, and a tool response is cut before it is scanned. And each sender may have
 * only so many characters waiting; an event past that is stored as a marker alone.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** One slice of the scheduler: stop at whichever comes first. */
export const SLICE_MS = 4;
export const SLICE_UNITS = 16 * 1024;
/** A text this small, arriving with nothing queued, is redacted in place with no yield. */
export const INLINE_MAX_UNITS = 16 * 1024;
/** Characters one sender may have waiting, and all senders together. */
export const SENDER_PENDING_CAP_UNITS = 8 * 1024 * 1024;
export const GLOBAL_PENDING_CAP_UNITS = 32 * 1024 * 1024;
/** How long an event waits for capacity before it is stored as a marker alone. */
export const ADMISSION_WAIT_MS = 2000;
/** A leaf over the content cap keeps this much of each end, around `OVER_LIMIT_MARKER`. */
export const HEAD_CHARS = 499_968;
export const TAIL_CHARS = 499_968;
/** Extra text scanned past each kept end so a match straddling the cut is already a marker. */
export const CUT_MARGIN_CHARS = 20 * 1024;
/** The longest run at the kept tail's start that is dropped as a token's suffix. */
const TAIL_LEAD_RUN_MAX = 4 * 1024;
/** Extra characters of a tool response scanned beyond the part that is stored. */
const TOOL_RESPONSE_SCAN_MARGIN = 4 * 1024;
/** What an unrecognised leaf costs at minimum, and the walk's limits. */
const MIN_LEAF_UNITS = 64;
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_NODES = 200_000;
/** The longest model name or branch kept. */
export const SHORT_FIELD_MAX_CHARS = 256;
const KEY_MAX_CHARS = 256;

export const OVER_LIMIT_MARKER = " [REDACTED:over_limit] ";
export const BACKLOG_MARKER = "[REDACTED:redaction_backlog]";
export const ERROR_MARKER = "[REDACTED:redaction_error]";
export const NAME_MARKER = "[REDACTED:name]";
export const KEY_MARKER = "[REDACTED:key]";
export const TOO_DEEP_MARKER = "[REDACTED:too_deep]";
export const TOO_LARGE_MARKER = "[REDACTED:too_large]";
export const MASK = "[REDACTED]";

/** Top-level keys that carry identity: kept only when they are a plain id that no rule would change. */
const ID_KEYS: ReadonlySet<string> = new Set([
	"tool_use_id",
	"turn_id",
	"session_id",
	"approval_id",
	"codexTurnId",
	"transcript_uuid",
	"transcript_timestamp",
]);
const ID_GRAMMAR = /^[A-Za-z0-9_.:#-]{1,200}$/;

/** Top-level keys that carry a name, for a hook payload and for a stored event's raw payload. */
const HOOK_NAME_KEYS: ReadonlySet<string> = new Set([
	"tool_name",
	"hook_event_name",
	"provider_event_name",
	"agent_type",
	"permission_mode",
	"source_event_type",
	"transcript_type",
]);
const RAW_NAME_KEYS: ReadonlySet<string> = new Set([
	...HOOK_NAME_KEYS,
	"kind",
	"source",
	"status",
	"code",
	"tool",
	"toolOutcome",
	"request_kind",
]);
const NAME_GRAMMAR = /^[A-Za-z0-9_.:/@+-]{1,128}$/;

/** Operational identity the host and the server compare as written: left as they arrive. */
const VERBATIM_KEYS: ReadonlySet<string> = new Set(["cwd", "transcript_path"]);

const PAIR_NAME_KEYS = ["name", "key", "header", "Name", "Key"] as const;
const PAIR_VALUE_KEYS = ["value", "Value"] as const;
const PAIR_VALUE_MIN_CHARS = 4;
const SECRET_VALUE_MIN_CHARS = 6;

// ── Counters ────────────────────────────────────────────────────────────────

export interface IngestRedactionCounters {
	pendingUnits: number;
	pendingJobs: number;
	unitsScanned: number;
	hits: number;
	cutLeaves: number;
	backlogMarkers: number;
	errors: number;
	idsDropped: number;
	sessionIdRefused: number;
	maxSliceMs: number;
}

const counters: IngestRedactionCounters = {
	pendingUnits: 0,
	pendingJobs: 0,
	unitsScanned: 0,
	hits: 0,
	cutLeaves: 0,
	backlogMarkers: 0,
	errors: 0,
	idsDropped: 0,
	sessionIdRefused: 0,
	maxSliceMs: 0,
};

export function getIngestRedactionCounters(): IngestRedactionCounters {
	return { ...counters };
}

/** What one call did; also folded into the counters as it goes. */
export interface RedactionStats {
	units: number;
	hits: number;
	cutLeaves: number;
	errors: number;
	idsDropped: number;
	backlog: boolean;
	/** Characters this call scanned in place; past one slice's worth the rest goes through the scheduler. */
	inlineUnits: number;
}

function newStats(): RedactionStats {
	return {
		units: 0,
		hits: 0,
		cutLeaves: 0,
		errors: 0,
		idsDropped: 0,
		backlog: false,
		inlineUnits: 0,
	};
}

// ── The scheduler ───────────────────────────────────────────────────────────

interface Job {
	engine: RedactionJob;
	resolve: (result: { text: string; hits: number }) => void;
	reject: (error: unknown) => void;
}

const queues = new Map<string, Job[]>();
const ring: string[] = [];
let turnScheduled = false;
let sliceObserver: ((info: { sender: string; units: number; ms: number }) => void) | null = null;

function scheduleTurn(): void {
	if (turnScheduled) return;
	turnScheduled = true;
	setImmediate(runTurn);
}

/** One slice of the next sender's oldest job; every other sender waits for its own turn. */
function runTurn(): void {
	turnScheduled = false;
	const sender = ring.shift();
	if (sender === undefined) return;
	const queue = queues.get(sender);
	const job = queue?.[0];
	if (queue && job) {
		const started = performance.now();
		try {
			const step = job.engine.step(SLICE_MS, SLICE_UNITS);
			const ms = performance.now() - started;
			counters.unitsScanned += step.units;
			counters.maxSliceMs = Math.max(counters.maxSliceMs, ms);
			sliceObserver?.({ sender, units: step.units, ms });
			if (step.done) {
				queue.shift();
				counters.pendingJobs--;
				const result = job.engine.result();
				counters.hits += result.hits;
				job.resolve({ text: result.text, hits: result.hits });
			}
		} catch (error) {
			queue.shift();
			counters.pendingJobs--;
			job.reject(error);
		}
		if (queue.length > 0) ring.push(sender);
		else queues.delete(sender);
	}
	if (ring.length > 0) scheduleTurn();
}

function runJobInTurns(
	sender: string,
	engine: RedactionJob,
): Promise<{ text: string; hits: number }> {
	return new Promise((resolve, reject) => {
		let queue = queues.get(sender);
		if (!queue) {
			queue = [];
			queues.set(sender, queue);
			ring.push(sender);
		}
		queue.push({ engine, resolve, reject });
		counters.pendingJobs++;
		scheduleTurn();
	});
}

// ── Admission ───────────────────────────────────────────────────────────────

interface Waiter {
	sender: string;
	units: number;
	resolve: (ticket: Ticket | null) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Ticket {
	release(): void;
}

const pendingBySender = new Map<string, number>();
const waiters: Waiter[] = [];

function fits(sender: string, units: number): boolean {
	return (
		(pendingBySender.get(sender) ?? 0) + units <= SENDER_PENDING_CAP_UNITS &&
		counters.pendingUnits + units <= GLOBAL_PENDING_CAP_UNITS
	);
}

function reserve(sender: string, units: number): Ticket {
	pendingBySender.set(sender, (pendingBySender.get(sender) ?? 0) + units);
	counters.pendingUnits += units;
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			const left = (pendingBySender.get(sender) ?? 0) - units;
			if (left > 0) pendingBySender.set(sender, left);
			else pendingBySender.delete(sender);
			counters.pendingUnits -= units;
			drainWaiters();
		},
	};
}

function drainWaiters(): void {
	for (let i = 0; i < waiters.length; ) {
		const waiter = waiters[i] as Waiter;
		if (!fits(waiter.sender, waiter.units)) {
			i++;
			continue;
		}
		waiters.splice(i, 1);
		clearTimeout(waiter.timer);
		waiter.resolve(reserve(waiter.sender, waiter.units));
	}
}

/**
 * Reserves `units` for `sender`, waiting up to `ADMISSION_WAIT_MS` for room. Null means the
 * event cannot be scanned now: the caller stores a marker alone. An event larger than one
 * sender may ever hold is refused at once; waiting could never help it.
 */
function admit(sender: string, units: number): Ticket | Promise<Ticket | null> | null {
	if (units > SENDER_PENDING_CAP_UNITS) return null;
	if (fits(sender, units) && waiters.length === 0) return reserve(sender, units);
	return new Promise<Ticket | null>((resolve) => {
		const waiter: Waiter = {
			sender,
			units,
			resolve,
			timer: setTimeout(() => {
				const at = waiters.indexOf(waiter);
				if (at !== -1) waiters.splice(at, 1);
				resolve(null);
			}, ADMISSION_WAIT_MS),
		};
		waiters.push(waiter);
	});
}

// ── Leaves ──────────────────────────────────────────────────────────────────

/** The string cut to `max` characters, never inside a surrogate pair. */
function cutHead(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return text.slice(0, end);
}

/** The last `max` characters, never starting inside a surrogate pair. */
function cutTail(text: string, max: number): string {
	if (text.length <= max) return text;
	let start = text.length - max;
	const first = text.charCodeAt(start);
	if (first >= 0xdc00 && first <= 0xdfff) start++;
	return text.slice(start);
}

function leafUnits(length: number): number {
	if (length > MAX_EVENT_CONTENT_CHARS) return HEAD_CHARS + TAIL_CHARS + 2 * CUT_MARGIN_CHARS;
	return Math.max(length, MIN_LEAF_UNITS);
}

/** A text of at most `MAX_EVENT_CONTENT_CHARS`: in place when small and nothing is waiting, else in slices. */
function redactBounded(
	text: string,
	sender: string,
	stats: RedactionStats,
): string | Promise<string> {
	stats.units += text.length;
	// In place only while this call has not yet used a slice's worth of the loop: a batch of many
	// small texts is paced by the scheduler like one large text.
	if (
		text.length <= INLINE_MAX_UNITS &&
		counters.pendingJobs === 0 &&
		stats.inlineUnits + text.length <= INLINE_MAX_UNITS
	) {
		stats.inlineUnits += text.length;
		const started = performance.now();
		const result = redact(text);
		counters.unitsScanned += text.length;
		counters.hits += result.hits.length;
		counters.maxSliceMs = Math.max(counters.maxSliceMs, performance.now() - started);
		stats.hits += result.hits.length;
		return result.text;
	}
	return runJobInTurns(sender, createRedactionJob(text)).then((result) => {
		stats.hits += result.hits;
		return result.text;
	});
}

/** What remains of a kept tail after its first token fragment and any orphaned key block are dropped. */
function trimTailEdge(tail: string): string {
	let text = tail;
	const lead = new RegExp(`^\\S{1,${TAIL_LEAD_RUN_MAX}}`).exec(text);
	if (lead) text = text.slice(lead[0].length);
	const end = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/.exec(text);
	if (end && !text.slice(0, end.index).includes("-----BEGIN")) {
		const lineEnd = text.indexOf("\n", end.index);
		text = lineEnd === -1 ? "" : text.slice(lineEnd + 1);
	}
	return text;
}

async function redactOverLimit(
	text: string,
	sender: string,
	stats: RedactionStats,
): Promise<string> {
	stats.cutLeaves++;
	counters.cutLeaves++;
	const head = await redactBounded(text.slice(0, HEAD_CHARS + CUT_MARGIN_CHARS), sender, stats);
	const tail = await redactBounded(
		text.slice(text.length - (TAIL_CHARS + CUT_MARGIN_CHARS)),
		sender,
		stats,
	);
	return cutHead(head, HEAD_CHARS) + OVER_LIMIT_MARKER + trimTailEdge(cutTail(tail, TAIL_CHARS));
}

/** One text, redacted. Never throws: a failure is `ERROR_MARKER`. */
async function redactLeaf(text: string, sender: string, stats: RedactionStats): Promise<string> {
	if (text.length === 0) return text;
	try {
		return text.length > MAX_EVENT_CONTENT_CHARS
			? await redactOverLimit(text, sender, stats)
			: await redactBounded(text, sender, stats);
	} catch {
		counters.errors++;
		stats.errors++;
		return ERROR_MARKER;
	}
}

// ── The walk ────────────────────────────────────────────────────────────────

interface WalkState {
	sender: string;
	stats: RedactionStats;
	/**
	 * Identical strings in one event cost once. A string under a secret key is masked before this is
	 * consulted, so a memoized answer is never one the key context would have changed.
	 */
	plain: Map<string, string>;
	keys: Map<string, string>;
	nodes: number;
	/** Cut each string leaf to this many characters before it is scanned (a tool response). */
	leafCap: number | null;
}

function newWalkState(
	sender: string,
	stats: RedactionStats,
	leafCap: number | null = null,
): WalkState {
	return {
		sender,
		stats,
		plain: new Map(),
		keys: new Map(),
		nodes: 0,
		leafCap,
	};
}

/** Units the event will cost: the pre-walk that decides admission. */
function estimateUnits(value: unknown, depth = 0, budget = { nodes: 0 }): number {
	if (typeof value === "string") return leafUnits(value.length);
	if (value === null || typeof value !== "object") return 1;
	if (depth >= MAX_WALK_DEPTH || ++budget.nodes > MAX_WALK_NODES) return 1;
	let total = 1;
	for (const child of Array.isArray(value) ? value : Object.values(value)) {
		total += estimateUnits(child, depth + 1, budget);
		if (total > GLOBAL_PENDING_CAP_UNITS) break;
	}
	return total;
}

function redactKey(key: string, ws: WalkState): string {
	const known = ws.keys.get(key);
	if (known !== undefined) return known;
	let out: string;
	try {
		out = key.length > KEY_MAX_CHARS ? KEY_MARKER : redact(key).text;
	} catch {
		counters.errors++;
		ws.stats.errors++;
		out = KEY_MARKER;
	}
	ws.keys.set(key, out);
	return out;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	// defineProperty, so an own `__proto__` key stays data and never reaches the prototype.
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

async function leafFor(text: string, underSecretKey: boolean, ws: WalkState): Promise<string> {
	if (underSecretKey && text.length >= SECRET_VALUE_MIN_CHARS && !isPlaceholderValue(text)) {
		return MASK;
	}
	const known = ws.plain.get(text);
	if (known !== undefined) return known;
	const input = ws.leafCap !== null ? cutHead(text, ws.leafCap) : text;
	const out = await redactLeaf(input, ws.sender, ws.stats);
	ws.plain.set(text, out);
	return out;
}

/** Names of members whose value a sibling's name marks as secret: `{name: "DB_PASSWORD", value: "..."}`. */
function pairedValueKeys(obj: Record<string, unknown>): string[] {
	for (const nameKey of PAIR_NAME_KEYS) {
		const name = obj[nameKey];
		if (typeof name === "string" && isSecretKeyName(name)) {
			return PAIR_VALUE_KEYS.filter((valueKey) => typeof obj[valueKey] === "string");
		}
	}
	return [];
}

async function walkValue(
	value: unknown,
	inheritSecret: boolean,
	depth: number,
	ws: WalkState,
): Promise<unknown> {
	if (typeof value === "string") return leafFor(value, inheritSecret, ws);
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_WALK_DEPTH) return TOO_DEEP_MARKER;
	if (++ws.nodes > MAX_WALK_NODES) return TOO_LARGE_MARKER;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		// `[key, value]` pairs: a secret-named first element masks the second.
		const pairMask =
			value.length === 2 &&
			typeof value[0] === "string" &&
			typeof value[1] === "string" &&
			isSecretKeyName(value[0]);
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (pairMask && i === 1) {
				out.push(maskIfValue(item as string, PAIR_VALUE_MIN_CHARS));
			} else {
				out.push(await walkValue(item, inheritSecret, depth + 1, ws));
			}
		}
		return out;
	}
	return walkObject(value as Record<string, unknown>, depth, ws);
}

function maskIfValue(text: string, minChars: number): string {
	return text.length >= minChars && !isPlaceholderValue(text) ? MASK : text;
}

async function walkObject(
	obj: Record<string, unknown>,
	depth: number,
	ws: WalkState,
	skip?: (key: string) => boolean,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	const paired = pairedValueKeys(obj);
	for (const key of Object.keys(obj)) {
		if (skip?.(key)) continue;
		const value = obj[key];
		const outKey = redactKey(key, ws);
		let child: unknown;
		if (typeof value === "string") {
			child = paired.includes(key)
				? maskIfValue(value, PAIR_VALUE_MIN_CHARS)
				: await leafFor(value, isSecretKeyName(key), ws);
		} else if (Array.isArray(value)) {
			child = await walkValue(value, isSecretKeyName(key), depth + 1, ws);
		} else {
			child = await walkValue(value, false, depth + 1, ws);
		}
		setOwn(out, outKey, child);
	}
	return out;
}

/** True when `redact()` leaves the short text exactly as it is. */
function unchangedByRedaction(text: string): boolean {
	try {
		return redact(text).text === text;
	} catch {
		return false;
	}
}

/** An id the grammar allows and no rule would change. */
function isCleanId(value: unknown): value is string {
	return typeof value === "string" && ID_GRAMMAR.test(value) && unchangedByRedaction(value);
}

function isCleanName(value: unknown): value is string {
	return typeof value === "string" && NAME_GRAMMAR.test(value) && unchangedByRedaction(value);
}

/**
 * A mapping's top level. Ids and names are kept verbatim when plain and removed or replaced
 * when not (an id's removal is noted as `<key>_redacted: true`); everything else is walked.
 */
async function walkTopLevel(
	obj: Record<string, unknown>,
	nameKeys: ReadonlySet<string>,
	ws: WalkState,
	hooks: {
		special?: (
			key: string,
			value: unknown,
		) => Promise<{ handled: true; value: unknown } | { handled: false }>;
	} = {},
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	const paired = pairedValueKeys(obj);
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (ID_KEYS.has(key)) {
			if (
				value === undefined ||
				value === null ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				setOwn(out, key, value);
			} else if (isCleanId(value)) {
				setOwn(out, key, value);
			} else {
				ws.stats.idsDropped++;
				counters.idsDropped++;
				setOwn(out, `${key}_redacted`, true);
			}
			continue;
		}
		if (nameKeys.has(key) && typeof value === "string") {
			setOwn(out, key, isCleanName(value) || keepReservedName(key, value) ? value : NAME_MARKER);
			continue;
		}
		if (VERBATIM_KEYS.has(key)) {
			setOwn(out, key, value);
			continue;
		}
		const special = await hooks.special?.(key, value);
		if (special?.handled) {
			setOwn(out, key, special.value);
			continue;
		}
		const outKey = redactKey(key, ws);
		let child: unknown;
		if (typeof value === "string") {
			child = paired.includes(key)
				? maskIfValue(value, PAIR_VALUE_MIN_CHARS)
				: await leafFor(value, isSecretKeyName(key), ws);
		} else if (Array.isArray(value)) {
			child = await walkValue(value, isSecretKeyName(key), 1, ws);
		} else {
			child = await walkValue(value, false, 1, ws);
		}
		setOwn(out, outKey, child);
	}
	return out;
}

/** An event name the normalizer refuses is kept as written so it still gets refused. */
function keepReservedName(key: string, value: string): boolean {
	if (key !== "hook_event_name" && key !== "provider_event_name") return false;
	const trimmed = value.trim();
	return isServerOnlyEventName(trimmed) || isSupervisorOnlyEventName(trimmed);
}

// ── Marker-only copies ──────────────────────────────────────────────────────

function idsAndNamesOnly(
	obj: Record<string, unknown>,
	nameKeys: ReadonlySet<string>,
	ws: { stats: RedactionStats },
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (ID_KEYS.has(key)) {
			if (isCleanId(value)) setOwn(out, key, value);
			else if (value !== undefined) {
				ws.stats.idsDropped++;
				counters.idsDropped++;
				setOwn(out, `${key}_redacted`, true);
			}
		} else if (
			nameKeys.has(key) &&
			(isCleanName(value) || (typeof value === "string" && keepReservedName(key, value)))
		) {
			setOwn(out, key, value);
		} else if (VERBATIM_KEYS.has(key)) {
			setOwn(out, key, value);
		}
	}
	return out;
}

function noteBacklog(stats: RedactionStats): void {
	stats.backlog = true;
	counters.backlogMarkers++;
}

// ── Hook payloads ───────────────────────────────────────────────────────────

/** A hook payload whose text has been redacted; the only thing `normalizeHookEvent` should be given. */
declare const preparedBrand: unique symbol;
export interface PreparedHookPayload {
	/** The redacted copy. */
	payload: HookEventPayload;
	/** The tool response's length before any cut, when one was seen (the normalizer reports it). */
	originalToolResponseChars?: number;
	stats: RedactionStats;
	readonly [preparedBrand]: true;
}

export type PrepareResult = PreparedHookPayload | { refused: "session_id" };

const preparedPayloads = new WeakSet<object>();

export function isPreparedHookPayload(value: unknown): value is PreparedHookPayload {
	return typeof value === "object" && value !== null && preparedPayloads.has(value);
}

function serializeToolResponse(toolResponse: unknown): string | null {
	if (!toolResponse) return null;
	return typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
}

const TOOL_RESPONSE_SCAN_CHARS = TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP + TOOL_RESPONSE_SCAN_MARGIN;

/**
 * A tool result, redacted the way it will be stored: the part that fits the raw-payload cap,
 * plus a margin, is scanned. A string is cut and redacted; a structure has each string
 * leaf cut and redacted (so a line start is still a line start) and is then serialized.
 */
async function redactToolResponse(
	response: unknown,
	sender: string,
	stats: RedactionStats,
): Promise<{ text: string; originalChars: number } | null> {
	const original = serializeToolResponse(response);
	if (original === null) return null;
	const originalChars = original.length;
	if (typeof response === "string") {
		const cut = cutHead(response, TOOL_RESPONSE_SCAN_CHARS);
		return { text: await redactLeaf(cut, sender, stats), originalChars };
	}
	const ws = newWalkState(sender, stats, TOOL_RESPONSE_SCAN_CHARS);
	const walked = await walkValue(response, false, 0, ws);
	const text = (serializeToolResponse(walked) ?? "").slice(0, TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
	return { text, originalChars };
}

function estimateToolResponseUnits(response: unknown): number {
	if (!response) return 0;
	if (typeof response === "string")
		return leafUnits(Math.min(response.length, TOOL_RESPONSE_SCAN_CHARS));
	return estimateUnits(response, 0);
}

function senderOfKey(keyId: string): string {
	return `k:${keyId}`;
}

/**
 * True when a session id is itself a secret a rule would mask. Such a delivery is refused before
 * anything is created from it: a session row is keyed by the id, so storing it would store the secret.
 * Counted on /health as `sessionIdRefused`.
 */
export function refuseSessionIdForStorage(sessionId: unknown): boolean {
	if (typeof sessionId !== "string" || unchangedByRedaction(sessionId)) return false;
	counters.sessionIdRefused++;
	return true;
}

/**
 * A copy of a hook payload that is safe to store, or a refusal when its session id is itself
 * a secret. Nothing in `payload` changes. Built after the cheap rejection gates and before
 * any session write, so a refusal or a marker never follows a mutation.
 */
export async function prepareHookPayloadForStorage(
	payload: HookEventPayload,
	ctx: { keyId: string },
): Promise<PrepareResult> {
	const stats = newStats();
	const raw = payload as unknown as Record<string, unknown>;
	const sessionId = raw.session_id;
	if (typeof sessionId === "string" && !unchangedByRedaction(sessionId)) {
		counters.sessionIdRefused++;
		return { refused: "session_id" };
	}
	const sender = senderOfKey(ctx.keyId);
	const isToolResult =
		raw.hook_event_name === "PostToolUse" || raw.hook_event_name === "PostToolUseFailure";
	let units = estimateUnits({ ...raw, tool_response: undefined, tool_input: raw.tool_input });
	if (isToolResult) units += estimateToolResponseUnits(raw.tool_response);

	const ticket = await admit(sender, units);
	let copy: Record<string, unknown>;
	let originalToolResponseChars: number | undefined;
	if (ticket === null) {
		noteBacklog(stats);
		copy = idsAndNamesOnly(raw, HOOK_NAME_KEYS, { stats });
		if (raw.hook_event_name === "UserPromptSubmit" && raw.prompt)
			setOwn(copy, "prompt", BACKLOG_MARKER);
		if (typeof raw.last_assistant_message === "string" && raw.last_assistant_message.trim()) {
			setOwn(copy, "last_assistant_message", BACKLOG_MARKER);
		}
	} else {
		try {
			const ws = newWalkState(sender, stats);
			copy = await walkTopLevel(raw, HOOK_NAME_KEYS, ws, {
				special: async (key, value) => {
					if (key === "tool_response" && isToolResult) {
						const redacted = await redactToolResponse(value, sender, stats);
						if (redacted === null) return { handled: true, value };
						originalToolResponseChars = redacted.originalChars;
						return { handled: true, value: redacted.text };
					}
					if (key === "model" && typeof value === "string") {
						return { handled: true, value: await shortField(value, sender, stats) };
					}
					return { handled: false };
				},
			});
		} catch {
			counters.errors++;
			stats.errors++;
			noteBacklog(stats);
			copy = idsAndNamesOnly(raw, HOOK_NAME_KEYS, { stats });
		} finally {
			ticket.release();
		}
	}
	const prepared = {
		payload: copy as unknown as HookEventPayload,
		originalToolResponseChars,
		stats,
	} as PreparedHookPayload;
	preparedPayloads.add(prepared);
	return prepared;
}

async function shortField(text: string, sender: string, stats: RedactionStats): Promise<string> {
	const cut = cutHead(text, SHORT_FIELD_MAX_CHARS + 256);
	return cutHead(await redactLeaf(cut, sender, stats), SHORT_FIELD_MAX_CHARS);
}

// ── Other text ──────────────────────────────────────────────────────────────

/**
 * A short text (a model name, a branch, a title), redacted and cut. Synchronous: the input is
 * cut to a few hundred characters first, so it costs microseconds. Never throws.
 */
export function redactShortForStorage(text: string, maxChars = SHORT_FIELD_MAX_CHARS): string {
	try {
		return cutHead(redact(cutHead(text, maxChars + 256)).text, maxChars);
	} catch {
		counters.errors++;
		return ERROR_MARKER;
	}
}

/** Free text of any length (a native session name, a task line): redacted through the scheduler. */
export async function redactTextForStorage(text: string, sender: string): Promise<string> {
	const stats = newStats();
	const ticket = await admit(sender, leafUnits(text.length));
	if (ticket === null) {
		noteBacklog(stats);
		return BACKLOG_MARKER;
	}
	try {
		return await redactLeaf(text, sender, stats);
	} finally {
		ticket.release();
	}
}

// ── Stored events ───────────────────────────────────────────────────────────

/** Events whose text has been redacted: the only thing the insert path writes. */
declare const storableBrand: unique symbol;
export type StorableEvents = NormalizedEvent[] & { readonly [storableBrand]: true };

const storableArrays = new WeakSet<object>();

export function isStorableEvents(events: unknown): events is StorableEvents {
	return Array.isArray(events) && storableArrays.has(events);
}

/** Marks events built from a prepared hook payload (already redacted) as storable. */
export function storableFromPrepared(
	prepared: PreparedHookPayload,
	events: NormalizedEvent[],
): StorableEvents {
	if (!isPreparedHookPayload(prepared)) throw new Error("not a prepared hook payload");
	storableArrays.add(events);
	return events as StorableEvents;
}

function eventUnits(event: NormalizedEvent): number {
	return (
		(event.content === null ? 0 : leafUnits(event.content.length)) +
		(event.toolResponse === null ? 0 : leafUnits(event.toolResponse.length)) +
		(event.toolInput ? estimateUnits(event.toolInput) : 0) +
		estimateUnits(event.rawPayload)
	);
}

function redactName(value: string | null): string | null {
	if (value === null) return null;
	return isCleanName(value) ? value : NAME_MARKER;
}

async function redactOneEvent(
	event: NormalizedEvent,
	sender: string,
	stats: RedactionStats,
): Promise<NormalizedEvent> {
	const ws = newWalkState(sender, stats);
	const content = event.content === null ? null : await leafFor(event.content, false, ws);
	const toolResponse =
		event.toolResponse === null ? null : await leafFor(event.toolResponse, false, ws);
	const toolInput = event.toolInput
		? ((await walkValue(event.toolInput, false, 0, ws)) as Record<string, unknown>)
		: null;
	const rawPayload = await walkTopLevel(event.rawPayload, RAW_NAME_KEYS, ws);
	return {
		...event,
		content,
		toolName: redactName(event.toolName),
		providerEventType: redactName(event.providerEventType),
		toolInput,
		toolResponse,
		rawPayload,
	};
}

function markerOnlyEvent(event: NormalizedEvent, stats: RedactionStats): NormalizedEvent {
	return {
		...event,
		content: event.content === null ? null : BACKLOG_MARKER,
		toolInput: null,
		toolResponse: null,
		toolName: isCleanName(event.toolName) ? event.toolName : null,
		providerEventType: isCleanName(event.providerEventType) ? event.providerEventType : null,
		rawPayload: idsAndNamesOnly(event.rawPayload, RAW_NAME_KEYS, { stats }),
	};
}

/**
 * The events with every text field redacted: `content`, `toolInput`, `toolResponse` and the
 * whole raw payload. Never throws; an event that cannot be scanned now (its sender is over
 * its share) is stored as a marker with its valid ids and names, never in the clear.
 * `sender` says whose share the work is charged to (an ingest key, a supervisor, a session).
 */
export async function redactEventsForStorage(
	sender: string,
	events: NormalizedEvent[],
): Promise<StorableEvents> {
	const stats = newStats();
	let out: NormalizedEvent[];
	let units = 0;
	for (const event of events) units += eventUnits(event);
	const ticket = await admit(sender, units);
	if (ticket === null) {
		noteBacklog(stats);
		out = events.map((event) => markerOnlyEvent(event, stats));
	} else {
		try {
			out = [];
			for (const event of events) {
				try {
					out.push(await redactOneEvent(event, sender, stats));
				} catch {
					counters.errors++;
					stats.errors++;
					out.push(markerOnlyEvent(event, stats));
				}
			}
		} finally {
			ticket.release();
		}
	}
	storableArrays.add(out);
	return out as StorableEvents;
}

/** Test seams. Never used by production code. */
export const __testing = {
	setSliceObserver(fn: typeof sliceObserver): void {
		sliceObserver = fn;
	},
	reset(): void {
		for (const key of Object.keys(counters) as Array<keyof IngestRedactionCounters>) {
			if (key !== "pendingUnits" && key !== "pendingJobs") counters[key] = 0;
		}
	},
	pending(): { units: number; jobs: number; waiters: number } {
		return { units: counters.pendingUnits, jobs: counters.pendingJobs, waiters: waiters.length };
	},
};

export { FAIL_CLOSED_MARKER_PATTERN };
