/**
 * AGEN-69 phase 5: the session summary service.
 *
 * `getSessionSummaryView` is the read model: point reads only, never a write, a
 * decrypt or a model call, and no AI on/off/paused state (the web reads that from
 * `/ai/status`, D-32). This is the only module besides `retention-service.ts` that
 * names the `ai_session_summaries` table (TC-5.35).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
	STALE_EVENT_COUNT_CAP,
	type SessionSummaryRefusalBody,
	type SessionSummaryStartBody,
	type SessionSummaryView,
	type SummaryBlockReason,
	type SummaryErrorCode,
} from "../../shared/session-summary-view.js";
import { SUMMARY_SCHEMA_VERSION, type StoredSessionSummary } from "../../shared/session-summary.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { type Db, getDb } from "../db/client.js";
import { aiSessionSummaries, llmProviders, sessions } from "../db/schema/index.js";
import { SESSION_COLUMNS_SANS_OWNERSHIP } from "../db/session-columns.js";
import { executeRows } from "../db/sql-helpers.js";
import { isShuttingDown } from "../drain-state.js";
import { OwnTurnBusyError, runInOwnTurn } from "../util/own-turn.js";
import { isAiActive } from "./ai/feature.js";
import { priceCompletion } from "./ai/llm/pricing.js";
import { getAdapter } from "./ai/llm/registry.js";
import { LlmError, type LlmResponse, type ProviderKind, estimateTokens } from "./ai/llm/types.js";
import { getProviderApiKey } from "./ai/providers-service.js";
import {
	EvidenceReadError,
	classExpression,
	effectiveCategory,
	loadEvidence,
} from "./ai/session-summary/evidence-loader.js";
import { type Ledger, buildLedgerAsync, userPromptTexts } from "./ai/session-summary/ledger.js";
import {
	type RepairKind,
	classifyStopReason,
	parseAnswer,
} from "./ai/session-summary/output-schema.js";
import {
	PROMPT_VERSION,
	buildSummaryLlmRequest,
	buildSummaryPrompt,
	sessionForPrompt,
} from "./ai/session-summary/prompt.js";
import {
	ACTIVITY_ACTION_WINDOW,
	ACTIVITY_PROMPT_OLDEST_WINDOW,
	BREAKER_FAILURES,
	BREAKER_OPEN_MS,
	BREAKER_WINDOW_MS,
	BUSY_RETRY_AFTER_SECONDS,
	JOIN_WAIT_BUDGET_MS,
	MAX_CONCURRENT_GENERATIONS,
	MAX_INPUT_TOKENS,
	MAX_OUTPUT_TOKENS,
	SCAN_BUSY_RETRY_AFTER_SECONDS,
	SHUTDOWN_RELEASE_BUDGET_MS,
	SHUTTING_DOWN_RETRY_AFTER_SECONDS,
	STALE_SCAN_WINDOW,
	SUMMARY_COOLDOWN_SECONDS,
	SUMMARY_LEASE_SECONDS,
	URL_SCAN_SLICE_CHARS,
} from "./ai/session-summary/service-limits.js";
import { collectUserPromptUrls } from "./ai/session-summary/tripwire.js";
import {
	buildStoredSummary,
	newestEventAt,
	sessionStateForVerify,
	verifySummary,
} from "./ai/session-summary/verify.js";
import {
	DEFAULT_DAILY_CAP_CENTS,
	type SpendReservation,
	getTodaySpendCents,
	releaseReservedSpend,
	reserveSpendCents,
	settleReservedSpend,
	topUpReservation,
} from "./ai/spend-service.js";
import { logAdminAction } from "./audit-log.js";
import { isLabsFlagEnabled } from "./labs-service.js";
import { readRetentionDays } from "./retention-service.js";
import { parseDbTimestamp, toDbTimestamp } from "./util/db-time.js";

// ── the interface callers use ────────────────────────────────────────────────

export interface SummaryRequestCaller {
	/** Who is asking: a user id or a key id, as a string. Used only for the team-mode one-at-a-time rule. */
	subject: string;
	/** The instance is in team mode (the caller derives it; this module never compares the mode). */
	teamMode: boolean;
	/** The real actor of the request, for the audit line. */
	actor: Actor;
}

export type SummaryRequestResult =
	| { kind: "started"; body: SessionSummaryStartBody; done: Promise<void> }
	| { kind: "joined"; body: SessionSummaryStartBody }
	| { kind: "refused"; refusal: SessionSummaryRefusalBody };

// ── time and the attempt row ─────────────────────────────────────────────────

/** The instants a decision is made against, all built with `toDbTimestamp` so they compare with stored text. */
interface Clock {
	nowMs: number;
	leaseCutoff: string;
	cooldownCutoff: string;
}

function clockAt(date: Date = new Date()): Clock {
	const nowMs = parseDbTimestamp(toDbTimestamp(date)) as number;
	return {
		nowMs,
		leaseCutoff: toDbTimestamp(new Date(nowMs - SUMMARY_LEASE_SECONDS * 1000)),
		cooldownCutoff: toDbTimestamp(new Date(nowMs - SUMMARY_COOLDOWN_SECONDS * 1000)),
	};
}

const isoOf = (stamp: string | null): string | null => {
	const ms = stamp ? parseDbTimestamp(stamp) : null;
	return ms === null ? null : new Date(ms).toISOString();
};

interface AttemptColumns {
	attemptStatus: string | null;
	attemptStartedAt: string | null;
	attemptErrorCode: string | null;
}

/** What the attempt columns say now, with the lease and the cooldown applied. */
type AttemptJudgement =
	| { kind: "live" }
	| { kind: "lapsed" }
	| { kind: "cooldown"; retryAfterSeconds: number }
	| { kind: "open" };

function judgeAttempt(row: AttemptColumns, clock: Clock): AttemptJudgement {
	const started = row.attemptStartedAt;
	if (row.attemptStatus === "generating") {
		return started !== null && started < clock.leaseCutoff ? { kind: "lapsed" } : { kind: "live" };
	}
	if (
		started !== null &&
		!(started < clock.cooldownCutoff) &&
		row.attemptErrorCode !== "interrupted"
	) {
		const startedMs = parseDbTimestamp(started) as number;
		const left = SUMMARY_COOLDOWN_SECONDS - Math.floor((clock.nowMs - startedMs) / 1000);
		return { kind: "cooldown", retryAfterSeconds: Math.max(1, left) };
	}
	return { kind: "open" };
}

