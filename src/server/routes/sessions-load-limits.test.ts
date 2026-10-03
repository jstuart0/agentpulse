/**
 * Bounds on the work one caller can queue through the stats and list routes:
 * past the own-turn queue's depth ceiling a request is answered 503 busy, and
 * an `owner=<id>` that matches no user is answered with an empty, correctly
 * shaped result without running a scan.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";
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
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { OWN_TURN_MAX_WAITING, runInOwnTurn } = await import("../util/own-turn.js");

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

const ORPHAN_OWNER = "5c1d9e7a-2b3f-4a60-8d1e-7f3a9b2c4d5e";

async function world() {
	await setStoredMode("team");
	const me = await seedLocalUser("load-me");
	const emptyUser = await seedLocalUser("load-empty");
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values(
			[
				{ sessionId: "mine-1", ownerUserId: me.id },
				{ sessionId: "orphan-1", ownerUserId: ORPHAN_OWNER },
			].map((row) => ({
				...row,
				displayName: row.sessionId,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				startedAt: now,
				lastActivityAt: now,
			})) as never,
		);
	return { me, emptyUser, headers: await cookieHeadersFor(me.id) };
}

async function get(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("an owner id that matches no user", () => {
	for (const path of ["/sessions", "/sessions/stats", "/sessions/stats?group_by=owner"]) {
		const sep = path.includes("?") ? "&" : "?";
		test(`${path} answers the same shape as a user with no sessions`, async () => {
			const w = await world();
			const known = await get(`${path}${sep}owner=${w.emptyUser.id}`, w.headers);
			const unknown = await get(`${path}${sep}owner=${ORPHAN_OWNER}`, w.headers);
			expect(unknown.res.status).toBe(200);
			expect(known.res.status).toBe(200);
			const scrub = ({ ownerScope, ...rest }: Record<string, unknown>) => rest;
			expect(scrub(unknown.body)).toEqual(scrub(known.body));
			expect(unknown.body.ownerScope).toEqual({ kind: "user", userId: ORPHAN_OWNER });
		});

		test(`${path} runs no scan for it (sessions owned by an id with no user are not read)`, async () => {
			const w = await world();
			const unknownCalls = await countDbCalls(async () => {
				await get(`${path}${sep}owner=${ORPHAN_OWNER}`, w.headers);
			});
			const knownCalls = await countDbCalls(async () => {
				await get(`${path}${sep}owner=${w.emptyUser.id}`, w.headers);
			});
			expect(unknownCalls).toBeLessThan(knownCalls);
		});
	}

	test("the orphan's sessions do not appear through it", async () => {
		const w = await world();
		const list = await get(`/sessions?owner=${ORPHAN_OWNER}`, w.headers);
		expect(list.body.sessions).toEqual([]);
		expect(list.body.total).toBe(0);
	});
});

/** Holds the own-turn queue full: one job running behind a gate and the ceiling's worth waiting. */
async function fillQueue() {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started = false;
	const running = runInOwnTurn(async () => {
		started = true;
		await gate;
	});
	while (!started) await new Promise((resolve) => setImmediate(resolve));
	const waiting = Array.from({ length: OWN_TURN_MAX_WAITING }, () =>
		runInOwnTurn(async () => undefined),
	);
	return async () => {
		release();
		await Promise.all([running, ...waiting]);
	};
}

/** A request that is answered, or null if it is still waiting after a moment (a request queued behind a full queue). */
async function getOrNull(path: string, headers: Headers) {
	return Promise.race([
		get(path, headers),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
	]);
}

describeSqliteOnly("the own-turn queue ceiling (SQLite)", () => {
	test("a stats or list request past the ceiling is a 503 busy with Retry-After, and service resumes", async () => {
		const w = await world();
		const drain = await fillQueue();
		try {
			for (const path of [
				"/sessions/stats",
				"/sessions/stats?group_by=owner",
				"/sessions?operational=idle",
			]) {
				const answered = await getOrNull(path, w.headers);
				expect({ path, status: answered?.res.status, body: answered?.body }).toEqual({
					path,
					status: 503,
					body: { error: "busy" },
				});
				expect(answered?.res.headers.get("Retry-After")).toBe("1");
			}
		} finally {
			await drain();
		}
		const after = await get("/sessions/stats", w.headers);
		expect(after.res.status).toBe(200);
	});

	test("a plain list needs no scan and is not refused while the queue is full", async () => {
		const w = await world();
		const drain = await fillQueue();
		try {
			const answered = await getOrNull("/sessions", w.headers);
			expect(answered?.res.status).toBe(200);
		} finally {
			await drain();
		}
	});
});
