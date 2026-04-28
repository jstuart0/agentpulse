import { createActionRequest } from "../ai/action-requests-service.js";
import type { AskThreadOrigin } from "./ask-service.js";

/**
 * Persisted payload for an `add_channel` action request.
 *
 * Field name `channelKind` (not `kind`) — the row-level discriminant column
 * is `kind`, and stamping the channel sub-kind into a payload field of the
 * same name collided with the discriminated-union narrowing helpers when
 * those were introduced. Keep the field renamed here and read it as
 * `channelKind` in the executor / inbox.
 */
export interface AddChannelPayload {
	channelKind: "telegram" | "webhook" | "email";
	label: string;
}

function detectChannelKind(message: string): "telegram" | "webhook" | "email" | null {
	const lower = message.toLowerCase();
	if (lower.includes("telegram")) return "telegram";
	if (lower.includes("webhook")) return "webhook";
	if (lower.includes("email")) return "email";
	return null;
}

function deriveLabel(message: string): string {
	const namedMatch = message.match(/named\s+"?([^"]+?)"?(?:\s|$)/i);
	if (namedMatch) return namedMatch[1].trim();
	const forMatch = message.match(/\bfor\s+"?([^",.]+?)"?(?:\s|$)/i);
	if (forMatch) return forMatch[1].trim();
	return "Ask-created channel";
}

export async function handleChannelSetupRequest(
	message: string,
	args: { origin: AskThreadOrigin; threadId: string; telegramChatId?: string | null },
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const kind = detectChannelKind(message);
	if (!kind) {
		return {
			replyText: "Which channel type would you like to set up? (telegram, webhook, or email)",
			actionRequestId: null,
		};
	}

	const label = deriveLabel(message);
	const payload: AddChannelPayload = { channelKind: kind, label };

	const actionRequest = await createActionRequest({
		kind: "add_channel",
		question: `Set up a new **${kind}** notification channel named "${label}"?`,
		payload,
		origin: args.origin,
		askThreadId: args.threadId,
	});

	return {
		replyText: `I've queued a new **${kind}** channel setup — approve in inbox to create it. After approval, you'll receive setup instructions.`,
		actionRequestId: actionRequest.id,
	};
}
