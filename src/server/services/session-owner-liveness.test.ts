/**
 * Phase 2 (2026-09-29-deliver-supervisor-auth-routing, r2/D18, F19/F20):
 * liveness reads must decide "is this session's supervisor connected" from
 * the owner of record, not the recorded (possibly stale/hijacked)
 * managed_sessions.supervisor_id column.
 *
 * Test contract items 60-66 (L1-L4, I1-I3, getSessionOwnerConnections,
 * listLiveOwnedManagedSessionIds).
 *
 * Deliberately its own file, not session-tracker.test.ts or
 * ai/intelligence-service.test.ts — both are under active sibling edits
 * (Risks → sibling overlap).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { managedSessions, sessions, supervisors } = await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { updateStaleSessions } = await import("./session-tracker.js");
const { intelligenceForSession, intelligenceForSessions } = await import(
	"./ai/intelligence-service.js"
);
const { getSessionOwnerConnections, listLiveOwnedManagedSessionIds } = await import(
	"./session-ownership.js"
);

const MINUTE = 60 * 1000;

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			// Past the idle cutoff (5 min) but well within the end cutoff
			// (30 min), matching session-tracker.test.ts's "i1" fixture shape.
			lastActivityAt: isoAgo(10 * MINUTE),
		})
		.execute();
}

async function seedSupervisorRow(id: string, status: "connected" | "offline") {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: id,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
			status,
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: now,
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

async function seedManagedRowRaw(
	sessionId: string,
	supervisorId: string,
	launchRequestId: string,
	managedState = "headless",
) {
	const now = new Date().toISOString();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId,
			supervisorId,
			managedState,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

/**
 * Seeds all five fixtures from the test contract:
 *  - HIJ-LIVE: recorded owner offline, launch claimant connected.
 *  - HIJ-DEAD: recorded owner connected, launch claimant offline.
 *  - LL-LIVE / LL-DEAD: launch-less, recorded owner connected/offline.
 *  - UNMANAGED: a sessions row only.
 */
async function seedFixtures() {
	await mkSession("HIJ-LIVE");
	await seedSupervisorRow("hij-live-owner", "offline");
	await seedSupervisorRow("hij-live-claimant", "connected");
	const hijLiveLaunch = await seedOwnedLaunch("HIJ-LIVE", "hij-live-claimant");
	await seedManagedRowRaw("HIJ-LIVE", "hij-live-owner", hijLiveLaunch.launchId);

	await mkSession("HIJ-DEAD");
	await seedSupervisorRow("hij-dead-owner", "connected");
	await seedSupervisorRow("hij-dead-claimant", "offline");
	const hijDeadLaunch = await seedOwnedLaunch("HIJ-DEAD", "hij-dead-claimant");
	await seedManagedRowRaw("HIJ-DEAD", "hij-dead-owner", hijDeadLaunch.launchId);

	await mkSession("LL-LIVE");
	await seedSupervisorRow("ll-live-owner", "connected");
	await seedManagedRowRaw("LL-LIVE", "ll-live-owner", "LL-LIVE");

	await mkSession("LL-DEAD");
	await seedSupervisorRow("ll-dead-owner", "offline");
	await seedManagedRowRaw("LL-DEAD", "ll-dead-owner", "LL-DEAD");

	await mkSession("UNMANAGED");
}

describe("updateStaleSessions — liveness by owner of record (F19)", () => {
	test("L1: HIJ-LIVE stays active (claimant is connected, stale recorded owner is offline)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "HIJ-LIVE"));
		expect(row?.status).toBe("active");
	});

	test("L2: HIJ-DEAD becomes idle (claimant is offline, stale recorded owner is connected)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "HIJ-DEAD"));
		expect(row?.status).toBe("idle");
	});

	test("L3/L4: launch-less rows follow their recorded owner unchanged (controls)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [live] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "LL-LIVE"));
		expect(live?.status).toBe("active");
		const [dead] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "LL-DEAD"));
		expect(dead?.status).toBe("idle");
	});
});

describe("intelligenceForSession / intelligenceForSessions — owner of record (F20)", () => {
	test("I1: HIJ-LIVE's reasonCode is not supervisor_offline", async () => {
		await seedFixtures();
		const intel = await intelligenceForSession("HIJ-LIVE");
		expect(intel?.reasonCode).not.toBe("supervisor_offline");
	});

	test("I2: HIJ-DEAD's reasonCode is supervisor_offline", async () => {
		await seedFixtures();
		const intel = await intelligenceForSession("HIJ-DEAD");
		expect(intel?.reasonCode).toBe("supervisor_offline");
	});

	test("I3: bulk path agrees with the single path across all four shapes", async () => {
		await seedFixtures();
		const map = await intelligenceForSessions(["HIJ-LIVE", "HIJ-DEAD", "LL-DEAD", "UNMANAGED"]);
		expect(map.size).toBe(4);
		expect(map.get("HIJ-LIVE")?.reasonCode).not.toBe("supervisor_offline");
		expect(map.get("HIJ-DEAD")?.reasonCode).toBe("supervisor_offline");
		expect(map.get("LL-DEAD")?.reasonCode).toBe("supervisor_offline");
		expect(map.get("UNMANAGED")?.reasonCode).not.toBe("supervisor_offline");
	});
});

describe("getSessionOwnerConnections", () => {
	test("returns owner-of-record connected state, keyed only by managed sessions", async () => {
		await seedFixtures();
		const result = await getSessionOwnerConnections([
			"HIJ-LIVE",
			"HIJ-DEAD",
			"LL-LIVE",
			"UNMANAGED",
		]);
		expect(result.get("HIJ-LIVE")).toBe(true);
		expect(result.get("HIJ-DEAD")).toBe(false);
		expect(result.get("LL-LIVE")).toBe(true);
		// Named member: UNMANAGED must be absent, not present-with-any-value —
		// callers rely on `.get()` returning undefined for an unmanaged session.
		expect(result.has("UNMANAGED")).toBe(false);
	});

	test("empty input returns an empty map with no query", async () => {
		const result = await getSessionOwnerConnections([]);
		expect(result.size).toBe(0);
	});
});

describe("listLiveOwnedManagedSessionIds", () => {
	test("returns exactly the sessions whose owner of record is connected AND in the requested states", async () => {
		await seedFixtures();
		// Named member: owner connected but wrong managed_state must be excluded.
		await mkSession("COMPLETED-BUT-CONNECTED");
		await seedSupervisorRow("completed-owner", "connected");
		await seedManagedRowRaw(
			"COMPLETED-BUT-CONNECTED",
			"completed-owner",
			"COMPLETED-BUT-CONNECTED",
			"completed",
		);

		const ids = await listLiveOwnedManagedSessionIds(["headless"]);
		expect(new Set(ids)).toEqual(new Set(["HIJ-LIVE", "LL-LIVE"]));
	});

	test("empty states returns [] with no query", async () => {
		const ids = await listLiveOwnedManagedSessionIds([]);
		expect(ids).toEqual([]);
	});
});
