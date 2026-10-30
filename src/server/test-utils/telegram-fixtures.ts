/**
 * Fixtures for the Telegram tests: an enrolled channel, and the update shapes
 * the bot receives. Everything goes through the channel service or Drizzle.
 * Not a test file.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { notificationChannels } from "../db/schema/index.js";
import { encryptSecret } from "../services/ai/secrets.js";
import { completeEnrollment, createPendingChannel } from "../services/channels/channels-service.js";
import type { TelegramUpdate } from "../services/channels/telegram.js";

/**
 * A verified Telegram channel enrolled the way the bot enrolls one: pending,
 * then redeemed from a private chat. `userId` is who owns it in team mode.
 */
export async function seedVerifiedChannel(input: {
	chatId: string;
	fromUserId?: string;
	userId?: string;
	label?: string;
}): Promise<string> {
	const { channel, enrollmentCode } = await createPendingChannel({
		kind: "telegram",
		label: input.label ?? `chat ${input.chatId}`,
		userId: input.userId,
	});
	const bound = await completeEnrollment({
		channelId: channel.id,
		chatId: input.chatId,
		fromUserId: input.fromUserId ?? input.chatId,
		code: enrollmentCode,
	});
	if (!bound) throw new Error("fixture channel did not bind");
	return channel.id;
}

/** A channel as it was stored before the enrolling user was recorded: only the chat id. */
export async function seedLegacyChannel(input: {
	chatId: string;
	userId?: string;
}): Promise<string> {
	const id = await seedVerifiedChannel({ ...input, fromUserId: input.chatId });
	await getDb()
		.update(notificationChannels)
		.set({ credentialCiphertext: encryptSecret(JSON.stringify({ chatId: input.chatId })) })
		.where(eq(notificationChannels.id, id));
	return id;
}

export type ChatKind = "private" | "group" | "supergroup";

export function tapUpdate(input: {
	data: string;
	chatId: string | number;
	chatType?: ChatKind;
	fromId?: string | number;
	withMessage?: boolean;
	updateId?: number;
}): TelegramUpdate {
	const chatId = Number(input.chatId);
	return {
		update_id: input.updateId ?? 1,
		callback_query: {
			id: `cb-${input.updateId ?? 1}`,
			data: input.data,
			from: { id: Number(input.fromId ?? input.chatId) },
			...(input.withMessage === false
				? {}
				: { message: { message_id: 1, chat: { id: chatId, type: input.chatType ?? "private" } } }),
		},
	};
}

export function textUpdate(input: {
	text: string;
	chatId: string | number;
	chatType?: ChatKind;
	fromId?: string | number;
	updateId?: number;
}): TelegramUpdate {
	return {
		update_id: input.updateId ?? 1,
		message: {
			message_id: 1,
			chat: { id: Number(input.chatId), type: input.chatType ?? "private" },
			text: input.text,
			from: { id: Number(input.fromId ?? input.chatId) },
		},
	};
}

export interface TelegramApiCall {
	method: string;
	body: Record<string, unknown>;
}

/**
 * Runs `run` with a bot token configured and the Telegram HTTP API replaced by
 * a recorder, so a test sees exactly what the bot would have sent. Restores
 * the token and fetch afterwards.
 */
export async function withTelegramApi<T>(
	run: (calls: TelegramApiCall[]) => Promise<T>,
): Promise<T> {
	const { config } = await import("../config.js");
	const botStore = await import("../services/channels/telegram-credentials.js");
	const calls: TelegramApiCall[] = [];
	const realFetch = globalThis.fetch;
	const original = (config as Record<string, unknown>).telegramBotToken;
	await botStore.clearTelegramCredentials();
	(config as Record<string, unknown>).telegramBotToken = "test-token";
	await botStore.refreshTelegramCredentials();
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		// Only the Bot API is replaced; any other host (a stub model provider) is reached for real.
		if (!String(url).startsWith("https://api.telegram.org/")) return realFetch(url, init);
		const method = String(url).split("/").pop() ?? "";
		calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
	}) as typeof fetch;
	try {
		return await run(calls);
	} finally {
		globalThis.fetch = realFetch;
		(config as Record<string, unknown>).telegramBotToken = original;
		await botStore.refreshTelegramCredentials();
	}
}

/** The text of every `sendMessage` call, in order. */
export function sentTexts(calls: TelegramApiCall[]): string[] {
	return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text ?? ""));
}

/** The text of every `answerCallbackQuery` call, in order. */
export function answeredTexts(calls: TelegramApiCall[]): string[] {
	return calls
		.filter((c) => c.method === "answerCallbackQuery")
		.map((c) => String(c.body.text ?? ""));
}
