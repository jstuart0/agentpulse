/**
 * The supervisor's offline outbox: a bounded, private, per-session queue of the session reports it could
 * not deliver, kept on disk so it survives a restart. This module only STORES. It knows nothing about the
 * network, the report gate or the rules: it has no `fetch`, no `request` and no endpoint path. The gate
 * (a later phase) decides what to queue and when to send; this decides how it is kept.
 *
 * Layout (all under `<home>/.agentpulse/supervisor-outbox/`, created on the first append, so a healthy
 * host does no filesystem work at all):
 *
 *   s-<sha256(sessionId)[0:32]>/      one directory per session, 0700
 *     session.json                    { v, sessionId, supervisorId }
 *     <16-digit seq>.json             one file per queued report, 0600, written atomically
 *   outbox-meta.json                  the summary of the last flush
 *
 * What it keeps: state reports (idempotent, last write wins), events batches (each with a delivery id the
 * server dedupes on) and `gap` entries, which stand in for events that were dropped to stay in bounds.
 *
 * Bounds (OUTBOX_LIMITS) and what happens past them, in this order:
 *  1. over the per-session cap, the oldest state entry that is not the head is folded into the next state
 *     entry (a state report is a patch, so the later one carries it);
 *  2. still over, the oldest events entries that are not the head are replaced by one gap entry;
 *  3. over the total cap, rule 2 is applied to the largest session;
 *  4. a new session past MAX_SESSIONS is lost;
 *  5. an entry older than 24 h never takes a state report with it: aged state entries fold into one,
 *     aged events become a gap, so a session that never got a report through still replays its creation;
 *  6. a head that failed 8 times in a row over at least an hour is removed as lost.
 * The head (the oldest entry of a session) is never folded or dropped by the size rules. Every loss is
 * counted in `lost`, except an exclusion purge.
 *
 * Trust: the root, a session directory and an entry file are read only when they are this account's own,
 * private, plain and not links. An untrusted root disables the outbox; an untrusted session directory or
 * head is "held": it is neither read nor deleted, and only `purge` (an exclusion) removes it, by unlinking
 * its entries without reading or following them. One held session never blocks another.
 *
 * Units: `pending` counts queued reports (entries). `delivered` and `lost` count events for an events
 * entry and one for a state entry; a gap entry delivers nothing of the user's.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { isPrivateOwnStat, readPrivateFileNoFollow, trustedDirectory } from "./private-store.js";

export interface OutboxEntry {
	sessionId: string;
	seq: number;
	kind: "state" | "events" | "gap";
	queuedAt: string;
	attempted: boolean;
	body: string;
	deliveryId?: string;
	lost?: number;
	failures?: number;
	firstFailureAt?: string;
}

export interface OutboxSummary {
	pending: number;
	oldestPendingAt: string | null;
	lastFlushAt: string | null;
	lastFlushDelivered: number;
	lastFlushLost: number;
}

export interface OutboxLimits {
	entryBytes: number;
	sessionBytes: number;
	sessionEntries: number;
	totalBytes: number;
	sessions: number;
	ageMs: number;
	poisonFailures: number;
	poisonSpanMs: number;
	/** Most events in one stored entry; a larger batch is split when it is queued. */
	eventsPerEntry: number;
}

const MIB = 1024 * 1024;
export const OUTBOX_LIMITS: OutboxLimits = {
	entryBytes: MIB,
	sessionBytes: 8 * MIB,
	sessionEntries: 2_000,
	totalBytes: 64 * MIB,
	sessions: 256,
	ageMs: 24 * 60 * 60 * 1000,
	poisonFailures: 8,
	poisonSpanMs: 60 * 60 * 1000,
	eventsPerEntry: 500,
};

export const OUTBOX_VERSION = 1;
const OUTBOX_RELATIVE_ROOT = join(".agentpulse", "supervisor-outbox");
const META_FILE = "outbox-meta.json";
const SESSION_FILE = "session.json";
const MAX_SESSION_ID_LENGTH = 1_024;
/** Room kept free in an entry for its envelope (ids, timestamps) when splitting a body by size. */
const ENVELOPE_RESERVE_BYTES = 4_096;
const DIR_PATTERN = /^s-[0-9a-f]{32}$/;
const ENTRY_PATTERN = /^(\d{16})\.json$/;
const TMP_PATTERN = /^\..*\.tmp$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const LSTAT_BATCH = 256;
/** At most this many session directories are examined at load; the rest are purged, and the unknown set is held to the same size. */
const MAX_LOAD_DIRS = 1_024;
/** Names beyond the entry cap that a directory may hold at load before the rest is purged. */
const EXTRA_NAMES_ALLOWED = 16;
/** A counter read from disk is clamped to this. */
const MAX_COUNTER = 10_000_000;
const PURGE_PATTERN = /^\.purge-[0-9a-f]{16}$/;
const GAP_TAIL =
	" while this machine was offline: its offline queue was full or the events were more than a day old.";

export interface ReportOutbox {
	/** False when the root is not private to this account: nothing is read or written and `append` loses. */
	readonly enabled: boolean;
	/** The asynchronous load finished (byte totals are known). */
	ready(): Promise<void>;
	/** Every session directory has been listed (names only); until then `hasPending` may not know a session. */
	listed(): boolean;
	hasPending(sessionId: string): boolean;
	/** Sessions with something queued, the one with the oldest head first. */
	sessions(): string[];
	/** Directories whose session can't be told (no readable session.json, or an untrusted directory). */
	unknownDirs(): string[];
	append(
		sessionId: string,
		e: Pick<OutboxEntry, "kind" | "body" | "attempted" | "deliveryId">,
	): "queued" | "lost";
	/** The oldest entry of a session; "held" when its directory or file can't be trusted; null when empty. */
	head(sessionId: string): OutboxEntry | "held" | null;
	/** False when the write failed: the entry is still unattempted, so don't send it this round. */
	markAttempted(sessionId: string, seq: number): boolean;
	/**
	 * Notes a failed delivery of the head. Counts toward the poison rule unless `opts.counts` is false: a
	 * server's own back-pressure (a 503 carrying Retry-After) is not a failure and must be passed as
	 * `counts: false`, which changes nothing and never poisons.
	 */
	recordFailure(
		sessionId: string,
		seq: number,
		nowMs: number,
		opts?: { counts?: boolean },
	): "keep" | "poisoned";
	remove(sessionId: string, seq: number, outcome: "delivered" | "lost"): void;
	purge(sessionId: string, opts?: { countLost?: boolean }): void;
	purgeDir(dirName: string): void;
	ageOut(nowMs: number): void;
	beginFlush(): void;
	endFlush(nowIso: string): void;
	summary(): OutboxSummary;
}

