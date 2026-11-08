import { CLAUDE_STOP, CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
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
import { CLAUDE_TAKEOVER } from "../../shared/session-resume.js";
import { getDb } from "../db/client.js";
import { launchRequests, supervisors } from "../db/schema/index.js";

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
 * Also seeds the owning host as a live `supervisors` row (lease an hour out,
 * left untouched when the row already exists), because stop and prompt are
 * refused for a host that is offline or gone. Pass `host: "none"` for a test
 * that needs the missing-host case.
 *
 * Status defaults to "completed", which `findPendingLaunchForObservedSession`
 * ignores. That keeps `associateObservedSession` a no-op against this
 * fixture, so seeding ownership doesn't also trigger launch-attachment
 * side effects the caller didn't ask for. It is not "running" because a
 * headless Claude launch that is still running is the session's first turn
 * (AGEN-117 T12), and the session then takes no prompt: most callers queue one.
 * A test about the first turn passes `status: "running"`.
 */
export async function seedOwnedLaunch(
	sessionId: string,
	supervisorId: string,
	opts?: { status?: string; host?: "live" | "none"; agentType?: string; takeover?: boolean },
): Promise<{ launchId: string }> {
	const status = opts?.status ?? "completed";
	if (opts?.host !== "none") await seedLiveHostIfAbsent(supervisorId);
	const [row] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: opts?.agentType ?? "claude_code",
			cwd: "/tmp/owned-launch-fixture",
			// Headless, not the column's terminal default: a Stop on a terminal launch is refused at enqueue
			// (nothing can stop it), and most callers of this fixture queue a Stop to test something else.
			requestedLaunchMode: "headless",
			requestedSupervisorId: supervisorId,
			claimedBySupervisorId: supervisorId,
			status,
			// A continued Claude session's carrier, as the takeover's settle writes it.
			...(opts?.takeover ? { metadata: { boundObservedSession: true } } : {}),
		})
		.onConflictDoUpdate({
			target: launchRequests.launchCorrelationId,
			set: {
				requestedSupervisorId: supervisorId,
				claimedBySupervisorId: supervisorId,
				status,
				...(opts?.takeover ? { metadata: { boundObservedSession: true } } : {}),
			},
		})
		.returning();

	return { launchId: row.id };
}

const LIVE_LEASE_MS = 60 * 60_000;

async function seedLiveHostIfAbsent(supervisorId: string): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: supervisorId,
			hostName: supervisorId,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			// Capable enough that a retry of a fixture launch passes the host's own checks.
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "interactive_terminal", "managed_codex"],
				os: "linux",
				terminalSupport: ["terminal"],
				// A fixture host takes Codex follow-ups and Claude stops; a test about an older supervisor seeds its own. (supervisor-fixture.ts's
				// seedSupervisor differs on purpose: its default host is an older one, with no features.)
				features: [CODEX_FOLLOW_UP_PROMPTS, CLAUDE_STOP, CLAUDE_TAKEOVER],
				executables: {
					claude: {
						available: true,
						command: "claude",
						resolvedPath: "/usr/bin/claude",
						source: "auto",
					},
					codex: {
						available: true,
						command: "codex",
						resolvedPath: "/usr/bin/codex",
						source: "auto",
					},
				},
			},
			trustedRoots: ["/"],
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + LIVE_LEASE_MS).toISOString(),
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
}
