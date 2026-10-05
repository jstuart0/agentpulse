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
	BUSY_RETRY_AFTER_SECONDS,
	MAX_CONCURRENT_GENERATIONS,
	MAX_INPUT_TOKENS,
	MAX_OUTPUT_TOKENS,
	SCAN_BUSY_RETRY_AFTER_SECONDS,
	SHUTDOWN_RELEASE_BUDGET_MS,
	SHUTTING_DOWN_RETRY_AFTER_SECONDS,
	SUMMARY_COOLDOWN_SECONDS,
	SUMMARY_LEASE_SECONDS,
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

/** A prompt anywhere, or an action (not read-class) among the newest events. */
async function hasEnoughActivity(sessionId: string): Promise<boolean> {
	const query = sql`SELECT CASE WHEN
		EXISTS (SELECT 1 FROM events p WHERE p.session_id = ${sessionId} AND ${effectiveCategory("p")} = 'prompt')
		OR EXISTS (
			SELECT 1 FROM (
				SELECT id, category, event_type, tool_name FROM events
				WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${sql.raw(String(ACTIVITY_ACTION_WINDOW))}
			) a WHERE ${classExpression("a")} = 'action')
		THEN 1 ELSE 0 END AS enough`;
	const [row] = await runInOwnTurn(() => executeRows<{ enough: number | string }>(getDb(), query));
	return Number(row?.enough ?? 0) === 1;
}

/** Material events after `throughEventId` (everything but `user_ack`, NULL categories included), counted up to the cap. */
async function countStaleEvents(sessionId: string, throughEventId: number): Promise<number> {
	const query = sql`SELECT count(*) AS n FROM (
		SELECT 1 FROM events WHERE session_id = ${sessionId} AND id > ${throughEventId}
		AND COALESCE(category, '') <> 'user_ack' LIMIT ${sql.raw(String(STALE_EVENT_COUNT_CAP))}
	) AS stale`;
	const [row] = await runInOwnTurn(() => executeRows<{ n: number | string }>(getDb(), query));
	return Number(row?.n ?? 0);
}

/** The session's oldest event id now; null when it has none. */
async function readFirstEventId(sessionId: string): Promise<number | null> {
	const query = sql`SELECT min(id) AS min_id FROM events WHERE session_id = ${sessionId}`;
	const [row] = await executeRows<{ min_id: number | string | null }>(getDb(), query);
	return row?.min_id === null || row?.min_id === undefined ? null : Number(row.min_id);
}

// ── the view ─────────────────────────────────────────────────────────────────

