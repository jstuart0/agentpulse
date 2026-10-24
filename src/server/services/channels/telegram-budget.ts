/**
 * The one global cap on messages sent to Telegram: reports and HITL requests
 * together, across every session, counted from what was actually sent (the
 * `telegram_sent_at` stamps), so a restart can't reset it and a spike of
 * escalations can't drown the chat.
 */
import { gte, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { aiHitlRequests, aiWatcherReports } from "../../db/schema/index.js";

export const NOTIFY_TELEGRAM_GLOBAL_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** How many Telegram messages (reports and HITL requests) were sent since `sinceIso`. */
export async function telegramSendsSince(sinceIso: string): Promise<number> {
	const db = getDb();
	const [reports] = await db
		.select({ n: sql<number>`count(*)` })
		.from(aiWatcherReports)
		.where(gte(aiWatcherReports.telegramSentAt, sinceIso));
	const [hitls] = await db
		.select({ n: sql<number>`count(*)` })
		.from(aiHitlRequests)
		.where(gte(aiHitlRequests.telegramSentAt, sinceIso));
	return Number(reports?.n ?? 0) + Number(hitls?.n ?? 0);
}

/** True when the last hour already holds the cap. */
export async function telegramGlobalCapReached(now = Date.now()): Promise<boolean> {
	const since = new Date(now - HOUR_MS).toISOString();
	return (await telegramSendsSince(since)) >= NOTIFY_TELEGRAM_GLOBAL_PER_HOUR;
}
