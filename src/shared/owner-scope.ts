/**
 * The `owner` query grammar shared by the server, the dashboard and the MCP
 * package, so one parser decides what a value means.
 *
 *   (absent) | all   everyone's sessions
 *   me               the caller's own (needs a caller with a user id)
 *   <user id>        one user's
 *   unassigned       no owner and no recorded ingest key
 *   service          no owner, reported by a key
 */

export const OWNER_KEYWORDS = ["all", "me", "unassigned", "service"] as const;

export type ParsedOwnerParam =
	| { kind: "all" }
	| { kind: "me" }
	| { kind: "unassigned" }
	| { kind: "service" }
	| { kind: "user"; userId: string };

/** What a query actually filters on once `me` has been resolved to an id. */
export type OwnerScope =
	| { kind: "user"; userId: string }
	| { kind: "unassigned" }
	| { kind: "service" };

// User ids are generated UUIDs; anything else is a typo, not an unknown user.
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Null when the value isn't in the grammar. An empty or absent value means everyone. */
export function parseOwnerParam(raw: string | null | undefined): ParsedOwnerParam | null {
	if (raw === undefined || raw === null || raw === "") return { kind: "all" };
	if (raw === "all" || raw === "me" || raw === "unassigned" || raw === "service") {
		return { kind: raw };
	}
	// Ids are generated lowercase; an uppercase spelling means the same user.
	if (USER_ID_PATTERN.test(raw)) return { kind: "user", userId: raw.toLowerCase() };
	return null;
}

/**
 * The scope a response says it applied. `me` is echoed as `me` WITH the user id
 * it resolved to, so a client can tell "my sessions" from "everyone's" without
 * trusting that the server understood the parameter; an absent scope is `all`.
 */
export interface OwnerScopeEcho {
	kind: "all" | "me" | "user" | "unassigned" | "service";
	userId?: string;
}

/** The echo for a request's parsed `owner` value and the scope it resolved to. */
export function ownerScopeEcho(
	parsed: ParsedOwnerParam,
	scope: OwnerScope | undefined,
): OwnerScopeEcho {
	if (scope === undefined) return { kind: "all" };
	if (scope.kind === "user") {
		return { kind: parsed.kind === "me" ? "me" : "user", userId: scope.userId };
	}
	return { kind: scope.kind };
}

/**
 * Resolve a parsed value for a caller. `all` yields no scope; `me` with no
 * caller id yields null so the caller can refuse instead of listing everyone.
 */
export function resolveOwnerScope(
	parsed: ParsedOwnerParam,
	callerUserId: string | null | undefined,
): OwnerScope | undefined | null {
	switch (parsed.kind) {
		case "all":
			return undefined;
		case "me":
			return callerUserId ? { kind: "user", userId: callerUserId } : null;
		default:
			return parsed;
	}
}
