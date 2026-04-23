import { getChannel } from "./channels-service.js";
import { getChannelAdapter } from "./registry.js";
import type { SendChannelMessageInput } from "./types.js";

/**
 * Dispatch a HITL request to a notification channel. Best-effort: a
 * failed delivery is logged but does not block the in-app HITL flow —
 * the operator can still approve/decline from /inbox or the session AI
 * tab. Every delivery attempt is audited via emitAiEvent by the caller.
 */
export async function dispatchHitlToChannel(input: {
	channelId: string;
	message: SendChannelMessageInput;
}): Promise<{ ok: boolean; externalMessageId?: string; error?: string }> {
	const channel = await getChannel(input.channelId);
	if (!channel) return { ok: false, error: "Channel not found" };
	if (!channel.isActive) return { ok: false, error: "Channel is inactive" };
	if (!channel.verifiedAt) return { ok: false, error: "Channel is not verified" };

	const adapter = getChannelAdapter(channel.kind);
	if (!adapter.isConfigured()) {
		return { ok: false, error: `${channel.kind} adapter is not configured` };
	}

	try {
		return await adapter.send(channel, input.message);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
