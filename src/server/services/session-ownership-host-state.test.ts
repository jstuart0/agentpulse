/**
 * AGEN-66: getSessionOwnerHostStates reads the same owner-of-record query as
 * getSessionOwnerConnections and classifies it live / offline / gone, so a
 * stop or prompt can be refused at queue time instead of failing 90 s later.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { isPostgresTest } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedManagedSession, seedSupervisor } = await import("../test-utils/supervisor-fixture.js");
const { getSessionOwnerConnections, getSessionOwnerHostStates } = await import(
	"./session-ownership.js"
);

const NOW = Date.parse("2026-11-03T12:00:00.000Z");

beforeAll(() => initializeDatabase());

async function reset() {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
}
beforeEach(reset);
afterEach(reset);

async function managedOn(sessionId: string, hostId: string, leaseOffsetMs: number | "none") {
	if (leaseOffsetMs !== "none") {
		await seedSupervisor(hostId, { leaseOffsetMs, leaseBaseMs: NOW });
	}
	await seedManagedSession({ sessionId, supervisorId: hostId, managedState: "managed" });
}

describe("getSessionOwnerHostStates", () => {
	test("live, offline, revoked and no-row hosts read live, offline, gone and gone", async () => {
		await managedOn("hs-live", "h-live", 60_000);
		await managedOn("hs-offline", "h-offline", -60_000);
		await managedOn("hs-revoked", "h-revoked", 60_000);
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, "h-revoked"));
		// seedManagedSession's owned-launch fixture adds a live host unless one exists; remove it.
		await managedOn("hs-norow", "h-norow", "none");
		await getDb().delete(supervisors).where(eq(supervisors.id, "h-norow"));

		const states = await getSessionOwnerHostStates(
			["hs-live", "hs-offline", "hs-revoked", "hs-norow", "hs-unmanaged"],
			NOW,
		);
		expect(states.get("hs-live")?.state).toBe("live");
		expect(states.get("hs-offline")?.state).toBe("offline");
		expect(states.get("hs-revoked")).toEqual({ state: "gone", lastSeenAt: null });
		expect(states.get("hs-norow")).toEqual({ state: "gone", lastSeenAt: null });
		expect(states.has("hs-unmanaged")).toBe(false);
	});

	test("an offline or live host reports its last heartbeat", async () => {
		await managedOn("hs-seen", "h-seen", -60_000);
		const [host] = await getDb().select().from(supervisors).where(eq(supervisors.id, "h-seen"));
		const states = await getSessionOwnerHostStates(["hs-seen"], NOW);
		expect(states.get("hs-seen")?.lastSeenAt).toBe(host?.lastHeartbeatAt ?? "unset");
	});

	test("the lease boundary: nowMs equal to the expiry reads offline, one millisecond before reads live", async () => {
		await managedOn("hs-edge", "h-edge", 0);
		expect((await getSessionOwnerHostStates(["hs-edge"], NOW)).get("hs-edge")?.state).toBe(
			"offline",
		);
		expect((await getSessionOwnerHostStates(["hs-edge"], NOW - 1)).get("hs-edge")?.state).toBe(
			"live",
		);
	});

	test("it agrees with getSessionOwnerConnections on every session", async () => {
		await managedOn("hs-a", "h-a", 60_000);
		await managedOn("hs-b", "h-b", -60_000);
		await managedOn("hs-c", "h-c", 60_000);
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, "h-c"));
		const ids = ["hs-a", "hs-b", "hs-c"];
		const connections = await getSessionOwnerConnections(ids, NOW);
		const states = await getSessionOwnerHostStates(ids, NOW);
		for (const id of ids)
			expect(states.get(id)?.state === "live").toBe(connections.get(id) as boolean);
	});

	test("an empty list is an empty map", async () => {
		expect((await getSessionOwnerHostStates([], NOW)).size).toBe(0);
	});

	test("on the transaction handle inside withAdminLock it issues its statement there and completes", async () => {
		await managedOn("hs-tx", "h-tx", 60_000);
		const dbSelect = spyOn(getDb(), "select");
		try {
			const state = await withAdminLock(async (tx) =>
				(await getSessionOwnerHostStates(["hs-tx"], NOW, tx)).get("hs-tx"),
			);
			expect(state?.state).toBe("live");
			// On Postgres the transaction is a distinct handle, so the shared one saw nothing.
			if (isPostgresTest) expect(dbSelect.mock.calls.length).toBe(0);
		} finally {
			dbSelect.mockRestore();
		}
	});
});
