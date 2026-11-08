/**
 * What each tool call of a continued Claude session ran, kept for its owner (AGEN-123, F18-F23, F40, F63).
 *
 * The only module that reads or writes `fork_tool_calls` (fork-tool-calls-readers.guard.test.ts holds that):
 * storage, redaction, encryption, the volume caps and retention live here and nowhere else, so no feed, push,
 * search, embedding, Ask, watcher, Summary or Telegram path can reach the text. A reader needs a signed-in
 * person who owns the session or is an admin; the routes check the person, this module checks the rest.
 *
 * What is stored is not what the host sent. Each text goes through: NUL and invalid UTF-8 out; the last 1 KiB
 * dropped when the host cut it; the whole received text redacted (the built-in rules and any the caller
 * passes); cut to 16 KiB at a code point; redacted again, because a secret straddling a cut escapes a pattern
 * (xander M5). A redactor that throws stores nothing for the call. The cut text is then encrypted with
 * AGENTPULSE_SECRETS_KEY, so a database copy or a backup alone yields no tool text (F40).
 */
import type { SQL } from "drizzle-orm";
import { and, asc, count, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { FORK_CALL_OUTCOMES, FORK_REPORTED_TOOLS } from "../../shared/claude-fork-copy.js";
import {
	FORK_TOOL_DETAIL_CAP_BYTES,
	FORK_TOOL_DETAIL_LIMITS,
	FORK_TOOL_DETAIL_RETENTION_MS,
	type ForkToolCallDto,
	type ForkToolCallIndexEntry,
	type ForkToolCallIndexList,
	type ForkToolCallList,
	type ForkToolCallReport,
	type ForkToolCallsReportBody,
	type ForkToolCallsReportResponse,
} from "../../shared/fork-tool-calls.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { forkToolCalls, sessions, settings } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { type RedactionRule, stripAndRedact } from "./ai/redactor.js";
import { decryptSecretAsync, encryptSecretAsync } from "./ai/secrets.js";
import { mayReadToolDetail } from "./authorization.js";
import { getMode } from "./instance-mode.js";
import { assertSupervisorCanWriteSession } from "./session-ownership.js";
import { FixedWindowCounter } from "./util/fixed-window-counter.js";

/** The setting event retention reads; a copy of retention-service's key (a test holds them equal) so this module doesn't import it. */
export const EVENTS_RETENTION_SETTING_KEY = "eventsRetentionDays";

const HOUR_MS = 60 * 60 * 1000;
const TOOL_USE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REPORTED_TOOLS: readonly string[] = FORK_REPORTED_TOOLS;
const OUTCOMES: readonly string[] = FORK_CALL_OUTCOMES;

/** Whether the server can keep detail at all: the key it is encrypted with must be set. */
export function forkToolDetailAvailable(): boolean {
	return Boolean(config.secretsKey);
}

export type ForkToolDetailRefusalCode =
	| "human_required"
	| "not_owner"
	| "session_not_found"
	| "tool_call_not_found"
	| "invalid_query"
	| "invalid_body"
	| "not_a_fork"
	| "detail_unavailable";

export class ForkToolDetailRefusal extends Error {
	constructor(readonly code: ForkToolDetailRefusalCode) {
		super(code);
		this.name = "ForkToolDetailRefusal";
	}
}

// ---- parsing the host's report ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function textField(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	return byteLength(value) <= FORK_TOOL_DETAIL_LIMITS.hostFieldCapBytes ? value : undefined;
}

function parseCall(raw: unknown): ForkToolCallReport | null {
	if (!isRecord(raw)) return null;
	const { toolUseId, turnActionId, tool, outcome, fromSubagent } = raw;
	if (typeof toolUseId !== "string" || !TOOL_USE_ID_RE.test(toolUseId)) return null;
	if (
		turnActionId !== null &&
		(typeof turnActionId !== "string" || !ACTION_ID_RE.test(turnActionId))
	) {
		return null;
	}
	if (typeof tool !== "string" || !REPORTED_TOOLS.includes(tool)) return null;
	if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return null;
	if (typeof fromSubagent !== "boolean") return null;
	const input = textField(raw.input);
	const output = textField(raw.output);
	if (input === undefined || output === undefined) return null;
	if (typeof raw.inputTruncated !== "boolean" || typeof raw.outputTruncated !== "boolean") {
		return null;
	}
	return {
		toolUseId,
		turnActionId,
		tool,
		outcome,
		fromSubagent,
		input,
		inputTruncated: raw.inputTruncated,
		output,
		outputTruncated: raw.outputTruncated,
	};
}