async function readSessionAndRow(sessionId: string) {
	const [row] = await getDb()
		.select({
			sessionId: sessions.sessionId,
			rowSessionId: aiSessionSummaries.sessionId,
			generatedAt: aiSessionSummaries.generatedAt,
			attemptStatus: aiSessionSummaries.attemptStatus,
			throughEventId: aiSessionSummaries.throughEventId,
			attemptStartedAt: aiSessionSummaries.attemptStartedAt,
			attemptErrorCode: aiSessionSummaries.attemptErrorCode,
			summary: aiSessionSummaries.summary,
			provenance: aiSessionSummaries.provenance,
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

function attemptOf(row: SessionAndRow, judgement: AttemptJudgement): SessionSummaryView["attempt"] {
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
 * generation is live only the row is read: the provider, spend and staleness
 * fields are then placeholders (see the phase 5 report).
 */
export async function getSessionSummaryView(sessionId: string): Promise<SessionSummaryView | null> {
	const row = await readSessionAndRow(sessionId);
	if (!row) return null;
	const clock = clockAt();
	const judgement = judgeAttempt(row, clock);
	const stored = storedOf(row);
	const base = {
		stored,
		generatedAt: stored ? isoOf(row.generatedAt) : null,
		throughEventId: stored ? row.throughEventId : null,
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
	if (judgement.kind === "live") {
		// A joiner needs no budget: nothing blocks, and staleness is not read while a generation runs.
		return {
			...base,
			staleEvents: 0,
			evidenceShrunk: false,
			blocked: null,
			cooldownSeconds: null,
			provider: shownProvider,
			spend,
		};
	}
	let staleEvents = 0;
	let evidenceShrunk = false;
	let enoughActivity = true;
	let retentionDays: number | undefined;
	if (stored) {
		if (row.throughEventId !== null)
			staleEvents = await countStaleEvents(sessionId, row.throughEventId);
		const firstNow = await readFirstEventId(sessionId);
		const firstThen = stored.provenance.firstEventId;
		evidenceShrunk = firstNow === null || (firstThen !== null && firstNow > firstThen);
		enoughActivity = firstNow !== null;
		const days = await readRetentionDays();
		if (days > 0) retentionDays = days;
	} else {
		enoughActivity = await hasEnoughActivity(sessionId);
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
}

const entries = new Set<Entry>();

/** Points where a test may observe or hold the flow; production never sets them. */
export type SummaryStep =
	| "row_read"
	| "slot"
	| "reserving"
	| "reserve"
	| "claim"
	| "audit"
	| "start"
	| "finish_write";

export interface SummaryTestHooks {
	at?: (step: SummaryStep) => void | Promise<void>;
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
	for (const entry of entries) entry.taken = true;
	entries.clear();
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
}

const LLM_CODES: Record<LlmError["subType"], SummaryErrorCode> = {
	permanent_auth: "provider_auth",
	transient_rate_limit: "provider_rate_limit",
	transient_timeout: "provider_timeout",
	permanent_validation: "provider_error",
	unknown: "provider_error",
};

/** Statuses a provider answers before it bills: the call is charged nothing. */
const PRE_BILLING_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 408, 422, 429]);

/**
 * What an exception ended the run as, and what it cost (R-I b). Only the code, the sub-type and the
 * HTTP status are taken from it: its message and cause can carry a provider's body or a key. The
 * calls that returned are charged as they were. The call in flight when it threw is charged by
 * what is known of it: nothing for an explicit pre-billing rejection, the priced input for an
 * explicit 5xx, and the single-call maximum for everything else (a client-side timeout, a network
 * failure, an unexpected status, an error after the provider answered), since its outcome is unknown.
 */
function describeFailure(error: unknown, entry: Entry): FailureDetail {
	const completed = entry.settledCents;
	if (error instanceof LlmError) {
		const status = error.status ?? null;
		let inFlight = entry.pendingMaxCents;
		if (status !== null && PRE_BILLING_STATUSES.has(status)) inFlight = 0;
		else if (status !== null && status >= 500 && status <= 599) inFlight = entry.pendingInputCents;
		return {
			code: LLM_CODES[error.subType] ?? "provider_error",
			subType: error.subType,
			status,
			chargeCents: completed + inFlight,
		};
	}
	if (error instanceof OwnTurnBusyError) {
		return { code: "busy", subType: null, status: null, chargeCents: completed };
	}
	return {
		code: "internal_error",
		subType: null,
		status: null,
		chargeCents: completed + entry.pendingMaxCents,
	};
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
	entry.pendingInputCents = pricedInputCents;
	entry.pendingMaxCents = maxCents;
	entry.phase = "calling";
	const adapter = getAdapter({
		kind: provider.kind,
		apiKey: ctx.key,
		baseUrl: provider.baseUrl ?? undefined,
	});
	const response = await adapter.complete(request);
	// Some adapters estimate a missing input count from the transcript alone: price the whole prompt.
	const inputTokens = response.usage.estimated
		? estimateTokens(sentText)
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
	const userPromptUrls = collectUserPromptUrls(userPromptTexts(bundle));
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
		console.error("[session-summary] row write failed", JSON.stringify({ code: errorName(error) }));
	}
	try {
		await withOneRetry("settlement", () =>
			settleReservedSpend(entry.reservation as SpendReservation, {
				sessionId: entry.sessionId,
				actualCents: outcome.ok ? entry.settledCents : outcome.chargeCents,
			}),
		);
	} finally {
		entries.delete(entry);
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
		if (error instanceof EvidenceReadError) {
			console.error("[session-summary] evidence read failed", JSON.stringify({ code: error.code }));
		}
		outcome = { ok: false, code: detail.code, chargeCents: detail.chargeCents };
	}
	try {
		await finish(ctx, outcome, detail);
	} finally {
		if (!ctx.entry.taken) entries.delete(ctx.entry);
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
): Promise<SummaryRequestResult> {
	// A request for this very session that holds a slot is about to win the claim or lose it:
	// wait for its answer, so a caller that raced it joins instead of being told "busy".
	const racing = [...entries].filter((held) => held.sessionId === sessionId);
	await Promise.all(racing.map((held) => held.requestSettled));
	const row = await readSessionAndRow(sessionId);
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
	const row = await readSessionAndRow(sessionId);
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
		enough = await hasEnoughActivity(sessionId);
	} catch (error) {
		if (error instanceof OwnTurnBusyError) {
			return refuse({ error: "busy", retryAfterSeconds: SCAN_BUSY_RETRY_AFTER_SECONDS });
		}
		throw error;
	}
	if (!enough) return refuse({ error: "too_little_activity" });
	const provider = await readDefaultProvider();
	if (!provider) return refuse({ error: "no_provider" });

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
	};
	const slotRefusal = takeSlot(entry, caller);
	if (slotRefusal) return joinOrRefuse(sessionId, slotRefusal);

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
		await at("reserve");
		const now = new Date();
		const token = randomUUID();
		const claim = await claimOrNotFound(sessionId, token, now);
		if (claim === "not_found") return refuse({ error: "session_not_found" });
		if (claim === "lost") {
			return joinOrRefuse(sessionId, {
				error: "busy",
				retryAfterSeconds: SCAN_BUSY_RETRY_AFTER_SECONDS,
			});
		}
		claimedToken = token;
		await at("claim");
		// The key is decrypted (a blocking scrypt) only now that this request owns the attempt: a
		// refusal or a lost claim never pays for it. An unreadable key is a failed attempt that
		// starts no cooldown, so someone fixing their key is not locked out.
		const key = await readProviderKey(provider.id);
		await at("audit");
		logAdminAction("session_summary_requested", caller.actor, {
			sessionId,
			providerKind: provider.kind,
			model: provider.model,
		});
		await at("start");
		if (isShuttingDown()) {
			exitCode = "interrupted";
			return refuse({
				error: "shutting_down",
				retryAfterSeconds: SHUTTING_DOWN_RETRY_AFTER_SECONDS,
			});
		}

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
				entries.delete(entry);
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
		entries.delete(entry);
	}
}

/**
 * Shutdown: every running generation that is not already writing its result is taken,
 * its row marked failed / interrupted (token cleared) and its reservation settled. A
 * released run that later completes writes and settles nothing. An entry with no token
 * yet (between the claim and the hand-over) is skipped: nothing was sent, and its own
 * request returns any reservation. Idempotent, and returns within the budget even when
 * a write hangs.
 */
export async function releaseOwnSummaryClaims(): Promise<void> {
	const work: Promise<void>[] = [];
	for (const entry of entries) {
		if (entry.taken || entry.token === null || entry.phase === "finishing") continue;
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
