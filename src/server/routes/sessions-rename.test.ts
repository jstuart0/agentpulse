// Phase 6 (F5) — PUT /sessions/:id/rename `source` field + PUT
// /sessions/:id/native-name route. Route-level coverage for the precedence
// contract that session-tracker.test.ts exercises at the service layer;
// this file covers the HTTP surface (status codes, request/response shape)
// that the statusline script and relay actually hit.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { sessionsRouter } = await import("./sessions.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			...overrides,
		})
		.execute();
}

async function getSession(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

describe("PUT /sessions/:id/rename", () => {
	test("400 when name is missing/blank", async () => {
		await mkSession("blank-name");
		const res = await app.request("/api/v1/sessions/blank-name/rename", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "   " }),
		});
		expect(res.status).toBe(400);
	});

	test("no source in body → metadata.renameSource defaults to 'user'", async () => {
		await mkSession("route-default-source");
		const res = await app.request("/api/v1/sessions/route-default-source/rename", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "renamed-by-dashboard" }),
		});
		expect(res.status).toBe(200);
		const row = await getSession("route-default-source");
		expect(row?.displayName).toBe("renamed-by-dashboard");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("user");
	});

	test("source: 'sync' in body is forwarded to renameSession", async () => {
		await mkSession("route-sync-source");
		const res = await app.request("/api/v1/sessions/route-sync-source/rename", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "codex-thread-name", source: "sync" }),
		});
		expect(res.status).toBe(200);
		const row = await getSession("route-sync-source");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("sync");
	});
});

describe("PUT /sessions/:id/native-name", () => {
	test("400 when name is missing/blank", async () => {
		await mkSession("blank-native-name");
		const res = await app.request("/api/v1/sessions/blank-native-name/native-name", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "" }),
		});
		expect(res.status).toBe(400);
	});

	test("404 on unknown session (deliberate departure from /rename's silent no-op)", async () => {
		const res = await app.request("/api/v1/sessions/does-not-exist/native-name", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "some-native-name" }),
		});
		expect(res.status).toBe(404);
	});

	test("known session, no prior manual rename → 200, displayName updated", async () => {
		await mkSession("native-happy", { displayName: "brave-falcon" });
		const res = await app.request("/api/v1/sessions/native-happy/native-name", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "claude-native-name" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; applied: boolean };
		expect(body).toEqual({ ok: true, applied: true });

		const row = await getSession("native-happy");
		expect(row?.displayName).toBe("claude-native-name");
	});

	test("known session with a manual rename (renameSource: 'user') → 200 but displayName untouched", async () => {
		await mkSession("native-refused", {
			displayName: "human-chosen-name",
			metadata: { renameSource: "user" },
		});
		const res = await app.request("/api/v1/sessions/native-refused/native-name", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "claude-native-name" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; applied: boolean };
		expect(body).toEqual({ ok: true, applied: false });

		const row = await getSession("native-refused");
		expect(row?.displayName).toBe("human-chosen-name");
	});

	test("end-to-end precedence: manual rename via /rename blocks a subsequent /native-name pull", async () => {
		await mkSession("e2e-precedence", { displayName: "brave-falcon" });

		const renameRes = await app.request("/api/v1/sessions/e2e-precedence/rename", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "human-picked-name" }),
		});
		expect(renameRes.status).toBe(200);

		const nativeRes = await app.request("/api/v1/sessions/e2e-precedence/native-name", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "claude-native-name" }),
		});
		expect(nativeRes.status).toBe(200);
		const nativeBody = (await nativeRes.json()) as { ok: boolean; applied: boolean };
		expect(nativeBody.applied).toBe(false);

		const row = await getSession("e2e-precedence");
		expect(row?.displayName).toBe("human-picked-name");
	});
});
