/**
 * Admin operations that hand sessions to a user: claiming every session nobody
 * owns, and changing one session's owner. Both run under the admin lock with
 * the target checked in the same transaction, so a user disabled a moment
 * earlier can't be handed anything.
 *
 * Ingest never changes a non-null owner (first write wins); these are the only
 * ways one changes after creation, apart from launch association filling an
 * empty one.
 */
import { and, eq, isNull } from "drizzle-orm";
import { assertOwnerAssignable } from "../auth/owner-state.js";
import { withAdminLock } from "../db/admin-lock.js";
import { apiKeys, sessions } from "../db/schema/index.js";
import { requestWsRevalidation } from "../ws/revalidation.js";

/** Gives every session with no owner and no recorded key to the user. Returns how many. */
export async function claimUnassignedSessions(userId: string): Promise<number> {
	return withAdminLock(async (tx) => {
		await assertOwnerAssignable(tx, userId);
		const claimed = await tx
			.update(sessions)
			.set({ ownerUserId: userId })
			.where(and(isNull(sessions.ownerUserId), isNull(sessions.ingestKeyId)))
			.returning({ id: sessions.id });
		return claimed.length;
	}).then(async (count) => {
		await requestWsRevalidation();
		return count;
	});
}

export type ChangeSessionOwnerResult =
	| { found: false }
	| { found: true; from: string | null; to: string | null };

/**
 * Sets (or, with null, clears) one session's owner. Handing the session to a
 * different user also clears the recorded ingest key unless that key belongs
 * to the new owner: the previous owner's key (or a service key bound to it)
 * stops being authoritative for a session that is no longer theirs. Claiming
 * unassigned sessions needs no such step, it only takes sessions with no
 * recorded key.
 */
export async function changeSessionOwner(
	sessionId: string,
	ownerUserId: string | null,
): Promise<ChangeSessionOwnerResult> {
	return withAdminLock(async (tx) => {
		const [row] = await tx
			.select({ ownerUserId: sessions.ownerUserId, ingestKeyId: sessions.ingestKeyId })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!row) return { found: false as const };
		if (ownerUserId !== null) await assertOwnerAssignable(tx, ownerUserId);
		const staleKey =
			ownerUserId !== null &&
			ownerUserId !== row.ownerUserId &&
			row.ingestKeyId !== null &&
			!(await keyBelongsTo(tx, row.ingestKeyId, ownerUserId));
		await tx
			.update(sessions)
			.set(staleKey ? { ownerUserId, ingestKeyId: null } : { ownerUserId })
			.where(eq(sessions.sessionId, sessionId));
		return { found: true as const, from: row.ownerUserId, to: ownerUserId };
	}).then(async (result) => {
		if (result.found) await requestWsRevalidation();
		return result;
	});
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function keyBelongsTo(tx: any, keyId: string, userId: string): Promise<boolean> {
	const [key] = await tx
		.select({ ownerUserId: apiKeys.ownerUserId })
		.from(apiKeys)
		.where(eq(apiKeys.id, keyId))
		.limit(1);
	return key?.ownerUserId === userId;
}

/**
 * Gives a session nobody owns its owner, when a takeover of it has succeeded. Conditional on the owner still
 * being empty, so an admin's change made after the takeover was requested is never overwritten, and it runs
 * on the caller's transaction (the settle of the takeover's action). The user must exist and be active:
 * `assertOwnerAssignable` throws otherwise, and the caller leaves the session unowned. Returns whether it
 * assigned. The recorded ingest key is left alone, so the relay's key keeps reporting.
 */
export async function assignTakeoverOwner(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	sessionId: string,
	ownerUserId: string,
): Promise<boolean> {
	await assertOwnerAssignable(tx, ownerUserId);
	const assigned = await tx
		.update(sessions)
		.set({ ownerUserId })
		.where(and(eq(sessions.sessionId, sessionId), isNull(sessions.ownerUserId)))
		.returning({ id: sessions.id });
	return assigned.length > 0;
}
