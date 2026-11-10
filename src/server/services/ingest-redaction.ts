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
 * Cost is bounded three ways. Work runs in slices of at most 4 ms or 16 Ki characters (a rescan after a window grew is one atomic pass of up to about 33 Ki),
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
/** Extra characters of a tool response scanned beyond the part that is stored. */
const TOOL_RESPONSE_SCAN_MARGIN = 4 * 1024;
/** What an unrecognised leaf costs at minimum, and the walk's limits. */
const MIN_LEAF_UNITS = 64;
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_NODES = 200_000;
/** The longest model name or branch kept. */
export const SHORT_FIELD_MAX_CHARS = 256;
const KEY_MAX_CHARS = 256;
export const MAX_DISTINCT_KEYS = 10_000;

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
const SECRET_FLAG =
	/^--(?:(?:client|access|auth|api|refresh|bearer)-)?(?:password|token|secret|api-key)(?:-file|-path)?$/;
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
	/** Transcript-sync batches whose insert threw and were skipped (the cursor moves on). */
	transcriptSyncInsertFailed: number;
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
	transcriptSyncInsertFailed: 0,
};

export function noteTranscriptSyncInsertFailed(): void {
	counters.transcriptSyncInsertFailed++;
}

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
	/** True when this call changed or withheld any text. */
	changed: boolean;
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
		changed: false,
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

let senderCap = SENDER_PENDING_CAP_UNITS;
let globalCap = GLOBAL_PENDING_CAP_UNITS;
/** Events waiting for room at once; past this a new one is stored as a marker without waiting. */
export const MAX_ADMISSION_WAITERS = 256;

