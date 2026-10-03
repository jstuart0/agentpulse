/**
 * Owner-or-admin rules for team mode, in one place.
 *
 * The same operation is reachable through a route and, without one, through
 * the AI action-request executors; both call the functions here with the real
 * actor (the signed-in human, or the human who approved the action), so the
 * rule can't drift between them. In solo mode every owner-or-admin assertion
 * is a no-op: nothing about ownership is enforced there.
 *
 * Team mode:
 *  - A session (delete, archive, rename, pin): its owner or an admin. An
 *    unowned session stays open to any signed-in member.
 *  - A key or a host (revoke, rotate, view): its owner or an admin. One with
 *    no owner (a service key, a pre-existing host) is an admin's.
 *  - An actor with no user id (a Telegram chat, autonomous AI, a service key
 *    that isn't kept as an admin) is a member with no identity: refused on
 *    anything owned, and on an unowned session too (open to signed-in members,
 *    not to someone the instance doesn't know). A host credential has no role
 *    at all and is refused on everything.
 *
 * Host ownership gates rotate and revoke only, never who may launch on the host.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor, InstanceModeName } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, supervisors, users } from "../db/schema/index.js";
import { incrementIngestKeyBound } from "../routes/ingest-counters.js";
import { getMode } from "./instance-mode.js";
import { isOnServiceKeyList } from "./service-key-lists.js";
import { resolveSessionHost } from "./session-ownership.js";

/** What every surface says when owner-or-admin refuses someone. */
export const NOT_OWNER_MESSAGE = "Only the owner or an admin can do that.";

export class NotOwnerError extends Error {
	constructor(readonly resource: "session" | "key" | "host") {
		super(`Only the ${resource}'s owner or an admin can do that.`);
		this.name = "NotOwnerError";
	}
}

export class HostNotFoundError extends Error {
	constructor() {
		super("Supervisor not found");
		this.name = "HostNotFoundError";
	}
}

export class AdminRequiredError extends Error {
	constructor() {
		super("Only an admin can do that.");
		this.name = "AdminRequiredError";
	}
}

/**
 * May this caller clear a session's WAITING or ERROR (acknowledge it, or put
 * it back)? An unowned session accepts any caller; an owned one its owner,
 * and in team mode an admin through `adminOverride`. Auth disabled accepts
 * anyone. The REST routes and the hook path's UserAcknowledge branch both ask
 * this, so the two can't disagree; the hook path never passes an override (a
 * key carries no role on that path).
 */
export function mayClearAttention(input: {
	sessionOwnerUserId: string | null;
	callerUserId: string | null;
	authDisabled?: boolean;
	adminOverride?: boolean;
}): boolean {
	if (input.sessionOwnerUserId === null) return true;
	if (input.authDisabled) return true;
	if (input.callerUserId !== null && input.callerUserId === input.sessionOwnerUserId) return true;
	return input.adminOverride === true;
}

async function modeOf(actor: Actor): Promise<InstanceModeName> {
	return actor.mode ?? (await getMode());
}

function isOwnerOrAdmin(actor: Actor, ownerUserId: string | null, unownedIsOpen: boolean): boolean {
	if (actor.role === "none") return false;
	if (actor.role === "admin") return true;
	if (ownerUserId === null) return unownedIsOpen && actor.userId !== null;
	return actor.userId !== null && actor.userId === ownerUserId;
}

async function assertSessionOwnerOrAdmin(actor: Actor, sessionId: string): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	if (!isOwnerOrAdmin(actor, row.ownerUserId, true)) throw new NotOwnerError("session");
}

/**
 * Which of these sessions may the actor delete, archive, rename or pin? Solo:
 * all of them. One query for the whole list (a bulk request names many).
 */
