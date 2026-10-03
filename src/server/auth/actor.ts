/**
 * The real caller behind a request that writes requested_by_user_id /
 * resolved_by_user_id. Every service function that writes one of those
 * columns takes an Actor instead of hardcoding a placeholder label,
 * so DISABLE_AUTH, an API key, and a real user are each recorded honestly.
 */
import type { AuthUser } from "./middleware.js";

export type ActorLabel =
	| "user"
	| "api_key"
	| "supervisor"
	| "ai"
	| "telegram"
	| "anonymous"
	| "system";

/**
 * The caller's authority over team-owned things: `admin` (a signed-in admin,
 * an owned key whose owner is one, an ownerless manage key where that counts
 * as admin), `member` (everyone else who is signed in or holds a key) and
 * `none` (a host credential: neither, ever).
 */
export type EffectiveRole = "admin" | "member" | "none";

export type InstanceModeName = "solo" | "team";

export interface Actor {
	/** users.id for a local or SSO caller, or an owned key's owner. Null otherwise. */
	userId: string | null;
	/** The legacy actor-label column's value. */
	label: ActorLabel;
	/**
	 * The caller's effective role, resolved once for the request. Absent for
	 * an actor that was never a request (autonomous AI, a Telegram chat,
	 * system work): authorization treats an absent role as a member with no
	 * user id.
	 */
	role?: EffectiveRole;
	/** The instance mode the role was resolved under; absent means "look it up". */
	mode?: InstanceModeName;
}

/** The DISABLE_AUTH / no-caller actor — never a user, always "anonymous". */
export const ANONYMOUS_ACTOR: Actor = { userId: null, label: "anonymous" };

/**
 * Derive the acting user from an already-resolved AuthUser (c.get("authUser")).
 * DISABLE_AUTH's synthetic "anonymous" api_key caller maps to the anonymous
 * actor, not to "api_key" — it isn't a real key.
 */
export function actorFromAuthUser(authUser: AuthUser | null | undefined): Actor {
	if (!authUser) return ANONYMOUS_ACTOR;
	if (authUser.source === "api_key") {
		if (authUser.id === "anonymous") return ANONYMOUS_ACTOR;
		if (authUser.isSupervisorCredential) return { userId: null, label: "supervisor" };
		return { userId: authUser.userId, label: "api_key" };
	}
	// forwardauth or local: a real cookie/header-resolved user.
	return { userId: authUser.userId, label: "user" };
}

/**
 * A Telegram chat acting on its own behalf: a member with no identity. It is
 * never given a user id, a role or a mode: in team mode it is refused every
 * owner-or-admin operation (on an unowned session too), because a chat is not a
 * person the instance knows. Every Telegram call site passes this one value.
 */
export const TELEGRAM_ACTOR: Actor = { userId: null, label: "telegram" };
