/**
 * Notification channel abstraction. Every adapter (Telegram, webhook,
 * email, ...) implements this interface so the runner and HITL service
 * can deliver prompts through any enrolled channel without knowing the
 * underlying transport.
 */

export type NotificationChannelKind = "telegram" | "webhook" | "email";

export interface NotificationChannelRecord {
	id: string;
	userId: string;
	kind: NotificationChannelKind;
	label: string;
	config: Record<string, unknown> | null;
	isActive: boolean;
	verifiedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SendChannelMessageInput {
	hitlId: string;
	proposalId: string;
	sessionId: string;
	sessionDisplayName: string | null;
	decision: "continue" | "ask";
	prompt: string;
	why: string | null;
}

export interface ChannelDeliveryResult {
	ok: boolean;
	externalMessageId?: string;
	error?: string;
}

export interface NotificationChannelAdapter {
	readonly kind: NotificationChannelKind;
	/** Is this adapter ready to send/receive (env vars configured, etc.)? */
	isConfigured(): boolean;
	/** Send a HITL prompt with approve/decline actions. */
	send(
		channel: NotificationChannelRecord,
		input: SendChannelMessageInput,
	): Promise<ChannelDeliveryResult>;
}

/**
 * Callback data payload we embed in Telegram inline-keyboard buttons so
 * the webhook handler can resolve the right HITL request when a user
 * taps. Shape: `hitl:<hitlId>:<action>` — short because Telegram caps
 * callback_data at 64 bytes.
 */
export interface HitlCallbackData {
	hitlId: string;
	action: "approve" | "decline";
}

export function encodeHitlCallbackData(data: HitlCallbackData): string {
	return `hitl:${data.hitlId}:${data.action}`;
}

export function parseHitlCallbackData(raw: string): HitlCallbackData | null {
	if (!raw.startsWith("hitl:")) return null;
	const parts = raw.split(":");
	if (parts.length !== 3) return null;
	const action = parts[2];
	if (action !== "approve" && action !== "decline") return null;
	return { hitlId: parts[1], action };
}
