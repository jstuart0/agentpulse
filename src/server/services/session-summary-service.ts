/**
 * AGEN-69 phase 5: the session summary service.
 *
 * `getSessionSummaryView` is the read model: point reads only, never a write, a
 * decrypt or a model call, and no AI on/off/paused state (the web reads that from
 * `/ai/status`, D-32). This is the only module besides `retention-service.ts` that
 * names the `ai_session_summaries` table (TC-5.35).
 */
import { and, eq, sql } from "drizzle-orm";
import {
	STALE_EVENT_COUNT_CAP,
	type SessionSummaryRefusalBody,
	type SessionSummaryStartBody,
	type SessionSummaryView,
	type SummaryBlockReason,
	type SummaryErrorCode,
} from "../../shared/session-summary-view.js";
import type { StoredSessionSummary } from "../../shared/session-summary.js";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import { aiSessionSummaries, llmProviders, sessions } from "../db/schema/index.js";
import { executeRows } from "../db/sql-helpers.js";
import { runInOwnTurn } from "../util/own-turn.js";
import { priceCompletion } from "./ai/llm/pricing.js";
import type { ProviderKind } from "./ai/llm/types.js";
import { classExpression, effectiveCategory } from "./ai/session-summary/evidence-loader.js";
import {
	ACTIVITY_ACTION_WINDOW,
	MAX_INPUT_TOKENS,
	MAX_OUTPUT_TOKENS,
	SUMMARY_COOLDOWN_SECONDS,
	SUMMARY_LEASE_SECONDS,
} from "./ai/session-summary/service-limits.js";
import { DEFAULT_DAILY_CAP_CENTS, getTodaySpendCents } from "./ai/spend-service.js";
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
		throughAt: stored ? stored.provenance.throughAt : null,
		throughEventId: stored ? row.throughEventId : null,
		attempt: attemptOf(row, judgement),
	};
	const midnight = nextLocalMidnightIso();
	if (judgement.kind === "live") {
		return {
			...base,
			staleEvents: 0,
			evidenceShrunk: false,
			blocked: null,
			cooldownSeconds: null,
			provider: null,
			spend: {
				spentCents: 0,
				capCents: DEFAULT_DAILY_CAP_CENTS,
				maxCostCents: 0,
				maxCostWithRetryCents: 0,
				resetsAt: midnight,
			},
		};
	}

	const provider = await readDefaultProvider();
	const spentCents = await getTodaySpendCents();
	const maxCostCents = provider ? maxCallCostCents(provider) : 0;
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
		provider: provider ? { kind: provider.kind, model: provider.model } : null,
		spend: {
			spentCents,
			capCents: DEFAULT_DAILY_CAP_CENTS,
			maxCostCents,
			maxCostWithRetryCents: 2 * maxCostCents,
			resetsAt: midnight,
		},
		...(retentionDays === undefined ? {} : { retentionDays }),
	};
}

// ── generation (phase 5, second pair) ────────────────────────────────────────

/** Points in a request and a generation where a test may observe or hold the flow (see `_setSummaryHooksForTest`). */
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

export function _setSummaryHooksForTest(_hooks: SummaryTestHooks | null): void {}

/** Abandons every running generation as a dead process would: nothing is written or settled. */
export function _resetSummaryGenerationsForTest(): void {}

export function _summaryGenerationCountForTest(): number {
	return 0;
}

/**
 * The claim: one conditional UPDATE, atomic on both dialects. `db` is for tests that need a second
 * connection. True when this caller now owns the attempt.
 */
export async function claimSummaryAttempt(
	_sessionId: string,
	_token: string,
	_now: Date = new Date(),
	_db = getDb(),
): Promise<boolean> {
	throw new Error("not implemented");
}

export async function requestSummaryGeneration(
	_sessionId: string,
	_caller: SummaryRequestCaller,
): Promise<SummaryRequestResult> {
	throw new Error("not implemented");
}

export async function releaseOwnSummaryClaims(): Promise<void> {
	throw new Error("not implemented");
}
