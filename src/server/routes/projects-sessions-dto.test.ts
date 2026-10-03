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
const { projects, sessions } = await import("../db/schema/index.js");

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
