/**
 * Launch attribution: a launched session is owned by whoever requested the
 * launch, whichever path (the agent's own hook events, or its supervisor's
 * report) creates the session row first — and a launch that names an
 * already-existing session's id can't take over its ownership.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, sessions, supervisors } = await import("../db/schema/index.js");
const { processHookEvent } = await import("./event-processor.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(sessions);
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
});

function uniqueId(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

async function seedSupervisor(id: string, ownerUserId: string | null = null) {
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `host-${id}`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {},
			trustedRoots: [],
			status: "connected",
			lastHeartbeatAt: new Date().toISOString(),
			heartbeatLeaseExpiresAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			ownerUserId,
		});
}

async function seedPendingLaunch(
	sessionId: string,
	supervisorId: string,
	requestedByUserId: string,
) {
	await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: `/tmp/launch-attribution-fixture-${crypto.randomUUID()}`,
			requestedSupervisorId: supervisorId,
			claimedBySupervisorId: supervisorId,
			status: "awaiting_session",
			requestedByUserId,
		});
}

describe("A launches on B's host: hook-first and supervisor-first both end with owner A", () => {
	test("hook event arrives first: the insert itself creates the row owned by A, before any association runs", async () => {
		const supervisorId = uniqueId("sup");
		await seedSupervisor(supervisorId, "user-B-host-owner");
		const sessionId = uniqueId("hook-first-session");
		await seedPendingLaunch(sessionId, supervisorId, "user-A-launcher");

		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			{ keyId: "anonymous", deliveryId: null, origin: "native" },
		);

		const [afterHook] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterHook.ownerUserId).toBe("user-A-launcher");

		// The supervisor's own report arriving after changes nothing.
		await upsertManagedSessionState(supervisorId, {
			sessionId,
			status: "active",
			agentType: "claude_code",
			launchRequestId: undefined,
		});

		const [afterSupervisorReport] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterSupervisorReport.ownerUserId).toBe("user-A-launcher");
	});

	test("the supervisor's report arrives first: its own insert creates the row owned by A, via the launch named in the report", async () => {
		const supervisorId = uniqueId("sup");
		await seedSupervisor(supervisorId, "user-B-host-owner");
		const sessionId = uniqueId("supervisor-first-session");
		const { launchId } = await (async () => {
			await seedPendingLaunch(sessionId, supervisorId, "user-A-launcher");
			const [row] = await getDb()
				.select({ id: launchRequests.id })
				.from(launchRequests)
				.where(eq(launchRequests.launchCorrelationId, sessionId));
			return { launchId: row.id };
		})();

		await upsertManagedSessionState(supervisorId, {
			sessionId,
			status: "active",
			agentType: "claude_code",
			launchRequestId: launchId,
		});

		const [afterReport] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterReport.ownerUserId).toBe("user-A-launcher");

		// A hook event for the same session arriving after changes nothing.
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "PostToolUse" },
			"claude_code",
			{
				keyId: "key-C",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: "user-C-poster", ingestKeyId: "key-C" },
			},
		);

		const [afterHookToo] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterHookToo.ownerUserId).toBe("user-A-launcher");
	});
});

describe("interleaving: the loser of the create-the-row race doesn't throw, and its attribution write is a no-op", () => {
	test("supervisor path's insert wins first; the hook path's own insert attempt for the same session id neither throws nor changes the owner", async () => {
		const supervisorId = uniqueId("sup");
		await seedSupervisor(supervisorId, null);
		const sessionId = uniqueId("interleave-session");
		await seedPendingLaunch(sessionId, supervisorId, "user-A-launcher");
		const [{ id: launchId }] = await getDb()
			.select({ id: launchRequests.id })
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, sessionId));

		// Supervisor path creates the row first — owned by A via the launch.
		await upsertManagedSessionState(supervisorId, {
			sessionId,
			status: "active",
			agentType: "claude_code",
			launchRequestId: launchId,
		});
		const [afterSupervisorWins] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterSupervisorWins.ownerUserId).toBe("user-A-launcher");

		// The hook path's own create-attempt for the same session id, as if
		// its own "does this session exist" read had raced against the
		// supervisor path's insert and seen "no row" — the insert itself
		// resolves via onConflictDoNothing, never throws, and the guarded
		// fill after it is a no-op because the row is already owned.
		let threw: unknown;
		try {
			await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				{
					keyId: "key-D",
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: "user-D-poster", ingestKeyId: "key-D" },
				},
			);
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeUndefined();

		const [finalRow] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(finalRow.ownerUserId).toBe("user-A-launcher");
	});
});

describe("a requester-supplied launchCorrelationId equal to an existing, owned session id leaves that session's owner unchanged", () => {
	test("a launch row seeded directly (bypassing the API, which can no longer create one this way) can't take over an existing session's owner", async () => {
		const sessionId = uniqueId("already-owned-session");

		// U1's session already exists.
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			{
				keyId: "key-U1",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: "user-U1", ingestKeyId: "key-U1" },
			},
		);
		const [owned] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(owned.ownerUserId).toBe("user-U1");

		// A launch is seeded directly with the SAME correlation id (the squat
		// shape AGEN-65 refuses to let the API create), requested by U2.
		await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: "claude_code",
				cwd: `/tmp/squat-fixture-${crypto.randomUUID()}`,
				status: "awaiting_session",
				requestedByUserId: "user-U2-squatter",
			});

		// The next SessionStart for this session leaves the owner unchanged.
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			{
				keyId: "key-U1",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: "user-U1", ingestKeyId: "key-U1" },
			},
		);
		const [stillOwned] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(stillOwned.ownerUserId).toBe("user-U1");
	});
});
