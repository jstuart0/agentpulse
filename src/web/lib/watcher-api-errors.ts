import { registerApiErrorMessages } from "./api-errors.js";

/**
 * The sentences for the watcher's refusals (approving, sending, configuring a
 * session's watcher or a Telegram channel). Imported for its effect by the
 * screens that can show them: the AI tab, the inbox, and the AI and Telegram
 * settings.
 */
registerApiErrorMessages({
	prompt_not_deliverable:
		"AgentPulse can't type into this session right now. Copy the prompt from the dashboard instead.",
	dispatch_blocked: "Blocked by the safety filter. Edit the prompt to send it.",
	prompt_unsafe:
		"That prompt has characters or a leading symbol AgentPulse won't type into a session. Edit it to send it.",
	stale_proposal: "This suggestion is out of date: the session has moved on.",
	expired: "This request expired.",
	prompt_changed: "The suggestion changed after you opened it. Reload and review it again.",
	not_approvable: "This suggestion contained hidden or unsafe characters; edit it to send.",
	already_resolved: "Someone already answered this.",
	ai_paused: "AI is paused, so nothing is sent.",
	empty_prompt: "There is no prompt to send.",
	prompt_too_long: "That prompt is too long to send from here. Shorten it.",
	human_required: "Sign in to the dashboard to do that. An API key can't.",
	detail_full_needs_private_chat:
		"Full detail isn't available for a group chat. Re-link the channel from a private chat first.",
	invalid_provider: "That provider no longer exists.",
	invalid_channel: "That channel can't be used for this session.",
	session_missing: "That session no longer exists.",
	launch_missing: "AgentPulse can't find how this session was launched.",
	dispatch_failed: "Something went wrong sending it. Nothing was sent.",
});
