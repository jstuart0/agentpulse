/**
 * GET /sessions query validation: limit and offset are bounded integers on
 * both the full list and the narrow projection, `fields` can't be combined with
 * `operational` (the projection would silently ignore it), an uppercase user id
 * means the same user as its lowercase form, and a refusal never echoes more
 * than a short prefix of what the caller sent.
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
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function world() {
	await setStoredMode("team");
	const me = await seedLocalUser("val-me");
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values(
			["val-1", "val-2", "val-3"].map((sessionId) => ({
				sessionId,
				agentType: "claude_code",
				status: "active",
				displayName: sessionId,
				metadata: {},
				startedAt: now,
				lastActivityAt: now,
				ownerUserId: sessionId === "val-3" ? null : me.id,
			})) as never,
		);
	return { me, headers: await cookieHeadersFor(me.id) };
}

async function get(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("limit and offset", () => {
	const BAD_LIMITS = [
		"abc",
		"1.5",
		"-1",
		"0",
		"5001",
		"1e3",
		"NaN",
		"Infinity",
		"0x10",
		"99999999999",
	];
	const BAD_OFFSETS = ["abc", "1.5", "-1", "1000001", "1e3", "NaN", "Infinity"];

	test("a limit that isn't an integer from 1 to 5000 is a 400, on the full list and the projection", async () => {
		const w = await world();
		for (const limit of BAD_LIMITS) {
			for (const extra of ["", "&fields=sessionId"]) {
				const res = await get(`/sessions?limit=${limit}${extra}`, w.headers);
				expect({ limit, extra, status: res.status, error: res.body.error }).toEqual({
					limit,
					extra,
					status: 400,
					error: "invalid_limit",
				});
			}
		}
	});

	test("an offset that isn't a non-negative integer within bounds is a 400, on both", async () => {
		const w = await world();
		for (const offset of BAD_OFFSETS) {
			for (const extra of ["", "&fields=sessionId"]) {
				const res = await get(`/sessions?offset=${offset}${extra}`, w.headers);
				expect({ offset, extra, status: res.status, error: res.body.error }).toEqual({
					offset,
					extra,
					status: 400,
					error: "invalid_offset",
				});
			}
		}
	});

	test("the bounds themselves and the defaults are fine", async () => {
		const w = await world();
		for (const path of [
			"/sessions",
			"/sessions?limit=1",
			"/sessions?limit=5000",
			"/sessions?offset=0",
			"/sessions?offset=1000000",
			"/sessions?limit=2&offset=1&fields=sessionId",
			"/sessions?limit=&offset=",
		]) {
			expect({ path, status: (await get(path, w.headers)).status }).toEqual({ path, status: 200 });
		}
		const page = await get("/sessions?limit=2&offset=1", w.headers);
		expect((page.body.sessions as unknown[]).length).toBe(2);
	});

	test("a refused value is echoed as a short prefix at most", async () => {
		const w = await world();
		const res = await get(`/sessions?limit=${"9".repeat(500)}`, w.headers);
		expect(res.status).toBe(400);
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
	});
});

describe("fields together with operational", () => {
	test("is a 400 unsupported_combination instead of silently ignoring operational", async () => {
		const w = await world();
		const res = await get("/sessions?fields=sessionId&operational=waiting", w.headers);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("unsupported_combination");
	});

	test("each alone still works", async () => {
		const w = await world();
		expect((await get("/sessions?fields=sessionId", w.headers)).status).toBe(200);
		expect((await get("/sessions?operational=idle", w.headers)).status).toBe(200);
	});
});

describe("the owner value", () => {
	test("an uppercase user id means the same user as its lowercase form", async () => {
		const w = await world();
		const upper = await get(`/sessions?owner=${w.me.id.toUpperCase()}`, w.headers);
		expect(upper.status).toBe(200);
		expect(upper.body.ownerScope).toEqual({ kind: "user", userId: w.me.id });
		expect(
			(upper.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId).sort(),
		).toEqual(["val-1", "val-2"]);
		const stats = await get(`/sessions/stats?owner=${w.me.id.toUpperCase()}`, w.headers);
		expect(stats.body.total).toBe(2);
	});

	test("an invalid owner is refused with at most a short prefix of what was sent", async () => {
		const w = await world();
		const res = await get(`/sessions?owner=${"z".repeat(500)}`, w.headers);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid_owner");
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
		const short = await get("/sessions/stats?owner=everybody", w.headers);
		expect(short.body.value).toBe("everybody");
	});
});
