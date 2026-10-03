import { eq } from "drizzle-orm";
import type { LaunchRequest } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { managedSessions, sessions } from "../db/schema/index.js";
import { findPendingLaunchForObservedSession } from "./launch-dispatch.js";
import { parseDbTimestamp } from "./util/db-time.js";

/**
 * Pure correlation resolver (WS1). Takes an observed session id + an
 * optional supervisor id and returns a resolution record — never writes
 * to any table. Callers that want to associate the session must use a
 * dedicated writer service (e.g. `launchDispatch.associateObservedSession`).
 *
 * Keeping this function pure is the enforcement boundary: linker state
 * and launch lifecycle state always have one writer each, and no route
 * handler composes multi-service writes through the resolver.
 */

export interface CorrelationResolution {
	launchRequest: LaunchRequest;
	resolvedSupervisorId: string;
}

export async function resolveObservedSessionCorrelation(
	sessionId: string,
	supervisorId?: string | null,
): Promise<CorrelationResolution | null> {
	const launchRequest = await findPendingLaunchForObservedSession(sessionId);
	if (!launchRequest) return null;

	if (supervisorId) {
		// D7: a supervisor can only correlate a launch it claimed. This is
		// defense-in-depth — assertSupervisorCanWriteSession already rejected
		// the request upstream, so a mismatch here never surfaces as a second
		// error, just a null resolution the caller treats as "nothing to do".
		if (launchRequest.claimedBySupervisorId !== supervisorId) return null;
		return { launchRequest, resolvedSupervisorId: supervisorId };
	}

	// Hook path (no supervisorId). Security (launch-correlation squatting):
	// a pending launch matching this sessionId is NOT sufficient evidence that
	// the launch legitimately "belongs" to this session — a launch created
	// after the fact with a squatted correlation id matches here too. Refuse
	// to attach when either signal says this session was already someone
	// else's before this launch:
	//
	//   1. The session is already managed under a DIFFERENT launch request.
	//      A brand-new session correlating to its own awaiting launch never
	//      has a managed row yet, so this only fires on an attach attempt.
	//      (control-actions.ts's resolveManagedLaunch documents a legacy
	//      shape where launchRequestId is stamped as the sessionId itself —
	//      that sentinel always names *this* correlationId-matched launch,
	//      so it counts as "same launch", not a mismatch.)
	//   2. The session row already existed before this launch was created.
	//      Every legitimate producer of a launchSpec generates a fresh,
	//      previously-unused crypto.randomUUID() (launch-compatibility.ts,
	//      template-preview.ts, control-actions.ts's retryLaunchForSession),
	//      so a launch whose correlation id matches an OLDER session can only
	//      be squatting on that session's identity, not the session the
	//      launch actually spawned.
	const [existingManaged] = await getDb()
		.select({ launchRequestId: managedSessions.launchRequestId })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	const isSameLaunch =
		!existingManaged ||
		existingManaged.launchRequestId === launchRequest.id ||
		existingManaged.launchRequestId === sessionId;
	if (!isSameLaunch) {
		return null;
	}

	const [existingSession] = await getDb()
		.select({ startedAt: sessions.startedAt })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (existingSession) {
		// Both columns are TEXT in both dialects and can legitimately hold
		// three different shapes (app-stamped ISO, SQLite's bare
		// datetime('now'), Postgres's offset-bearing CURRENT_TIMESTAMP
		// text) — a raw string `<` compares lexicographically, not
		// chronologically, and silently flips the wrong way across formats
		// (AGEN-65). parseDbTimestamp (shared with event-dedup.ts /
		// ai/context.ts) normalizes all three to epoch ms, treating an
		// absent zone as UTC.
		//
		// Fail closed on the security property: if either side can't be
		// parsed, refuse rather than guess. This only narrows the normal
		// new-session path in the direction of "safe" — a brand-new session
		// has no row here yet, so this branch (and the fail-closed refusal)
		// is never reached for it; only a *pre-existing* session with a
		// corrupt timestamp loses the ability to re-correlate, which is the
		// same outcome a real squat attempt gets.
		const existingStartedAtMs = parseDbTimestamp(existingSession.startedAt);
		const launchCreatedAtMs = parseDbTimestamp(launchRequest.createdAt);
		if (existingStartedAtMs === null || launchCreatedAtMs === null) {
			return null;
		}
		if (existingStartedAtMs < launchCreatedAtMs) {
			return null;
		}
	}

	const resolvedSupervisorId =
		launchRequest.claimedBySupervisorId ?? launchRequest.requestedSupervisorId ?? "unknown";

	return { launchRequest, resolvedSupervisorId };
}