// ── the default provider and what a call can cost ───────────────────────────

interface DefaultProvider {
	id: string;
	kind: ProviderKind;
	model: string;
	baseUrl: string | null;
}

async function readDefaultProvider(): Promise<DefaultProvider | null> {
	const [row] = await getDb()
		.select({
			id: llmProviders.id,
			kind: llmProviders.kind,
			model: llmProviders.model,
			baseUrl: llmProviders.baseUrl,
		})
		.from(llmProviders)
		.where(and(eq(llmProviders.userId, "local"), eq(llmProviders.isDefault, true)))
		.limit(1);
	return row ? { ...row, kind: row.kind as ProviderKind } : null;
}

/** The most one model call can cost: the bounded prompt in, the full output out. Zero for a free provider. */
function maxCallCostCents(provider: Pick<DefaultProvider, "kind" | "model">): number {
	return priceCompletion(provider.kind, provider.model, {
		inputTokens: MAX_INPUT_TOKENS,
		outputTokens: MAX_OUTPUT_TOKENS,
		estimated: true,
	});
}

/**
 * The most tokens a prompt can be, whatever its characters: the larger of the 4.5-characters-per-token
 * estimate and one token per two UTF-8 bytes (dense text, CJK and emoji run at 1 to 2 bytes per token,
 * where the estimate counts characters). Used wherever the budget must not be under-counted.
 */
function worstCaseInputTokens(text: string): number {
	return Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text, "utf8") / 2));
}

/** The next midnight of the server's local date, as an instant (the spend day is the server-local date). */
function nextLocalMidnightIso(now: Date = new Date()): string {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}

// ── probes ───────────────────────────────────────────────────────────────────

/**
 * Whether the session has enough to summarise, and its oldest event id now (null when it has no
 * events), in one statement. "Enough" is a prompt in the oldest `ACTIVITY_PROMPT_OLDEST_WINDOW`
 * or newest `ACTIVITY_ACTION_WINDOW` events, or an action (not read-class) in the newest ones.
 * Both windows are index range scans on (session_id, id), so a view costs a bounded read, never a
 * scan of a long session. A session whose only prompt sits in the unscanned middle of a very long
 * history reads as "too little activity" until it has newer activity. The view and the POST both
 * ask this one question, so the button is never offered and then refused.
 */
async function probeActivity(
	sessionId: string,
): Promise<{ enough: boolean; firstEventId: number | null }> {
	const query = sql`SELECT
		(SELECT min(id) FROM events WHERE session_id = ${sessionId}) AS min_id,
		CASE WHEN
			EXISTS (
				SELECT 1 FROM (
					SELECT id, category, event_type FROM events
					WHERE session_id = ${sessionId} ORDER BY id ASC LIMIT ${sql.raw(String(ACTIVITY_PROMPT_OLDEST_WINDOW))}
				) o WHERE ${effectiveCategory("o")} = 'prompt')
			OR EXISTS (
				SELECT 1 FROM (
					SELECT id, category, event_type, tool_name FROM events
					WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${sql.raw(String(ACTIVITY_ACTION_WINDOW))}
				) n WHERE ${effectiveCategory("n")} = 'prompt' OR ${classExpression("n")} = 'action')
		THEN 1 ELSE 0 END AS enough`;
	const [row] = await runInOwnTurn(() =>
		executeRows<{ enough: number | string; min_id: number | string | null }>(getDb(), query),
	);
	return {
		enough: Number(row?.enough ?? 0) === 1,
		firstEventId: row?.min_id === null || row?.min_id === undefined ? null : Number(row.min_id),
	};
}

/**
 * Material events after `throughEventId` (everything but `user_ack`, NULL categories included),
 * counted up to the cap, inside a window of `STALE_SCAN_WINDOW` rows: a long tail of
 * acknowledgements cannot make a view cost a session scan. When the window fills before the cap is
 * reached the count is a lower bound.
 */
async function countStaleEvents(sessionId: string, throughEventId: number): Promise<number> {
	const query = sql`SELECT count(*) AS n FROM (
		SELECT 1 FROM (
			SELECT category FROM events WHERE session_id = ${sessionId} AND id > ${throughEventId}
			ORDER BY id ASC LIMIT ${sql.raw(String(STALE_SCAN_WINDOW))}
		) w WHERE COALESCE(w.category, '') <> 'user_ack' LIMIT ${sql.raw(String(STALE_EVENT_COUNT_CAP))}
	) AS stale`;
	const [row] = await runInOwnTurn(() => executeRows<{ n: number | string }>(getDb(), query));
	return Number(row?.n ?? 0);
}

// ── the view ─────────────────────────────────────────────────────────────────

/**
 * The session and its summary row in one read. `omitSummary` leaves out the summary body (the
 * 30 to 60 KB column) for a polled view, which never returns it; the provenance is still read,
 * because the shrunk-evidence rule needs its first event id.
 */
async function readSessionAndRow(sessionId: string, omitSummary = false) {
	const [row] = await getDb()
		.select({
			sessionId: sessions.sessionId,
			rowSessionId: aiSessionSummaries.sessionId,
			generatedAt: aiSessionSummaries.generatedAt,
			attemptStatus: aiSessionSummaries.attemptStatus,
			throughEventId: aiSessionSummaries.throughEventId,
			attemptStartedAt: aiSessionSummaries.attemptStartedAt,
			attemptErrorCode: aiSessionSummaries.attemptErrorCode,
			summary: omitSummary ? sql<null>`NULL` : aiSessionSummaries.summary,
			provenance: aiSessionSummaries.provenance,
		})
		.from(sessions)
		.leftJoin(aiSessionSummaries, eq(aiSessionSummaries.sessionId, sessions.sessionId))
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ?? null;
}

/** The attempt columns only (the POST never reads the summary or its provenance), or null for an unknown session. */
async function readAttemptRow(sessionId: string): Promise<AttemptColumns | null> {
	const [row] = await getDb()
		.select({
			attemptStatus: aiSessionSummaries.attemptStatus,
			attemptStartedAt: aiSessionSummaries.attemptStartedAt,
			attemptErrorCode: aiSessionSummaries.attemptErrorCode,
		})
		.from(sessions)
		.leftJoin(aiSessionSummaries, eq(aiSessionSummaries.sessionId, sessions.sessionId))
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ?? null;
}

