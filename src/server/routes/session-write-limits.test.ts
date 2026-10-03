/**
 * The dashboard's per-caller rate-limit buckets on the real routes. A caller's
 * bucket is theirs alone (one signed-in user exhausting theirs doesn't touch
 * another's), and a session id that doesn't exist answers 404 before any bucket
 * is created for it, so the table can't be grown by making ids up.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const {
	RATE_LIMIT_CAPACITY,
	_resetBucketsForTest,
	_setRateLimitClockForTest,
	_trackedBucketsForTest,
} = await import("../middleware/hook-rate-limit.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	_setRateLimitClockForTest(null);
	_resetBucketsForTest();
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

const acknowledge = (sessionId: string, headers: Headers) =>
	app.request(`/api/v1/sessions/${sessionId}/acknowledge`, jsonRequest("POST", {}, headers));

describe("per-caller buckets on the acknowledge route", () => {
	test("one signed-in user exhausting their bucket is throttled; another user is unaffected", async () => {
		const first = await seedLocalUser("wl-first");
		const second = await seedLocalUser("wl-second");
		await getDb()
			.insert(sessions)
			.values({ sessionId: "wl-1", agentType: "claude_code", status: "completed" });
		const firstHeaders = await cookieHeadersFor(first.id);
		const secondHeaders = await cookieHeadersFor(second.id);
		_setRateLimitClockForTest(() => 7_000_000);
		try {
			for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
				expect((await acknowledge("wl-1", firstHeaders)).status).toBe(200);
			}
			const throttled = await acknowledge("wl-1", firstHeaders);
			expect(throttled.status).toBe(429);
			expect(((await throttled.json()) as { error: string }).error).toBe("rate_limited");

			expect((await acknowledge("wl-1", secondHeaders)).status).toBe(200);
		} finally {
			_setRateLimitClockForTest(null);
		}
	});
});

describe("a session that doesn't exist answers 404 before any bucket is made", () => {
	test("cookie callers on acknowledge, un-acknowledge and native-name", async () => {
		const user = await seedLocalUser("wl-404");
		const headers = await cookieHeadersFor(user.id);
		for (let i = 0; i < 20; i++) {
			const id = `no-such-${i}`;
			expect((await acknowledge(id, headers)).status).toBe(404);
			const unack = await app.request(
				`/api/v1/sessions/${id}/acknowledge`,
				jsonRequest("DELETE", {}, headers),
			);
			expect(unack.status).toBe(404);
			const named = await app.request(
				`/api/v1/sessions/${id}/native-name`,
				jsonRequest("PUT", { name: "x" }, headers),
			);
			expect(named.status).toBe(404);
		}
		expect(_trackedBucketsForTest()).toBe(0);
	});

	test("a real session still gets its bucket", async () => {
		const user = await seedLocalUser("wl-real");
		await getDb()
			.insert(sessions)
			.values({ sessionId: "wl-real", agentType: "claude_code", status: "completed" });
		expect((await acknowledge("wl-real", await cookieHeadersFor(user.id))).status).toBe(200);
		expect(_trackedBucketsForTest()).toBe(1);
	});

	test("an API key's native-name write for an unknown session is the same 404 as before", async () => {
		const { key } = await seedKey("wl-key", ["ingest"]);
		const res = await app.request(
			"/api/v1/sessions/no-such/native-name",
			jsonRequest("PUT", { name: "x" }, bearerHeaders(key)),
		);
		expect(res.status).toBe(404);
	});
});
