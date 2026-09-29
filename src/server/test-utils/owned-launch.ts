/**
 * Shared test fixture: "a session owned by supervisor X" (Phase 1.0,
 * 2026-09-29-deliver-supervisor-auth-routing).
 *
 * Not a test file itself — imported by this campaign's own suites, by
 * managed-session-state.test.ts's fixture-only edit, and by the cli-parity /
 * event-dedup sibling rebases (see the plan's Risks → Sibling break
 * inventory). One shared construction of "owned launch" instead of three
 * hand-rolled `launch_requests` inserts drifting on required columns.
 */
import { getDb } from "../db/client.js";
import { launchRequests } from "../db/schema/index.js";

/**
 * Insert (or reset) a `launch_requests` row whose `launchCorrelationId` is
 * `sessionId` and whose claimant is `supervisorId`, establishing ownership
 * per session-ownership.ts's D5 rule (launch claimant, else managed row).
 *
 * Idempotent per `sessionId`: upserts on the unique `launch_correlation_id`,
 * so re-seeding an id in a suite that doesn't reset `launch_requests` between
 * runs (e.g. managed-session-state.test.ts) never throws.
 *
 * Never creates a `sessions` or `managed_sessions` row — callers own those
 * fixtures themselves.
 *
 * Status defaults to "running", which `findPendingLaunchForObservedSession`
 * ignores. That keeps `associateObservedSession` a no-op against this
 * fixture, so seeding ownership doesn't also trigger launch-attachment
 * side effects the caller didn't ask for.
 */
export async function seedOwnedLaunch(
	sessionId: string,
	supervisorId: string,
	opts?: { status?: string },
): Promise<{ launchId: string }> {
	const status = opts?.status ?? "running";
	const [row] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/owned-launch-fixture",
			requestedSupervisorId: supervisorId,
			claimedBySupervisorId: supervisorId,
			status,
		})
		.onConflictDoUpdate({
			target: launchRequests.launchCorrelationId,
			set: {
				requestedSupervisorId: supervisorId,
				claimedBySupervisorId: supervisorId,
				status,
			},
		})
		.returning();

	return { launchId: row.id };
}
