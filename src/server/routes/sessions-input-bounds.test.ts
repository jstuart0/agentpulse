/**
 * Bounds on caller-supplied values at the sessions routes: the three
 * invalid-value refusals echo a short prefix at most, and the timeline's
 * limit and offset are validated the way the list's are.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, events } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function world() {
	await setStoredMode("solo");
	const me = await seedLocalUser("bounds-me");
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: "bounds-1",
			displayName: "bounds-1",
			agentType: "claude_code",
			status: "active",
			metadata: {},
			startedAt: now,
			lastActivityAt: now,
			ownerUserId: me.id,
		} as never);
	return { headers: await cookieHeadersFor(me.id) };
}

async function request(method: string, path: string, headers: Headers, body?: unknown) {
	const init: RequestInit = { method, headers: new Headers(headers) };
	if (body !== undefined) {
		(init.headers as Headers).set("Content-Type", "application/json");
		init.body = JSON.stringify(body);
	}
	const res = await app.request(`/api/v1${path}`, init);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LONG = "z".repeat(500);

describe("invalid values are echoed as a short prefix", () => {
	test("operational", async () => {
		const w = await world();
		const res = await request("GET", `/sessions?operational=${LONG}`, w.headers);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid_operational");
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
	});

	test("fields", async () => {
		const w = await world();
		const res = await request("GET", `/sessions?fields=${LONG}`, w.headers);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid_field");
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
	});

	test("rename source", async () => {
		const w = await world();
		const res = await request("PUT", "/sessions/bounds-1/rename", w.headers, {
			name: "x",
			source: LONG,
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid_source");
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
	});

	test("a short invalid value is still echoed whole", async () => {
		const w = await world();
		const res = await request("GET", "/sessions?operational=bogus", w.headers);
		expect(res.body.value).toBe("bogus");
	});
});

describe("timeline limit and offset", () => {
	test("bad values are a 400 like the list's, with a short echo", async () => {
		const w = await world();
		for (const limit of ["abc", "1.5", "-1", "0", "5001", "1e3", "NaN", "Infinity"]) {
			const res = await request("GET", `/sessions/bounds-1/timeline?limit=${limit}`, w.headers);
			expect({ limit, status: res.status, error: res.body.error }).toEqual({
				limit,
				status: 400,
				error: "invalid_limit",
			});
		}
		for (const offset of ["abc", "1.5", "-1", "1000001", "1e3", "NaN"]) {
			const res = await request("GET", `/sessions/bounds-1/timeline?offset=${offset}`, w.headers);
			expect({ offset, status: res.status, error: res.body.error }).toEqual({
				offset,
				status: 400,
				error: "invalid_offset",
			});
		}
		const long = await request(
			"GET",
			`/sessions/bounds-1/timeline?limit=${"9".repeat(500)}`,
			w.headers,
		);
		expect(String(long.body.value).length).toBeLessThanOrEqual(64);
	});

	test("the defaults and the bounds are fine", async () => {
		const w = await world();
		for (const query of [
			"",
			"?limit=1",
			"?limit=5000",
			"?offset=0",
			"?limit=&offset=",
			"?limit=10&offset=5",
		]) {
			const res = await request("GET", `/sessions/bounds-1/timeline${query}`, w.headers);
			expect({ query, status: res.status }).toEqual({ query, status: 200 });
		}
	});
});