export interface CreateReportOutboxOptions {
	home: string;
	supervisorId: string;
	now?: () => number;
	log?: (line: string) => void;
	limits?: Partial<OutboxLimits>;
	/** Writes `text` to `path` atomically and privately; a test replaces it to make a write fail. */
	writer?: (path: string, text: string) => void;
}

// ── folding state reports ───────────────────────────────────────────────────────

/**
 * Two state reports for one session as one: what the server would hold after receiving `a` and then
 * `b` (see upsertManagedSessionState on the server). `status` and `desiredThreadTitle` take `b`'s own
 * value, even an absent one, because the server resets them to a default when a report omits them;
 * `cwd` and `model` take `b` only when it names one; `metadata` is merged shallowly; every other field
 * is `b ?? a`. Associative: fold(fold(a, b), c) equals fold(a, fold(b, c)).
 */
export function foldStateReports(
	a: ManagedSessionStateInput,
	b: ManagedSessionStateInput,
): ManagedSessionStateInput {
	const out: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		const av = (a as unknown as Record<string, unknown>)[key];
		const bv = (b as unknown as Record<string, unknown>)[key];
		let value: unknown;
		if (key === "status" || key === "desiredThreadTitle") value = bv;
		else if (key === "cwd" || key === "model") value = bv !== undefined ? bv : av;
		else if (key === "metadata") {
			value =
				isPlainObject(av) || isPlainObject(bv)
					? { ...(isPlainObject(av) ? av : {}), ...(isPlainObject(bv) ? bv : {}) }
					: (bv ?? av);
		} else value = bv ?? av;
		if (value !== undefined) out[key] = value;
	}
	return out as unknown as ManagedSessionStateInput;
}

