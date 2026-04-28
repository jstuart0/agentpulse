import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import { sendTelegramRaw } from "../channels/telegram.js";

/**
 * Send an inline Approve/Decline keyboard to a Telegram chat for a given
 * action request. Best-effort — failures are logged but never propagate to
 * the caller, so a Telegram hiccup cannot block the reply path.
 */
export async function sendTelegramActionRequest(
	chatId: string,
	actionRequestId: string,
	question: string,
	contextLabel = "Action request",
): Promise<void> {
	const token = getTelegramBotToken();
	if (!token) return;
	const keyboard = {
		inline_keyboard: [
			[
				{ text: "Approve", callback_data: `act:approve:${actionRequestId}` },
				{ text: "Decline", callback_data: `act:decline:${actionRequestId}` },
			],
		],
	};
	await sendTelegramRaw(token, "sendMessage", {
		chat_id: chatId,
		text: `AgentPulse · ${contextLabel}\n\n${question}`,
		reply_markup: keyboard,
	}).catch((err) => {
		console.warn("[telegram-helpers] sendTelegramActionRequest failed:", err);
	});
}
