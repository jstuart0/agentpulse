/**
 * Session ownership: who a session belongs to, decided once at creation and
 * never overwritten by ingest afterward (first write wins).
 *
 * Pure rules only — no DB access. Callers (event-processor.ts,
 * managed-session-state.ts) do the reads/writes and apply the guards these
 * functions imply:
 *  - a new row's owner/key come from ownerForNewSession, written directly
 *    into the insert values;
 *  - an existing row is only ever touched by fillForUnownedRow's result,
 *    and only under `WHERE owner_user_id IS NULL AND ingest_key_id IS NULL`;
 *  - isOwnerMismatch decides whether to bump the ingest-owner-mismatch
 *    counter, independent of whether the row was actually touched.
 */
import { mayClearAttention } from "./authorization.js";

export interface Attribution {
	/** The posting key's owner, or null for a service key or no caller at all. */
	ownerUserId: string | null;
	/** The posting key's id, or null when there's no key context (a supervisor report, DISABLE_AUTH). */
	ingestKeyId: string | null;
}

export interface OwnerFields {
	ownerUserId: string | null;
	ingestKeyId: string | null;
}

/**
 * Decide a brand-new session's owner and key at the moment it's created.
 *
 * A pending launch's requester always wins over the posting key's owner —
 * that's what makes a launched session come into existence already owned
 * by whoever launched it, regardless of whether the hook path or the
 * supervisor path's report gets there first. ingestKeyId is independent of
 * that: it's always the posting key on the hook path, and always null on
 * the supervisor path, whether or not a launch is in play.
 */
export function ownerForNewSession(input: {
	launchRequesterUserId?: string | null;
	attribution?: Attribution | null;
	supervisorOwnerUserId?: string | null;
}): OwnerFields {
	const ingestKeyId = input.attribution?.ingestKeyId ?? null;
	const ownerUserId =
		input.launchRequesterUserId ??
		input.attribution?.ownerUserId ??
		input.supervisorOwnerUserId ??
		null;
	return { ownerUserId, ingestKeyId };
}

/**
 * Decide what to fill on an existing row whose owner and key are BOTH
 * still null (pre-upgrade data, a DISABLE_AUTH-era row, or a supervisor-
 * created row with no owner) — the one case ingest is allowed to write a
 * non-null value into an existing row.
 *
 * Returns null when there's nothing to do: the row isn't eligible (it
 * already has an owner or a key — ingest never touches those again), or
 * the incoming attribution itself carries nothing to fill (an anonymous/
 * DISABLE_AUTH caller touching an already-unassigned row).
 *
 * An owned key's event fills both columns. A service key's event
 * (ownerUserId null, ingestKeyId set) fills only ingestKeyId — "Unassigned"
 * becomes "Service key," never silently becomes owned.
 */
export function fillForUnownedRow(
	row: Pick<OwnerFields, "ownerUserId" | "ingestKeyId">,
	attribution: Attribution,
): Partial<OwnerFields> | null {
	if (row.ownerUserId !== null || row.ingestKeyId !== null) return null;
	if (attribution.ownerUserId !== null) {
		return { ownerUserId: attribution.ownerUserId, ingestKeyId: attribution.ingestKeyId };
	}
	if (attribution.ingestKeyId !== null) {
		return { ingestKeyId: attribution.ingestKeyId };
	}
	return null;
}

/**
 * The mismatch counter fires only when the row's owner and the
 * event's key's owner are BOTH non-null and disagree. A service key
 * touching someone's owned session doesn't count — that's expected shared
 * tooling traffic, not an ownership fight. Neither does an unassigned row
 * (nothing to disagree with yet).
 */
export function isOwnerMismatch(
	row: Pick<OwnerFields, "ownerUserId">,
	attribution: Attribution,
): boolean {
	return (
		row.ownerUserId !== null &&
		attribution.ownerUserId !== null &&
		row.ownerUserId !== attribution.ownerUserId
	);
}

/**
 * Permission check for acting on a session's acknowledgement state (clearing
 * WAITING/ERROR) — distinct from isOwnerMismatch above, which is evidence
 * for a *counter*, not a permission gate. An owned session may only be
 * acknowledged by its owner; an ownerless posting key (no caller context, or
 * a service key) is never let in just because its own side is null. Only a
 * session with no owner accepts any caller. Used by the UserAcknowledge hook
 * branch in event-processor.ts. The rule itself is mayClearAttention
 * (authorization.ts), which the REST acknowledge/unacknowledge routes ask
 * too; a key carries no role on this path, so there is never an admin
 * override here.
 */
export function canAcknowledgeOwnedSession(
	row: Pick<OwnerFields, "ownerUserId">,
	attribution: Attribution,
): boolean {
	return mayClearAttention({
		sessionOwnerUserId: row.ownerUserId,
		callerUserId: attribution.ownerUserId,
	});
}
