/**
 * A host kept when its owner was disabled (disable with revokeHosts: false)
 * still works, but its owner is gone: a session the host's supervisor creates
 * is unowned, not handed to a disabled account. An active owner still gets it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	disableUserDirectly,
	jsonRequest,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, managedSessions, sessions, supervisorCredentials, supervisors } =
	await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(sessions);
	await getDb().delete(supervisorCredentials);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

async function hostFor(ownerUserId: string) {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: "do-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {},
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			createdAt: now,
			updatedAt: now,
			ownerUserId,
		});
	const { token } = await createSupervisorCredential(id, "do-credential");
	return { id, token };
}

async function reportSession(host: { id: string; token: string }, sessionId: string) {
	// A launch the host claimed with no requester: the session falls back to the host's owner.
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/do",
			requestedSupervisorId: host.id,
			claimedBySupervisorId: host.id,
			status: "launching",
		})
		.returning();
	const res = await app.request(
		`/api/v1/supervisors/${host.id}/managed-session-state`,
		jsonRequest(
			"POST",
			{ sessionId, agentType: "claude_code", launchRequestId: launch.id, managedState: "managed" },
			new Headers({ Authorization: `Bearer ${host.token}` }),
		),
	);
	expect(res.status).toBe(200);
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

describe("a session the host's supervisor creates", () => {
	test("is owned by the host's owner while the owner is active", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("do-active");
		const host = await hostFor(owner.id);
		expect((await reportSession(host, "do-1"))?.ownerUserId).toBe(owner.id);
	});

	test("is unowned when the host's owner has been disabled and the host kept", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("do-disabled");
		const host = await hostFor(owner.id);
		await disableUserDirectly(owner.id);
		expect((await reportSession(host, "do-2"))?.ownerUserId).toBeNull();
	});
});
