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
	/** The priced input of the call in flight (a call that may have been billed). */
	pendingInputEstimateCents: number;
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
	maxCostCents: number;
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

/**
 * What an exception ended the run as. Only the code, the sub-type and the HTTP status
 * are taken from it: its message and cause can carry a provider's body or a key.
 * A call that may have been billed (a timeout, or anything that failed after the
 * provider answered) is charged its priced input; one rejected before billing is not.
 */
function describeFailure(error: unknown, entry: Entry): FailureDetail {
	const completed = entry.settledCents;
	const inFlight = entry.pendingInputEstimateCents;
	if (error instanceof LlmError) {
		return {
			code: LLM_CODES[error.subType] ?? "provider_error",
			subType: error.subType,
			status: error.status ?? null,
			chargeCents: completed + (error.subType === "transient_timeout" ? inFlight : 0),
		};
	}
	if (error instanceof OwnTurnBusyError) {
		return { code: "busy", subType: null, status: null, chargeCents: completed };
	}
	return { code: "internal_error", subType: null, status: null, chargeCents: completed + inFlight };
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

async function callModel(
	ctx: RunContext,
	totals: Totals,
	built: ReturnType<typeof buildSummaryPrompt>,
	repair?: RepairKind,
): Promise<LlmResponse> {
	const { entry, provider } = ctx;
	const request = buildSummaryLlmRequest(built, provider.model, repair);
	const sentText = request.systemPrompt + request.transcriptPrompt;
	entry.pendingInputEstimateCents = priceCompletion(provider.kind, provider.model, {
		inputTokens: estimateTokens(sentText),
		outputTokens: 0,
		estimated: true,
	});
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
	entry.pendingInputEstimateCents = 0;
	totals.inputTokens += inputTokens;
	totals.outputTokens += response.usage.outputTokens;
	totals.estimated ||= response.usage.estimated;
	totals.calls += 1;
	return response;
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
	const first = await callModel(ctx, totals, built);
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
	const reservation = entry.reservation as SpendReservation;
	const needed = entry.settledCents + ctx.maxCostCents;
	if (
		reservation.cents < needed &&
		!(await topUpReservation(reservation, needed - reservation.cents))
	) {
		return failure(entry, "spend_cap");
	}
	if (entry.taken) return RELEASED;
	const second = await callModel(ctx, totals, built, repair);
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
		await settleReservedSpend(entry.reservation as SpendReservation, {
			sessionId: entry.sessionId,
			actualCents: outcome.ok ? entry.settledCents : outcome.chargeCents,
		});
	} catch (error) {
		console.error(
			"[session-summary] settlement failed",
			JSON.stringify({ code: errorName(error) }),
		);
	} finally {
		entries.delete(entry);
	}
}

/** An error's class name only: never its message, which can carry a body or a key. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

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
	let key: string | null;
	try {
		key = await getProviderApiKey(provider.id);
	} catch {
		return refuse({ error: "provider_key_unreadable" });
	}
	if (key === null) return refuse({ error: "no_provider" });

	let settleRequest!: () => void;
	const entry: Entry = {
		sessionId,
		subject: caller.subject,
		token: null,
		reservation: null,
		phase: "reading",
		settledCents: 0,
		pendingInputEstimateCents: 0,
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

		// Hand over: from here the entry owns the token and the reservation, and the run owns the rest.
		entry.token = token;
		entry.reservation = reservation;
		handedOver = true;
		const ctx: RunContext = { entry, token, provider, key, maxCostCents };
		const done = runGeneration(ctx).catch((error: unknown) => {
			console.error("[session-summary] run failed", JSON.stringify({ code: errorName(error) }));
		});
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
	} finally {
		try {
			if (!handedOver) {
				entries.delete(entry);
				if (claimedToken) {
					await writeAttempt(sessionId, claimedToken, failedRow(exitCode)).catch(() => {});
				}
				if (reservation) await releaseReservedSpend(reservation).catch(() => {});
			}
		} finally {
			settleRequest();
		}
	}
}

export async function releaseOwnSummaryClaims(): Promise<void> {
	throw new Error("not implemented");
}