type SessionAndRow = NonNullable<Awaited<ReturnType<typeof readSessionAndRow>>>;

function storedOf(row: SessionAndRow): StoredSessionSummary | null {
	return row.summary && row.provenance
		? { summary: row.summary, provenance: row.provenance }
		: null;
}

function attemptOf(
	row: AttemptColumns,
	judgement: AttemptJudgement,
): SessionSummaryView["attempt"] {
	const startedAt = isoOf(row.attemptStartedAt);
	if (judgement.kind === "lapsed") return { status: "failed", startedAt, errorCode: "interrupted" };
	const status =
		row.attemptStatus === "generating" || row.attemptStatus === "failed"
			? row.attemptStatus
			: "idle";
	const errorCode =
		status === "failed"
			? ((row.attemptErrorCode as SummaryErrorCode | null) ?? "internal_error")
			: null;
	return { status, startedAt, errorCode };
}

/**
 * The summary of a session as the Summary tab shows it, or null for an unknown
 * session. Rejects with `OwnTurnBusyError` when the scan queue is full. While a
 * generation is live nothing blocks (a joiner needs no budget) and only the capped stale
 * probe reads events, so a stale summary is not shown as current during its own update; the
 * shrunk-evidence and retention fields are then placeholders. `omitStored` is the polled
 * view (`?poll=1`): the same view without the stored summary, marked `storedOmitted`.
 */
export async function getSessionSummaryView(
	sessionId: string,
	options: { omitStored?: boolean } = {},
): Promise<SessionSummaryView | null> {
	const omitStored = options.omitStored === true;
	const row = await readSessionAndRow(sessionId, omitStored);
	if (!row) return null;
	const clock = clockAt();
	const judgement = judgeAttempt(row, clock);
	const stored = omitStored ? null : storedOf(row);
	const hasStored = omitStored ? row.provenance !== null : stored !== null;
	const base = {
		stored,
		...(omitStored ? { storedOmitted: true as const } : {}),
		generatedAt: hasStored ? isoOf(row.generatedAt) : null,
		throughEventId: hasStored ? row.throughEventId : null,
		attempt: attemptOf(row, judgement),
	};
	const midnight = nextLocalMidnightIso();
	const provider = await readDefaultProvider();
	const spentCents = await getTodaySpendCents();
	const maxCostCents = provider ? maxCallCostCents(provider) : 0;
	const spend = {
		spentCents,
		capCents: DEFAULT_DAILY_CAP_CENTS,
		maxCostCents,
		maxCostWithRetryCents: 2 * maxCostCents,
		resetsAt: midnight,
	};
	const shownProvider = provider ? { kind: provider.kind, model: provider.model } : null;
	const staleEvents =
		hasStored && row.throughEventId !== null
			? await countStaleEvents(sessionId, row.throughEventId)
			: 0;
	if (judgement.kind === "live") {
		return {
			...base,
			staleEvents,
			evidenceShrunk: false,
			blocked: null,
			cooldownSeconds: null,
			provider: shownProvider,
			spend,
		};
	}
	const { enough: enoughActivity, firstEventId: firstNow } = await probeActivity(sessionId);
	let evidenceShrunk = false;
	let retentionDays: number | undefined;
	if (hasStored) {
		const firstThen = (row.provenance as { firstEventId: number | null }).firstEventId;
		evidenceShrunk = firstNow === null || (firstThen !== null && firstNow > firstThen);
		const days = await readRetentionDays();
		if (days > 0) retentionDays = days;
	}

	let blocked: SummaryBlockReason | null = null;
	let cooldownSeconds: number | null = null;
	if (!enoughActivity) blocked = "too_little_activity";
	else if (!provider) blocked = "no_provider";
	else if (judgement.kind === "cooldown") {
		blocked = "summary_cooldown";
		cooldownSeconds = judgement.retryAfterSeconds;
	} else if (maxCostCents > 0 && spentCents + maxCostCents >= DEFAULT_DAILY_CAP_CENTS) {
		blocked = "spend_cap_reached";
	}

	return {
		...base,
		staleEvents,
		evidenceShrunk,
		blocked,
		cooldownSeconds,
		provider: shownProvider,
		spend,
		...(retentionDays === undefined ? {} : { retentionDays }),
	};
}

// ── who owns a running generation ────────────────────────────────────────────

/**
 * A generation running in this process. The entry exists from the moment a request
 * takes a slot (step 9) but gets its token and reservation only once the claim is won
 * (step 12): a shutdown release skips an entry with no token. `taken` is set once,
 * synchronously, by whichever of the finisher and the release acts first; the taker
 * owns both the row write and the settlement, and nobody else does either. A
 * `finishing` entry stays in the set, and so counts toward the cap, until its write
 * and settlement are done.
 */
type Phase = "reading" | "calling" | "finishing";

interface Entry {
	sessionId: string;
	subject: string;
	token: string | null;
	reservation: SpendReservation | null;
	phase: Phase;
	/** Actual cost of the calls that have returned. */
	settledCents: number;
	/** The call in flight, if any (both 0 otherwise): its input priced at the worst-case ratio, and its single-call maximum. */
	pendingInputCents: number;
	pendingMaxCents: number;
	taken: boolean;
	/** Settles when the request that created this entry has its answer (claim won or lost, or an exit). */
	requestSettled: Promise<void>;
	/** Set by `finish` when it takes the entry: settles when the row write and the settlement are done. */
	settling: Promise<void> | null;
	/** Fires at the lease expiry if the run is still hanging: see `expireEntry`. */
	watchdog: ReturnType<typeof setTimeout> | null;
}

const entries = new Set<Entry>();

/** Takes an entry out of the set for good, and stops its watchdog. */
function dropEntry(entry: Entry): void {
	if (entry.watchdog !== null) clearTimeout(entry.watchdog);
	entry.watchdog = null;
	entries.delete(entry);
}

/** Points where a test may observe or hold the flow; production never sets them. */
export type SummaryStep =
	| "row_read"
	| "slot"
	| "reserving"
	| "reserve"
	| "claim"
	| "audit"
	| "start"
	| "join_wait"
	| "finish_write";

export interface SummaryTestHooks {
	at?: (step: SummaryStep) => void | Promise<void>;
	/** The watchdog's delay in place of the lease (milliseconds). */
	watchdogMs?: number;
}