export async function sessionIdsActorMayChange(
	actor: Actor,
	sessionIds: readonly string[],
): Promise<Set<string>> {
	if (sessionIds.length === 0 || (await modeOf(actor)) === "solo") return new Set(sessionIds);
	const rows = await getDb()
		.select({ sessionId: sessions.sessionId, ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(inArray(sessions.sessionId, [...sessionIds]));
	const allowed = new Set(sessionIds.filter((id) => !rows.some((row) => row.sessionId === id)));
	for (const row of rows) {
		if (isOwnerOrAdmin(actor, row.ownerUserId, true)) allowed.add(row.sessionId);
	}
	return allowed;
}

/** All of these sessions, or none: throws unless the actor may change every one of them. */
export async function assertCanChangeSessions(
	actor: Actor,
	sessionIds: readonly string[],
): Promise<void> {
	const allowed = await sessionIdsActorMayChange(actor, sessionIds);
	if (sessionIds.some((id) => !allowed.has(id))) throw new NotOwnerError("session");
}

export const assertCanDeleteSession = assertSessionOwnerOrAdmin;
export const assertCanArchiveSession = assertSessionOwnerOrAdmin;
export const assertCanRenameSession = assertSessionOwnerOrAdmin;
export const assertCanPinSession = assertSessionOwnerOrAdmin;
/** Notes and the stored CLAUDE.md (which feeds the owner's AI watcher context). */
export const assertCanEditSessionNotes = assertSessionOwnerOrAdmin;

async function assertKeyOwnerOrAdmin(actor: Actor, keyId: string): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	const [row] = await getDb()
		.select({ ownerUserId: apiKeys.ownerUserId })
		.from(apiKeys)
		.where(eq(apiKeys.id, keyId))
		.limit(1);
	if (!row) return;
	if (!isOwnerOrAdmin(actor, row.ownerUserId, false)) throw new NotOwnerError("key");
}

export const assertCanRevokeKey = assertKeyOwnerOrAdmin;
export const assertCanViewKey = assertKeyOwnerOrAdmin;

/** Rotate or revoke a host: its owner or an admin. Never consulted for launching on it. */
export async function assertCanManageHost(actor: Actor, supervisorId: string): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	const [row] = await getDb()
		.select({ ownerUserId: supervisors.ownerUserId })
		.from(supervisors)
		.where(eq(supervisors.id, supervisorId))
		.limit(1);
	if (!row) return;
	if (!isOwnerOrAdmin(actor, row.ownerUserId, false)) throw new NotOwnerError("host");
}

/**
 * Enrolling a host (minting an enrollment token) in team mode needs someone to
 * own the host: a caller with a user id, or an admin (a kept admin service
 * key, which has no user). An ownerless key that is not kept as an admin
 * service key is a plain member with no identity, so it can't. Solo is left
 * exactly as it was.
 */
export async function assertCanEnrollHost(actor: Actor): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	if (actor.userId === null && actor.role !== "admin") throw new AdminRequiredError();
}

/**
 * Issue an enrollment token scoped to an existing host (the enroll and rotate
 * routes). Registering with such a token re-keys the host, so in team mode the
 * host must exist, the actor must own it or be an admin, and a revoked host is
 * re-enrolled by an admin only. Solo is left exactly as it was.
 */
export async function assertCanIssueHostToken(actor: Actor, supervisorId: string): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	const [row] = await getDb()
		.select({ ownerUserId: supervisors.ownerUserId, enrollmentState: supervisors.enrollmentState })
		.from(supervisors)
		.where(eq(supervisors.id, supervisorId))
		.limit(1);
	if (!row) throw new HostNotFoundError();
	if (!isOwnerOrAdmin(actor, row.ownerUserId, false)) throw new NotOwnerError("host");
	if (row.enrollmentState === "revoked" && actor.role !== "admin") throw new AdminRequiredError();
}

/**
 * Registering with a host-scoped token, checked again at the moment of use: a
 * token minted before the host changed hands, was revoked, or before its
 * creator was demoted or disabled must not re-key the host. A token with no
 * creator (minted by a key that has no owner) can't be re-judged here; it was
 * judged when minted. Solo is left as it was.
 */
export async function isHostTokenCreatorStillAllowed(input: {
	createdByUserId: string | null;
	hostId: string;
}): Promise<boolean> {
	if ((await getMode()) === "solo") return true;
	if (input.createdByUserId === null) return true;
	const db = getDb();
	const [user] = await db
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, input.createdByUserId))
		.limit(1);
	if (!user || user.disabledAt !== null) return false;
	const [host] = await db
		.select({ ownerUserId: supervisors.ownerUserId, enrollmentState: supervisors.enrollmentState })
		.from(supervisors)
		.where(eq(supervisors.id, input.hostId))
		.limit(1);
	if (!host) return false;
	if (user.role === "admin") return true;
	return host.enrollmentState !== "revoked" && host.ownerUserId === input.createdByUserId;
}

/**
 * The actor is an admin. Strict in both modes: it guards operations that are
 * new (nothing in solo to preserve), unlike the owner-or-admin assertions
 * above, which leave solo exactly as it was.
 */
export function assertAdmin(actor: Actor): void {
	if (actor.role !== "admin") throw new AdminRequiredError();
}

/** What a hook-path write says about who posted it: the posting key's owner and the key itself. */
export interface WriteAttribution {
	ownerUserId: string | null;
	ingestKeyId: string | null;
}

/** The facts about the target session the hook rule needs. */
export interface HookTargetSession {
	sessionId: string;
	ownerUserId: string | null;
	ingestKeyId: string | null;
}

/**
 * What the hook rule decided for a write. `bindKeyId` is set when the write is
 * accepted only on condition that this key becomes the session's ingest key;
 * the caller binds it with {@link bindIngestKey} once it knows the write
 * will actually be applied.
 */
export type ForeignKeyVerdict = { drop: true } | { drop: false; bindKeyId: string | null };

