/**
 * Phase 1 (2026-09-29-deliver-supervisor-auth-routing): D7 correlation
 * override. Test contract items 14-17.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { launchRequests } = await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { resolveObservedSessionCorrelation } = await import("./correlation-resolver.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(launchRequests).execute();
});

async function seedUnclaimedLaunch(sessionId: string, status = "validated") {
	await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/correlation-resolver-test",
			status,
		})
		.execute();
}

describe("resolveObservedSessionCorrelation", () => {
	test("supervisorId supplied, != claimant → null", async () => {
		await seedOwnedLaunch("corr-sess-1", "sup-A", { status: "awaiting_session" });
		const resolution = await resolveObservedSessionCorrelation("corr-sess-1", "sup-B");
		expect(resolution).toBeNull();
	});

	test("supervisorId supplied, launch unclaimed → null", async () => {
		await seedUnclaimedLaunch("corr-sess-2", "validated");
		const resolution = await resolveObservedSessionCorrelation("corr-sess-2", "sup-A");
		expect(resolution).toBeNull();
	});

	test("supervisorId supplied, = claimant → resolves that id", async () => {
		await seedOwnedLaunch("corr-sess-3", "sup-A", { status: "awaiting_session" });
		const resolution = await resolveObservedSessionCorrelation("corr-sess-3", "sup-A");
		expect(resolution?.resolvedSupervisorId).toBe("sup-A");
	});

	test("supervisorId not supplied (hook path) → claimed ?? requested ?? unknown, byte-identical", async () => {
		await seedOwnedLaunch("corr-sess-4", "sup-A", { status: "awaiting_session" });
		const resolution = await resolveObservedSessionCorrelation("corr-sess-4");
		expect(resolution?.resolvedSupervisorId).toBe("sup-A");
	});

	test("a running launch: no resolution, with or without supervisorId", async () => {
		await seedOwnedLaunch("corr-sess-5", "sup-A", { status: "running" });

		const withoutSupervisor = await resolveObservedSessionCorrelation("corr-sess-5");
		expect(withoutSupervisor).toBeNull();

		const withSupervisor = await resolveObservedSessionCorrelation("corr-sess-5", "sup-A");
		expect(withSupervisor).toBeNull();
	});
});
