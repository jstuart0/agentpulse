/**
 * GET /projects/:id/sessions no longer returns raw session rows, which
 * used to leak ingestKeyId. Its rows must be shaped exactly like
 * GET /sessions rows — through mapSessionDto, with
 * ownerKind/nameSource/nativeName present and ingestKeyId absent.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { managedSessions, projects, sessions } = await import("../db/schema/index.js");

beforeAll(async () => {
	await initializeDatabase();
});

describe("GET /projects/:id/sessions goes through mapSessionDto", () => {
	test("rows have no ingestKeyId and do have ownerKind/nameSource/nativeName", async () => {
		const { key } = await createApiKey(`projects-sessions-dto-test-${crypto.randomUUID()}`, [
			"manage",
		]);
		const projectId = crypto.randomUUID();
		const now = new Date().toISOString();
		await getDb()
			.insert(projects)
			.values({
				id: projectId,
				cwd: `/tmp/projects-sessions-dto-${projectId.slice(0, 8)}`,
				name: `dto-test-project-${projectId.slice(0, 8)}`,
				createdAt: now,
				updatedAt: now,
			});
		const sessionId = `projects-sessions-dto-session-${crypto.randomUUID()}`;
		await getDb().insert(sessions).values({
			sessionId,
			displayName: "dto-test-session",
			agentType: "claude_code",
			status: "active",
			projectId,
			ingestKeyId: "some-key-id",
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
		});

		const res = await app.request(`/api/v1/projects/${projectId}/sessions`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
		expect(body.sessions.length).toBeGreaterThan(0);
		const row = body.sessions.find((s) => s.sessionId === sessionId);
		expect(row).toBeDefined();
		expect(row).not.toHaveProperty("ingestKeyId");
		expect(row?.ownerKind).toBe("service");
		expect(row).toHaveProperty("nameSource");
		expect(row).toHaveProperty("nativeName");
	});
});

describe("GET /projects/:id/sessions rows carry the effective machine, as the session list's do", () => {
	test("the supervisor's host for a launched session, else the reported host, else null", async () => {
		const { key } = await createApiKey(`projects-sessions-machine-${crypto.randomUUID()}`, [
			"manage",
		]);
		const projectId = crypto.randomUUID();
		const now = new Date().toISOString();
		await getDb()
			.insert(projects)
			.values({
				id: projectId,
				cwd: `/tmp/projects-sessions-machine-${projectId.slice(0, 8)}`,
				name: `machine-test-project-${projectId.slice(0, 8)}`,
				createdAt: now,
				updatedAt: now,
			});
		const suffix = crypto.randomUUID().slice(0, 8);
		const base = {
			agentType: "claude_code",
			status: "active",
			projectId,
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
		};
		const reported = `machine-reported-${suffix}`;
		const supervised = `machine-supervised-${suffix}`;
		const bare = `machine-bare-${suffix}`;
		await getDb()
			.insert(sessions)
			.values([
				{ ...base, sessionId: reported, reportedHost: "laptop-1" },
				{ ...base, sessionId: supervised, reportedHost: "ignored-name" },
				{ ...base, sessionId: bare },
			]);
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: supervised,
				launchRequestId: `launch-${suffix}`,
				supervisorId: "supervisor-1",
				hostName: "build-01",
			});

		const res = await app.request(`/api/v1/projects/${projectId}/sessions`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sessions: Array<{ sessionId: string; machine?: unknown }>;
		};
		const machineOf = (id: string) => body.sessions.find((s) => s.sessionId === id)?.machine;
		expect(machineOf(reported)).toBe("laptop-1");
		expect(machineOf(supervised)).toBe("build-01");
		expect(machineOf(bare)).toBeNull();

		// the same row the list serves
		const list = await app.request(`/api/v1/sessions?projectId=${projectId}`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		const listed = (await list.json()) as {
			sessions: Array<{ sessionId: string; machine?: unknown }>;
		};
		for (const row of body.sessions) {
			expect(listed.sessions.find((s) => s.sessionId === row.sessionId)?.machine).toBe(row.machine);
		}
	});
});