let hooks: SummaryTestHooks | null = null;

async function at(step: SummaryStep): Promise<void> {
	await hooks?.at?.(step);
}

export function _setSummaryHooksForTest(next: SummaryTestHooks | null): void {
	hooks = next;
}

/** Abandons every running generation as a dead process would: nothing is written or settled. */
export function _resetSummaryGenerationsForTest(): void {
	maxChargedFailures = [];
	for (const entry of [...entries]) {
		entry.taken = true;
		dropEntry(entry);
	}
}

export function _summaryGenerationCountForTest(): number {
	return entries.size;
}

// ── the claim ────────────────────────────────────────────────────────────────

/**
 * One conditional UPDATE, atomic on both dialects: the row must not be generating
 * within its lease, and must be outside its cooldown unless the last attempt was
 * interrupted. `db` is for tests that need a second connection. True when this
 * caller now owns the attempt.
 */
export async function claimSummaryAttempt(
	sessionId: string,
	token: string,
	now: Date = new Date(),
	db: Db = getDb(),
): Promise<boolean> {
	const clock = clockAt(now);
	const rows = await db
		.update(aiSessionSummaries)
		.set({
			attemptStatus: "generating",
			attemptStartedAt: toDbTimestamp(now),
			attemptToken: token,
			attemptErrorCode: null,
		})
		.where(
			and(
				eq(aiSessionSummaries.sessionId, sessionId),
				or(
					ne(aiSessionSummaries.attemptStatus, "generating"),
					lt(aiSessionSummaries.attemptStartedAt, clock.leaseCutoff),
				),
				or(
					isNull(aiSessionSummaries.attemptStartedAt),
					lt(aiSessionSummaries.attemptStartedAt, clock.cooldownCutoff),
					eq(aiSessionSummaries.attemptErrorCode, "interrupted"),
					eq(aiSessionSummaries.attemptStatus, "generating"),
				),
			),
		)
		.returning({ sessionId: aiSessionSummaries.sessionId });
	return rows.length > 0;
}

async function sessionExists(sessionId: string): Promise<boolean> {
	const [row] = await getDb()
		.select({ id: sessions.sessionId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row !== undefined;
}

/** Inserts the idle row if missing, then claims. A session deleted underneath is `not_found`. */
async function claimOrNotFound(
	sessionId: string,
	token: string,
	now: Date,
): Promise<"won" | "lost" | "not_found"> {
	try {
		await getDb().insert(aiSessionSummaries).values({ sessionId }).onConflictDoNothing();
	} catch (error) {
		if (!(await sessionExists(sessionId))) return "not_found";
		throw error;
	}
	return (await claimSummaryAttempt(sessionId, token, now)) ? "won" : "lost";
}

/** A row write of a generation: matches only while this run still holds the token and the row is generating. */
async function writeAttempt(
	sessionId: string,
	token: string,
	set: Partial<typeof aiSessionSummaries.$inferInsert>,
): Promise<void> {
	await getDb()
		.update(aiSessionSummaries)
		.set({ ...set, attemptToken: null })
		.where(
			and(
				eq(aiSessionSummaries.sessionId, sessionId),
				eq(aiSessionSummaries.attemptToken, token),
				eq(aiSessionSummaries.attemptStatus, "generating"),
			),
		);
}

const failedRow = (code: SummaryErrorCode) => ({
	attemptStatus: "failed" as const,
	attemptErrorCode: code,
});

// ── one generation ───────────────────────────────────────────────────────────

interface RunContext {
	entry: Entry;
	token: string;
	provider: DefaultProvider;
	key: string;
}

type Outcome =
	| { ok: true; stored: StoredSessionSummary; throughEventId: number | null }
	| { ok: false; code: SummaryErrorCode; chargeCents: number };

interface FailureDetail {
	code: SummaryErrorCode;
	subType: string | null;
	status: number | null;
	chargeCents: number;
	/** The failure cost the single-call maximum: it counts toward the breaker. */
	maxCharged: boolean;
}

const LLM_CODES: Record<LlmError["subType"], SummaryErrorCode> = {
	permanent_auth: "provider_auth",
	transient_rate_limit: "provider_rate_limit",
	transient_timeout: "provider_timeout",
	permanent_validation: "provider_error",
	unknown: "provider_error",
};

/**
 * How much of a call in flight a failure may have cost: nothing (the request cannot have left, or
 * the provider refused it with a 4xx), the priced input (an ordinary 5xx), or the single-call
 * maximum (the outcome is unknown).
 */
type ChargeClass = "none" | "input" | "max";

/** Codes of a failure before any byte was written: no connection, no DNS, no TLS session. */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
	"ConnectionRefused",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"FailedToOpenSocket",
]);

/** The cause's own code, never message text (a message can carry anything a provider or a proxy wrote). */
function connectPhaseFailure(error: LlmError): boolean {
	const code = (error.cause as { code?: unknown } | null | undefined)?.code;
	if (typeof code !== "string") return false;
	return (
		CONNECT_PHASE_CODES.has(code) ||
		code.startsWith("ERR_TLS_") ||
		code.startsWith("CERT_") ||
		code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
		code === "SELF_SIGNED_CERT_IN_CHAIN" ||
		code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
		code === "UNABLE_TO_GET_ISSUER_CERT" ||
		code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
	);
}

function chargeClassOf(error: LlmError): ChargeClass {
	const status = error.status ?? null;
	if (status === null) return connectPhaseFailure(error) ? "none" : "max";
	if (status >= 400 && status <= 499) return status === 499 ? "max" : "none";
	if (status >= 500 && status <= 599) return status === 504 || status === 524 ? "max" : "input";
	return "max";
}

/**
 * What an exception ended the run as, and what it cost (R-I b, Q-1). Only the code, the sub-type
 * and the HTTP status are taken from it: its message and cause text can carry a provider's body or
 * a key. The calls that returned are charged as they were. The call in flight when it threw is
 * charged by `chargeClassOf`; anything that is not an `LlmError` after a call was sent (the provider
 * answered, then something broke) is an unknown outcome and costs the maximum.
 */
