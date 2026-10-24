/**
 * The Notify report store: one row per (session, turn), kept by the database.
 *
 * It owns dedupe (the unique index), takeover of a transient failure, the
 * evidence watermark (only a *delivered* report moves it), the Telegram
 * rate-limit counts and which reports the inbox shows. It holds no turn logic
 * of its own: the turn key comes from `turn-identity.ts`.
 */
import { aliasedTable, and, count, desc, eq, gte, inArray, max, notExists, sql } from "drizzle-orm";
import type {
	WatcherReport,
	WatcherReportStatus,
	WatcherReportTelegramStatus,
	WatcherReportVerdict,
} from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { aiWatcherReports, sessions } from "../../db/schema/index.js";
import { parseDbTimestamp } from "../util/db-time.js";

/** A report is tried at most this many times for one turn. */
export const MAX_REPORT_ATTEMPTS = 2;

/** Failures a second try can fix. Anything the model said wrong is never retried. */
export const TRANSIENT_FAILURE_CODES = [
	"provider_timeout",
	"provider_transient",
	"evidence_read",
	"abandoned",
] as const;

export type ReportFailureCode =
	| (typeof TRANSIENT_FAILURE_CODES)[number]
	| "empty_output"
	| "length"
	| "refusal"
	| "parse"
	| "citation"
	| "suspect_text"
	| "spend_cap"
	| `provider_${string}`;

/** Why a report was not delivered although nothing failed. */
export type SuppressionCode = "no_new_evidence" | "stale";

type ReportRow = typeof aiWatcherReports.$inferSelect;

export function toWatcherReport(row: ReportRow): WatcherReport {
	return {
		id: row.id,
		sessionId: row.sessionId,
		turnKey: row.turnKey,
		verdict: row.verdict as WatcherReportVerdict | null,
		why: row.why,
		status: row.status as WatcherReportStatus,
		failureCode: row.failureCode,
		telegramStatus: row.telegramStatus as WatcherReportTelegramStatus | null,
		createdAt: row.createdAt,
	};
}

export interface ClaimInput {
	sessionId: string;
	turnKey: string;
	triggerEventId: number | null;
}

export type ClaimResult = { claimed: true; id: string; attempt: number } | { claimed: false };

/**
 * Take the right to report this turn. One statement decides it: insert, or take
 * over the existing row only when it is a transient failure with attempts left.
 * An empty result means the turn is owned (claimed, delivered, suppressed, or
 * failed in a way a retry can't fix).
 */
export async function claimReport(input: ClaimInput): Promise<ClaimResult> {
	const now = new Date().toISOString();
	const rows = await getDb()
		.insert(aiWatcherReports)
		.values({
			sessionId: input.sessionId,
			turnKey: input.turnKey,
			triggerEventId: input.triggerEventId,
			status: "claimed",
			attemptCount: 1,
			claimedAt: now,
			createdAt: now,
		})
		.onConflictDoUpdate({
			target: [aiWatcherReports.sessionId, aiWatcherReports.turnKey],
			set: {
				status: "claimed",
				failureCode: null,
				triggerEventId: input.triggerEventId,
				attemptCount: sql`${aiWatcherReports.attemptCount} + 1`,
				claimedAt: now,
			},
			setWhere: and(
				eq(aiWatcherReports.status, "failed"),
				inArray(aiWatcherReports.failureCode, [...TRANSIENT_FAILURE_CODES]),
				sql`${aiWatcherReports.attemptCount} < ${MAX_REPORT_ATTEMPTS}`,
			),
		})
		.returning({ id: aiWatcherReports.id, attemptCount: aiWatcherReports.attemptCount });
	const row = rows[0];
	return row ? { claimed: true, id: row.id, attempt: row.attemptCount } : { claimed: false };
}

export interface Usage {
	providerId: string;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
}

export interface CompleteInput extends Usage {
	id: string;
	verdict: WatcherReportVerdict;
	why: string;
	evidenceIds: string[];
	/** The newest event the report covered; the next report starts after it. */
	throughEventId: number;
}

/** The claimed row becomes the delivered report. False when it was not claimed any more. */
export async function completeReport(input: CompleteInput): Promise<boolean> {
	const rows = await getDb()
		.update(aiWatcherReports)
		.set({
			status: "delivered",
			verdict: input.verdict,
			why: input.why,
			evidenceIds: input.evidenceIds,
			throughEventId: input.throughEventId,
			failureCode: null,
			providerId: input.providerId,
			tokensIn: input.tokensIn,
			tokensOut: input.tokensOut,
			costCents: input.costCents,
		})
		.where(and(eq(aiWatcherReports.id, input.id), eq(aiWatcherReports.status, "claimed")))
		.returning({ id: aiWatcherReports.id });
	return rows.length > 0;
}

/** A claimed row that did not produce a report. Never moves the evidence watermark. */
export async function failReport(
	id: string,
	code: ReportFailureCode,
	usage?: Partial<Usage>,
): Promise<void> {
	await settle(id, "failed", code, usage);
}

/** A claimed row whose report was not worth delivering (nothing new, or the turn moved on). */
export async function suppressReport(
	id: string,
	code: SuppressionCode,
	usage?: Partial<Usage>,
): Promise<void> {
	await settle(id, "suppressed", code, usage);
}

