/**
 * "Whose sessions is the dashboard showing", as one value and the few
 * functions that turn it into a request, a row test and a response check.
 * The value grammar is src/shared/owner-scope.ts's: `all`, `me`, `unassigned`,
 * `service`, or a user id.
 */
export type OwnerParam = string;

export const OWNER_ALL = "all";
export const OWNER_ME = "me";
export const OWNER_UNASSIGNED = "unassigned";
export const OWNER_SERVICE = "service";

/** What the dashboard is showing. Every request and every live update is built from this one value. */
export interface DashboardScope {
	owner: OwnerParam;
	excludeScratch: boolean;
	/** Which machine's sessions (see host-scope.ts); absent or empty is every machine. */
	host?: string;
}

export interface ScopeQuery {
	owner?: string;
	excludeScratch?: boolean;
	host?: string;
}

export interface OwnedSession {
	ownerUserId?: string | null;
	ownerKind?: "user" | "service" | "unassigned";
}

/**
 * Whether the row says anything about its owner. A server that predates
 * ownership sends neither field; such a row can't be judged by a filter, so
 * filters keep one they already show and let the next poll decide the rest.
 */
export function hasOwnerInfo(session: OwnedSession): boolean {
	return session.ownerUserId !== undefined || session.ownerKind !== undefined;
}

const KEYWORDS: ReadonlySet<string> = new Set([
	OWNER_ALL,
	OWNER_ME,
	OWNER_UNASSIGNED,
	OWNER_SERVICE,
]);

/** The user id when the scope is one specific person (not me, not a keyword). */
export function personOwnerId(owner: OwnerParam): string | null {
	return KEYWORDS.has(owner) ? null : owner;
}

/** The query parameters every list, stats and paging request carries for this scope: the owner, the scratch toggle and the machine. */
export function scopeQuery(scope: DashboardScope): ScopeQuery {
	const query: ScopeQuery = {};
	if (scope.owner !== OWNER_ALL) query.owner = scope.owner;
	if (scope.excludeScratch) query.excludeScratch = true;
	if (scope.host) query.host = scope.host;
	return query;
}

/** Whether a row belongs in the view for `owner`. The caller's id resolves `me`. */
export function matchesOwnerScope(
	session: OwnedSession,
	owner: OwnerParam,
	viewerUserId: string | null,
): boolean {
	if (owner === OWNER_ALL) return true;
	const rowOwner = session.ownerUserId ?? null;
	if (owner === OWNER_ME) return viewerUserId !== null && rowOwner === viewerUserId;
	if (owner === OWNER_SERVICE) return rowOwner === null && session.ownerKind === "service";
	if (owner === OWNER_UNASSIGNED) {
		return (
			rowOwner === null && (session.ownerKind === undefined || session.ownerKind === "unassigned")
		);
	}
	return rowOwner === owner;
}

/** The scope a response echoed, reduced to the grammar's own words; undefined when it can't be read. */
function canonicalEcho(echo: unknown, viewerUserId: string | null): string | undefined {
	if (echo === null) return OWNER_ALL;
	if (typeof echo === "string") return echo === OWNER_ME ? (viewerUserId ?? OWNER_ME) : echo;
	if (typeof echo !== "object") return undefined;
	const { kind, userId } = echo as { kind?: unknown; userId?: unknown };
	// `me` is echoed as `me` together with the id it resolved to; a person as `user`.
	if (kind === "user" || kind === "me" || (kind === undefined && typeof userId === "string")) {
		return typeof userId === "string" ? userId : kind === "me" ? OWNER_ME : undefined;
	}
	return typeof kind === "string" ? kind : undefined;
}

/**
 * Whether a response's echo of the scope it applied is the scope that was
 * asked for. No echo (an older server) is accepted; an echo that names a
 * different scope, or can't be read, is not.
 */
export function echoMatchesRequest(
	requested: OwnerParam,
	viewerUserId: string | null,
	echo: unknown,
): boolean {
	if (echo === undefined) return true;
	const applied = canonicalEcho(echo, viewerUserId);
	if (applied === undefined) return requested === OWNER_ALL;
	const wanted = requested === OWNER_ME ? (viewerUserId ?? OWNER_ME) : requested;
	return applied === wanted;
}

/** A response described a different set of sessions than the one asked for. */
export class ScopeMismatchError extends Error {
	constructor() {
		super("The server answered for a different set of sessions than the one asked for.");
		this.name = "ScopeMismatchError";
	}
}

/** Throws {@link ScopeMismatchError} unless the response's echo is the scope that was asked for. */
export function assertEchoMatches(
	requested: OwnerParam,
	viewerUserId: string | null,
	echo: unknown,
): void {
	if (!echoMatchesRequest(requested, viewerUserId, echo)) throw new ScopeMismatchError();
}