/** A counter read back from disk, as an integer in [0, 10,000,000]. */
function clampCounter(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(MAX_COUNTER, Math.max(0, Math.trunc(value)));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── helpers ─────────────────────────────────────────────────────────────────────

export function outboxDirName(sessionId: string): string {
	return `s-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

const seqName = (seq: number) => `${String(seq).padStart(16, "0")}.json`;
const byteLength = (text: string) => Buffer.byteLength(text, "utf-8");

function isPrivateDirectory(path: string): boolean {
	try {
		const st = lstatSync(path);
		if (process.platform === "win32") return st.isDirectory() && trustedDirectory(path);
		return isPrivateOwnStat(st, "directory", process.getuid?.() ?? null);
	} catch {
		return false;
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function parseObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Events in an events or gap body (1 when it can't be told). */
function eventCount(entry: Pick<OutboxEntry, "kind" | "body">): number {
	if (entry.kind === "state") return 1;
	const parsed = parseObject(entry.body);
	return Array.isArray(parsed?.events) ? (parsed.events as unknown[]).length : 1;
}

function lostPhrase(lost: number): string {
	return `${lost === 1 ? "1 event from this session wasn't" : `${lost} events from this session weren't`} delivered${GAP_TAIL}`;
}

function gapBody(lost: number, firstLossAt: string): string {
	const event: ManagedSessionEventInput = {
		eventType: "ManagedEventsLost",
		category: "system_event",
		source: "launch_system",
		content: lostPhrase(lost),
		rawPayload: { lost },
		occurredAt: firstLossAt,
	};
	return JSON.stringify({ events: [event] });
}

function gapFirstLossAt(entry: OutboxEntry): string {
	const events = parseObject(entry.body)?.events;
	const at = Array.isArray(events)
		? (events[0] as { occurredAt?: unknown })?.occurredAt
		: undefined;
	return typeof at === "string" ? at : entry.queuedAt;
}

// ── the store ───────────────────────────────────────────────────────────────────

interface EntryMeta {
	seq: number;
	bytes: number;
	/** When it was queued: exact for an entry this run wrote or read, the file's mtime for one only listed. */
	queuedAtMs: number;
	kind?: OutboxEntry["kind"];
	/** The listing found it not to be a private plain file; it is "held" if it becomes the head. */
	suspect?: boolean;
	/** `queuedAtMs` is the file's mtime, not read from the entry yet. */
	approx?: boolean;
	gone?: boolean;
}

interface SessionState {
	sessionId: string;
	dirName: string;
	dir: string;
	entries: EntryMeta[];
	bytes: number;
	nextSeq: number;
	head: OutboxEntry | undefined;
}

type EntryRead = OutboxEntry | "held" | undefined;

export function createReportOutbox(opts: CreateReportOutboxOptions): ReportOutbox {
	const limits: OutboxLimits = { ...OUTBOX_LIMITS, ...opts.limits };
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => undefined);
	const writeText =
		opts.writer ?? ((path: string, text: string) => writePrivateFileAtomicNoFollow(path, text));
	const root = join(opts.home, OUTBOX_RELATIVE_ROOT);

	let enabled = true;
	let isListed = false;
	let isReady = false;
	let totalBytes = 0;
	const sessions = new Map<string, SessionState>();
	const sessionsByDir = new Map<string, SessionState>();
	const unknown = new Set<string>();
	let rootChecked = false;
	let rootWarned = false;

	let delivered = 0;
	let lost = 0;
	let lastFlushAt: string | null = null;
	let lastFlushDelivered = 0;
	let lastFlushLost = 0;

	const iso = (ms: number) => new Date(ms).toISOString();

	function disable(why: string) {
		enabled = false;
		if (!rootWarned) {
			rootWarned = true;
			log(
				`[supervisor] the offline outbox is off: ${why}. Reports can't be kept while the server is unreachable.`,
			);
		}
	}

	// ── root and sessions on disk ──

	/** Creates the root on first use and judges it; false (and the outbox off) when it can't be trusted. */
	function ensureRoot(): boolean {
		if (!enabled) return false;
		if (rootChecked && isPrivateDirectory(root)) return true;
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
		} catch (error) {
			if (!isMissing(error) && (error as NodeJS.ErrnoException)?.code !== "EEXIST") {
				disable("its directory can't be created");
				return false;
			}
		}
		if (!isPrivateDirectory(root)) {
			disable("its directory isn't private to this account");
			return false;
		}
		rootChecked = true;
		return true;
	}

	function track(state: SessionState) {
		sessions.set(state.sessionId, state);
		sessionsByDir.set(state.dirName, state);
	}

	function untrack(state: SessionState) {
		sessions.delete(state.sessionId);
		sessionsByDir.delete(state.dirName);
		totalBytes -= state.bytes;
		state.bytes = 0;
		state.entries = [];
		state.head = undefined;
	}

	function newState(sessionId: string): SessionState {
		const dirName = outboxDirName(sessionId);
		return {
			sessionId,
			dirName,
			dir: join(root, dirName),
			entries: [],
			bytes: 0,
			nextSeq: 1,
			head: undefined,
		};
	}

	function setBytes(state: SessionState, meta: EntryMeta, bytes: number) {
		if (meta.gone) return;
		const delta = bytes - meta.bytes;
		meta.bytes = bytes;
		state.bytes += delta;
		totalBytes += delta;
	}

	function addMeta(state: SessionState, meta: EntryMeta) {
		state.entries.push(meta);
		state.entries.sort((x, y) => x.seq - y.seq);
		state.bytes += meta.bytes;
		totalBytes += meta.bytes;
		state.nextSeq = Math.max(state.nextSeq, meta.seq + 1);
		if (state.entries[0] === meta) state.head = undefined;
	}

	function dropMeta(state: SessionState, meta: EntryMeta) {
		const at = state.entries.indexOf(meta);
		if (at < 0) return;
		state.entries.splice(at, 1);
		meta.gone = true;
		state.bytes -= meta.bytes;
		totalBytes -= meta.bytes;
		if (at === 0) state.head = undefined;
	}

	function unlinkQuiet(path: string): boolean {
		try {
			unlinkSync(path);
			return true;
		} catch (error) {
			if (isMissing(error)) return true;
			log(`[supervisor] couldn't remove an outbox file: ${(error as Error)?.message ?? error}`);
			return false;
		}
	}

	/** Removes an emptied session's directory. */
	function retire(state: SessionState) {
		unlinkQuiet(join(state.dir, SESSION_FILE));
		try {
			rmdirSync(state.dir);
		} catch (error) {
			if (!isMissing(error)) log("[supervisor] couldn't remove an empty outbox directory");
		}
		untrack(state);
	}

	function countLoss(units: number) {
		lost += units;
	}

	/**
	 * Removes a session directory. It is first renamed to a name only this process knows (`.purge-<random>`),
	 * so what is examined and emptied afterwards cannot be swapped for a link behind our back. Then every name
	 * in it is unlinked (a link is removed, never followed; a real subdirectory makes the final rmdir fail and
	 * is left) and the directory removed. `removed` is how many queued entries went; `gone` is false when
	 * something is still there, in which case the leftover is reported by name so it is retried.
	 */
	function purgeDirectory(dirName: string): { removed: number; gone: boolean; leftover?: string } {
		const alreadyRenamed = PURGE_PATTERN.test(dirName);
		if (!alreadyRenamed && !DIR_PATTERN.test(dirName)) return { removed: 0, gone: true };
		let path = join(root, dirName);
		let leftover = dirName;
		if (!alreadyRenamed) {
			leftover = `.purge-${randomBytes(8).toString("hex")}`;
			const renamed = join(root, leftover);
			try {
				renameSync(path, renamed);
			} catch (error) {
				return {
					removed: 0,
					gone: isMissing(error),
					leftover: isMissing(error) ? undefined : dirName,
				};
			}
			path = renamed;
		}
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(path);
		} catch {
			return { removed: 0, gone: true };
		}
		if (st.isSymbolicLink() || !st.isDirectory()) {
			return unlinkQuietSilent(path)
				? { removed: 0, gone: true }
				: { removed: 0, gone: false, leftover };
		}
		let removed = 0;
		let names: string[] = [];
		try {
			names = readdirSync(path);
		} catch {
			return { removed: 0, gone: false, leftover };
		}
		for (const name of names) {
			if (unlinkQuietSilent(join(path, name)) && ENTRY_PATTERN.test(name)) removed++;
		}
		try {
			rmdirSync(path);
		} catch {
			return { removed, gone: false, leftover };
		}
		return { removed, gone: true };
	}

	/** Purges a directory and counts what it held; a leftover is remembered by name so a later pass retries it. */
	function purgeAndRemember(dirName: string, countLost: boolean): number {
		const result = purgeDirectory(dirName);
		if (countLost) countLoss(result.removed);
		if (!result.gone && result.leftover) {
			if (unknown.size < MAX_LOAD_DIRS) unknown.add(result.leftover);
			log(
				"[supervisor] an offline outbox directory couldn't be fully removed; it will be tried again",
			);
		} else unknown.delete(dirName);
		return result.removed;
	}

	function unlinkQuietSilent(path: string): boolean {
		try {
			unlinkSync(path);
			return true;
		} catch {
			return false;
		}
	}

	// ── reading entries ──

	function toEntry(
		state: SessionState,
		meta: EntryMeta,
		raw: Record<string, unknown>,
	): OutboxEntry | null {
		if (raw.v !== OUTBOX_VERSION) return null;
		if (raw.sessionId !== state.sessionId) return null;
		if (raw.seq !== meta.seq) return null;
		const kind = raw.kind;
		if (kind !== "state" && kind !== "events" && kind !== "gap") return null;
		if (typeof raw.queuedAt !== "string" || typeof raw.attempted !== "boolean") return null;
		if (typeof raw.body !== "string") return null;
		if (raw.deliveryId !== undefined) {
			if (typeof raw.deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(raw.deliveryId))
				return null;
		}
		const body = parseObject(raw.body);
		if (!body) return null;
		if (kind === "state" && body.sessionId !== state.sessionId) return null;
		if (kind !== "state" && !Array.isArray(body.events)) return null;
		const entry: OutboxEntry = {
			sessionId: state.sessionId,
			seq: meta.seq,
			kind,
			queuedAt: raw.queuedAt,
			attempted: raw.attempted,
			body: raw.body,
		};
		if (typeof raw.deliveryId === "string") entry.deliveryId = raw.deliveryId;
		if (typeof raw.lost === "number") entry.lost = clampCounter(raw.lost);
		if (typeof raw.failures === "number") entry.failures = clampCounter(raw.failures);
		if (typeof raw.firstFailureAt === "string") entry.firstFailureAt = raw.firstFailureAt;
		return entry;
	}

	/** Reads and validates one entry. An invalid or vanished one is removed (and counted lost) and gives undefined. */
	function readEntry(state: SessionState, meta: EntryMeta): EntryRead {
		const path = join(state.dir, seqName(meta.seq));
		const found = readPrivateFileNoFollow(path, limits.entryBytes);
		if (found.kind === "untrusted") return "held";
		if (found.kind === "absent") {
			dropMeta(state, meta);
			countLoss(1);
			return undefined;
		}
		const raw = parseObject(found.text);
		const entry = raw ? toEntry(state, meta, raw) : null;
		if (!entry) {
			log("[supervisor] an offline outbox entry was invalid and was dropped");
			unlinkQuiet(path);
			dropMeta(state, meta);
			countLoss(1);
			return undefined;
		}
		meta.kind = entry.kind;
		meta.queuedAtMs = Date.parse(entry.queuedAt) || meta.queuedAtMs;
		meta.approx = false;
		return entry;
	}

	/** Writes an entry's file and updates its bookkeeping. Throws when the write fails. */
	function writeEntry(state: SessionState, meta: EntryMeta, entry: OutboxEntry) {
		const text = JSON.stringify({ v: OUTBOX_VERSION, ...entry });
		writeText(join(state.dir, seqName(entry.seq)), text);
		setBytes(state, meta, byteLength(text));
		meta.kind = entry.kind;
		meta.queuedAtMs = Date.parse(entry.queuedAt) || meta.queuedAtMs;
		meta.approx = false;
	}

	function head(sessionId: string): OutboxEntry | "held" | null {
		const state = sessions.get(sessionId);
		if (!state || state.entries.length === 0) return null;
		if (!isPrivateDirectory(state.dir)) return "held";
		if (state.head) return { ...state.head };
		while (state.entries.length > 0) {
			const meta = state.entries[0] as EntryMeta;
			const read = readEntry(state, meta);
			if (read === "held") return "held";
			if (read) {
				state.head = read;
				return { ...read };
			}
		}
		retireIfEmpty(state);
		return null;
	}

	function retireIfEmpty(state: SessionState) {
		if (state.entries.length === 0 && sessions.get(state.sessionId) === state) retire(state);
	}

	// ── making room ──

	const sessionFits = (state: SessionState, size: number) =>
		state.entries.length + 1 <= limits.sessionEntries &&
		(!isReady || state.bytes + size <= limits.sessionBytes);
	const totalFits = (size: number) => !isReady || totalBytes + size <= limits.totalBytes;

	/** Rule 1: fold the oldest non-head state entry into the next state entry. */
	function foldOne(state: SessionState): boolean {
		const states: Array<{ meta: EntryMeta; entry: OutboxEntry }> = [];
		for (let i = 1; i < state.entries.length; i++) {
			const meta = state.entries[i] as EntryMeta;
			if (meta.kind && meta.kind !== "state") continue;
			const read = readEntry(state, meta);
			if (read === undefined) {
				i--;
				continue;
			}
			if (read === "held") return false;
			if (read.kind === "state") {
				states.push({ meta, entry: read });
				if (states.length === 2) break;
			}
		}
		const [older, next] = states;
		if (!older || !next) return false;
		const a = parseObject(older.entry.body) as unknown as ManagedSessionStateInput | null;
		const b = parseObject(next.entry.body) as unknown as ManagedSessionStateInput | null;
		if (!a || !b) return false;
		try {
			writeEntry(state, next.meta, {
				...next.entry,
				body: JSON.stringify(foldStateReports(a, b)),
			});
		} catch {
			return false;
		}
		unlinkQuiet(join(state.dir, seqName(older.meta.seq)));
		dropMeta(state, older.meta);
		return true;
	}

	/**
	 * Rule 2, one step: the oldest events entry that is not the head becomes (or joins) a gap. It joins the
	 * nearest earlier unattempted gap if there is one; otherwise it is rewritten in place as a gap.
	 */
	function replaceOne(state: SessionState): boolean {
		let gapBefore: { meta: EntryMeta; entry: OutboxEntry } | null = null;
		for (let i = 1; i < state.entries.length; i++) {
			const meta = state.entries[i] as EntryMeta;
			const read = readEntry(state, meta);
			if (read === undefined) {
				i--;
				continue;
			}
			if (read === "held") return false;
			if (read.kind === "gap" && !read.attempted) {
				gapBefore = { meta, entry: read };
				continue;
			}
			if (read.kind !== "events") continue;
			const units = eventCount(read);
			try {
				if (gapBefore) {
					const total = (gapBefore.entry.lost ?? 0) + units;
					writeEntry(state, gapBefore.meta, {
						...gapBefore.entry,
						lost: total,
						body: gapBody(total, gapFirstLossAt(gapBefore.entry)),
					});
					unlinkQuiet(join(state.dir, seqName(meta.seq)));
					dropMeta(state, meta);
				} else {
					writeEntry(state, meta, {
						...read,
						kind: "gap",
						attempted: false,
						deliveryId: randomUUID(),
						lost: units,
						failures: undefined,
						firstFailureAt: undefined,
						body: gapBody(units, read.queuedAt),
					});
				}
			} catch {
				return false;
			}
			countLoss(units);
			return true;
		}
		return false;
	}

	/** Rule 3, one step: rule 2 on the largest session that has anything to give. */
	function replaceOneInLargest(): boolean {
		const bySize = [...sessions.values()].sort((x, y) => y.bytes - x.bytes);
		for (const state of bySize) if (replaceOne(state)) return true;
		return false;
	}

	function makeRoom(state: SessionState, size: number): boolean {
		for (;;) {
			const sessionOk = sessionFits(state, size);
			if (sessionOk && totalFits(size)) return true;
			if (!sessionOk) {
				if (foldOne(state) || replaceOne(state)) continue;
				return false;
			}
			if (!replaceOneInLargest()) return false;
		}
	}

	// ── append ──

	function splitEvents(body: string): string[] | null {
		const parsed = parseObject(body);
		const list = parsed?.events;
		if (!Array.isArray(list)) return null;
		const pieces: string[] = [];
		const budget = limits.entryBytes - ENVELOPE_RESERVE_BYTES;
		const push = (chunk: unknown[]) => {
			const text = JSON.stringify({ events: chunk });
			if (chunk.length > 1 && byteLength(text) > budget) {
				const mid = Math.ceil(chunk.length / 2);
				push(chunk.slice(0, mid));
				push(chunk.slice(mid));
			} else pieces.push(text);
		};
		for (let i = 0; i < list.length; i += limits.eventsPerEntry) {
			push(list.slice(i, i + limits.eventsPerEntry));
		}
		return pieces;
	}

	function ensureSessionState(sessionId: string): SessionState | "lost" {
		const known = sessions.get(sessionId);
		if (known) return known;
		if (!isListed) loadDirSync(outboxDirName(sessionId));
		const loaded = sessions.get(sessionId);
		if (loaded) return loaded;
		if (sessions.size >= limits.sessions) return "lost";
		const state = newState(sessionId);
		try {
			mkdirSync(state.dir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return "lost";
		}
		if (!isPrivateDirectory(state.dir)) return "lost";
		try {
			writeText(
				join(state.dir, SESSION_FILE),
				JSON.stringify({ v: OUTBOX_VERSION, sessionId, supervisorId: opts.supervisorId }),
			);
		} catch {
			try {
				rmdirSync(state.dir);
			} catch {
				// not empty or gone: left as it is
			}
			return "lost";
		}
		track(state);
		return state;
	}

	function appendPiece(
		sessionId: string,
		kind: OutboxEntry["kind"],
		body: string,
		attempted: boolean,
		deliveryId: string | undefined,
	): boolean {
		const state = ensureSessionState(sessionId);
		if (state === "lost") return false;
		const queuedAtMs = now();
		const entry: OutboxEntry = {
			sessionId,
			seq: state.nextSeq,
			kind,
			queuedAt: iso(queuedAtMs),
			attempted,
			body,
		};
		if (deliveryId) entry.deliveryId = deliveryId;
		const text = JSON.stringify({ v: OUTBOX_VERSION, ...entry });
		const size = byteLength(text);
		if (size > limits.entryBytes) return false;
		if (!isPrivateDirectory(state.dir)) return false;
		if (!makeRoom(state, size)) return false;
		const meta: EntryMeta = { seq: entry.seq, bytes: 0, queuedAtMs, kind };
		try {
			writeText(join(state.dir, seqName(entry.seq)), text);
		} catch (error) {
			log(`[supervisor] couldn't queue a report offline: ${(error as Error)?.message ?? error}`);
			if (state.entries.length === 0) retire(state);
			return false;
		}
		meta.bytes = size;
		addMeta(state, meta);
		return true;
	}

	/** Events that couldn't be queued: counted, and noted in a gap if there is room for one. */
	function noteDropped(sessionId: string, units: number, atMs: number) {
		countLoss(units);
		const state = sessions.get(sessionId);
		if (!state || !isPrivateDirectory(state.dir)) return;
		const tail = state.entries[state.entries.length - 1];
		try {
			if (tail && state.entries.length > 1) {
				const read = readEntry(state, tail);
				if (read && read !== "held" && read.kind === "gap" && !read.attempted) {
					const total = (read.lost ?? 0) + units;
					writeEntry(state, tail, {
						...read,
						lost: total,
						body: gapBody(total, gapFirstLossAt(read)),
					});
					return;
				}
			}
			if (state.entries.length + 1 > limits.sessionEntries) return;
			const entry: OutboxEntry = {
				sessionId,
				seq: state.nextSeq,
				kind: "gap",
				queuedAt: iso(atMs),
				attempted: false,
				body: gapBody(units, iso(atMs)),
				deliveryId: randomUUID(),
				lost: units,
			};
			const text = JSON.stringify({ v: OUTBOX_VERSION, ...entry });
			const size = byteLength(text);
			if (
				isReady &&
				(state.bytes + size > limits.sessionBytes || totalBytes + size > limits.totalBytes)
			) {
				return;
			}
			writeText(join(state.dir, seqName(entry.seq)), text);
			addMeta(state, { seq: entry.seq, bytes: size, queuedAtMs: atMs, kind: "gap" });
		} catch {
			// counted already; a gap that can't be written is not worth more
		}
	}

	function append(
		sessionId: string,
		e: Pick<OutboxEntry, "kind" | "body" | "attempted" | "deliveryId">,
	): "queued" | "lost" {
		const unitsOf = () => eventCount({ kind: e.kind, body: e.body });
		if (!enabled || !sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
			countLoss(unitsOf());
			return "lost";
		}
		if (e.kind === "gap") return "lost";
		if (!ensureRoot()) {
			countLoss(unitsOf());
			return "lost";
		}
		const parsed = parseObject(e.body);
		if (!parsed || (e.kind === "state" && parsed.sessionId !== sessionId)) {
			countLoss(1);
			return "lost";
		}
		if (e.kind === "state") {
			if (appendPiece(sessionId, "state", e.body, e.attempted, undefined)) return "queued";
			countLoss(1);
			return "lost";
		}
		if (!Array.isArray(parsed.events)) {
			countLoss(1);
			return "lost";
		}
		const total = parsed.events.length;
		const givenId =
			e.deliveryId && DELIVERY_ID_PATTERN.test(e.deliveryId) ? e.deliveryId : undefined;
		const oversize =
			total > limits.eventsPerEntry ||
			byteLength(e.body) > limits.entryBytes - ENVELOPE_RESERVE_BYTES;
		// An entry that was already sent as one request keeps its body and delivery id: splitting it would
		// make the server see a different delivery, and a lost acknowledgement could then store it twice.
		const pieces =
			oversize && !(e.attempted && givenId) ? (splitEvents(e.body) ?? [e.body]) : [e.body];
		let queued = 0;
		let droppedUnits = 0;
		for (const piece of pieces) {
			const single = pieces.length === 1;
			const ok = appendPiece(
				sessionId,
				"events",
				piece,
				single ? e.attempted : false,
				single ? (givenId ?? randomUUID()) : randomUUID(),
			);
			const units = eventCount({ kind: "events", body: piece });
			if (ok) queued++;
			else droppedUnits += units;
		}
		if (droppedUnits > 0) noteDropped(sessionId, droppedUnits, now());
		return queued > 0 ? "queued" : "lost";
	}

	// ── loading ──

	function readSessionFile(dir: string): { sessionId: string; supervisorId: string } | null {
		const found = readPrivateFileNoFollow(join(dir, SESSION_FILE), 4_096);
		if (found.kind !== "ok") return null;
		const raw = parseObject(found.text);
		if (
			!raw ||
			raw.v !== OUTBOX_VERSION ||
			typeof raw.sessionId !== "string" ||
			!raw.sessionId ||
			raw.sessionId.length > MAX_SESSION_ID_LENGTH ||
			typeof raw.supervisorId !== "string"
		) {
			return null;
		}
		return { sessionId: raw.sessionId, supervisorId: raw.supervisorId };
	}

	/** Decides what a listed directory is, given its entry names. Pure bookkeeping; no further I/O but cleanup. */
	function adopt(dirName: string, namesIn: string[]) {
		let names = namesIn;
		const dir = join(root, dirName);
		const info = readSessionFile(dir);
		if (!info || outboxDirName(info.sessionId) !== dirName) {
			if (unknown.size < MAX_LOAD_DIRS) unknown.add(dirName);
			return;
		}
		if (info.supervisorId !== opts.supervisorId) {
			purgeAndRemember(dirName, true);
			return;
		}
		const state = newState(info.sessionId);
		// A directory holding far more than it is allowed to is not trusted to be ours: only the names up to
		// the cap are looked at, and the surplus entries are removed and counted lost.
		const surplus: string[] = [];
		if (names.length > limits.sessionEntries + EXTRA_NAMES_ALLOWED) {
			names = [...names].sort();
			surplus.push(
				...names
					.slice(limits.sessionEntries + EXTRA_NAMES_ALLOWED)
					.filter((n) => n !== SESSION_FILE),
			);
			names = names.slice(0, limits.sessionEntries + EXTRA_NAMES_ALLOWED);
		}
		for (const name of surplus) {
			if (unlinkQuietSilent(join(dir, name)) && ENTRY_PATTERN.test(name)) countLoss(1);
		}
		for (const name of names) {
			if (TMP_PATTERN.test(name)) {
				unlinkQuietSilent(join(dir, name));
				continue;
			}
			const match = ENTRY_PATTERN.exec(name);
			if (!match) continue;
			const seq = Number(match[1]);
			state.entries.push({ seq, bytes: 0, queuedAtMs: Number.NaN });
			state.nextSeq = Math.max(state.nextSeq, seq + 1);
		}
		state.entries.sort((x, y) => x.seq - y.seq);
		for (const extra of state.entries.splice(limits.sessionEntries)) {
			if (unlinkQuietSilent(join(dir, seqName(extra.seq)))) countLoss(1);
		}
		if (state.entries.length === 0) {
			purgeAndRemember(dirName, false);
			return;
		}
		track(state);
	}

	/** Lists one directory synchronously: for a session touched before the asynchronous listing reached it. */
	function loadDirSync(dirName: string) {
		if (sessionsByDir.has(dirName) || unknown.has(dirName)) return;
		const dir = join(root, dirName);
		if (!isPrivateDirectory(dir)) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		adopt(dirName, names);
		const state = sessionsByDir.get(dirName);
		if (!state) return;
		for (const meta of state.entries) {
			try {
				const st = lstatSync(join(dir, seqName(meta.seq)));
				setBytes(state, meta, st.size);
				meta.queuedAtMs = st.mtimeMs;
				meta.approx = true;
				if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0) meta.suspect = true;
			} catch {
				meta.suspect = true;
			}
		}
	}

	async function load() {
		try {
			let names: string[];
			try {
				names = await readdir(root);
			} catch {
				return; // no root yet: a healthy host that has never queued anything
			}
			if (!isPrivateDirectory(root)) {
				disable("its directory isn't private to this account");
				return;
			}
			rootChecked = true;
			let examined = 0;
			let purgedExtra = 0;
			for (const name of names) {
				if (name === META_FILE) {
					readMeta();
					continue;
				}
				if (PURGE_PATTERN.test(name)) {
					// left by an earlier run that was interrupted, or by a purge that couldn't finish
					purgeAndRemember(name, false);
					continue;
				}
				if (!DIR_PATTERN.test(name) || sessionsByDir.has(name) || unknown.has(name)) continue;
				if (++examined > MAX_LOAD_DIRS) {
					// More session directories than this outbox ever follows: the surplus is not ours to keep.
					if (purgedExtra++ < MAX_LOAD_DIRS) purgeAndRemember(name, true);
					continue;
				}
				const dir = join(root, name);
				let entries: string[];
				try {
					if (!isPrivateDirectory(dir)) {
						if (unknown.size < MAX_LOAD_DIRS) unknown.add(name);
						continue;
					}
					entries = await readdir(dir);
				} catch {
					if (unknown.size < MAX_LOAD_DIRS) unknown.add(name);
					continue;
				}
				if (sessionsByDir.has(name)) continue; // appended to meanwhile and adopted synchronously
				adopt(name, entries);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		} finally {
			isListed = true;
		}
		const pending: Array<{ state: SessionState; meta: EntryMeta }> = [];
		for (const state of sessions.values()) {
			for (const meta of state.entries)
				if (Number.isNaN(meta.queuedAtMs)) pending.push({ state, meta });
		}
		for (let i = 0; i < pending.length; i += LSTAT_BATCH) {
			await Promise.all(
				pending.slice(i, i + LSTAT_BATCH).map(async ({ state, meta }) => {
					try {
						const st = await lstat(join(state.dir, seqName(meta.seq)));
						if (meta.gone) return;
						setBytes(state, meta, st.size);
						meta.queuedAtMs = st.mtimeMs;
						meta.approx = true;
						if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0) {
							meta.suspect = true;
						}
					} catch {
						meta.suspect = true;
						if (Number.isNaN(meta.queuedAtMs)) meta.queuedAtMs = now();
					}
				}),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	function readMeta() {
		const found = readPrivateFileNoFollow(join(root, META_FILE), 4_096);
		if (found.kind !== "ok") return;
		const raw = parseObject(found.text);
		if (!raw || raw.v !== OUTBOX_VERSION) return;
		if (typeof raw.lastFlushAt === "string") lastFlushAt = raw.lastFlushAt;
		if (typeof raw.lastFlushDelivered === "number") lastFlushDelivered = raw.lastFlushDelivered;
		if (typeof raw.lastFlushLost === "number") lastFlushLost = raw.lastFlushLost;
	}

	const loading = load().then(
		() => {
			isReady = true;
		},
		(error) => {
			isReady = true;
			log(
				`[supervisor] the offline outbox couldn't be read: ${(error as Error)?.message ?? error}`,
			);
		},
	);

	// ── removing and aging ──

	function unitsRemoved(state: SessionState, meta: EntryMeta): number {
		if (state.head && state.head.seq === meta.seq) {
			return state.head.kind === "gap" ? 0 : eventCount(state.head);
		}
		return meta.kind === "gap" ? 0 : 1;
	}

	function remove(sessionId: string, seq: number, outcome: "delivered" | "lost") {
		const state = sessions.get(sessionId);
		const meta = state?.entries.find((m) => m.seq === seq);
		if (!state || !meta) return;
		const units = unitsRemoved(state, meta);
		unlinkQuiet(join(state.dir, seqName(seq)));
		dropMeta(state, meta);
		if (outcome === "delivered") delivered += units;
		else countLoss(units);
		retireIfEmpty(state);
	}

	function markAttempted(sessionId: string, seq: number): boolean {
		const state = sessions.get(sessionId);
		const current = head(sessionId);
		if (!state || !current || current === "held" || current.seq !== seq) return false;
		if (current.attempted) return true;
		const meta = state.entries[0] as EntryMeta;
		try {
			writeEntry(state, meta, { ...current, attempted: true });
		} catch {
			return false;
		}
		state.head = { ...current, attempted: true };
		return true;
	}

	function recordFailure(
		sessionId: string,
		seq: number,
		nowMs: number,
		options?: { counts?: boolean },
	): "keep" | "poisoned" {
		if (options?.counts === false) return "keep";
		const state = sessions.get(sessionId);
		const current = head(sessionId);
		if (!state || !current || current === "held" || current.seq !== seq) return "keep";
		const failures = (current.failures ?? 0) + 1;
		const firstFailureAt = current.firstFailureAt ?? iso(nowMs);
		const since = nowMs - (Date.parse(firstFailureAt) || nowMs);
		if (failures >= limits.poisonFailures && since >= limits.poisonSpanMs) {
			log("[supervisor] an offline outbox entry kept failing and was dropped");
			remove(sessionId, seq, "lost");
			return "poisoned";
		}
		const updated = { ...current, failures, firstFailureAt };
		try {
			writeEntry(state, state.entries[0] as EntryMeta, updated);
		} catch {
			// kept in memory only; the count restarts if the supervisor does
		}
		state.head = updated;
		return "keep";
	}

	function ageOutSession(state: SessionState, nowMs: number) {
		const aged = state.entries.filter((m) => m.queuedAtMs <= nowMs - limits.ageMs);
		if (aged.length === 0) return;
		const loaded: Array<{ meta: EntryMeta; entry: OutboxEntry }> = [];
		for (const meta of aged) {
			const read = readEntry(state, meta);
			if (read === "held") continue;
			// Reading gives the time the entry was really queued, which replaces the file's mtime it was
			// judged by until now: an entry that turns out to be recent stays.
			if (read && meta.queuedAtMs <= nowMs - limits.ageMs) loaded.push({ meta, entry: read });
		}
		const agedStates = loaded.filter((x) => x.entry.kind === "state");
		const agedOther = loaded.filter((x) => x.entry.kind !== "state");
		if (agedStates.length > 1) {
			const [first, ...rest] = agedStates as [(typeof agedStates)[number], ...typeof agedStates];
			let folded = parseObject(first.entry.body) as unknown as ManagedSessionStateInput | null;
			for (const next of rest) {
				const b = parseObject(next.entry.body) as unknown as ManagedSessionStateInput | null;
				if (folded && b) folded = foldStateReports(folded, b);
			}
			if (folded) {
				try {
					writeEntry(state, first.meta, {
						...first.entry,
						attempted: false,
						body: JSON.stringify(folded),
					});
					for (const next of rest) {
						unlinkQuiet(join(state.dir, seqName(next.meta.seq)));
						dropMeta(state, next.meta);
					}
				} catch {
					// left as they are; the next pass tries again
				}
			}
		}
		if (agedOther.length > 0) {
			const units = agedOther.reduce(
				(sum, x) => sum + (x.entry.kind === "gap" ? (x.entry.lost ?? 0) : eventCount(x.entry)),
				0,
			);
			const [anchor, ...rest] = agedOther as [(typeof agedOther)[number], ...typeof agedOther];
			const firstLossAt = agedOther
				.map((x) => (x.entry.kind === "gap" ? gapFirstLossAt(x.entry) : x.entry.queuedAt))
				.sort()[0] as string;
			const realLoss = agedOther.reduce(
				(sum, x) => sum + (x.entry.kind === "gap" ? 0 : eventCount(x.entry)),
				0,
			);
			try {
				writeEntry(state, anchor.meta, {
					...anchor.entry,
					kind: "gap",
					attempted: false,
					deliveryId: randomUUID(),
					lost: units,
					failures: undefined,
					firstFailureAt: undefined,
					body: gapBody(units, firstLossAt),
				});
				for (const next of rest) {
					unlinkQuiet(join(state.dir, seqName(next.meta.seq)));
					dropMeta(state, next.meta);
				}
				countLoss(realLoss);
			} catch {
				// left as they are; the next pass tries again
			}
		}
		state.head = undefined;
	}

	function ageOut(nowMs: number) {
		for (const state of [...sessions.values()]) {
			if (!isPrivateDirectory(state.dir)) continue;
			ageOutSession(state, nowMs);
			retireIfEmpty(state);
		}
	}

	function purge(sessionId: string, options?: { countLost?: boolean }) {
		const state = sessions.get(sessionId);
		const dirName = state?.dirName ?? outboxDirName(sessionId);
		const queued = state?.entries.length ?? 0;
		const result = purgeDirectory(dirName);
		if (options?.countLost) countLoss(Math.max(queued, result.removed));
		if (!result.gone && result.leftover) {
			if (unknown.size < MAX_LOAD_DIRS) unknown.add(result.leftover);
			log(
				"[supervisor] an offline outbox directory couldn't be fully removed; it will be tried again",
			);
		}
		if (state) untrack(state);
	}

	function purgeDir(dirName: string) {
		if (!DIR_PATTERN.test(dirName) && !PURGE_PATTERN.test(dirName)) return;
		purgeAndRemember(dirName, true);
	}

	function endFlush(nowIso: string) {
		lastFlushAt = nowIso;
		lastFlushDelivered = delivered;
		lastFlushLost = lost;
		delivered = 0;
		lost = 0;
		if (!ensureRoot()) return;
		try {
			writeText(
				join(root, META_FILE),
				JSON.stringify({
					v: OUTBOX_VERSION,
					supervisorId: opts.supervisorId,
					lastFlushAt,
					lastFlushDelivered,
					lastFlushLost,
				}),
			);
		} catch {
			// the summary lives in memory until the next flush
		}
	}

	return {
		get enabled() {
			return enabled;
		},
		ready: () => loading,
		listed: () => isListed,
		hasPending: (sessionId) => (sessions.get(sessionId)?.entries.length ?? 0) > 0,
		sessions() {
			for (const state of [...sessions.values()]) {
				if ((state.entries[0] as EntryMeta | undefined)?.approx) head(state.sessionId);
			}
			return [...sessions.values()]
				.filter((s) => s.entries.length > 0)
				.sort(
					(x, y) =>
						(x.entries[0] as EntryMeta).queuedAtMs - (y.entries[0] as EntryMeta).queuedAtMs ||
						(x.dirName < y.dirName ? -1 : 1),
				)
				.map((s) => s.sessionId);
		},
		unknownDirs: () => [...unknown],
		append,
		head,
		markAttempted,
		recordFailure,
		remove,
		purge,
		purgeDir,
		ageOut,
		beginFlush() {
			delivered = 0;
		},
		endFlush,
		summary() {
			let pending = 0;
			let oldest = Number.POSITIVE_INFINITY;
			for (const state of [...sessions.values()]) {
				pending += state.entries.length;
				// The oldest entry of a session is its head. One only listed has its file's mtime for a
				// time; reading it gives the time it was queued.
				if ((state.entries[0] as EntryMeta | undefined)?.approx) head(state.sessionId);
				const first = state.entries[0];
				if (first && !Number.isNaN(first.queuedAtMs) && first.queuedAtMs < oldest) {
					oldest = first.queuedAtMs;
				}
			}
			return {
				pending,
				oldestPendingAt: Number.isFinite(oldest) ? iso(oldest) : null,
				lastFlushAt,
				lastFlushDelivered,
				lastFlushLost,
			};
		},
	};
}
