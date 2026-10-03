/**
 * Host ownership: who owns a supervisor row.
 * Enrollment records the enrolling caller as owner, at first enrollment
 * only. Rotation never changes or fills the owner, regardless of who
 * rotates — not someone else's host, and not an ownerless (pre-upgrade)
 * one either, even when the rotating caller is the host's eventual owner.
 * The unscoped-token-plus-existing-id guard is unaffected by any of this.
 *
 * Also covers the stale-broadcast fix: after a launch association, the
 * session broadcast reflects the just-assigned owner, not the
 * pre-association snapshot.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { launchRequests, sessions, supervisors } = await import("../db/schema/index.js");
const { sessionBus } = await import("../services/notifier.js");

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

function manageHeaders(key: string): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

async function enroll(key: string, hostName: string, supervisorId?: string) {
	const res = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: manageHeaders(key),
		body: JSON.stringify({ name: hostName, supervisorId }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { token: string };
}

async function register(hostName: string, enrollmentToken: string, supervisorId?: string) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: supervisorId,
			hostName,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
		}),
	});
}

describe("host ownership: enroll records the owner, at first enrollment only; rotate never touches it", () => {
	test("enroll by A → owned by A; rotate by B → still A; an unowned host rotated by A → still unowned; unscoped token + existing id → 409, no owner change", async () => {
		const { key: keyA } = await createApiKey("host-owner-A", ["manage"], "user-host-A");
		const { key: keyB } = await createApiKey("host-owner-B", ["manage"], "user-host-B");

		// (a) enroll by A → A
		const hostName = `host-${crypto.randomUUID()}`;
		const { token: enrollTokenA } = await enroll(keyA, hostName);
		const registerRes = await register(hostName, enrollTokenA);
		expect(registerRes.status).toBe(200);
		const { supervisor } = (await registerRes.json()) as { supervisor: { id: string } };

		const [afterEnroll] = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.id, supervisor.id));
		expect(afterEnroll.ownerUserId).toBe("user-host-A");

		// (b) rotate by B → doesn't change the owner
		const rotateResB = await app.request(`/api/v1/admin/supervisors/${supervisor.id}/rotate`, {
			method: "POST",
			headers: manageHeaders(keyB),
			body: JSON.stringify({}),
		});
		const { token: rotateTokenB } = (await rotateResB.json()) as { token: string };
		const reRegisterRes = await register(hostName, rotateTokenB, supervisor.id);
		expect(reRegisterRes.status).toBe(200);

		const [afterRotateByB] = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.id, supervisor.id));
		expect(afterRotateByB.ownerUserId).toBe("user-host-A");

		// (c) an unowned (pre-upgrade) host rotated by A → stays unowned.
		// Owner is set at first enrollment only; rotation is a credential
		// operation, not an ownership one, even when the rotating caller
		// would otherwise be a reasonable owner.
		const unownedId = crypto.randomUUID();
		await getDb()
			.insert(supervisors)
			.values({
				id: unownedId,
				hostName: `preexisting-${crypto.randomUUID()}`,
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: {},
				trustedRoots: [],
				status: "disconnected",
				lastHeartbeatAt: new Date().toISOString(),
				heartbeatLeaseExpiresAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		const rotateResUnowned = await app.request(`/api/v1/admin/supervisors/${unownedId}/rotate`, {
			method: "POST",
			headers: manageHeaders(keyA),
			body: JSON.stringify({}),
		});
		const { token: rotateTokenForUnowned } = (await rotateResUnowned.json()) as { token: string };
		const unownedRegisterRes = await register(
			"preexisting-rotate-target",
			rotateTokenForUnowned,
			unownedId,
		);
		expect(unownedRegisterRes.status).toBe(200);

		const [afterUnownedRotate] = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.id, unownedId));
		expect(afterUnownedRotate.ownerUserId).toBeNull();

		// (d) unscoped token + an existing id → 409, no owner change (pre-existing
		// guard; this phase must not touch it).
		const { token: unscopedToken } = await enroll(keyB, `unscoped-${crypto.randomUUID()}`);
		const conflictRes = await register("doesn't matter", unscopedToken, supervisor.id);
		expect(conflictRes.status).toBe(409);
		const body = (await conflictRes.json()) as { error: string };
		expect(body.error).toBe("supervisor_exists_use_rotate");

		const [afterConflict] = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.id, supervisor.id));
		expect(afterConflict.ownerUserId).toBe("user-host-A");
	});
});

describe("the broadcast after a launch association carries the just-assigned owner", () => {
	test("session_updated on the managed-session-state report reflects the owner the launch association sets in this same call, not the pre-association snapshot", async () => {
		// An unowned supervisor (seeded directly, not through enroll), so the
		// ONLY source of an owner here is the launch correlation — isolating
		// this from the host-ownership behavior covered above.
		const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
		const supervisorId = crypto.randomUUID();
		await getDb()
			.insert(supervisors)
			.values({
				id: supervisorId,
				hostName: `unowned-broadcast-host-${crypto.randomUUID()}`,
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
			});
		const { token: supervisorCredential } = await createSupervisorCredential(
			supervisorId,
			"broadcast-test-credential",
		);

		const sessionId = `broadcast-session-${crypto.randomUUID()}`;
		await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: "claude_code",
				cwd: `/tmp/broadcast-owner-fixture-${crypto.randomUUID()}`,
				requestedSupervisorId: supervisorId,
				claimedBySupervisorId: supervisorId,
				status: "awaiting_session",
				requestedByUserId: "user-broadcast-A",
			});

		const updates: Array<{ sessionId: string; ownerUserId: string | null }> = [];
		const listener = (session: unknown) => {
			updates.push(session as { sessionId: string; ownerUserId: string | null });
		};
		sessionBus.on("session_updated", listener);
		try {
			const res = await app.request(`/api/v1/supervisors/${supervisorId}/managed-session-state`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentPulse-Supervisor-Token": supervisorCredential,
				},
				body: JSON.stringify({ sessionId, status: "active", agentType: "claude_code" }),
			});
			expect(res.status).toBe(200);
		} finally {
			sessionBus.off("session_updated", listener);
		}

		const broadcastForThisSession = updates.find((u) => u.sessionId === sessionId);
		expect(broadcastForThisSession).toBeDefined();
		expect(broadcastForThisSession?.ownerUserId).toBe("user-broadcast-A");

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-broadcast-A");
	});
});