function describeFailure(error: unknown, entry: Entry): FailureDetail {
	const completed = entry.settledCents;
	if (error instanceof LlmError) {
		const charge = chargeClassOf(error);
		const inFlight =
			charge === "none" ? 0 : charge === "input" ? entry.pendingInputCents : entry.pendingMaxCents;
		return {
			code: LLM_CODES[error.subType] ?? "provider_error",
			subType: error.subType,
			status: error.status ?? null,
			chargeCents: completed + inFlight,
			maxCharged: charge === "max" && entry.pendingMaxCents > 0,
		};
	}
	if (error instanceof OwnTurnBusyError) {
		return { code: "busy", subType: null, status: null, chargeCents: completed, maxCharged: false };
	}
	return {
		code: "internal_error",
		subType: null,
		status: null,
		chargeCents: completed + entry.pendingMaxCents,
		maxCharged: entry.pendingMaxCents > 0,
	};
}

// ── the breaker ──────────────────────────────────────────────────────────────

/**
 * A provider that times out, or that a gateway cuts off, costs the single-call maximum on every
 * attempt. After `BREAKER_FAILURES` such failures within `BREAKER_WINDOW_MS`, with no call
 * succeeding since, new requests are refused `busy` (nothing reserved, claimed or charged) until a
 * call succeeds or `BREAKER_OPEN_MS` have passed since the last one. Process-wide and in memory,
 * like the other limiters here: with N replicas it is N times looser.
 */
let maxChargedFailures: number[] = [];

function recordMaxChargedFailure(): void {
	maxChargedFailures.push(Date.now());
	if (maxChargedFailures.length > BREAKER_FAILURES) maxChargedFailures.shift();
}

function recordCallSuccess(): void {
	maxChargedFailures = [];
}

/** Whole seconds a request must wait while the breaker is open; 0 when it is closed. */
function breakerRetryAfterSeconds(): number {
	const now = Date.now();
	maxChargedFailures = maxChargedFailures.filter((t) => now - t < BREAKER_WINDOW_MS);
	if (maxChargedFailures.length < BREAKER_FAILURES) return 0;
	const last = maxChargedFailures[maxChargedFailures.length - 1] as number;
	const left = BREAKER_OPEN_MS - (now - last);
	return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
}

const failure = (entry: Entry, code: SummaryErrorCode): Outcome => ({
	ok: false,
	code,
	chargeCents: entry.settledCents,
});

async function gatesStillOpen(): Promise<boolean> {
	return (await isAiActive()) && (await isLabsFlagEnabled("sessionSummary"));
}

/** The tokens, cost and call count of the calls that returned. */
interface Totals {
	inputTokens: number;
	outputTokens: number;
	estimated: boolean;
	calls: number;
}

/** What `callModel` gives back: the answer, or the outcome that ended the run before the call was sent. */
type CallResult = { response: LlmResponse } | { outcome: Outcome };

/**
 * One model call. The text actually sent is priced at the worst-case token ratio and the
 * reservation is topped up to hold the calls that returned plus this call's maximum; a refused
 * top-up ends the run before anything is sent (R-I a). The ownership check and the move into the
 * `calling` phase follow the last await before the send, so a release that lands during the
 * top-up is honoured and a call is never sent that nobody will settle.
 */
