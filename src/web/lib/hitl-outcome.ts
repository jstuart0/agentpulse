import { describeApiError, plainErrorMessage } from "./api-errors.js";
import { ApiError, type DeliveryOutcome } from "./api.js";

/** The refusals only answering a HITL request can meet. Kept out of the shared table: only the inbox and the AI panel read it. */
const HITL_MESSAGES: Record<string, string> = {
	already_resolved: "Someone already answered this. The list has been refreshed.",
	prompt_changed: "The agent changed its proposal while you were looking. Review the new one.",
	control_busy: "That session is busy with another action. Try again in a moment.",
	empty_prompt: "There's no prompt to send.",
	prompt_hash_required: "This key can only approve the exact prompt it was shown.",
	expired: "This request has expired. Wait for the agent to ask again.",
	not_awaiting: "This request isn't waiting for an answer any more.",
	confirm_required:
		"The first attempt may have run. Confirm to send it again, knowing it could run twice.",
	not_failed: "That attempt hasn't failed, so there's nothing to retry.",
	not_retryable: "That can't be retried.",
	retry_conflict: "Someone else just retried this. The list has been refreshed.",
	filter_blocked: "The safety filter blocked that prompt.",
	invalid_action: "That isn't something the server can do.",
	invalid_ids: "Too many items at once. Try fewer.",
};

/** A refusal to a decision in plain words: the HITL table first, then the shared one, then the caller's fallback. */
export function describeHitlError(err: unknown, fallback: string): string {
	if (err instanceof ApiError && err.code && Object.hasOwn(HITL_MESSAGES, err.code)) {
		return HITL_MESSAGES[err.code] as string;
	}
	return describeApiError(err, fallback);
}

/** Like plainErrorMessage, with the HITL sentences. */
export function plainHitlErrorMessage(err: unknown): string {
	const known = describeHitlError(err, "");
	return known || plainErrorMessage(err);
}

/** A 409 or 404 on a decision: the item on screen is no longer what the server has, so reload the list. */
export function isStaleItemError(err: unknown): boolean {
	return err instanceof ApiError && (err.status === 409 || err.status === 404);
}

const BLOCKED_REASONS: Record<string, string> = {
	supervisor_offline: "the agent's machine is offline",
	launch_mismatch: "AgentPulse can't match this session to the launch that started it",
	launch_not_found: "AgentPulse can't find the launch that started this session",
	filter: "the safety filter blocked the prompt",
};

/** One sentence for what happened to an approved prompt, in the dashboard's voice. */
export function describeDelivery(delivery: DeliveryOutcome | null | undefined): string | null {
	if (!delivery) return null;
	switch (delivery.state) {
		case "queued":
			return "Approved. The prompt is queued for the agent's machine.";
		case "running":
			return "Approved. The agent's machine is picking the prompt up.";
		case "succeeded":
			return "Approved. The prompt was sent to the agent.";
		case "failed":
			return "Approved, but the agent's machine couldn't take the prompt.";
		case "unknown":
			return "Approved, but the agent's machine never confirmed. The prompt may or may not have run.";
		case "not_managed":
			return "Approved. This session isn't managed by AgentPulse, so nothing was sent.";
		case "blocked": {
			const why =
				(delivery.reason &&
					Object.hasOwn(BLOCKED_REASONS, delivery.reason) &&
					BLOCKED_REASONS[delivery.reason]) ||
				"it couldn't be sent";
			return `Approved, but nothing was sent: ${why}.`;
		}
	}
}