async function settle(
	id: string,
	status: "failed" | "suppressed",
	code: string,
	usage?: Partial<Usage>,
): Promise<void> {
	await getDb()
		.update(aiWatcherReports)
		.set({
			status,
			failureCode: code,
			...(usage?.providerId ? { providerId: usage.providerId } : {}),
			...(usage?.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
			...(usage?.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
			...(usage?.costCents !== undefined ? { costCents: usage.costCents } : {}),
		})
		.where(and(eq(aiWatcherReports.id, id), eq(aiWatcherReports.status, "claimed")));
}

/** What happened to the Telegram copy. `sentAt` is stamped only for `sent`. */
export async function markTelegram(
	id: string,
	status: WatcherReportTelegramStatus,
	sentAt: Date = new Date(),
): Promise<void> {
	await getDb()
		.update(aiWatcherReports)
		.set({
			telegramStatus: status,
			telegramSentAt: status === "sent" ? sentAt.toISOString() : null,
		})
		.where(eq(aiWatcherReports.id, id));
}

/** The newest event the session's last *delivered* report covered, or 0 when it has none. */
export async function lastDeliveredThrough(sessionId: string): Promise<number> {
	const [row] = await getDb()
		.select({ through: max(aiWatcherReports.throughEventId) })
		.from(aiWatcherReports)
		.where(
			and(eq(aiWatcherReports.sessionId, sessionId), eq(aiWatcherReports.status, "delivered")),
		);
	return Number(row?.through ?? 0);
}

async function newestIso(
	column: typeof aiWatcherReports.telegramSentAt | typeof aiWatcherReports.createdAt,
	where: ReturnType<typeof and>,
): Promise<number | null> {
	const [row] = await getDb()
		.select({ at: column })
		.from(aiWatcherReports)
		.where(where)
		.orderBy(desc(column))
		.limit(1);
	return row?.at ? parseDbTimestamp(row.at) : null;
}

/**
 * When the last report was sent to Telegram for this session (any verdict), as
 * epoch ms, or null. A routine report waits ten minutes after it.
 */
export async function lastRoutineSentAt(sessionId: string): Promise<number | null> {
	return newestIso(
		aiWatcherReports.telegramSentAt,
		and(eq(aiWatcherReports.sessionId, sessionId), eq(aiWatcherReports.telegramStatus, "sent")),
	);
}

/** How many escalations (`stuck`, `needs_you`) went to Telegram for this session since `sinceMs`. */
export async function escalationsSentSince(sessionId: string, sinceMs: number): Promise<number> {
	const [row] = await getDb()
		.select({ n: count() })
		.from(aiWatcherReports)
		.where(
			and(
				eq(aiWatcherReports.sessionId, sessionId),
				eq(aiWatcherReports.telegramStatus, "sent"),
				inArray(aiWatcherReports.verdict, ["stuck", "needs_you"]),
				gte(aiWatcherReports.telegramSentAt, new Date(sinceMs).toISOString()),
			),
		);
	return Number(row?.n ?? 0);
}

/** When the session's newest report row (any status) was created, as epoch ms, or null. */
export async function lastReportCreatedAt(sessionId: string): Promise<number | null> {
	return newestIso(aiWatcherReports.createdAt, eq(aiWatcherReports.sessionId, sessionId));
}

/** The newest reports for a session, newest first. */
export async function listReportsForSession(
	sessionId: string,
	limit = 10,
): Promise<WatcherReport[]> {
	const rows = await getDb()
		.select()
		.from(aiWatcherReports)
		.where(eq(aiWatcherReports.sessionId, sessionId))
		.orderBy(desc(aiWatcherReports.createdAt))
		.limit(limit);
	return rows.map(toWatcherReport);
}

export interface InboxReport {
	id: string;
	sessionId: string;
	sessionName: string | null;
	verdict: WatcherReportVerdict;
	why: string;
	at: string;
}

/**
 * The newest delivered report of each session that the person has not
 * acknowledged since: `report.created_at > sessions.last_user_acknowledged_at`
 * (or never acknowledged). Compared in JS, because the two columns are written
 * in different timestamp formats.
 */
export async function listInboxReports(): Promise<InboxReport[]> {
	const db = getDb();
	const newer = aliasedTable(aiWatcherReports, "newer_report");
	const rows = await db
		.select({
			id: aiWatcherReports.id,
			sessionId: aiWatcherReports.sessionId,
			verdict: aiWatcherReports.verdict,
			why: aiWatcherReports.why,
			createdAt: aiWatcherReports.createdAt,
			sessionName: sessions.displayName,
			acknowledgedAt: sessions.lastUserAcknowledgedAt,
		})
		.from(aiWatcherReports)
		.innerJoin(sessions, eq(sessions.sessionId, aiWatcherReports.sessionId))
		.where(
			and(
				eq(aiWatcherReports.status, "delivered"),
				notExists(
					db
						.select({ one: sql`1` })
						.from(newer)
						.where(
							and(
								eq(newer.sessionId, aiWatcherReports.sessionId),
								eq(newer.status, "delivered"),
								sql`${newer.createdAt} > ${aiWatcherReports.createdAt}`,
							),
						),
				),
			),
		)
		.orderBy(desc(aiWatcherReports.createdAt));
	const out: InboxReport[] = [];
	for (const row of rows) {
		if (row.verdict === null || row.why === null) continue;
		const created = parseDbTimestamp(row.createdAt);
		if (created === null) continue;
		const ack = parseDbTimestamp(row.acknowledgedAt);
		if (ack !== null && created <= ack) continue;
		out.push({
			id: row.id,
			sessionId: row.sessionId,
			sessionName: row.sessionName,
			verdict: row.verdict as WatcherReportVerdict,
			why: row.why,
			at: row.createdAt,
		});
	}
	return out;
}