async function callModel(
	ctx: RunContext,
	totals: Totals,
	built: ReturnType<typeof buildSummaryPrompt>,
	repair?: RepairKind,
): Promise<CallResult> {
	const { entry, provider } = ctx;
	const request = buildSummaryLlmRequest(built, provider.model, repair);
	const sentText = request.systemPrompt + request.transcriptPrompt;
	const worstInputTokens = worstCaseInputTokens(sentText);
	const pricedInputCents = priceCompletion(provider.kind, provider.model, {
		inputTokens: worstInputTokens,
		outputTokens: 0,
		estimated: true,
	});
	const maxCents = priceCompletion(provider.kind, provider.model, {
		inputTokens: worstInputTokens,
		outputTokens: MAX_OUTPUT_TOKENS,
		estimated: true,
	});
	const reservation = entry.reservation as SpendReservation;
	const needed = entry.settledCents + maxCents;
	if (
		reservation.cents < needed &&
		!(await topUpReservation(reservation, needed - reservation.cents))
	) {
		return { outcome: entry.taken ? RELEASED : failure(entry, "spend_cap") };
	}
	if (entry.taken) return { outcome: RELEASED };
	// The adapter is built before anything is marked pending: a throw from here sent nothing and
	// charges nothing.
	const adapter = getAdapter({
		kind: provider.kind,
		apiKey: ctx.key,
		baseUrl: provider.baseUrl ?? undefined,
	});
	entry.pendingInputCents = pricedInputCents;
	entry.pendingMaxCents = maxCents;
	entry.phase = "calling";
	const response = await adapter.complete(request);
	recordCallSuccess();
	// An adapter that reports no usage estimates the input from the transcript alone: price the whole
	// prompt at the worst-case ratio.
	const inputTokens = response.usage.estimated
		? worstCaseInputTokens(sentText)
		: response.usage.inputTokens;
	entry.settledCents += priceCompletion(provider.kind, provider.model, {
		...response.usage,
		inputTokens,
	});
	entry.pendingInputCents = 0;
	entry.pendingMaxCents = 0;
	totals.inputTokens += inputTokens;
	totals.outputTokens += response.usage.outputTokens;
	totals.estimated ||= response.usage.estimated;
	totals.calls += 1;
	return { response };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The URLs the user typed, collected in slices of about `URL_SCAN_SLICE_CHARS` characters with the
 * event loop let go between them: one pass over up to half a megabyte of prompt text held it for
 * 200 ms under load, long enough to delay a hook ingest.
 */
async function collectUrlsInSlices(texts: string[]): Promise<Set<string>> {
	const urls = new Set<string>();
	let slice: string[] = [];
	let chars = 0;
	for (const text of texts) {
		slice.push(text);
		chars += text.length;
		if (chars < URL_SCAN_SLICE_CHARS) continue;
		for (const url of collectUserPromptUrls(slice)) urls.add(url);
		slice = [];
		chars = 0;
		await nextTurn();
	}
	for (const url of collectUserPromptUrls(slice)) urls.add(url);
	return urls;
}

/** The session row, by named columns (no ownership ids), or null when it is gone. */
async function readSessionRow(sessionId: string) {
	const [row] = await getDb()
		.select(SESSION_COLUMNS_SANS_OWNERSHIP)
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ?? null;
}

const RELEASED: Outcome = { ok: false, code: "interrupted", chargeCents: 0 };

async function generate(ctx: RunContext): Promise<Outcome> {
	const { entry, provider } = ctx;
	const bundle = await loadEvidence(entry.sessionId);
	if (bundle.throughEventId === null) return failure(entry, "internal_error");
	const userPromptUrls = await collectUrlsInSlices(userPromptTexts(bundle));
	const ledger: Ledger = await buildLedgerAsync({
		rows: bundle.rows,
		firstPromptRows: bundle.firstPromptRows,
		scan: bundle.scan,
		agentType: bundle.agentType,
	});
	const sessionRow = await readSessionRow(entry.sessionId);
	if (!sessionRow) return failure(entry, "internal_error");
	const built = buildSummaryPrompt(sessionForPrompt(sessionRow), ledger);
	const totals: Totals = { inputTokens: 0, outputTokens: 0, estimated: false, calls: 0 };

	const conclude = async (
		draft: Parameters<typeof verifySummary>[0]["draft"],
	): Promise<Outcome> => {
		const after = await readSessionRow(entry.sessionId);
		if (!after) return failure(entry, "internal_error");
		const verified = verifySummary({
			draft,
			ledger,
			session: sessionStateForVerify(after),
			userPromptUrls,
			nonce: built.nonce,
		});
		const stored = buildStoredSummary({
			verified,
			promptVersion: PROMPT_VERSION,
			provider: { kind: provider.kind, model: provider.model },
			usage: {
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				estimated: totals.estimated,
			},
			costCents: entry.settledCents,
			calls: totals.calls,
			redactionHits: built.redactionHits,
			coverage: { ...ledger.coverage, overBudget: ledger.overBudget },
			firstEventId: bundle.firstEventId,
			throughAt: newestEventAt(bundle.rows),
		});
		return { ok: true, stored, throughEventId: bundle.throughEventId };
	};

	if (entry.taken) return RELEASED;
	const firstCall = await callModel(ctx, totals, built);
	if ("outcome" in firstCall) return firstCall.outcome;
	const first = firstCall.response;
	const firstStop = classifyStopReason(first.stopReason);
	if (firstStop === "refusal") return failure(entry, "provider_refused");
	let repair: RepairKind;
	if (firstStop === "length") repair = { kind: "truncated" };
	else {
		const parsed = parseAnswer(first.text, built.nonce);
		if (parsed.ok) return conclude(parsed.draft);
		repair = { kind: "parse", path: parsed.path };
	}

	// One repair call, on the same reservation, if the run still owns the generation and the gates are open.
	if (entry.taken) return RELEASED;
	if (!(await gatesStillOpen())) return failure(entry, "ai_inactive");
	const secondCall = await callModel(ctx, totals, built, repair);
	if ("outcome" in secondCall) return secondCall.outcome;
	const second = secondCall.response;
	const secondStop = classifyStopReason(second.stopReason);
	if (secondStop === "refusal") return failure(entry, "provider_refused");
	if (secondStop === "length") return failure(entry, "output_truncated");
	const reparsed = parseAnswer(second.text, built.nonce);
	return reparsed.ok ? conclude(reparsed.draft) : failure(entry, "parse_failed");
}

/**
 * Ends a run: takes the entry (synchronously, once), writes the row under the token
 * guard, settles the reservation, and only then lets the slot go. A run whose entry
 * was already taken (the shutdown release, or a dead process) writes and settles nothing.
 */
async function finish(
	ctx: RunContext,
	outcome: Outcome,
	detail: FailureDetail | null,
): Promise<void> {
	const { entry, token } = ctx;
	if (entry.taken) return;
	entry.taken = true;
	entry.phase = "finishing";
	const settling = settleRun(entry, token, outcome, detail);
	entry.settling = settling;
	await settling;
}

/** The finisher's work after it owns the entry: the row write, the settlement, then the slot goes. */
async function settleRun(
	entry: Entry,
	token: string,
	outcome: Outcome,
	detail: FailureDetail | null,
): Promise<void> {
	try {
		try {
			await at("finish_write");
			if (outcome.ok) {
				await writeAttempt(entry.sessionId, token, {
					summary: outcome.stored.summary,
					provenance: outcome.stored.provenance,
					schemaVersion: SUMMARY_SCHEMA_VERSION,
					generatedAt: toDbTimestamp(new Date()),
					throughEventId: outcome.throughEventId,
					attemptStatus: "idle",
					attemptErrorCode: null,
				});
			} else {
				console.warn(
					"[session-summary] attempt failed",
					JSON.stringify({
						code: outcome.code,
						subType: detail?.subType ?? null,
						status: detail?.status ?? null,
					}),
				);
				await writeAttempt(entry.sessionId, token, failedRow(outcome.code));
			}
		} catch (error) {
			console.error(
				"[session-summary] row write failed",
				JSON.stringify({ code: errorName(error) }),
			);
		}
		await withOneRetry("settlement", () =>
			settleReservedSpend(entry.reservation as SpendReservation, {
				sessionId: entry.sessionId,
				actualCents: outcome.ok ? entry.settledCents : outcome.chargeCents,
			}),
		);
	} finally {
		dropEntry(entry);
	}
}

/** An error's class name only: never its message, which can carry a body or a key. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * Runs money work that must not be lost to one transient database error: a second attempt
 * after the first fails, each failure logged by class name. A reservation that is neither
 * settled nor released would stay counted on the day until its midnight.
 */
async function withOneRetry(label: string, work: () => Promise<void>): Promise<void> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			await work();
			return;
		} catch (error) {
			console.error(
				`[session-summary] ${label} failed`,
				JSON.stringify({ code: errorName(error) }),
			);
		}
	}
}

async function runGeneration(ctx: RunContext): Promise<void> {
	let outcome: Outcome;
	let detail: FailureDetail | null = null;
	try {
		outcome = await generate(ctx);
	} catch (error) {
		detail = describeFailure(error, ctx.entry);
		if (detail.maxCharged && !ctx.entry.taken) recordMaxChargedFailure();
		if (error instanceof EvidenceReadError) {
			console.error("[session-summary] evidence read failed", JSON.stringify({ code: error.code }));
		}
		outcome = { ok: false, code: detail.code, chargeCents: detail.chargeCents };
	}
	try {
		await finish(ctx, outcome, detail);
	} finally {
		if (!ctx.entry.taken) dropEntry(ctx.entry);
	}
}

