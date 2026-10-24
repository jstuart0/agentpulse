/**
 * The one gate for inbound Telegram updates.
 *
 * Every update that does anything (a HITL tap, an `act:` approval, an Ask
 * message) passes through authorizeTelegramCaller before any handler runs; the
 * only exception is `/start <code>`, which is how a chat becomes linked at all.
 * A handler never looks a channel up by chat id itself: it receives the
 * channel this gate resolved.
 *
 * A caller is authorized when all of these hold:
 *  - the chat is a private chat (a group can't bind one person: anyone in it
 *    could tap),
 *  - an active, verified channel is linked to that chat,
 *  - the sender's Telegram user id is the one that enrolled the channel.
 *
 * A channel enrolled before the user was recorded derives it from the chat id
 * when the chat id is positive (a private chat's id is the user's id); a
 * legacy group channel has no known user and is refused until it is re-linked
 * from a private chat (see getChannelCredential).
 */
import { findActiveChannelByChatId, getChannelCredential } from "./channels-service.js";
import type { TelegramUpdate } from "./telegram.js";
import type { NotificationChannelRecord } from "./types.js";

export type TelegramCallerResult =
	| { ok: true; channel: NotificationChannelRecord; fromId: string; chatId: string }
	| { ok: false; reply: "not_authorized" | "not_linked" | "silent" };

const NOT_AUTHORIZED_FOR_CALLBACK = { ok: false, reply: "not_authorized" } as const;

export async function authorizeTelegramCaller(
	update: TelegramUpdate,
): Promise<TelegramCallerResult> {
	const callback = update.callback_query;
	// A callback with no message has no chat to check: fail closed.
	const chat = callback ? callback.message?.chat : update.message?.chat;
	const from = callback ? callback.from : update.message?.from;

	// A refusal speaks to a tapped button ("Not authorized.") and stays quiet to a message.
	const refuse = (messageReply: "not_linked" | "silent"): TelegramCallerResult =>
		callback ? NOT_AUTHORIZED_FOR_CALLBACK : { ok: false, reply: messageReply };

	if (!chat) return refuse("silent");
	if (chat.type !== "private") return refuse("silent");

	const chatId = String(chat.id);
	const channel = await findActiveChannelByChatId(chatId);
	if (!channel) return refuse("not_linked");

	const credential = await getChannelCredential(channel.id);
	if (!credential || credential.fromUserId === null) return refuse("silent");
	if (!from || String(from.id) !== credential.fromUserId) return refuse("silent");

	return { ok: true, channel, fromId: String(from.id), chatId };
}
