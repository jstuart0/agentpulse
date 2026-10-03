/**
 * Phase 2 (2026-09-29-deliver-supervisor-auth-routing): owner-of-record
 * routing for claims, provider-sync listing, stale-lock expiry, and the
 * D12 forged-launch-pointer guard on queuePromptAction.
 *
 * codex r2 F44 (D10): queuePromptAction/retryLaunchForSession must resolve
 * the legacy launchRequestId = sessionId fallback shape (managed-session-
 * state.ts:131) by launchCorrelationId, not just by id.
 *
 * Test contract items 30-34.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const TEST_ACTOR: Actor = { userId: null, label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { claimNextControlAction, queuePromptAction, retryLaunchForSession } = await import(
	"./control-actions.js"
);
const { listManagedSessionsNeedingSync } = await import("./managed-session-state.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
});

async function seedSessionRow(sessionId: string) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.onConflictDoNothing()
		.execute();
}

async function seedManagedRowRaw(
	sessionId: string,
	supervisorId: string,
	launchRequestId: string,
	opts?: {
		desiredThreadTitle?: string | null;
		providerThreadTitle?: string | null;
		activeControlActionId?: string | null;
		controlLockExpiresAt?: string | null;
	},
) {
	await seedSessionRow(sessionId);
	const now = new Date().toISOString();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId,
			supervisorId,
			managedState: "managed",
			desiredThreadTitle: opts?.desiredThreadTitle ?? null,
			providerThreadTitle: opts?.providerThreadTitle ?? null,
			activeControlActionId: opts?.activeControlActionId ?? null,
			controlLockExpiresAt: opts?.controlLockExpiresAt ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

async function seedQueuedPrompt(sessionId: string, launchRequestId: string) {
	const now = new Date().toISOString();
	const [row] = await getDb()
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId,
			actionType: "prompt",
			requestedBy: "test",
			status: "queued",
			metadata: {},
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return row;
}

describe("claimNextControlAction routes by owner of record (D8)", () => {
	test("legacy hijack: claimant B claims the prompt, stale recorded owner A gets nothing", async () => {
		const sessionId = "hijack-sess";
		const bLaunch = await seedOwnedLaunch(sessionId, "sup-B");
		// Simulate a pre-fix rebind: the managed row's own supervisor_id column
		// still says A, but the launch was claimed by B.
		await seedManagedRowRaw(sessionId, "sup-A", bLaunch.launchId);
		const queued = await seedQueuedPrompt(sessionId, bLaunch.launchId);

		expect(await claimNextControlAction("sup-A")).toBeNull();
		const claimedByB = await claimNextControlAction("sup-B");
		expect(claimedByB?.id).toBe(queued.id);
	});

	test("launch-less row owned by B (control, unchanged behavior)", async () => {
		const sessionId = "launchless-sess";
		await seedManagedRowRaw(sessionId, "sup-B", sessionId);
		const queued = await seedQueuedPrompt(sessionId, sessionId);

		expect(await claimNextControlAction("sup-A")).toBeNull();
		const claimedByB = await claimNextControlAction("sup-B");
		expect(claimedByB?.id).toBe(queued.id);
	});
});

describe("listManagedSessionsNeedingSync routes by owner of record", () => {
	test("A excludes the hijacked session; B includes it", async () => {
		const sessionId = "sync-hijack-sess";
		const bLaunch = await seedOwnedLaunch(sessionId, "sup-B");
		await seedManagedRowRaw(sessionId, "sup-A", bLaunch.launchId, {
			desiredThreadTitle: "renamed",
			providerThreadTitle: null,
		});

		const forA = await listManagedSessionsNeedingSync("sup-A");
		expect(forA.some((row) => row.sessionId === sessionId)).toBe(false);

		const forB = await listManagedSessionsNeedingSync("sup-B");
		expect(forB.some((row) => row.sessionId === sessionId)).toBe(true);
	});
});

describe("expireStaleControlLocksForSupervisor routes by owner of record", () => {
	test("B's claim expires the hijacked session's stale control lock", async () => {
		const sessionId = "lock-hijack-sess";
		const bLaunch = await seedOwnedLaunch(sessionId, "sup-B");
		// The sessions row (and therefore the managed row) must exist before
		// control_actions.session_id's cascade FK can accept a queued prompt.
		await seedSessionRow(sessionId);
		const staleAction = await seedQueuedPrompt(sessionId, bLaunch.launchId);
		const pastExpiry = new Date(Date.now() - 1_000).toISOString();
		await seedManagedRowRaw(sessionId, "sup-A", bLaunch.launchId, {
			activeControlActionId: staleAction.id,
			controlLockExpiresAt: pastExpiry,
		});
		// Mark the "in-flight" action running, as claimNextControlAction would
		// have left it, so expiry has something to fail.
		await getDb()
			.update(controlActions)
			.set({ status: "running" })
			.where(eq(controlActions.id, staleAction.id));

		await claimNextControlAction("sup-B");

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow?.activeControlActionId).toBeNull();
		expect(managedRow?.controlLockExpiresAt).toBeNull();

		const [actionRow] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, staleAction.id));
		expect(actionRow?.status).toBe("failed");
	});
});

describe("queuePromptAction rejects a forged launch pointer (D12)", () => {
	test("managed.launchRequestId naming a launch for a different session throws, inserts nothing", async () => {
		const sessionId = "d12-forged-sess";
		const otherLaunch = await seedOwnedLaunch("d12-other-sess", "sup-A");
		await seedManagedRowRaw(sessionId, "sup-A", otherLaunch.launchId);

		await expect(queuePromptAction(sessionId, "hello", TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);

		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows.length).toBe(0);
	});

	test("happy path (matching launch) is unchanged", async () => {
		const sessionId = "d12-happy-sess";
		const launch = await seedOwnedLaunch(sessionId, "sup-A");
		await seedManagedRowRaw(sessionId, "sup-A", launch.launchId);

		const action = await queuePromptAction(sessionId, "hello", TEST_ACTOR);
		expect(action.actionType).toBe("prompt");
		expect(action.sessionId).toBe(sessionId);
	});
});

// F47 (Medium, xander spot check on F44): retryLaunchForSession must apply
// the same D12 cross-host guard queuePromptAction does — mirrors the
// forged-pointer test above.
describe("retryLaunchForSession rejects a forged launch pointer (D12/F47)", () => {
	test("managed.launchRequestId naming a launch for a different session throws, clones nothing", async () => {
		const sessionId = "d12-retry-forged-sess";
		const otherLaunch = await seedOwnedLaunch("d12-retry-other-sess", "sup-A");
		await seedManagedRowRaw(sessionId, "sup-A", otherLaunch.launchId);

		await expect(retryLaunchForSession(sessionId, TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);

		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows.length).toBe(0);
		// No clone was inserted for the forged pointer's own launch either —
		// only the two legitimate launches from setup exist.
		const launches = await getDb().select().from(launchRequests);
		expect(launches.length).toBe(1);
	});

	test("happy path (matching launch) is unchanged", async () => {
		const sessionId = "d12-retry-happy-sess";
		const launch = await seedOwnedLaunch(sessionId, "sup-A");
		await seedManagedRowRaw(sessionId, "sup-A", launch.launchId);

		const result = await retryLaunchForSession(sessionId, TEST_ACTOR);
		expect(result.launchRequest.retryOfLaunchRequestId).toBe(launch.launchId);
	});
});

describe("F44: queuePromptAction/retryLaunchForSession resolve the legacy launchRequestId=sessionId fallback", () => {
	test("a state report with no launchRequestId (fallback shape) — prompt, then retry, both succeed", async () => {
		const sessionId = "f44-happy-sess";
		const launch = await seedOwnedLaunch(sessionId, "sup-A");
		// Legacy fallback shape: managed.launchRequestId === sessionId — what
		// upsertManagedSessionState stores when a report omits
		// launchRequestId (managed-session-state.ts:131).
		await seedManagedRowRaw(sessionId, "sup-A", sessionId);

		const promptAction = await queuePromptAction(sessionId, "hello", TEST_ACTOR);
		expect(promptAction.actionType).toBe("prompt");
		// Queued with the REAL launch id, not the stale sessionId fallback
		// value (F44's second requirement).
		expect(promptAction.launchRequestId).toBe(launch.launchId);

		const retryResult = await retryLaunchForSession(sessionId, TEST_ACTOR);
		expect(retryResult.launchRequest.retryOfLaunchRequestId).toBe(launch.launchId);
	});

	test("cross-host refusal still fires on input shaped like the fallback: a real launch whose id collides with the session id, but whose correlation is a different session, is still rejected (D12)", async () => {
		const sessionId = "f44-collide-sess";
		// A real launch_requests row whose id happens to equal this session's
		// id (the same string that would otherwise trigger the fallback
		// lookup), but whose actual correlation belongs to a DIFFERENT
		// session. The id lookup must still win over the fallback, so D12
		// catches this exactly as it would any other forged pointer.
		await getDb()
			.insert(launchRequests)
			.values({
				id: sessionId,
				launchCorrelationId: "f44-other-sess",
				agentType: "claude_code",
				cwd: "/tmp/f44-collide",
				status: "running",
				requestedSupervisorId: "sup-A",
				claimedBySupervisorId: "sup-A",
			})
			.execute();
		await seedManagedRowRaw(sessionId, "sup-A", sessionId);

		await expect(queuePromptAction(sessionId, "hello", TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);

		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows.length).toBe(0);
	});
});
