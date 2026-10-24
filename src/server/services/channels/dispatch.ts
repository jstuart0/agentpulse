import { stampHitlTelegramSent } from "../ai/hitl-service.js";
import { getChannel } from "./channels-service.js";
import { getChannelAdapter } from "./registry.js";
import { telegramGlobalCapReached } from "./telegram-budget.js";
import type {
	ChannelDeliveryResult,
	SendChannelMessageInput,
	SendChannelReportInput,
} from "./types.js";

/** What a caller says about a HITL; the channel's own setting decides how much of it is sent. */
export type HitlChannelMessage = Omit<SendChannelMessageInput, "detail">;

export type HitlDeliveryResult = {
	ok: boolean;
	externalMessageId?: string;
	error?: string;
	/** True when nothing was sent on purpose (the global Telegram cap): not a delivery failure. */
	skipped?: boolean;
};

/**
 * Dispatch a HITL request to a notification channel. Best-effort: a
 * failed delivery is logged but does not block the in-app HITL flow —
 * the operator can still approve/decline from /inbox or the session AI
 * tab. Every delivery attempt is audited via emitAiEvent by the caller.
 *
 * The message goes out at the channel's `detail` setting (`minimal` unless the
 * owner chose `full`). Over the global cap on Telegram messages per hour the
 * send is skipped and the request stays open in the app. A successful send is
 * stamped on the request so it counts toward that cap.
 */
export async function dispatchHitlToChannel(input: {
	channelId: string;
	message: HitlChannelMessage;
}): Promise<HitlDeliveryResult> {
	const channel = await getChannel(input.channelId);
	if (!channel) return { ok: false, error: "Channel not found" };
	if (!channel.isActive) return { ok: false, error: "Channel is inactive" };
	if (!channel.verifiedAt) return { ok: false, error: "Channel is not verified" };

	const adapter = getChannelAdapter(channel.kind);
	if (!adapter.isConfigured()) {
		return { ok: false, error: `${adapter.kind} adapter is not configured` };
	}

	if (channel.kind === "telegram" && (await telegramGlobalCapReached())) {
		return { ok: false, skipped: true, error: "Telegram send cap reached for this hour" };
	}

	const detail = channel.config?.detail === "full" ? "full" : "minimal";
	try {
		const result = await adapter.send(channel, { ...input.message, detail });
		if (result.ok && channel.kind === "telegram") {
			await stampHitlTelegramSent(input.message.hitlId);
		}
		return result;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** What a caller says about a report; the channel's own setting decides how much of it is sent. */
export type ReportChannelMessage = Omit<SendChannelReportInput, "detail">;

/**
 * Deliver a Notify report. Same active-and-verified checks as a HITL. The
 * Telegram rate rule is the caller's (`telegramDecision`), because it needs the
 * report store's counts; this function only sends. Best-effort: a failure is a
 * result, never a throw.
 */
export async function dispatchReportToChannel(input: {
	channelId: string;
	message: ReportChannelMessage;
}): Promise<ChannelDeliveryResult> {
	const channel = await getChannel(input.channelId);
	if (!channel) return { ok: false, error: "Channel not found" };
	if (!channel.isActive) return { ok: false, error: "Channel is inactive" };
	if (!channel.verifiedAt) return { ok: false, error: "Channel is not verified" };

	const adapter = getChannelAdapter(channel.kind);
	if (!adapter.isConfigured()) {
		return { ok: false, error: `${adapter.kind} adapter is not configured` };
	}
	if (!adapter.sendReport) {
		return { ok: false, error: `${adapter.kind} adapter cannot deliver reports` };
	}
	const detail = channel.config?.detail === "full" ? "full" : "minimal";
	try {
		return await adapter.sendReport(channel, { ...input.message, detail });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
