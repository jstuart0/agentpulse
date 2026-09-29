/**
 * Owner-of-record rule for supervisor writes (AGEN-15, D4/D5/D8/D17).
 *
 * Rule (D5): a session's owner is (1) the supervisor that claimed the launch
 * whose launch_correlation_id equals the session id, regardless of that
 * launch's status; else (2) the managed_sessions row's supervisor_id; else
 * (3) nobody. The launch claimant outranks a rebound managed row, which is
 * what makes this rule self-healing against a legacy hijack with no
 * migration (D8/D11).
 *
 * This module is a leaf (D17): it imports only drizzle-orm, ../db/client.js
 * and ../db/schema/index.js. That's what lets launch-dispatch.ts reuse
 * findLaunchRowByCorrelationId without an import cycle
 * (launch-dispatch.ts -> managed-session-state.ts -> session-ownership.ts).
 * A source-scan test in session-ownership.test.ts enforces this structurally.
 *
 * It never reads authUser or config.disableAuth (D9) — ownership is
 * evaluated identically whether or not auth is enabled.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { launchRequests, managedSessions } from "../db/schema/index.js";

export type SessionOwnershipReason = "foreign_owner" | "no_owner" | "launch_mismatch";

export class SessionOwnershipError extends Error {
	readonly reason: SessionOwnershipReason;

	constructor(reason: SessionOwnershipReason, message?: string) {
		super(message ?? reason);
		this.name = "SessionOwnershipError";
		this.reason = reason;
	}
}

/**
 * Status-agnostic point lookup on the unique launch_correlation_id (D17).
 * Returns the raw row — callers that care about launch status (e.g. the
 * resolver's "pending" filter) apply that filter themselves.
 */
export async function findLaunchRowByCorrelationId(
	sessionId: string,
): Promise<typeof launchRequests.$inferSelect | null> {
	const [row] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, sessionId))
		.limit(1);
	return row ?? null;
}

/**
 * The select-side expression of the owner-of-record rule (D8): the launch
 * claimant if one exists for this managed row, else the managed row's own
 * supervisor_id. Phase 2's `sessionOwnedBy` is the where-side predicate of
 * the same rule — the parity test in session-ownership.test.ts pins the two
 * together.
 */
export const sessionOwnerSql = sql<string>`coalesce(${launchRequests.claimedBySupervisorId}, ${managedSessions.supervisorId})`;

/** Join condition linking a managed row to the launch that shares its session id. */
export const ownerLaunchJoin = eq(launchRequests.launchCorrelationId, managedSessions.sessionId);

/**
 * Resolve the owner of record for a session (D5). Returns null when nobody
 * owns it (no managed row and no claimed launch).
 */
export async function resolveSessionOwner(sessionId: string): Promise<string | null> {
	const [managedOwnerRow] = await getDb()
		.select({ owner: sessionOwnerSql })
		.from(managedSessions)
		.leftJoin(launchRequests, ownerLaunchJoin)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (managedOwnerRow) {
		return managedOwnerRow.owner ?? null;
	}

	const launch = await findLaunchRowByCorrelationId(sessionId);
	return launch?.claimedBySupervisorId ?? null;
}

/**
 * Throws unless `supervisorId` is the owner of record for `sessionId`, and
 * (when `opts.launchRequestId` is supplied) that id either matches the
 * managed row's existing stored value or names a launch claimed by
 * `supervisorId` for this exact session (D6). Callers must invoke this
 * before any write.
 */
export async function assertSupervisorCanWriteSession(
	supervisorId: string,
	sessionId: string,
	opts?: { launchRequestId?: string | null },
): Promise<void> {
	const owner = await resolveSessionOwner(sessionId);
	if (owner === null) {
		throw new SessionOwnershipError("no_owner", `No owner of record for session ${sessionId}`);
	}
	if (owner !== supervisorId) {
		throw new SessionOwnershipError(
			"foreign_owner",
			`Session ${sessionId} is owned by a different supervisor`,
		);
	}

	const launchRequestId = opts?.launchRequestId;
	if (!launchRequestId) return;

	const [managedRow] = await getDb()
		.select({ launchRequestId: managedSessions.launchRequestId })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (managedRow && managedRow.launchRequestId === launchRequestId) return;

	const [launchRow] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, launchRequestId))
		.limit(1);
	if (
		!launchRow ||
		launchRow.claimedBySupervisorId !== supervisorId ||
		launchRow.launchCorrelationId !== sessionId
	) {
		throw new SessionOwnershipError(
			"launch_mismatch",
			`launchRequestId ${launchRequestId} does not name a launch ${supervisorId} claimed for session ${sessionId}`,
		);
	}
}
