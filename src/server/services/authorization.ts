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
 * Host ownership gates rotate and revoke only, never who may launch on the host. A takeover (binding an
 * observed session to a host) isn't a launch: it has its own rules below (`mayBindSession`,
 * `mayBindToHost`), stricter than both.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor, InstanceModeName } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	apiKeys,
	controlActions,
	managedSessions,
	sessions,
	supervisors,
	users,
} from "../db/schema/index.js";
import { incrementIngestKeyBound } from "../routes/ingest-counters.js";
import { BindRefusal } from "./bind-refusal.js";
import { getMode } from "./instance-mode.js";
import { isOnServiceKeyList } from "./service-key-lists.js";
import { resolveSessionOwner } from "./session-ownership.js";
import { resolveSessionHost } from "./session-ownership.js";

/** What every surface says when owner-or-admin refuses someone. */
export const NOT_OWNER_MESSAGE = "Only the owner or an admin can do that.";

export class NotOwnerError extends Error {
	constructor(readonly resource: "session" | "key" | "host" | "channel" | "device") {
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

/**
 * May this actor see this session through a live, per-viewer channel (the
 * mobile WebSocket profile, push targeting, the inbox)? Solo: always. Team: the
 * session's owner, an admin, or any identified member for an unowned session.
 *
 * Fails closed: a host credential (role `none`) reads nothing; an actor whose
 * mode is unknown is judged as in team mode; a session row with no owner field
 * at all (as opposed to a null owner, "unowned") is readable only by an admin.
 *
 * This is the only definition: the REST routes keep their "team mode shares
 * every read" rule, and everything that filters per viewer asks here. Note that
 * a key owned by an admin resolves to admin (see resolveEffectiveRole), so it
 * reads every session whatever its scope.
 */
export function canReadSession(actor: Actor, session: { ownerUserId?: string | null }): boolean {
	if (actor.role === "none") return false;
	if (actor.mode === "solo") return true;
	// A row with no owner field is not "unowned" (null): only an admin reads it.
	if (session.ownerUserId === undefined) return actor.role === "admin";
	return isOwnerOrAdmin(actor, session.ownerUserId, true);
}

/**
 * Who a session's live events are for, as user ids: `"all"` when ownership
 * doesn't narrow it (solo, or an unowned session), else its owner. Admins read
 * every session (canReadSession) but aren't enumerable from the session row, so
 * a consumer that fans out per user adds them itself. A row with no owner field
 * is for nobody; an unknown mode is judged as team.
 */
export function sessionAudience(
	session: { ownerUserId?: string | null },
	mode: InstanceModeName,
): readonly string[] | "all" {
	if (mode === "solo") return "all";
	if (session.ownerUserId === undefined) return [];
	return session.ownerUserId === null ? "all" : [session.ownerUserId];
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

/**
 * While a takeover of this session is open its rows are half made: deleting or archiving it now would pull
 * the session out from under the host that is resuming it. Judged ahead of solo's no-op, because a takeover
 * is a takeover in solo too. Only a takeover counts; recovery of a degraded session changes no ownership.
 */
async function assertNoOpenTakeover(sessionId: string): Promise<void> {
	const open = await getDb()
		.select({ metadata: controlActions.metadata })
		.from(controlActions)
		.where(
			and(
				eq(controlActions.sessionId, sessionId),
				eq(controlActions.actionType, "resume"),
				inArray(controlActions.status, ["queued", "running"]),
			),
		);
	const takeover = open.some(
		(row) => (row.metadata as Record<string, unknown> | null)?.resumeKind === "takeover",
	);
	if (takeover) throw new BindRefusal("takeover_in_progress");
}

/**
 * A taken-over Claude session (a fork) that may still have a process is ended before it is deleted or
 * archived (AGEN-117 T17): `pending`, `managed` and `degraded` all can (a degraded one may have a child an
 * approved command is still finishing, and only its host can say). A host that is gone lifts the refusal:
 * nothing can confirm and no prompt can reach it. An offline host keeps it. Judged ahead of solo's no-op.
 */
async function assertNoLiveFork(sessionId: string): Promise<void> {
	const [row] = await getDb()
		.select({ managedState: managedSessions.managedState, metadata: sessions.metadata })
		.from(managedSessions)
		.innerJoin(sessions, eq(sessions.sessionId, managedSessions.sessionId))
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	if (!(row.metadata as Record<string, unknown> | null)?.forkedFromSessionId) return;
	if (!["pending", "managed", "degraded"].includes(row.managedState)) return;
	// The owner of record, by the one resolver; no owner or a revoked host is a host that is gone.
	const hostId = await resolveSessionOwner(getDb(), sessionId);
	if (hostId !== null) {
		const [host] = await getDb()
			.select({ enrollmentState: supervisors.enrollmentState })
			.from(supervisors)
			.where(eq(supervisors.id, hostId))
			.limit(1);
		if (host && host.enrollmentState !== "revoked") throw new BindRefusal("end_session_first");
	}
}

/** Delete: the owner or an admin (team), never while a takeover of it is open, and a live fork is ended first. */
export async function assertCanDeleteSession(actor: Actor, sessionId: string): Promise<void> {
	await assertSessionOwnerOrAdmin(actor, sessionId);
	await assertNoOpenTakeover(sessionId);
	await assertNoLiveFork(sessionId);
}

/** Archive: the same rule as delete. */
export async function assertCanArchiveSession(actor: Actor, sessionId: string): Promise<void> {
	await assertSessionOwnerOrAdmin(actor, sessionId);
	await assertNoOpenTakeover(sessionId);
	await assertNoLiveFork(sessionId);
}
export const assertCanRenameSession = assertSessionOwnerOrAdmin;
export const assertCanPinSession = assertSessionOwnerOrAdmin;
/** Notes and the stored CLAUDE.md (which feeds the owner's AI watcher context). */
export const assertCanEditSessionNotes = assertSessionOwnerOrAdmin;
/** Configure or remove a session's watcher. Solo: everyone. Team: the session's owner or an admin. */
export const assertCanConfigureWatcher = assertSessionOwnerOrAdmin;
/** Approve, decline or edit a watcher proposal on a session. Same rule as configuring it. */
export const assertCanDecideProposal = assertSessionOwnerOrAdmin;

/**
 * May this actor take this session over (bind it to a host so the host can run it)? The pure rule, strict
 * like `mayAnswerApproval` and unlike the aliases above:
 *  - Solo: allowed.
 *  - Team: a host credential (role `none`) never; an admin always; a missing session, nobody else.
 *  - An unowned session: an admin's alone. Every identified member may already prompt and stop an unowned
 *    session, and a takeover captures the conversation and its directory on a host.
 *  - An owned session: its owner.
 */
export function mayBindSession(
	actor: Actor,
	mode: InstanceModeName,
	session: { ownerUserId: string | null } | null,
): boolean {
	if (mode === "solo") return true;
	if (actor.role === "none") return false;
	if (actor.role === "admin") return true;
	if (session === null || session.ownerUserId === null) return false;
	return actor.userId !== null && actor.userId === session.ownerUserId;
}

/**
 * Throws `BindRefusal` unless the actor may take this session over. A session that doesn't exist, or one the
 * actor couldn't read at all, is `session_not_found` (the answer for a missing one, so a refusal says nothing
 * about existence); an unowned session a member can read but can't take over is `not_owner`. Reads only the
 * session, so a refusal performs no host read.
 */
export async function assertCanBindSession(actor: Actor, sessionId: string): Promise<void> {
	const mode = await modeOf(actor);
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const refusal = refuseBindSession(
		actor,
		mode,
		row ? { ownerUserId: row.ownerUserId ?? null } : null,
	);
	if (refusal !== null) throw new BindRefusal(refusal);
}

/**
 * The verdict behind `assertCanBindSession`, for a caller that already holds the session row (the binding
 * service re-judges it inside its lock): null to carry on, else the code to refuse with.
 */
export function refuseBindSession(
	actor: Actor,
	mode: InstanceModeName,
	session: { ownerUserId: string | null } | null,
): "session_not_found" | "not_owner" | null {
	if (session === null) return "session_not_found";
	if (mode === "solo") return null;
	if (!canReadSession(actor, session)) return "session_not_found";
	return mayBindSession(actor, mode, session) ? null : "not_owner";
}

export type HostBindVerdict = "host_gone" | "host_not_allowed" | "host_owner_mismatch";

/**
 * May this actor take a session (owned by `sessionOwnerUserId`) over onto this host? The pure rule;
 * null means yes. Authority over the host is separate from authority over the session:
 *  - Solo: any existing host.
 *  - A host credential: never.
 *  - A member: a host they own. A foreign, an unowned and a missing host are all the same `host_not_allowed`,
 *    so the answer is no oracle for which hosts exist.
 *  - An admin: any existing host; a missing or revoked one is `host_gone`.
 *  - Two different non-null owners are refused for everyone, an admin included (`host_owner_mismatch`): the
 *    host's owner would gain read and write on a session that isn't theirs. An admin who means it changes
 *    the session's owner first, which is on the record.
 */
export function mayBindToHost(
	actor: Actor,
	mode: InstanceModeName,
	sessionOwnerUserId: string | null,
	host: { ownerUserId: string | null; enrollmentState?: string | null } | null,
): HostBindVerdict | null {
	const gone = host === null || host.enrollmentState === "revoked";
	if (mode === "solo") return gone ? "host_gone" : null;
	if (actor.role === "none") return "host_not_allowed";
	if (actor.role !== "admin") {
		if (host === null || actor.userId === null || host.ownerUserId !== actor.userId) {
			return "host_not_allowed";
		}
	}
	if (host === null || gone) return "host_gone";
	if (
		sessionOwnerUserId !== null &&
		host.ownerUserId !== null &&
		sessionOwnerUserId !== host.ownerUserId
	) {
		return "host_owner_mismatch";
	}
	return null;
}

/**
 * May this actor start a fork's options (MCP servers, subagents) on this host? Those run the person's own
 * configuration on the machine, so only the machine's owner may ask for them (AGEN-119..123, C-H4, F53):
 *  - Solo: yes.
 *  - Team: only a signed-in actor who owns the host. An admin is refused on a host someone else owns, and
 *    anyone is refused on a host nobody owns. Null means yes.
 * A bind that asks for no option never calls this.
 */
export function mayUseForkOptionsOnHost(
	actor: Actor,
	mode: InstanceModeName,
	host: { ownerUserId: string | null } | null,
): "fork_options_host_not_yours" | null {
	if (mode === "solo") return null;
	if (actor.userId === null || host === null || host.ownerUserId !== actor.userId) {
		return "fork_options_host_not_yours";
	}
	return null;
}

/**
 * Throws `BindRefusal` unless the actor may use this host for a takeover (see `mayBindToHost`). Recovery of a
 * managed session doesn't call it: the host is the launch's own.
 */
export async function assertCanTargetHost(
	actor: Actor,
	sessionOwnerUserId: string | null,
	supervisorId: string,
): Promise<void> {
	const mode = await modeOf(actor);
	const [host] = await getDb()
		.select({ ownerUserId: supervisors.ownerUserId, enrollmentState: supervisors.enrollmentState })
		.from(supervisors)
		.where(eq(supervisors.id, supervisorId))
		.limit(1);
	const verdict = mayBindToHost(
		actor,
		mode,
		sessionOwnerUserId,
		host ? { ownerUserId: host.ownerUserId ?? null, enrollmentState: host.enrollmentState } : null,
	);
	if (verdict !== null) throw new BindRefusal(verdict);
}

/**
 * May this actor answer a Codex approval on this session? The pure rule, for a
 * caller that already has the session's owner (the approvals list computes
 * `viewer.canAccept` from it).
 *
 * Strict, unlike the alias above: a session the server can't find gives a
 * non-admin nothing (so existence isn't revealed), and an unowned session is
 * not open to everyone for an accept.
 *  - Solo: allowed.
 *  - Team: a host credential (role `none`) never; an admin always; a missing
 *    session, nobody else.
 *  - An unowned session: accept is an admin's alone; a decline or a cancel is
 *    open to any identified member (a decline can only stop a command).
 *  - An owned session: its owner (or an admin).
 */
export function mayAnswerApproval(
	actor: Actor,
	mode: InstanceModeName,
	session: { ownerUserId: string | null } | null,
	decision: "accept" | "decline" | "cancel",
): boolean {
	if (mode === "solo") return true;
	if (actor.role === "none") return false;
	if (actor.role === "admin") return true;
	if (session === null) return false;
	if (session.ownerUserId === null) return decision !== "accept" && actor.userId !== null;
	return actor.userId !== null && actor.userId === session.ownerUserId;
}

/**
 * May this actor read what a fork's tool calls ran (AGEN-123, F21)? The pure rule; the caller has already
 * required a signed-in person (an API key of any scope is refused `human_required` before this runs).
 *  - Solo: allowed.
 *  - Team: a host credential (role `none`) never; an admin always; a missing session, nobody else; an
 *    unowned session is an admin's alone (unlike an accept's decline, there is nothing safe about reading
 *    it); an owned session its owner.
 */
export function mayReadToolDetail(
	actor: Actor,
	mode: InstanceModeName,
	session: { ownerUserId: string | null } | null,
): boolean {
	if (mode === "solo") return true;
	if (actor.role === "none") return false;
	if (actor.role === "admin") return true;
	if (session === null || session.ownerUserId === null) return false;
	return actor.userId !== null && actor.userId === session.ownerUserId;
}

/**
 * Throws `NotOwnerError` unless the actor may answer an approval on this
 * session (see `mayAnswerApproval`). Reads the session's owner; call it before
 * the approval row is read, so a refusal says nothing about the row.
 */
export async function assertCanAnswerApproval(
	actor: Actor,
	sessionId: string,
	decision: "accept" | "decline" | "cancel",
): Promise<void> {
	const mode = await modeOf(actor);
	if (mode === "solo") return;
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (
		!mayAnswerApproval(actor, mode, row ? { ownerUserId: row.ownerUserId ?? null } : null, decision)
	) {
		throw new NotOwnerError("session");
	}
}

/**
 * May this caller manage this device (change it, test it, delete it)? Solo: yes.
 * Team: its owner or an admin. A device whose key has no owner is an admin's,
 * except that the very key it registered with may manage it (an ownerless key is
 * a member with no identity, and still has to be able to remove its own phone).
 */
export async function assertCanManageDevice(
	actor: Actor,
	device: { userId: string | null; apiKeyId: string },
	callerKeyId: string | null,
): Promise<void> {
	if ((await modeOf(actor)) === "solo") return;
	if (device.userId === null && callerKeyId !== null && callerKeyId === device.apiKeyId) return;
	if (!isOwnerOrAdmin(actor, device.userId, false)) throw new NotOwnerError("device");
}

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

/**
 * May this actor see, change or re-link this notification channel? Solo:
 * everyone, as before. Team: an admin, or the user the channel belongs to. A
 * channel whose user is "local" belongs to nobody in team mode, so only an
 * admin may touch it (the one who re-links it claims it).
 */
export async function mayManageChannel(
	actor: Actor,
	channel: { userId: string },
): Promise<boolean> {
	if ((await modeOf(actor)) === "solo") return true;
	if (actor.role === "none") return false;
	if (actor.role === "admin") return true;
	if (channel.userId === "local") return false;
	return actor.userId !== null && actor.userId === channel.userId;
}

/**
 * Re-linking is narrower than managing: it hands the channel's inbound rights
 * to whoever redeems the next code, so in team mode only its owner may do it. An
 * admin may only for a channel owned by "local", which belongs to nobody and is
 * claimed by the re-link. Solo mode has one operator.
 */
export async function mayRelinkChannel(
	actor: Actor,
	channel: { userId: string },
): Promise<boolean> {
	if ((await modeOf(actor)) === "solo") return true;
	if (channel.userId === "local") return actor.role === "admin";
	return actor.userId !== null && actor.userId === channel.userId;
}

export async function assertCanManageChannel(
	actor: Actor,
	channel: { userId: string },
): Promise<void> {
	if (!(await mayManageChannel(actor, channel))) throw new NotOwnerError("channel");
}

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

/**
 * May this caller read this launch request? Solo: always. Team: the user who
 * requested it, or an admin. A launch with no requester (an unattributed caller)
 * is an admin's, and a caller with no user id (a service key that isn't a kept
 * admin, a chat) reads none. Fails closed on an unknown mode (judged as team).
 */
export type LaunchReadScope = { kind: "all" } | { kind: "user"; userId: string } | { kind: "none" };

/** Which launches this caller may read, as something a query can filter on. */
export function launchReadScope(actor: Actor): LaunchReadScope {
	if (actor.role === "none") return { kind: "none" };
	if (actor.mode === "solo" || actor.role === "admin") return { kind: "all" };
	return actor.userId === null ? { kind: "none" } : { kind: "user", userId: actor.userId };
}

export function canReadLaunch(actor: Actor, launch: { requestedByUserId: string | null }): boolean {
	const scope = launchReadScope(actor);
	if (scope.kind === "all") return true;
	return scope.kind === "user" && scope.userId === launch.requestedByUserId;
}