const ACCEPT: ForeignKeyVerdict = { drop: false, bindKeyId: null };
const DROP: ForeignKeyVerdict = { drop: true };

/**
 * Records `keyId` as the session's ingest key if nothing is recorded yet.
 * Guarded in SQL, so of two service keys racing for the same session exactly
 * one binds; the loser is accepted only if the winner was itself.
 */
export async function bindIngestKey(sessionId: string, keyId: string): Promise<boolean> {
	const db = getDb();
	const bound = await db
		.update(sessions)
		.set({ ingestKeyId: keyId })
		.where(and(eq(sessions.sessionId, sessionId), isNull(sessions.ingestKeyId)))
		.returning({ id: sessions.id });
	if (bound.length > 0) {
		incrementIngestKeyBound();
		return true;
	}
	const [row] = await db
		.select({ ingestKeyId: sessions.ingestKeyId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row?.ingestKeyId === keyId;
}

/**
 * Applies the binding a verdict asks for, if any. False means the write must
 * be dropped after all (another key bound first).
 */
export async function commitForeignKeyVerdict(
	sessionId: string,
	verdict: ForeignKeyVerdict,
): Promise<boolean> {
	if (verdict.drop) return false;
	if (verdict.bindKeyId === null) return true;
	return bindIngestKey(sessionId, verdict.bindKeyId);
}

/**
 * Should a hook event, status update or native-name write be dropped because
 * the posting key is foreign to an owned session? Team mode only; solo accepts
 * everything as before, and an unowned session accepts any key.
 *
 * For an owned session, accepted when any holds:
 *  (a) the posting key's owner is the session's owner;
 *  (b) the posting key is the session's recorded ingest key;
 *  (c) the session has a host of record (a managed row, or the supervisor that
 *      claimed its launch) and the posting key's owner is that host's owner;
 *  (d) the session has a host of record and no recorded ingest key, and the
 *      posting key is an ownerless service key (on the kept-admin list or the
 *      plain service-key list; minting with service:true lists it): accepted on condition the
 *      key is recorded as the session's ingest key (the owner is unchanged).
 *
 * Any other ownerless key (a shared key from before the switch, the default
 * key) is dropped: it can't attach to a session an admin claimed for someone,
 * or race the host's real key on a fresh launch.
 *
 * (a) and (b) are in memory, so the steady state (the owner's own keys) adds
 * no statement; only a foreign-looking key reads the mode, and (c) and (d) the
 * host lookup. The two lists (one statement) are read only when (d) is reached.
 * Nothing is written here: the caller commits the verdict once the write is
 * certain to be applied.
 */
export async function judgeForeignKeyWrite(
	session: HookTargetSession,
	posting: WriteAttribution,
): Promise<ForeignKeyVerdict> {
	if (session.ownerUserId === null) return ACCEPT;
	if (posting.ownerUserId === session.ownerUserId) return ACCEPT;
	if (posting.ingestKeyId !== null && posting.ingestKeyId === session.ingestKeyId) return ACCEPT;
	if ((await getMode()) !== "team") return ACCEPT;

	if (posting.ownerUserId === null) {
		if (session.ingestKeyId !== null || posting.ingestKeyId === null) return DROP;
		if ((await resolveSessionHost(session.sessionId)) === null) return DROP;
		if (!(await isOnServiceKeyList(posting.ingestKeyId))) return DROP;
		return { drop: false, bindKeyId: posting.ingestKeyId };
	}
	const host = await resolveSessionHost(session.sessionId);
	return host !== null && host.ownerUserId === posting.ownerUserId ? ACCEPT : DROP;
}

/**
 * May this poster's first event create the session for a pending launch (and
 * be recorded as its ingest key)? Team mode: the requester's keys, the keys of
 * the owner of the launch's target host, and service keys. A write with no key
 * context (auth disabled, which is never team mode) and solo are unchanged.
 * Reads the mode only for a real key that isn't the requester's.
 */
export async function mayCreateSessionForPendingLaunch(
	launch: {
		requestedByUserId: string | null;
		claimedBySupervisorId: string | null;
		requestedSupervisorId: string | null;
	},
	posting: WriteAttribution,
): Promise<boolean> {
	if (posting.ingestKeyId === null) return true;
	if (posting.ownerUserId !== null && posting.ownerUserId === launch.requestedByUserId) return true;
	if ((await getMode()) !== "team") return true;

	if (posting.ownerUserId === null) return isOnServiceKeyList(posting.ingestKeyId);
	const hostId = launch.claimedBySupervisorId ?? launch.requestedSupervisorId;
	if (hostId === null) return false;
	const [host] = await getDb()
		.select({ ownerUserId: supervisors.ownerUserId })
		.from(supervisors)
		.where(eq(supervisors.id, hostId))
		.limit(1);
	return host?.ownerUserId === posting.ownerUserId;
}
