/**
 * The Telegram rate rule for Notify reports, as a pure function of counts the
 * report store reads. The inbox always gets the report; this only decides
 * whether the Telegram copy goes out.
 *
 *  - routine (`finished`): at most one Telegram message per session per ten
 *    minutes, counted from the last one sent;
 *  - escalation (`stuck`, `needs_you`): sent on every new turn, at most three
 *    per session per hour;
 *  - everything: at most 30 Telegram messages per hour across all sessions,
 *    reports and HITL requests together.
 */
import type { WatcherReportVerdict } from "../../../../shared/types.js";
import { NOTIFY_TELEGRAM_GLOBAL_PER_HOUR } from "../../channels/telegram-budget.js";

export const NOTIFY_TELEGRAM_MIN_INTERVAL_MS = 600_000;
export const NOTIFY_ESCALATIONS_PER_SESSION_PER_HOUR = 3;

export type TelegramDecision = "send" | "skipped_rate_limit";

export interface TelegramDecisionInput {
	verdict: WatcherReportVerdict;
	/** When the last report was sent to Telegram for this session (epoch ms), or null. */
	lastRoutineSentAt: number | null;
	/** Escalations sent to Telegram for this session in the last hour. */
	escalationsLastHour: number;
	/** Telegram messages (reports and HITL requests) sent in the last hour, all sessions. */
	globalLastHour: number;
	now: number;
}

export function telegramDecision(input: TelegramDecisionInput): TelegramDecision {
	if (input.globalLastHour >= NOTIFY_TELEGRAM_GLOBAL_PER_HOUR) return "skipped_rate_limit";
	if (input.verdict === "finished") {
		const recent =
			input.lastRoutineSentAt !== null &&
			input.now - input.lastRoutineSentAt < NOTIFY_TELEGRAM_MIN_INTERVAL_MS;
		return recent ? "skipped_rate_limit" : "send";
	}
	return input.escalationsLastHour >= NOTIFY_ESCALATIONS_PER_SESSION_PER_HOUR
		? "skipped_rate_limit"
		: "send";
}
