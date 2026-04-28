import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { db, initializeDatabase } = await import("../db/client.js");
const { controlActions, projects, sessions, supervisors } = await import("../db/schema.js");
const { projectsRouter } = await import("./projects.js");
const { Hono } = await import("hono");

const app = new Hono().route("/api/v1", projectsRouter);

const originalDisableAuth = config.disableAuth;

beforeAll(() => {
	initializeDatabase();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await db.delete(controlActions).execute();
	await db.delete(sessions).execute();
	await db.delete(projects).execute();
	await db.delete(supervisors).execute();
});

async function seedSupervisor(features: string[]): Promise<string> {
	const id = crypto.randomUUID();
	const future = new Date(Date.now() + 60_000).toISOString();
	const now = new Date().toISOString();
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
			features,
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

async function seedProject(input: {
	tags: string[];
	name?: string;
	cwd?: string;
}): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: input.name ?? `proj-${id.slice(0, 8)}`,
		cwd: input.cwd ?? "/tmp/scratch-fixture",
		tags: input.tags,
		isFavorite: false,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function postCleanup(id: string) {
	return app.request(`/api/v1/projects/${id}/cleanup-workarea`, { method: "POST" });
}

describe("POST /projects/:id/cleanup-workarea", () => {
	test("returns 404 when project does not exist", async () => {
		const res = await postCleanup("does-not-exist");
		expect(res.status).toBe(404);
	});

	test("rejects with 400 when project lacks scratch tag", async () => {
		await seedSupervisor(["can_run_prelaunch_actions", "can_cleanup_workarea"]);
		const id = await seedProject({ tags: ["ai-initiated"] });
		const res = await postCleanup(id);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe("string");
		expect(body.error).toContain("scratch");
	});

	test("rejects with 400 when project lacks ai-initiated tag", async () => {
		await seedSupervisor(["can_run_prelaunch_actions", "can_cleanup_workarea"]);
		const id = await seedProject({ tags: ["scratch"] });
		const res = await postCleanup(id);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("AI-initiated");
	});

	test("returns 409 when no connected supervisor advertises can_cleanup_workarea", async () => {
		await seedSupervisor(["can_run_prelaunch_actions"]);
		const id = await seedProject({ tags: ["scratch", "ai-initiated"] });
		const res = await postCleanup(id);
		expect(res.status).toBe(409);
	});

	test("queues a cleanup_workarea control_action with the right payload", async () => {
		const supervisorId = await seedSupervisor([
			"can_run_prelaunch_actions",
			"can_cleanup_workarea",
		]);
		const id = await seedProject({
			tags: ["scratch", "ai-initiated"],
			cwd: "/tmp/agentpulse-work/plan-caching",
		});

		const res = await postCleanup(id);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.queued).toBe(true);
		expect(body.targetSupervisorId).toBe(supervisorId);
		expect(body.action.actionType).toBe("cleanup_workarea");
		expect(body.action.status).toBe("queued");

		const rows = await db.select().from(controlActions).execute();
		expect(rows.length).toBe(1);
		const meta = (rows[0].metadata ?? {}) as Record<string, unknown>;
		expect(meta.projectId).toBe(id);
		expect(meta.cwd).toBe("/tmp/agentpulse-work/plan-caching");
		expect(meta.targetSupervisorId).toBe(supervisorId);
		expect(rows[0].sessionId).toBeNull();
	});

	test("reports session count for the modal copy", async () => {
		await seedSupervisor(["can_run_prelaunch_actions", "can_cleanup_workarea"]);
		const id = await seedProject({
			tags: ["scratch", "ai-initiated"],
			cwd: "/tmp/agentpulse-work/has-sessions",
		});
		const now = new Date().toISOString();
		await db.insert(sessions).values([
			{
				sessionId: `sess-${crypto.randomUUID()}`,
				agentType: "claude_code",
				cwd: "/tmp/agentpulse-work/has-sessions",
				projectId: id,
				startedAt: now,
				lastActivityAt: now,
			},
			{
				sessionId: `sess-${crypto.randomUUID()}`,
				agentType: "claude_code",
				cwd: "/tmp/agentpulse-work/has-sessions",
				projectId: id,
				startedAt: now,
				lastActivityAt: now,
			},
		]);

		const res = await postCleanup(id);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.sessionCount).toBe(2);
	});
});
