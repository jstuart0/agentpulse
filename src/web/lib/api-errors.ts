import { ApiError } from "./api.js";

/**
 * Plain sentences for the refusals the server can send. One table, so a
 * refusal reads the same wherever it surfaces (toast, inline, dialog).
 */
const MESSAGES: Record<string, string> = {
	not_owner: "Only the owner or an admin can do that.",
	admin_required: "Only admins can do that.",
	human_admin_required: "This needs an admin signed in to the dashboard, not an API key.",
	password_change_required: "Choose a new password first.",
	bad_origin:
		"This address isn't allowed to make admin changes. Set PUBLIC_URL to the address you use to open AgentPulse.",
	last_admin: "The only admin can't be demoted or disabled. Make someone else an admin first.",
	role_locked_by_env:
		"Admin role is set by AGENTPULSE_ADMIN_SSO_SUBJECTS and can't be changed here.",
	mode_locked_by_env: "The mode is set by AGENTPULSE_MODE and can't be changed here.",
	service_keys_undecided: "A key was added while this was open.",
	team_requires_auth: "Team mode needs sign-in. Unset DISABLE_AUTH to use it.",
	user_disabled: "That account is disabled.",
	user_not_found: "That person no longer exists.",
	username_taken: "That username is taken.",
	not_local_account: "Only local accounts have a password to reset.",
	key_has_owner: "A key with an owner can't be an admin service key.",
	key_not_manage: "Only a key that can manage can be kept as an admin service key.",
	insufficient_scope: "This key doesn't have permission to do that.",
	busy: "The server is busy. Try again in a moment.",
	key_not_user_settable: "That setting can't be changed here.",
};

const RATE_LIMITED = "Too many requests. Wait a moment and try again.";
const PASSWORD_REFUSED = "password_complexity_failed";

export function apiErrorCode(err: unknown): string | null {
	return err instanceof ApiError ? err.code : null;
}

export function isPasswordChangeRequired(err: unknown): boolean {
	return apiErrorCode(err) === "password_change_required";
}

/**
 * What to tell a person about a failed request. A known refusal gets its
 * plain sentence; anything else (an unknown code, a network failure) gets the
 * caller's own sentence, never the raw code or a stack.
 */
export function describeApiError(err: unknown, fallback: string): string {
	if (!(err instanceof ApiError)) return fallback;
	if (err.code === PASSWORD_REFUSED) {
		const reason = (err.body as { reason?: unknown } | null)?.reason;
		if (typeof reason === "string" && reason) return reason;
	}
	if (err.code && Object.hasOwn(MESSAGES, err.code)) return MESSAGES[err.code];
	if (err.status === 429) return RATE_LIMITED;
	return fallback;
}

/**
 * For surfaces that used to print `String(err)`: a known refusal in plain words,
 * else the error's own message (the server's text for an ApiError), never the
 * "ApiError: code" a bare String() gives.
 */
export function plainErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return describeApiError(err, message);
}

/** Why a key couldn't be created: the rate limit gets its own sentence, never "couldn't load keys". */
export function keyCreationErrorMessage(err: unknown): string {
	if (err instanceof ApiError && err.status === 429) {
		return "Too many keys created. Wait a minute and try again.";
	}
	return describeApiError(err, "Couldn't create the key. Try again.");
}

const KEY_GONE_MESSAGE = "That key isn't there any more, or it isn't yours to revoke.";

export interface RevokeKeyFailure {
	message: string;
	/** The key isn't there for this viewer any more: the list on screen is out of date and should be reloaded. */
	stale: boolean;
}

/** Why a key couldn't be revoked. A 404 means this tab's list is stale (the key is gone, or isn't the viewer's). */
export function revokeKeyFailure(err: unknown): RevokeKeyFailure {
	if (err instanceof ApiError && err.status === 404) {
		return { message: KEY_GONE_MESSAGE, stale: true };
	}
	return { message: describeApiError(err, "Couldn't revoke the key. Try again."), stale: false };
}

/** The server says the AI features aren't available (404 `ai_disabled`): not compiled in, or switched off. Asking again won't change that until the page reloads. */
export function isAiDisabledError(err: unknown): boolean {
	return err instanceof ApiError && err.status === 404 && err.code === "ai_disabled";
}
