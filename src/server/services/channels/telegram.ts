import { config } from "../../config.js";
import { getChannelCredential } from "./channels-service.js";
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
 * The bot token is instance-wide (TELEGRAM_BOT_TOKEN env var). Each
 * enrolled channel row stores its own encrypted `chatId` so messages
 * target the right Telegram DM.
 */

const API_BASE = "https://api.telegram.org";

function apiUrl(method: string): string {
	return `${API_BASE}/bot${config.telegramBotToken}/${method}`;
}

async function callTelegram<T>(
	method: string,
	body: Record<string, unknown>,
): Promise<{ ok: true; result: T } | { ok: false; description: string }> {
	if (!config.telegramBotToken) {
		return { ok: false, description: "TELEGRAM_BOT_TOKEN not configured" };
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
		return Boolean(config.telegramBotToken);
	},

	async send(
		channel: NotificationChannelRecord,
		input: SendChannelMessageInput,
	): Promise<ChannelDeliveryResult> {
		if (!this.isConfigured()) {
			return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
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
		`*AgentPulse* · HITL request`,
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
	if (!config.telegramBotToken) return;
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
