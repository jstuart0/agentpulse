import { getChannelCredential } from "./channels-service.js";
import { getTelegramBotToken } from "./telegram-credentials.js";
import {
	type ChannelDeliveryResult,
	type NotificationChannelAdapter,
	type NotificationChannelRecord,
	type SendChannelMessageInput,
	encodeHitlCallbackData,
} from "./types.js";

/**
 * Telegram Bot API adapter. Uses Bun's global fetch; no client lib.
 * Inbound updates are delivered to `/api/v1/channels/telegram/webhook`
 * (see src/server/routes/channels.ts).
 *
 * The bot token is instance-wide. It lives encrypted in the settings
 * table (preferred) or as the legacy TELEGRAM_BOT_TOKEN env var, and is
 * exposed via `getTelegramBotToken()` so the call site doesn't have to
 * care which source the credential came from. Each enrolled channel
 * row stores its own encrypted `chatId` for routing.
 */

const API_BASE = "https://api.telegram.org";

function apiUrl(method: string): string {
	return `${API_BASE}/bot${getTelegramBotToken()}/${method}`;
}

async function callTelegram<T>(
	method: string,
	body: Record<string, unknown>,
): Promise<{ ok: true; result: T } | { ok: false; description: string }> {
	if (!getTelegramBotToken()) {
		return { ok: false, description: "Telegram bot token not configured" };
	}
	const res = await fetch(apiUrl(method), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as
		| { ok: true; result: T }
		| { ok: false; description?: string; error_code?: number };
	if (!json.ok) {
		return {
			ok: false,
			description: "description" in json && json.description ? json.description : "unknown error",
		};
	}
	return json;
}

export const telegramAdapter: NotificationChannelAdapter = {
	kind: "telegram",

	isConfigured(): boolean {
		return Boolean(getTelegramBotToken());
	},

	async send(
		channel: NotificationChannelRecord,
		input: SendChannelMessageInput,
	): Promise<ChannelDeliveryResult> {
		if (!this.isConfigured()) {
			return { ok: false, error: "Telegram bot token not configured" };
		}
		if (!channel.verifiedAt) {
			return { ok: false, error: "Channel is not verified yet" };
		}
		const cred = await getChannelCredential(channel.id);
		if (!cred?.chatId) {
			return { ok: false, error: "Channel has no stored chat id" };
		}

		const text = formatHitlMessage(input);
		const keyboard = {
			inline_keyboard: [
				[
					{
						text: "✅ Approve",
						callback_data: encodeHitlCallbackData({
							hitlId: input.hitlId,
							action: "approve",
						}),
					},
					{
						text: "❌ Decline",
						callback_data: encodeHitlCallbackData({
							hitlId: input.hitlId,
							action: "decline",
						}),
					},
				],
			],
		};
		const res = await callTelegram<{ message_id: number }>("sendMessage", {
			chat_id: cred.chatId,
			text,
			parse_mode: "MarkdownV2",
			disable_web_page_preview: true,
			reply_markup: keyboard,
		});
		if (!res.ok) return { ok: false, error: res.description };
		return { ok: true, externalMessageId: String(res.result.message_id) };
	},
};

function formatHitlMessage(input: SendChannelMessageInput): string {
	const sessionLabel = input.sessionDisplayName ?? input.sessionId.slice(0, 8);
	const decision = input.decision === "continue" ? "continue" : "ask";
	const lines = [
		"*AgentPulse* · HITL request",
		`Session: \`${escapeMd(sessionLabel)}\``,
		`Decision: \`${decision}\``,
	];
	if (input.why) {
		lines.push("", `_${escapeMd(input.why)}_`);
	}
	if (input.prompt?.trim()) {
		// Telegram limits messages to 4096 chars. Budget 3000 for the prompt.
		const snippet = input.prompt.length > 3000 ? `${input.prompt.slice(0, 3000)}…` : input.prompt;
		lines.push("", "```", snippet, "```");
	}
	return lines.join("\n");
}

// MarkdownV2 reserved chars per https://core.telegram.org/bots/api#markdownv2-style.
// We don't escape inside pre/code blocks — that's handled by Telegram.
function escapeMd(text: string): string {
	return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * Send a plain-text confirmation (post-resolve echo). Best-effort —
 * we ignore failures so a flaky Telegram doesn't block the HITL path.
 */
export async function sendTelegramPlain(channelId: string, text: string): Promise<void> {
	if (!getTelegramBotToken()) return;
	const cred = await getChannelCredential(channelId);
	if (!cred?.chatId) return;
	await callTelegram("sendMessage", {
		chat_id: cred.chatId,
		text,
	}).catch(() => {
		// ignore
	});
}

/**
 * Escape hatch for Telegram callers that need shapes outside `sendTelegramMessage`'s
 * "plain text only" contract — e.g. inline keyboards, MarkdownV2, sendChatAction
 * (where `chatId` lives next to a non-text payload). Takes a raw bot token so
 * callers don't have to plumb the credential lookup; resolves to the same
 * `https://api.telegram.org/bot<token>/<method>` URL the rest of this module uses.
 *
 * Callers are responsible for catching/logging — this returns the raw fetch
 * promise so the caller can keep its existing error semantics.
 */
export function sendTelegramRaw(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return fetch(`${API_BASE}/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Low-level plain `sendMessage` helper that takes a raw `botToken` + `chatId`
 * (vs `sendTelegramPlain` which resolves the chatId from a stored channel id).
 *
 * Use this when:
 *  - the caller already has the chat id in hand (e.g. inbound webhook flow,
 *    enrollment reply where we don't yet have a channel row),
 *  - or the caller wants the optional 4096-char chunk-splitting behavior.
 *
 * Telegram caps `sendMessage.text` at 4096 chars. When `chunkSplit` is true
 * we leave room for a continuation indicator (LIMIT = 3800) and prefer to
 * split on a newline near the cap so we don't chop mid-sentence. Best-effort
 * — failures are swallowed so a flaky Telegram doesn't block the caller's
 * main work.
 */
export async function sendTelegramMessage(
	botToken: string,
	chatId: string | number,
	text: string,
	opts?: { chunkSplit?: boolean },
): Promise<void> {
	if (!botToken) return;
	const url = `${API_BASE}/bot${botToken}/sendMessage`;

	const parts: string[] = [];
	if (opts?.chunkSplit) {
		// Telegram caps at 4096; leave room for a continuation indicator.
		const LIMIT = 3800;
		let remaining = text;
		while (remaining.length > LIMIT) {
			// Prefer splitting on a newline near the limit so we don't chop
			// mid-sentence.
			const cutAt = remaining.lastIndexOf("\n", LIMIT);
			const end = cutAt > LIMIT / 2 ? cutAt : LIMIT;
			parts.push(remaining.slice(0, end));
			remaining = remaining.slice(end).replace(/^\s+/, "");
		}
		if (remaining) parts.push(remaining);
	} else {
		parts.push(text);
	}

	for (const part of parts) {
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: part }),
		}).catch(() => {
			// best-effort; let the caller's error handler surface failures
		});
	}
}

/**
 * Idempotently point the bot's webhook at this instance's public URL.
 * Called from the channel routes; safe to call repeatedly.
 */
export async function setTelegramWebhook(
	url: string,
	secretToken: string,
): Promise<{
	ok: boolean;
	description?: string;
}> {
	const res = await callTelegram("setWebhook", {
		url,
		secret_token: secretToken,
		allowed_updates: ["message", "callback_query"],
	});
	return res;
}

export async function deleteTelegramWebhook(): Promise<void> {
	await callTelegram("deleteWebhook", { drop_pending_updates: false });
}

/**
 * Called after a callback_query to clear Telegram's "loading" state
 * on the tapped button. Best-effort.
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
	await callTelegram("answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		text,
	}).catch(() => {
		// ignore
	});
}

export interface TelegramBotInfo {
	id: number;
	username: string | null;
	firstName: string | null;
	canJoinGroups: boolean;
	supportsInlineQueries: boolean;
}

export async function getTelegramBotInfo(): Promise<
	{ ok: true; info: TelegramBotInfo } | { ok: false; error: string }
> {
	const res = await callTelegram<{
		id: number;
		is_bot: boolean;
		first_name?: string;
		username?: string;
		can_join_groups?: boolean;
		supports_inline_queries?: boolean;
	}>("getMe", {});
	if (!res.ok) return { ok: false, error: res.description };
	return {
		ok: true,
		info: {
			id: res.result.id,
			username: res.result.username ?? null,
			firstName: res.result.first_name ?? null,
			canJoinGroups: Boolean(res.result.can_join_groups),
			supportsInlineQueries: Boolean(res.result.supports_inline_queries),
		},
	};
}

export interface TelegramWebhookInfo {
	url: string;
	hasCustomCertificate: boolean;
	pendingUpdateCount: number;
	lastErrorDate: number | null;
	lastErrorMessage: string | null;
	maxConnections: number | null;
	allowedUpdates: string[];
}

export async function getTelegramWebhookInfo(): Promise<
	{ ok: true; info: TelegramWebhookInfo } | { ok: false; error: string }
> {
	const res = await callTelegram<{
		url: string;
		has_custom_certificate: boolean;
		pending_update_count: number;
		last_error_date?: number;
		last_error_message?: string;
		max_connections?: number;
		allowed_updates?: string[];
	}>("getWebhookInfo", {});
	if (!res.ok) return { ok: false, error: res.description };
	return {
		ok: true,
		info: {
			url: res.result.url,
			hasCustomCertificate: res.result.has_custom_certificate,
			pendingUpdateCount: res.result.pending_update_count,
			lastErrorDate: res.result.last_error_date ?? null,
			lastErrorMessage: res.result.last_error_message ?? null,
			maxConnections: res.result.max_connections ?? null,
			allowedUpdates: res.result.allowed_updates ?? [],
		},
	};
}

/**
 * Minimal Telegram update types exposed so the webhook route and the
 * long-poll service can share one handler. The full Telegram shape has
 * dozens of fields we don't use; we only pick what the enrollment +
 * HITL-callback flows look at.
 */
export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string };
	text?: string;
	from?: { id: number; username?: string };
}

export interface TelegramCallbackQuery {
	id: string;
	data?: string;
	message?: TelegramMessage;
	from: { id: number; username?: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

/**
 * Long-polling `getUpdates` call. Used when the instance can't accept
 * a webhook (home-lab, NAT, private DNS). Telegram holds the request
 * open for up to `timeout` seconds if nothing is waiting, then
 * returns an empty array.
 */
export async function getTelegramUpdates(input: {
	offset?: number;
	timeout?: number;
}): Promise<{ ok: true; updates: TelegramUpdate[] } | { ok: false; error: string }> {
	const res = await callTelegram<TelegramUpdate[]>("getUpdates", {
		offset: input.offset ?? 0,
		timeout: input.timeout ?? 25,
		allowed_updates: ["message", "callback_query"],
	});
	if (!res.ok) return { ok: false, error: res.description };
	return { ok: true, updates: res.result };
}

/**
 * Send a standalone test message to a verified Telegram channel so the
 * user can confirm end-to-end delivery without needing a real HITL.
 * Uses the same formatting as a real HITL message but with inert
 * callback_data so taps are acknowledged but no HITL is resolved.
 */
export async function sendTelegramTest(channelId: string): Promise<ChannelDeliveryResult> {
	if (!getTelegramBotToken()) return { ok: false, error: "Telegram bot token not configured" };
	const cred = await (await import("./channels-service.js")).getChannelCredential(channelId);
	if (!cred?.chatId) return { ok: false, error: "Channel has no stored chat id" };
	const res = await callTelegram<{ message_id: number }>("sendMessage", {
		chat_id: cred.chatId,
		text: "*AgentPulse* · test delivery\nIf you see this, the channel is wired up correctly\\. The buttons below are inert\\.",
		parse_mode: "MarkdownV2",
		reply_markup: {
			inline_keyboard: [
				[
					{ text: "✅ Approve (test)", callback_data: "test:noop" },
					{ text: "❌ Decline (test)", callback_data: "test:noop" },
				],
			],
		},
	});
	if (!res.ok) return { ok: false, error: res.description };
	return { ok: true, externalMessageId: String(res.result.message_id) };
}
