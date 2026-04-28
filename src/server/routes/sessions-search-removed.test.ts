// Slice SEARCH-1 — the legacy GET /sessions/search route is gone.
//
// With the explicit handler removed, requests to `/sessions/search` now
// fall through to the parameterized `GET /sessions/:sessionId` route
// with `sessionId = "search"`. The expected behavior is a 404 with the
// standard "Session not found" body. This test locks that behavior down
// so a future re-introduction of a `/sessions/search` route is a
// deliberate decision instead of an accident.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { db, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema.js");
const { sessionsRouter } = await import("./sessions.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(() => {
	initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
});

describe("GET /sessions/search (legacy, removed)", () => {
	test("falls through to /sessions/:sessionId and returns 404", async () => {
		const res = await app.request("/api/v1/sessions/search?q=anything");
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Session not found");
	});

	test("returns 404 even when sessions exist whose content matches the query", async () => {
		// The legacy route would have LIKE-matched these; the FTS-backed
		// `/api/v1/search` endpoint is the only path that does so now.
		await db.insert(sessions).values({
			sessionId: "real-session-id",
			agentType: "claude_code",
			displayName: "matches search keyword",
			cwd: "/tmp/search-test",
		});

		const res = await app.request("/api/v1/sessions/search?q=search");
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Session not found");
	});
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
