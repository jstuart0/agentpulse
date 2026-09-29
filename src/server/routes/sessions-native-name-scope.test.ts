/**
 * Phase 2 (D1, D14, D20): PUT /sessions/:id/native-name is callable by an
 * ingest-only key (the relay/statusline's real-world key shape), while
 * every other mutating session route stays manage-only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey, SCOPE_INGEST, SCOPE_OBSERVE } = await import("../auth/api-key.js");
const { _resetBucketsForTest, _setRateLimitClockForTest, RATE_LIMIT_CAPACITY, tryConsume } =
	await import("../middleware/hook-rate-limit.js");
const { eq } = await import("drizzle-orm");

const originalDisableAuth = config.disableAuth;

function authBearer(key: string): Headers {
	return new Headers({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
}

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			...overrides,
		})
		.execute();
}

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = false;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
	_resetBucketsForTest();
});

afterEach(() => {
	_setRateLimitClockForTest(null);
	_resetBucketsForTest();
});

// F132: always select the row under test. Async ingestion from a /hooks test
// can land a session after beforeEach cleared the table.
async function rowFor(sessionId: string) {
	const [row] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.execute();
	return row;
}

describe("PUT /sessions/:id/native-name — ingest-only key", () => {
	test("known session -> 200, name updated", async () => {
		await mkSession("known-1", { displayName: "brave-falcon" });
		const { key } = await createApiKey("ingest-only", [SCOPE_INGEST]);
		const res = await app.request("/api/v1/sessions/known-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "native-name-from-claude" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.applied).toBe(true);
	});

	test("unknown session -> 404", async () => {
		const { key } = await createApiKey("ingest-only-2", [SCOPE_INGEST]);
		const res = await app.request("/api/v1/sessions/does-not-exist/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(404);
	});

	test("control-only name (\\x00\\x01) sanitizes to empty -> 400", async () => {
		await mkSession("control-only-1", { displayName: "brave-falcon" });
		const { key } = await createApiKey("ingest-only-3", [SCOPE_INGEST]);
		const res = await app.request("/api/v1/sessions/control-only-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "\x00\x01" }),
		});
		expect(res.status).toBe(400);
	});

	test("a pinned session -> 200 applied:false, displayName unchanged", async () => {
		await mkSession("pinned-1", {
			displayName: "human-chosen-name",
			metadata: { renameSource: "user" },
		});
		const { key } = await createApiKey("ingest-only-4", [SCOPE_INGEST]);
		const res = await app.request("/api/v1/sessions/pinned-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "native-name-from-claude" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.applied).toBe(false);
		const row = await rowFor("pinned-1");
		expect(row.displayName).toBe("human-chosen-name");
	});

	test("ingest-only key still gets 403 on /rename, /notes, and GET /sessions", async () => {
		await mkSession("scope-check-1");
		const { key } = await createApiKey("ingest-only-5", [SCOPE_INGEST]);
		const renameRes = await app.request("/api/v1/sessions/scope-check-1/rename", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "x", source: "user" }),
		});
		expect(renameRes.status).toBe(403);

		const notesRes = await app.request("/api/v1/sessions/scope-check-1/notes", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ notes: "x" }),
		});
		expect(notesRes.status).toBe(403);

		const listRes = await app.request("/api/v1/sessions", { headers: authBearer(key) });
		expect(listRes.status).toBe(403);
	});

	test("an observe-only key gets 403 on /native-name", async () => {
		await mkSession("observe-check-1");
		const { key } = await createApiKey("observe-only-1", [SCOPE_OBSERVE]);
		const res = await app.request("/api/v1/sessions/observe-check-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(403);
	});
});

describe("PUT /sessions/:id/native-name — rate limit (D20, F26)", () => {
	// The shared token bucket is continuous-refill (100 tokens/s), by design —
	// a steady low-rate caller is never throttled. That means a fixed count of
	// exactly 100 real (DB-backed) requests does not deterministically exhaust
	// it: wall-clock time spent per request refills a few tokens back before
	// the loop finishes. 300 sequential real calls builds in enough margin
	// that the limiter is guaranteed to trip well before the loop ends,
	// without asserting a specific call index — the property under test is
	// "this key does get 429'd, with the documented body shape", not "exactly
	// call N is the first to fail".
	test("sustained calls from one API key exceed the rate limit -> 429 {error:rate_limited} at least once; a second key is unaffected", async () => {
		await mkSession("rl-1");
		const { key: keyA, id: idA } = await createApiKey("rl-key-a", [SCOPE_INGEST]);
		const { key: keyB } = await createApiKey("rl-key-b", [SCOPE_INGEST]);

		// F132: a frozen clock means no refill, whatever the backend's speed.
		// Drain all but one token of key A's bucket directly, then the last
		// token is a 200 and the next call is the 429.
		const frozen = Date.now();
		_setRateLimitClockForTest(() => frozen);
		for (let i = 0; i < RATE_LIMIT_CAPACITY - 1; i++) {
			expect(tryConsume(`native-name:${idA}`)).toBe(true);
		}
		const put = (key: string, name: string) =>
			app.request("/api/v1/sessions/rl-1/native-name", {
				method: "PUT",
				headers: authBearer(key),
				body: JSON.stringify({ name }),
			});
		expect((await put(keyA, "last-token")).status).toBe(200);
		const limited = await put(keyA, "over-limit");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "rate_limited" });

		// A different key's bucket is untouched.
		const resB = await app.request("/api/v1/sessions/rl-1/native-name", {
			method: "PUT",
			headers: authBearer(keyB),
			body: JSON.stringify({ name: "name-from-b" }),
		});
		expect(resB.status).toBe(200);
	});

	test("/hooks stays silent-200 on its own rate limit even after /native-name's limiter changes (default onLimit unaffected)", async () => {
		const { key } = await createApiKey("rl-hooks-key", [SCOPE_INGEST]);
		let lastRes: Response | undefined;
		for (let i = 0; i < 101; i++) {
			lastRes = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: authBearer(key),
				body: JSON.stringify({ session_id: "rl-hooks-s1", hook_event_name: "UserPromptSubmit" }),
			});
		}
		expect(lastRes?.status).toBe(200);
	});
});

// xander F92: PUT /native-name is ingest-reachable; an oversize body is
// refused by a 16 KiB body limit before the handler parses it.
describe("PUT /sessions/:id/native-name — 16 KiB body limit", () => {
	const LIMIT = 16 * 1024;

	test("an oversize body -> 413, even when it isn't valid JSON (never parsed)", async () => {
		await mkSession("big-1", { displayName: "brave-falcon" });
		const { key } = await createApiKey("ingest-big", [SCOPE_INGEST]);
		const oversizeJson = JSON.stringify({ name: "x".repeat(LIMIT + 1) });
		const res = await app.request("/api/v1/sessions/big-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: oversizeJson,
		});
		expect(res.status).toBe(413);

		const notJson = `{${"y".repeat(LIMIT + 1)}`;
		const res2 = await app.request("/api/v1/sessions/big-1/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body: notJson,
		});
		expect(res2.status).toBe(413);

		const row = await rowFor("big-1");
		expect(row.displayName).toBe("brave-falcon");
	});

	test("positive control: a body just under the limit is processed", async () => {
		await mkSession("big-2", { displayName: "brave-falcon" });
		const { key } = await createApiKey("ingest-big-2", [SCOPE_INGEST]);
		const body = JSON.stringify({ name: `ok-${"z".repeat(LIMIT - 64)}` });
		expect(body.length).toBeLessThan(LIMIT);
		const res = await app.request("/api/v1/sessions/big-2/native-name", {
			method: "PUT",
			headers: authBearer(key),
			body,
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { applied: boolean }).applied).toBe(true);
	});
});