// ── the request ──────────────────────────────────────────────────────────────

const refuse = (refusal: SessionSummaryRefusalBody): SummaryRequestResult => ({
	kind: "refused",
	refusal,
});

function joinedOf(row: AttemptColumns): SummaryRequestResult {
	return {
		kind: "joined",
		body: {
			attempt: {
				status: "generating",
				startedAt: isoOf(row.attemptStartedAt) ?? new Date().toISOString(),
				joined: true,
			},
		},
	};
}

function startedResult(now: Date, done: Promise<void>): SummaryRequestResult {
	return {
		kind: "started",
		body: {
			attempt: {
				status: "generating",
				startedAt: new Date(clockAt(now).nowMs).toISOString(),
				joined: false,
			},
		},
		done,
	};
}

/** The default provider's key, or null when it cannot be read (the row is gone or the ciphertext does not decrypt). */
async function readProviderKey(providerId: string): Promise<string | null> {
	try {
		return await getProviderApiKey(providerId);
	} catch {
		return null;
	}
}

/** Takes a slot, synchronously, or says why not. Counts every entry, including one that is writing its result. */
function takeSlot(entry: Entry, caller: SummaryRequestCaller): SessionSummaryRefusalBody | null {
	if (caller.teamMode) {
		for (const held of entries) {
			if (held.subject === caller.subject) return { error: "caller_generation_running" };
		}
	}
	if (entries.size >= MAX_CONCURRENT_GENERATIONS) {
		return { error: "busy", retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
	}
	entries.add(entry);
	return null;
}

/**
 * After a refusal that came from a stale read (no slot, or a lost claim): a generation may have
 * started meanwhile, and a joiner needs neither a slot nor a budget, so answer the join.
 */
async function joinOrRefuse(
	sessionId: string,
	fallback: SessionSummaryRefusalBody,
	own: Entry,
): Promise<SummaryRequestResult> {
	// A request for this very session that holds a slot is about to win the claim or lose it:
	// wait for its answer, so a caller that raced it joins instead of being told "busy". The
	// caller's own entry is not waited on (its request settles only when this call returns, so
	// waiting on it would never end), and the wait is bounded: a holder stuck before its claim
	// must not hold this caller too.
	const racing = [...entries].filter((held) => held !== own && held.sessionId === sessionId);
	if (racing.length > 0) {
		await at("join_wait");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const bound = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, JOIN_WAIT_BUDGET_MS);
		});
		try {
			await Promise.race([Promise.all(racing.map((held) => held.requestSettled)), bound]);
		} finally {
			clearTimeout(timer);
		}
	}
	const row = await readAttemptRow(sessionId);
	if (!row) return refuse({ error: "session_not_found" });
	const judgement = judgeAttempt(row, clockAt());
	if (judgement.kind === "live") return joinedOf(row);
	if (judgement.kind === "cooldown" && fallback.error === "summary_cooldown") {
		return refuse({ error: "summary_cooldown", retryAfterSeconds: judgement.retryAfterSeconds });
	}
	return refuse(fallback);
}

/**
 * Asks for a summary. Returns `started` with the detached run's `done`, `joined` when a
 * generation is already live, or a refusal. Nothing before the reservation writes anything.
 * Rejects only for an unexpected failure, after every reservation, slot and claim it took
 * has been given back.
 */
export async function requestSummaryGeneration(
	sessionId: string,
	caller: SummaryRequestCaller,
): Promise<SummaryRequestResult> {
	const row = await readAttemptRow(sessionId);
	if (!row) return refuse({ error: "session_not_found" });
	await at("row_read");
	if (isShuttingDown()) {
		return refuse({ error: "shutting_down", retryAfterSeconds: SHUTTING_DOWN_RETRY_AFTER_SECONDS });
	}
	const judgement = judgeAttempt(row, clockAt());
	if (judgement.kind === "live") return joinedOf(row);
	if (judgement.kind === "cooldown") {
		return refuse({ error: "summary_cooldown", retryAfterSeconds: judgement.retryAfterSeconds });
	}

	let enough: boolean;
	try {
		enough = (await probeActivity(sessionId)).enough;
	} catch (error) {
		if (error instanceof OwnTurnBusyError) {
			return refuse({ error: "busy", retryAfterSeconds: SCAN_BUSY_RETRY_AFTER_SECONDS });
		}
		throw error;
	}
	if (!enough) return refuse({ error: "too_little_activity" });
	const provider = await readDefaultProvider();
	if (!provider) return refuse({ error: "no_provider" });
	const breakerWait = breakerRetryAfterSeconds();
	if (breakerWait > 0) return refuse({ error: "busy", retryAfterSeconds: breakerWait });

	let settleRequest!: () => void;
	const entry: Entry = {
		sessionId,
		subject: caller.subject,
		token: null,
		reservation: null,
		phase: "reading",
		settledCents: 0,
		pendingInputCents: 0,
		pendingMaxCents: 0,
		taken: false,
		requestSettled: new Promise<void>((resolve) => {
			settleRequest = resolve;
		}),
		settling: null,
		watchdog: null,
	};
	const slotRefusal = takeSlot(entry, caller);
	if (slotRefusal) return joinOrRefuse(sessionId, slotRefusal, entry);
	armWatchdog(entry);

	let reservation: SpendReservation | null = null;
	let claimedToken: string | null = null;
	let handedOver = false;
	let exitCode: SummaryErrorCode = "internal_error";
	let startsNoCooldown = false;
	try {
		await at("slot");
		const maxCostCents = maxCallCostCents(provider);
		await at("reserving");
		reservation = await reserveSpendCents(maxCostCents);
		if (!reservation) {
			return refuse({
				error: "spend_cap_reached",
				spentCents: await getTodaySpendCents(),
				capCents: DEFAULT_DAILY_CAP_CENTS,
				maxCostCents,
			});
		}
		entry.reservation = reservation;
		await at("reserve");
		const now = new Date();
		const token = randomUUID();
		const claim = await claimOrNotFound(sessionId, token, now);
		if (claim === "not_found") return refuse({ error: "session_not_found" });
		if (claim === "lost") {
			return joinOrRefuse(
				sessionId,
				{ error: "busy", retryAfterSeconds: SCAN_BUSY_RETRY_AFTER_SECONDS },
				entry,
			);
		}
		claimedToken = token;
		await at("claim");
		// The key is decrypted (a blocking scrypt) only now that this request owns the attempt: a
		// refusal or a lost claim never pays for it. An unreadable key is a failed attempt that
		// starts no cooldown, so someone fixing their key is not locked out.
		const key = await readProviderKey(provider.id);
		await at("audit");
		await at("start");
		// The last check before the hand-over; the audit line follows it, so a request refused here
		// logs nothing (one line per accepted request). An entry the watchdog took while this request
		// was stuck is no longer ours to run.
		if (isShuttingDown() || entry.taken) {
			exitCode = "interrupted";
			return refuse({
				error: "shutting_down",
				retryAfterSeconds: SHUTTING_DOWN_RETRY_AFTER_SECONDS,
			});
		}
		logAdminAction("session_summary_requested", caller.actor, {
			sessionId,
			providerKind: provider.kind,
			model: provider.model,
		});

		if (key === null) {
			exitCode = "provider_key_unreadable";
			startsNoCooldown = true;
			return startedResult(now, Promise.resolve());
		}

		// Hand over: from here the entry owns the token and the reservation, and the run owns the rest.
		entry.token = token;
		entry.reservation = reservation;
		handedOver = true;
		const ctx: RunContext = { entry, token, provider, key };
		const done = runGeneration(ctx).catch((error: unknown) => {
			console.error("[session-summary] run failed", JSON.stringify({ code: errorName(error) }));
		});
		return startedResult(now, done);
	} finally {
		try {
			if (!handedOver) {
				dropEntry(entry);
				if (claimedToken) {
					await writeAttempt(sessionId, claimedToken, {
						...failedRow(exitCode),
						...(startsNoCooldown ? { attemptStartedAt: null } : {}),
					}).catch(() => {});
				}
				if (reservation) {
					const held = reservation;
					await withOneRetry("reservation release", () => releaseReservedSpend(held));
				}
			}
		} finally {
			settleRequest();
		}
	}
}