/** The report, or null when any part of it isn't the contract: nothing partial is accepted. */
export function parseForkToolCallsReport(body: unknown): ForkToolCallsReportBody | null {
	if (!isRecord(body) || body.v !== 1 || !Array.isArray(body.calls)) return null;
	if (body.calls.length === 0 || body.calls.length > FORK_TOOL_DETAIL_LIMITS.callsPerReport) {
		return null;
	}
	const calls: ForkToolCallReport[] = [];
	for (const raw of body.calls) {
		const call = parseCall(raw);
		if (!call) return null;
		calls.push(call);
	}
	return { v: 1, calls };
}

// ---- making one text safe to keep ----

/** `text` cut to at most `maxBytes` UTF-8 bytes, on a code point. */
export function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= maxBytes) return { text, cut: false };
	let end = maxBytes;
	while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(encoded.subarray(0, end)), cut: true };
}

export interface PreparedText {
	text: string;
	/** Cut by the host or by this module. */
	truncated: boolean;
	/** Something looked like a secret and was replaced. */
	redacted: boolean;
}

/** Lone surrogates are the invalid UTF-8 of a JavaScript string; NUL is never kept. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function wellFormed(text: string): string {
	return text.replace(LONE_SURROGATE_RE, "\uFFFD").replaceAll("\u0000", "");
}

/**
 * The text as it will be kept, or throws if a redaction rule does (the caller then stores nothing for the
 * call). Order matters: redact the whole received text, then cut, then redact the cut text again.
 */
export function prepareDetailText(
	received: string,
	hostCut: boolean,
	rules: RedactionRule[] = [],
): PreparedText {
	let text = wellFormed(received);
	if (hostCut) {
		const kept = byteLength(text) - FORK_TOOL_DETAIL_LIMITS.hostCutDropBytes;
		text = kept > 0 ? cutUtf8(text, kept).text : "";
	}
	const first = stripAndRedact(text, rules);
	const cut = cutUtf8(first.text, FORK_TOOL_DETAIL_CAP_BYTES);
	const second = stripAndRedact(cut.text, rules);
	return {
		text: second.text,
		truncated: hostCut || cut.cut,
		redacted: first.hits.length > 0 || second.hits.length > 0,
	};
}

// ---- time ----

/** The oldest a stored call may be and still be served: 7 days, or a positive event-retention window if shorter. */
export function forkToolDetailCutoffMs(now: Date, eventRetentionDays: number): number {
	const window =
		eventRetentionDays > 0
			? Math.min(FORK_TOOL_DETAIL_RETENTION_MS, eventRetentionDays * 24 * HOUR_MS)
			: FORK_TOOL_DETAIL_RETENTION_MS;
	return now.getTime() - window;
}

