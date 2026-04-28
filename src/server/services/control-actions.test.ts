import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { db, initializeDatabase } = await import("../db/client.js");
const { controlActions, events, projects, sessions, supervisors } = await import("../db/schema.js");
const { claimNextControlAction, queueCleanupWorkArea, updateControlAction } = await import(
	"./control-actions.js"
);

beforeAll(() => {
	initializeDatabase();
});

afterAll(() => {});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(controlActions).execute();
	await db.delete(sessions).execute();
	await db.delete(projects).execute();
	await db.delete(supervisors).execute();
});

async function seedSupervisor(): Promise<string> {
	const id = `sup-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const future = new Date(Date.now() + 60_000).toISOString();
	await db.insert(supervisors).values({
		id,
		hostName: "test-host",
		platform: "darwin",
		arch: "arm64",
		version: "0.1.0",
		capabilities: {
			version: 1,
			agentTypes: ["claude_code"],
			launchModes: ["headless"],
			os: "macos",
			terminalSupport: [],
			features: ["can_run_prelaunch_actions", "can_cleanup_workarea"],
		},
		trustedRoots: ["/tmp"],
		status: "connected",
		capabilitySchemaVersion: 2,
		configSchemaVersion: 1,
		lastHeartbeatAt: now,
		heartbeatLeaseExpiresAt: future,
		enrollmentState: "active",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function seedScratchProject(): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: `proj-${id.slice(0, 8)}`,
		cwd: `/tmp/scratch-${id.slice(0, 8)}`,
		tags: ["scratch", "ai-initiated"],
		isFavorite: false,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

describe("cleanup_workarea control action", () => {
	test("claim picks up session-less cleanup actions targeted to this supervisor", async () => {
		const supervisorId = await seedSupervisor();
		const projectId = await seedScratchProject();

		const queued = await queueCleanupWorkArea({
			projectId,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			targetSupervisorId: supervisorId,
		});
		expect(queued.actionType).toBe("cleanup_workarea");

		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed).not.toBeNull();
		expect(claimed?.id).toBe(queued.id);
		expect(claimed?.status).toBe("running");
	});

	test("claim ignores cleanup actions targeted to a different supervisor", async () => {
		const supervisorId = await seedSupervisor();
		const projectId = await seedScratchProject();

		await queueCleanupWorkArea({
			projectId,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			targetSupervisorId: "some-other-supervisor",
		});

		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed).toBeNull();
	});

	test("succeeded status cascade-deletes the project and its sessions", async () => {
		const supervisorId = await seedSupervisor();
		const projectId = await seedScratchProject();

		const sessionRowId = crypto.randomUUID();
		const sessionTextId = `sess-${sessionRowId.slice(0, 8)}`;
		const now = new Date().toISOString();
		await db.insert(sessions).values({
			id: sessionRowId,
			sessionId: sessionTextId,
			agentType: "claude_code",
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			projectId,
			startedAt: now,
			lastActivityAt: now,
		});
		await db.insert(events).values({
			sessionId: sessionTextId,
			eventType: "SessionStart",
			rawPayload: { hook_event_name: "SessionStart", session_id: sessionTextId },
			createdAt: now,
		});

		const queued = await queueCleanupWorkArea({
			projectId,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			targetSupervisorId: supervisorId,
		});
		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed?.id).toBe(queued.id);

		const updated = await updateControlAction({
			actionId: queued.id,
			supervisorId,
			status: "succeeded",
		});
		expect(updated?.status).toBe("succeeded");

		const remainingProjects = await db.select().from(projects).execute();
		expect(remainingProjects.length).toBe(0);
		const remainingSessions = await db.select().from(sessions).execute();
		expect(remainingSessions.length).toBe(0);
		const remainingEvents = await db.select().from(events).execute();
		expect(remainingEvents.length).toBe(0);
	});

	test("failed status leaves the project and its sessions intact", async () => {
		const supervisorId = await seedSupervisor();
		const projectId = await seedScratchProject();

		const queued = await queueCleanupWorkArea({
			projectId,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			targetSupervisorId: supervisorId,
		});
		await claimNextControlAction(supervisorId);
		await updateControlAction({
			actionId: queued.id,
			supervisorId,
			status: "failed",
			error: "permission_denied",
		});

		const remainingProjects = await db.select().from(projects).execute();
		expect(remainingProjects.length).toBe(1);
	});
});