/**
 * The watchdog: a run still holding its slot at the lease expiry is hanging (an evidence read or a
 * database call that never returns), and without this the slot would stay taken until restart, so
 * two such hangs would switch the feature off. The entry is taken and settled as a shutdown release
 * does (a call in flight is an unknown outcome, charged its maximum), which frees the slot; if the
 * run ever wakes, it finds the entry taken and writes and settles nothing.
 */
function armWatchdog(entry: Entry): void {
	const delayMs = hooks?.watchdogMs ?? SUMMARY_LEASE_SECONDS * 1000;
	const timer = setTimeout(() => {
		void expireEntry(entry).catch((error: unknown) => {
			console.error(
				"[session-summary] watchdog failed",
				JSON.stringify({ code: errorName(error) }),
			);
		});
	}, delayMs);
	timer.unref?.();
	entry.watchdog = timer;
}

async function expireEntry(entry: Entry): Promise<void> {
	entry.watchdog = null;
	if (entry.taken) return;
	entry.taken = true;
	console.error("[session-summary] run outlived its lease", JSON.stringify({ phase: entry.phase }));
	if (entry.token === null) {
		// Stuck before the hand-over: free the slot and give back the reservation now; if the
		// request wakes it sees the entry taken, ends interrupted and releases nothing twice.
		const held = entry.reservation;
		dropEntry(entry);
		if (held) await withOneRetry("reservation release", () => releaseReservedSpend(held));
		return;
	}
	await releaseEntry(entry);
}

/**
 * Boot, single-replica (SQLite) only: a row left `generating` by a process that was killed is
 * marked `failed / interrupted` with its token cleared, so the page does not say "generating" for
 * the rest of the lease. On Postgres another replica may own the row, so nothing is touched.
 * Returns how many rows it recovered.
 */
export async function recoverInterruptedSummaries(): Promise<number> {
	if (config.dialect === "postgres") return 0;
	const rows = await getDb()
		.update(aiSessionSummaries)
		.set({ attemptStatus: "failed", attemptErrorCode: "interrupted", attemptToken: null })
		.where(eq(aiSessionSummaries.attemptStatus, "generating"))
		.returning({ id: aiSessionSummaries.sessionId });
	return rows.length;
}

/** Gives one taken entry back at shutdown: the row says interrupted, the reservation is settled per D-25. */
async function releaseEntry(entry: Entry): Promise<void> {
	try {
		await writeAttempt(entry.sessionId, entry.token as string, failedRow("interrupted"));
	} catch (error) {
		console.error(
			"[session-summary] release write failed",
			JSON.stringify({ code: errorName(error) }),
		);
	}
	try {
		const reservation = entry.reservation as SpendReservation;
		if (entry.phase === "reading") {
			await withOneRetry("reservation release", () => releaseReservedSpend(reservation));
		} else {
			// A call that returned is charged as it was; one in flight has an unknown outcome (R-I b):
			// its single-call maximum (0 when no call is in flight).
			await withOneRetry("release settlement", () =>
				settleReservedSpend(reservation, {
					sessionId: entry.sessionId,
					actualCents: entry.settledCents + entry.pendingMaxCents,
				}),
			);
		}
	} finally {
		dropEntry(entry);
	}
}

/**
 * Shutdown: every running generation that is not already writing its result is taken,
 * its row marked failed / interrupted (token cleared) and its reservation settled. A
 * released run that later completes writes and settles nothing. An entry with no token
 * yet (between the claim and the hand-over) is skipped: nothing was sent, and its own
 * request returns any reservation. An entry already writing its result is waited for. Idempotent,
 * and returns within the budget even when a write hangs.
 */
export async function releaseOwnSummaryClaims(): Promise<void> {
	const work: Promise<void>[] = [];
	for (const entry of entries) {
		if (entry.taken) {
			// A finisher that is writing its result owns the entry; wait for it, within the budget,
			// so a kill during the write does not lose a billed answer.
			if (entry.phase === "finishing" && entry.settling) work.push(entry.settling);
			continue;
		}
		if (entry.token === null) continue;
		entry.taken = true;
		work.push(releaseEntry(entry));
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, SHUTDOWN_RELEASE_BUDGET_MS);
	});
	try {
		await Promise.race([Promise.allSettled(work), budget]);
	} finally {
		clearTimeout(timer);
	}
}