async function readEventRetentionDays(): Promise<number> {
	const [row] = await getDb()
		.select()
		.from(settings)
		.where(eq(settings.key, EVENTS_RETENTION_SETTING_KEY))
		.limit(1);
	const n = typeof row?.value === "number" ? row.value : Number(row?.value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function cutoffIso(now: Date): Promise<string> {
	return new Date(forkToolDetailCutoffMs(now, await readEventRetentionDays())).toISOString();
}

// ---- writing ----

/** In memory, per replica, like the other limiters. */
const hourlyCalls = new FixedWindowCounter(HOUR_MS);

let idCounter = 0;
/** Sorts by time, then by arrival within the same millisecond; the tail keeps ids unguessable. */
function newRowId(nowMs: number): string {
	idCounter = (idCounter + 1) % 0x10000;
	return `${nowMs.toString(16).padStart(12, "0")}${idCounter.toString(16).padStart(4, "0")}-${crypto.randomUUID()}`;
}

async function sessionIsFork(sessionId: string): Promise<boolean> {
	const [row] = await getDb()
		.select({ metadata: sessions.metadata })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const metadata = row?.metadata as Record<string, unknown> | null | undefined;
	return typeof metadata?.forkedFromSessionId === "string";
}

interface PreparedCall {
	call: ForkToolCallReport;
	input: PreparedText | null;
	output: PreparedText | null;
}

/** Null: nothing is stored for this call (a rule threw). */
function prepareCall(call: ForkToolCallReport, rules: RedactionRule[]): PreparedCall | null {
	try {
		return {
			call,
			input: call.input === null ? null : prepareDetailText(call.input, call.inputTruncated, rules),
			output:
				call.output === null ? null : prepareDetailText(call.output, call.outputTruncated, rules),
		};
	} catch {
		return null;
	}
}

async function storeCall(
	sessionId: string,
	prepared: PreparedCall,
	nowIso: string,
	nowMs: number,
): Promise<boolean> {
	const { call, input, output } = prepared;
	const row = {
		id: newRowId(nowMs),
		sessionId,
		turnActionId: call.turnActionId,
		toolUseId: call.toolUseId,
		tool: call.tool,
		outcome: call.outcome,
		fromSubagent: call.fromSubagent,
		inputCipher: input === null ? null : await encryptSecretAsync(input.text),
		inputTruncated: input?.truncated ?? false,
		outputCipher: output === null ? null : await encryptSecretAsync(output.text),
		outputTruncated: output?.truncated ?? false,
		redacted: (input?.redacted ?? false) || (output?.redacted ?? false),
		createdAt: nowIso,
	};
	return withTransaction(async (tx) => {
		const inserted: Array<{ id: string }> = await tx
			.insert(forkToolCalls)
			.values(row)
			.onConflictDoNothing({ target: [forkToolCalls.sessionId, forkToolCalls.toolUseId] })
			.returning({ id: forkToolCalls.id });
		if (inserted.length === 0) return false;
		const [{ n }] = await tx
			.select({ n: count() })
			.from(forkToolCalls)
			.where(eq(forkToolCalls.sessionId, sessionId));
		const excess = Number(n) - FORK_TOOL_DETAIL_LIMITS.rowsPerSession;
		if (excess > 0) {
			const oldest: Array<{ id: string }> = await tx
				.select({ id: forkToolCalls.id })
				.from(forkToolCalls)
				.where(eq(forkToolCalls.sessionId, sessionId))
				.orderBy(asc(forkToolCalls.createdAt), asc(forkToolCalls.id))
				.limit(excess);
			await tx.delete(forkToolCalls).where(
				inArray(
					forkToolCalls.id,
					oldest.map((r) => r.id),
				),
			);
		}
		return true;
	});
}

export interface RecordOptions {
	/** The user's redaction rules, on top of the built-in ones. */
	rules?: RedactionRule[];
	now?: Date;
}

/**
 * Stores the calls a host reported for one of its forks. The host owns the session (ownership is judged by
 * `assertSupervisorCanWriteSession`, throwing `SessionOwnershipError`), and the session must be a fork. A
 * call over a cap or one a rule couldn't make safe is dropped and counted; a repeated `tool_use_id` keeps
 * the first content.
 */
export async function recordForkToolCalls(
	supervisorId: string,
	sessionId: string,
	calls: readonly ForkToolCallReport[],
	options: RecordOptions = {},
): Promise<ForkToolCallsReportResponse> {
	if (!forkToolDetailAvailable()) throw new ForkToolDetailRefusal("detail_unavailable");
	await assertSupervisorCanWriteSession(supervisorId, sessionId);
	if (!(await sessionIsFork(sessionId))) throw new ForkToolDetailRefusal("not_a_fork");
	const rules = options.rules ?? [];
	const now = options.now ?? new Date();
	let stored = 0;
	let dropped = 0;
	for (const call of calls) {
		const prepared = prepareCall(call, rules);
		if (!prepared) {
			dropped++;
			continue;
		}
		if (!hourlyCalls.tryConsume(sessionId, FORK_TOOL_DETAIL_LIMITS.callsPerHourPerSession)) {
			dropped++;
			continue;
		}
		if (await storeCall(sessionId, prepared, now.toISOString(), now.getTime())) stored++;
	}
	if (dropped > 0) {
		console.warn(JSON.stringify({ msg: "fork_tool_detail_dropped", sessionId, dropped, stored }));
	}
	return { stored, dropped };
}

/** Test seam: forgets the hourly counts. */
export function __resetForkToolDetailLimiterForTests(): void {
	(hourlyCalls as unknown as { windows: Map<string, unknown> }).windows.clear();
}

// ---- reading ----

export interface ToolDetailCaller {
	actor: Actor;
	/** A signed-in person (or auth off), never an API key. */
	isHuman: boolean;
}

/**
 * The person check, then the owner check, in that order and before any row is read, so a refusal says
 * nothing about whether a row exists. A missing session is a 403 to anyone who could not have read it.
 */
async function authorizeRead(sessionId: string, caller: ToolDetailCaller): Promise<void> {
	if (!caller.isHuman) throw new ForkToolDetailRefusal("human_required");
	const mode = caller.actor.mode ?? (await getMode());
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const session = row ? { ownerUserId: row.ownerUserId ?? null } : null;
	if (!mayReadToolDetail(caller.actor, mode, session)) {
		throw new ForkToolDetailRefusal("not_owner");
	}
	if (session === null) throw new ForkToolDetailRefusal("session_not_found");
	if (!forkToolDetailAvailable()) throw new ForkToolDetailRefusal("detail_unavailable");
}

async function decryptOrNull(cipher: string | null): Promise<string | null> {
	if (cipher === null) return null;
	try {
		return await decryptSecretAsync(cipher);
	} catch {
		// A key that no longer opens the text (rotated): the row reads as having no text.
		return null;
	}
}

type StoredRow = typeof forkToolCalls.$inferSelect;

function toIndexEntry(row: StoredRow): ForkToolCallIndexEntry {
	return {
		toolUseId: row.toolUseId,
		tool: row.tool,
		outcome: row.outcome,
		fromSubagent: Boolean(row.fromSubagent),
		inputTruncated: Boolean(row.inputTruncated),
		outputTruncated: Boolean(row.outputTruncated),
		redacted: Boolean(row.redacted),
		createdAt: row.createdAt,
	};
}

async function toDto(row: StoredRow): Promise<ForkToolCallDto> {
	return {
		...toIndexEntry(row),
		input: await decryptOrNull(row.inputCipher),
		output: await decryptOrNull(row.outputCipher),
	};
}

export interface ListQuery {
	/** A `toolUseId` of this session: the page starts after it (newest first). */
	beforeId?: string;
	limit?: number;
	turnActionId?: string;
}

interface StoredPage {
	rows: StoredRow[];
	nextBeforeId: string | null;
}

/** A page of the session's stored calls, newest first, with their text. */
export async function listForkToolCalls(
	sessionId: string,
	caller: ToolDetailCaller,
	query: ListQuery = {},
	now: Date = new Date(),
): Promise<ForkToolCallList> {
	const page = await readPage(sessionId, caller, query, now);
	return {
		v: 1,
		calls: await Promise.all(page.rows.map(toDto)),
		nextBeforeId: page.nextBeforeId,
	};
}

/** The same page without the text: the `input` and `output` keys are absent and nothing is decrypted. */
export async function listForkToolCallIndex(
	sessionId: string,
	caller: ToolDetailCaller,
	query: ListQuery = {},
	now: Date = new Date(),
): Promise<ForkToolCallIndexList> {
	const page = await readPage(sessionId, caller, query, now);
	return { v: 1, calls: page.rows.map(toIndexEntry), nextBeforeId: page.nextBeforeId };
}

async function readPage(
	sessionId: string,
	caller: ToolDetailCaller,
	query: ListQuery,
	now: Date,
): Promise<StoredPage> {
	const limit = query.limit ?? FORK_TOOL_DETAIL_LIMITS.listMax;
	if (!Number.isInteger(limit) || limit < 1 || limit > FORK_TOOL_DETAIL_LIMITS.listMax) {
		throw new ForkToolDetailRefusal("invalid_query");
	}
	if (query.beforeId !== undefined && !TOOL_USE_ID_RE.test(query.beforeId)) {
		throw new ForkToolDetailRefusal("invalid_query");
	}
	if (query.turnActionId !== undefined && !ACTION_ID_RE.test(query.turnActionId)) {
		throw new ForkToolDetailRefusal("invalid_query");
	}
	await authorizeRead(sessionId, caller);
	const cutoff = await cutoffIso(now);
	const db = getDb();
	const conditions: Array<SQL | undefined> = [
		eq(forkToolCalls.sessionId, sessionId),
		// The cutoff row itself is still served.
		gte(forkToolCalls.createdAt, cutoff),
	];
	if (query.turnActionId !== undefined) {
		conditions.push(eq(forkToolCalls.turnActionId, query.turnActionId));
	}
	if (query.beforeId !== undefined) {
		const [anchor] = await db
			.select({ id: forkToolCalls.id, createdAt: forkToolCalls.createdAt })
			.from(forkToolCalls)
			.where(
				and(eq(forkToolCalls.sessionId, sessionId), eq(forkToolCalls.toolUseId, query.beforeId)),
			)
			.limit(1);
		// An id of no row in this session pages nothing, so another session's ids can't be probed.
		if (!anchor) return { rows: [], nextBeforeId: null };
		const olderThanAnchor = or(
			lt(forkToolCalls.createdAt, anchor.createdAt),
			and(eq(forkToolCalls.createdAt, anchor.createdAt), lt(forkToolCalls.id, anchor.id)),
		);
		if (olderThanAnchor) conditions.push(olderThanAnchor);
	}
	const rows: StoredRow[] = await db
		.select()
		.from(forkToolCalls)
		.where(and(...conditions))
		.orderBy(desc(forkToolCalls.createdAt), desc(forkToolCalls.id))
		.limit(limit);
	const last = rows.at(-1);
	return { rows, nextBeforeId: rows.length === limit && last ? last.toolUseId : null };
}

/** One stored call, or `tool_call_not_found` when there is none (or it has aged out). */
export async function getForkToolCall(
	sessionId: string,
	toolUseId: string,
	caller: ToolDetailCaller,
	now: Date = new Date(),
): Promise<ForkToolCallDto> {
	await authorizeRead(sessionId, caller);
	const cutoff = await cutoffIso(now);
	const [row]: StoredRow[] = await getDb()
		.select()
		.from(forkToolCalls)
		.where(and(eq(forkToolCalls.sessionId, sessionId), eq(forkToolCalls.toolUseId, toolUseId)))
		.limit(1);
	if (!row || row.createdAt < cutoff) throw new ForkToolDetailRefusal("tool_call_not_found");
	return toDto(row);
}

// ---- retention ----

/**
 * Deletes calls older than the effective cutoff, in batches. Idempotent across replicas (a second one finds
 * the rows gone), so it takes no lock. Runs whether or not event retention is on.
 */
export async function pruneForkToolCalls(
	now: Date,
	eventRetentionDays: number,
	batchSize = 1000,
	maxBatches = 1000,
): Promise<number> {
	const cutoff = new Date(forkToolDetailCutoffMs(now, eventRetentionDays)).toISOString();
	const db = getDb();
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const rows: Array<{ id: string }> = await db
			.select({ id: forkToolCalls.id })
			.from(forkToolCalls)
			.where(lt(forkToolCalls.createdAt, cutoff))
			.orderBy(asc(forkToolCalls.createdAt), asc(forkToolCalls.id))
			.limit(batchSize);
		if (rows.length === 0) break;
		await db.delete(forkToolCalls).where(
			inArray(
				forkToolCalls.id,
				rows.map((r) => r.id),
			),
		);
		deleted += rows.length;
		if (rows.length < batchSize) break;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return deleted;
}