function fits(sender: string, units: number): boolean {
	return (
		(pendingBySender.get(sender) ?? 0) + units <= senderCap &&
		counters.pendingUnits + units <= globalCap
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

/** Admits every waiter that fits now, oldest first; a sender's later events never pass its earlier one. */
function drainWaiters(): void {
	const blocked = new Set<string>();
	for (let i = 0; i < waiters.length; ) {
		const waiter = waiters[i] as Waiter;
		if (blocked.has(waiter.sender) || !fits(waiter.sender, waiter.units)) {
			blocked.add(waiter.sender);
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
 * sender may ever hold is refused at once; waiting could never help it. An event waits only
 * behind earlier events of its own sender, so one sender's backlog never turns another
 * sender's small event into a marker. (Many ingest keys can still fill the shared 32 Mi
 * together; that is a stated residual: keys are minted by a manage-level caller.)
 */
function admit(sender: string, units: number): Ticket | Promise<Ticket | null> | null {
	if (units > senderCap) return null;
	const behindOwn = waiters.some((w) => w.sender === sender);
	if (!behindOwn && fits(sender, units)) return reserve(sender, units);
	if (waiters.length >= MAX_ADMISSION_WAITERS) return null;
	return new Promise<Ticket | null>((resolve) => {
		const waiter: Waiter = {
			sender,
			units,
			resolve,
			timer: setTimeout(() => {
				const at = waiters.indexOf(waiter);
				if (at !== -1) waiters.splice(at, 1);
				resolve(null);
				// Its leaving may free the events queued behind it.
				drainWaiters();
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
	// The whole leading run, however long: a token that began before the scanned part has lost its
	// prefix, so no rule can recognise what is left of it.
	const lead = /^\S+/.exec(text);
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
	/** Key characters redacted since the walk last gave the event loop a turn. */
	keyChars: number;
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
		keyChars: 0,
		leafCap,
	};
}

/** Units the event will cost: the pre-walk that decides admission. */
function estimateUnits(value: unknown, depth = 0, budget = { nodes: 0 }): number {
	if (typeof value === "string") return leafUnits(value.length);
	if (value === null || typeof value !== "object") return 1;
	if (depth >= MAX_WALK_DEPTH || ++budget.nodes > MAX_WALK_NODES) return 1;
	let total = 1;
	const members = Array.isArray(value) ? [value] : [Object.keys(value), Object.values(value)];
	// An object's keys are scanned too, so they cost what their text costs.
	if (!Array.isArray(value))
		for (const key of members[0] as string[]) total += Math.max(key.length, 1);
	for (const child of (Array.isArray(value) ? value : members[1]) as unknown[]) {
		total += estimateUnits(child, depth + 1, budget);
		if (total > GLOBAL_PENDING_CAP_UNITS) break;
	}
	return total;
}

/** Key redaction is synchronous, so a walk over many long keys takes a turn every ~64 Ki key characters. */
const KEY_CHARS_PER_TURN = 64 * 1024;

async function pace(key: string, ws: WalkState): Promise<void> {
	if (ws.keys.has(key)) return;
	ws.keyChars += Math.min(key.length, KEY_MAX_CHARS) + 16;
	if (ws.keyChars < KEY_CHARS_PER_TURN) return;
	ws.keyChars = 0;
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function redactKey(key: string, ws: WalkState): string {
	const known = ws.keys.get(key);
	if (known !== undefined) return known;
	// Distinct keys are bounded: past the cap a new key is stored as a marker.
	if (ws.keys.size >= MAX_DISTINCT_KEYS) {
		ws.stats.changed = true;
		return KEY_MARKER;
	}
	let out: string;
	try {
		out = key.length > KEY_MAX_CHARS ? KEY_MARKER : redact(key).text;
	} catch {
		counters.errors++;
		ws.stats.errors++;
		out = KEY_MARKER;
	}
	if (out !== key) ws.stats.changed = true;
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
		ws.stats.changed = true;
		return MASK;
	}
	const known = ws.plain.get(text);
	if (known !== undefined) return known;
	const input = ws.leafCap !== null ? cutHead(text, ws.leafCap) : text;
	const out = await redactLeaf(input, ws.sender, ws.stats);
	if (out !== text) ws.stats.changed = true;
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
			const prev = value[i - 1];
			if (pairMask && i === 1) {
				out.push(maskIfValue(item as string, PAIR_VALUE_MIN_CHARS));
			} else if (
				typeof item === "string" &&
				typeof prev === "string" &&
				SECRET_FLAG.test(prev) &&
				!item.startsWith("-")
			) {
				// argv as an array: `["--token", "abc"]` is the flag and its value.
				ws.stats.changed = true;
				out.push(MASK);
			} else {
				out.push(await walkValue(item, inheritSecret, depth + 1, ws));
			}
		}
		return out;
	}
	return walkObject(value as Record<string, unknown>, depth, ws, inheritSecret);
}

function maskIfValue(text: string, minChars: number): string {
	return text.length >= minChars && !isPlaceholderValue(text) ? MASK : text;
}

async function walkObject(
	obj: Record<string, unknown>,
	depth: number,
	ws: WalkState,
	inheritSecret = false,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	const paired = pairedValueKeys(obj);
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		await pace(key, ws);
		const outKey = redactKey(key, ws);
		let child: unknown;
		if (typeof value === "string") {
			child = paired.includes(key)
				? maskIfValue(value, PAIR_VALUE_MIN_CHARS)
				: await leafFor(value, inheritSecret || isSecretKeyName(key), ws);
		} else if (Array.isArray(value)) {
			child = await walkValue(value, inheritSecret || isSecretKeyName(key), depth + 1, ws);
		} else {
			// Strings anywhere under a secret-named key are that secret, not only direct children.
			child = await walkValue(value, inheritSecret || isSecretKeyName(key), depth + 1, ws);
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
				ws.stats.changed = true;
				counters.idsDropped++;
				setOwn(out, `${key}_redacted`, true);
			}
			continue;
		}
		if (nameKeys.has(key) && typeof value === "string") {
			const keep = isCleanName(value) || keepReservedName(key, value);
			if (!keep) ws.stats.changed = true;
			setOwn(out, key, keep ? value : NAME_MARKER);
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
		await pace(key, ws);
		const outKey = redactKey(key, ws);
		let child: unknown;
		if (typeof value === "string") {
			if (paired.includes(key)) ws.stats.changed = true;
			child = paired.includes(key)
				? maskIfValue(value, PAIR_VALUE_MIN_CHARS)
				: await leafFor(value, isSecretKeyName(key), ws);
		} else if (Array.isArray(value)) {
			child = await walkValue(value, isSecretKeyName(key), 1, ws);
		} else {
			child = await walkValue(value, isSecretKeyName(key), 1, ws);
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

/**
 * Who a hook's pending work is charged to: its key's owner when there is one (a member's several
 * keys share one share), else the key itself.
 */
export function senderOfPoster(poster: {
	keyId: string;
	attribution?: { ownerUserId: string | null } | undefined;
}): string {
	const owner = poster.attribution?.ownerUserId;
	return owner ? `u:${owner}` : `k:${poster.keyId}`;
}

/**
 * True when a session id is itself a secret a rule would mask. Such a delivery is refused before
 * anything is created from it: a session row is keyed by the id, so storing it would store the secret.
 * Counted on /health as `sessionIdRefused`.
 */
export function refuseSessionIdForStorage(sessionId: unknown): boolean {
	if (typeof sessionId !== "string" || isCleanId(sessionId)) return false;
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
	ctx: { keyId: string; attribution?: { ownerUserId: string | null } },
): Promise<PrepareResult> {
	const stats = newStats();
	const raw = payload as unknown as Record<string, unknown>;
	const sessionId = raw.session_id;
	// The grammar and its length bound come first, so no unbounded text reaches a rule.
	if (typeof sessionId === "string" && !isCleanId(sessionId)) {
		counters.sessionIdRefused++;
		return { refused: "session_id" };
	}
	const sender = senderOfPoster(ctx);
	const isToolResult =
		raw.hook_event_name === "PostToolUse" || raw.hook_event_name === "PostToolUseFailure";
	// A tool result is scanned by its own path (cut first); on any other event a `tool_response` is
	// an ordinary leaf and is counted like one.
	let units = estimateUnits(isToolResult ? { ...raw, tool_response: undefined } : raw);
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
		// What a reader would judge a call or a task by says "withheld", never "empty".
		if (raw.tool_input) setOwn(copy, "tool_input", { _withheld: BACKLOG_MARKER });
		if (raw.tool_response) setOwn(copy, "tool_response", BACKLOG_MARKER);
		if (raw.task_subject) setOwn(copy, "task_subject", BACKLOG_MARKER);
		if (raw.message) setOwn(copy, "message", BACKLOG_MARKER);
		stats.changed = true;
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
			stats.changed = true;
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
 * A recognised token prefix and at least 8 token characters at the very end of a string that was
 * just cut: what is left of a token whose full form no rule can match any more.
 */
const CUT_TOKEN_FRAGMENT =
	/(?:sk-ant-|sk-or-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abposr]-|xapp-|hf_|npm_|AIza|AKIA|ASIA|sk_live_|eyJ|aps?_)[A-Za-z0-9_.-]{8,}$/;

export function trimCutTokenFragment(text: string): string {
	return text.replace(CUT_TOKEN_FRAGMENT, "[REDACTED:cut_token]");
}

/**
 * A short text (a model name, a branch, a title), redacted and cut. Synchronous: the input is
 * cut to a few hundred characters first, so it costs microseconds. Never throws.
 */
export function redactShortForStorage(text: string, maxChars = SHORT_FIELD_MAX_CHARS): string {
	try {
		// Redact, cut, redact again; a cut that fell inside a token it could no longer recognise
		// loses that fragment too.
		const first = redact(cutHead(text, maxChars + 256)).text;
		const cut = cutHead(first, maxChars);
		const second = redact(cut).text;
		return cut.length < first.length ? trimCutTokenFragment(second) : second;
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
	// Text the step changed or withheld is not compared with other text by the dedup (see NormalizedEvent).
	if (prepared.stats.changed) for (const event of events) event.redactionChanged = true;
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

function redactName(value: string | null, stats: RedactionStats): string | null {
	if (value === null) return null;
	if (isCleanName(value)) return value;
	stats.changed = true;
	return NAME_MARKER;
}

/** The categories and sources a stored event may carry; anything else is not one of ours. */
const EVENT_CATEGORIES: ReadonlySet<string> = new Set([
	"prompt",
	"assistant_message",
	"progress_update",
	"plan_update",
	"tool_event",
	"status_update",
	"system_event",
	"permission_event",
	"user_ack",
	"ai_proposal_pending",
	"ai_proposal",
	"ai_report",
	"ai_hitl_request",
	"ai_hitl_response",
	"ai_continue_sent",
	"ai_continue_blocked",
	"ai_error",
]);
const EVENT_SOURCES: ReadonlySet<string> = new Set([
	"observed_hook",
	"observed_status",
	"observed_transcript",
	"managed_control",
	"launch_system",
]);
const FALLBACK_CATEGORY = "system_event";
const FALLBACK_SOURCE = "launch_system";

/** `eventType`, `category` and `source`: a name, and two members of a closed set. */
function checkedLabels(
	event: NormalizedEvent,
	stats: RedactionStats,
): Pick<NormalizedEvent, "eventType" | "category" | "source"> {
	// A non-string event type carries no sender text; pass it through so the insert still rejects a
	// malformed internal event (NOT NULL) instead of storing it under a marker name.
	const eventType =
		typeof event.eventType !== "string" || isCleanName(event.eventType)
			? event.eventType
			: NAME_MARKER;
	const category = EVENT_CATEGORIES.has(event.category) ? event.category : FALLBACK_CATEGORY;
	const source = EVENT_SOURCES.has(event.source) ? event.source : FALLBACK_SOURCE;
	if (eventType !== event.eventType || category !== event.category || source !== event.source) {
		stats.changed = true;
	}
	return {
		eventType,
		category: category as NormalizedEvent["category"],
		source: source as NormalizedEvent["source"],
	};
}

async function redactOneEvent(
	event: NormalizedEvent,
	sender: string,
	stats: RedactionStats,
): Promise<NormalizedEvent> {
	const before = stats.changed;
	stats.changed = false;
	const ws = newWalkState(sender, stats);
	const content = event.content === null ? null : await leafFor(event.content, false, ws);
	const toolResponse =
		event.toolResponse === null ? null : await leafFor(event.toolResponse, false, ws);
	const toolInput = event.toolInput
		? ((await walkValue(event.toolInput, false, 0, ws)) as Record<string, unknown>)
		: null;
	const rawPayload = await walkTopLevel(event.rawPayload, RAW_NAME_KEYS, ws);
	const labels = checkedLabels(event, stats);
	const toolName = redactName(event.toolName, stats);
	const providerEventType = redactName(event.providerEventType, stats);
	const changed = stats.changed;
	stats.changed = before || changed;
	return {
		...event,
		...labels,
		content,
		toolName,
		providerEventType,
		toolInput,
		toolResponse,
		rawPayload,
		...(changed ? { redactionChanged: true } : {}),
	};
}

function markerOnlyEvent(event: NormalizedEvent, stats: RedactionStats): NormalizedEvent {
	const labels = checkedLabels(event, stats);
	return {
		...event,
		...labels,
		content: event.content === null ? null : BACKLOG_MARKER,
		// A call or a result is withheld, never empty: readers must not take it for harmless.
		toolInput: event.toolInput ? { _withheld: BACKLOG_MARKER } : null,
		toolResponse: event.toolResponse === null ? null : BACKLOG_MARKER,
		toolName: isCleanName(event.toolName) ? event.toolName : null,
		providerEventType: isCleanName(event.providerEventType) ? event.providerEventType : null,
		rawPayload: idsAndNamesOnly(event.rawPayload, RAW_NAME_KEYS, { stats }),
		redactionChanged: true,
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
	/** Lower (or restore, with no arguments) the pending-work caps, so a test can fill them cheaply. */
	setCaps(sender = SENDER_PENDING_CAP_UNITS, all = GLOBAL_PENDING_CAP_UNITS): void {
		senderCap = sender;
		globalCap = all;
	},
	pending(): { units: number; jobs: number; waiters: number } {
		return { units: counters.pendingUnits, jobs: counters.pendingJobs, waiters: waiters.length };
	},
};

export { FAIL_CLOSED_MARKER_PATTERN };
