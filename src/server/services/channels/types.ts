/**
 * Notification channel abstraction. Every adapter (Telegram, webhook,
 * email, ...) implements this interface so the runner and HITL service
 * can deliver prompts through any enrolled channel without knowing the
 * underlying transport.
 */

import type {
	DecisionKind,
	NotificationChannelKind,
	WatcherReportVerdict,
} from "../../../shared/types.js";

export {
	KNOWN_NOTIFICATION_CHANNEL_KINDS,
	type NotificationChannelKind,
} from "../../../shared/types.js";

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
	// Narrow of DecisionKind — keeps this constrained to the two
	// decisions that map to outbound HITL prompts. Compile-time guard
	// against a future decision-kind addition silently widening this.
	decision: Extract<DecisionKind, "continue" | "ask">;
	prompt: string;
	why: string | null;
	/** True only when AgentPulse can type a prompt into this session (it launched it, the host is connected). */
	deliverable: boolean;
	/** True only when the stored suggestion is exactly what would be sent (the sanitiser changed nothing in it). */
	approvable: boolean;
	/** Hash of the prompt a person approves; the button exists only while the text shown still has this hash. */
	promptSha256: string | null;
	/** `minimal` carries no prompt text and no Approve button; `full` carries the redacted text. */
	detail: "minimal" | "full";
	/** The session's working directory, shown as `<repo>` in the message. */
	sessionCwd?: string | null;
}

/** A Notify report on its way to a channel. */
export interface SendChannelReportInput {
	sessionId: string;
	sessionLabel: string | null;
	verdict: WatcherReportVerdict;
	/** The model's note. Sent only at `full` detail. */
	why: string;
	/** A link to the session, only when the instance has an explicit public address. */
	dashboardUrl: string | null;
	detail: "minimal" | "full";
	sessionCwd?: string | null;
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
	/** Send a Notify report. Optional: an adapter without it can't deliver reports. */
	sendReport?(
		channel: NotificationChannelRecord,
		input: SendChannelReportInput,
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

/**
 * Callback data for ai_action_requests inline buttons.
 * Shape: `act:<action>:<id>` — `<id>` is a UUID (may contain hyphens
 * but no colons) so splitting on ":" with index 1 and 2 is safe here;
 * we join remaining parts in case the id ever changes format.
 */
export interface ActionCallbackData {
	actionRequestId: string;
	action: "approve" | "decline";
}

export function encodeActionCallbackData(data: ActionCallbackData): string {
	return `act:${data.action}:${data.actionRequestId}`;
}

export function parseActionCallbackData(raw: string): ActionCallbackData | null {
	if (!raw.startsWith("act:")) return null;
	// act:<action>:<uuid>
	const withoutPrefix = raw.slice("act:".length);
	const colonIdx = withoutPrefix.indexOf(":");
	if (colonIdx === -1) return null;
	const action = withoutPrefix.slice(0, colonIdx);
	if (action !== "approve" && action !== "decline") return null;
	const actionRequestId = withoutPrefix.slice(colonIdx + 1);
	if (!actionRequestId) return null;
	return { actionRequestId, action };
}
