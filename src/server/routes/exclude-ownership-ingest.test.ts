/**
 * Exclude rule x team mode, on the hook route.
 *
 * A delivery that carries the skip header is answered before anything is read
 * or stored, so it can never create a session row, and a session with no row
 * has no owner and appears in no count, list or tab for anybody. These tests
 * drive the real app in team mode with owned, foreign and ownerless keys and
 * compare the whole dashboard read model (stats under every owner scope,
 * grouped stats, every tab list, every tab count) before and after.
 *
 * They run on whichever database the suite is pointed at (SQLite by default,
 * Postgres under DATABASE_URL).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { SKIP_HEADER } = await import("../../shared/hook-headers.js");
const {
	_resetCountersForTest,
	getInFlightCount,
	getIngestForeignKeyDroppedCount,
	getIngestKeyBoundCount,
	getIngestOwnerMismatchCount,
	getIngestUnacknowledgeDroppedCount,
	getSessionCreationLimitedCount,
	getSkipHeaderDropped,
} = await import("./ingest-counters.js");
const { _resetSessionCreationLimitForTest } = await import("../services/session-creation-limit.js");
const { updateStaleSessions } = await import("../services/session-tracker.js");

const LIMIT_ENV = "AGENTPULSE_SESSION_CREATE_LIMIT";
const originalLimit = process.env[LIMIT_ENV];
const originalDisableAuth = config.disableAuth;

afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

beforeAll(async () => {
	await initializeDatabase();
	(await import("../routes/health.js")).markDbReady();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = false;
	if (originalLimit === undefined) {
		// assigning undefined to process.env would store the string "undefined"
		delete process.env[LIMIT_ENV];
	} else process.env[LIMIT_ENV] = originalLimit;
	_resetSessionCreationLimitForTest();
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

const NOW = () => new Date().toISOString();
const LONG_AGO = "2020-01-01T00:00:00.000Z";

interface World {
	a: { id: string; headers: Headers };
	b: { id: string };
	keyA: { id: string; key: string };
	keyB: { id: string; key: string };
	serviceKey: { id: string; key: string };
	otherServiceKey: { id: string; key: string };
}

async function world(): Promise<World> {
	await setStoredMode("team");
	const a = await seedLocalUser("xo-a");
	const b = await seedLocalUser("xo-b");
	return {
		a: { id: a.id, headers: await cookieHeadersFor(a.id) },
		b: { id: b.id },
		keyA: await seedKey("xo-key-a", ["ingest"], a.id),
		keyB: await seedKey("xo-key-b", ["ingest"], b.id),
		serviceKey: await seedKey("xo-service", ["ingest"]),
		otherServiceKey: await seedKey("xo-service-2", ["ingest"]),
	};
}

type SeedRow = Partial<typeof sessions.$inferInsert> & { sessionId: string };

async function seed(rows: SeedRow[]) {
	await getDb()
		.insert(sessions)
		.values(
			rows.map((row) => ({
				agentType: "claude_code",
				status: "active",
				displayName: row.sessionId,
				metadata: {},
				startedAt: NOW(),
				lastActivityAt: NOW(),
				...row,
			})),
		);
}

/** Every operational state, for three owners, an unassigned row and a service-key row. */
async function seedBaseline(w: World) {
	const done = NOW();
	await seed([
		{ sessionId: "a-working", ownerUserId: w.a.id, isWorking: true },
		{ sessionId: "a-waiting", ownerUserId: w.a.id, lastAgentTurnCompletedAt: done },
		{ sessionId: "a-error", ownerUserId: w.a.id, status: "failed", endedAt: done },
		{ sessionId: "a-done", ownerUserId: w.a.id, status: "completed", endedAt: done },
		{ sessionId: "b-working", ownerUserId: w.b.id, isWorking: true },
		{ sessionId: "b-waiting", ownerUserId: w.b.id, lastAgentTurnCompletedAt: done },
		{
			sessionId: "b-archived",
			ownerUserId: w.b.id,
			status: "completed",
			endedAt: done,
			isArchived: true,
		},
		{ sessionId: "u-waiting", lastAgentTurnCompletedAt: done },
		{ sessionId: "s-error", ingestKeyId: w.serviceKey.id, status: "failed", endedAt: done },
	]);
}

async function read(path: string, headers: Headers): Promise<unknown> {
	const res = await app.request(`/api/v1${path}`, { headers });
	expect({ path, status: res.status }).toEqual({ path, status: 200 });
	return res.json();
}

/**
 * The whole read model a viewer can ask for: stats under every owner scope,
 * grouped stats, and for every scope every tab's list (ids, in order) and total.
 */
async function snapshot(w: World) {
	const scopes = ["me", w.a.id, w.b.id, "unassigned", "service", "all", ""];
	const out: Record<string, unknown> = {};
	for (const scope of scopes) {
		const q = scope === "" ? "" : `owner=${scope}`;
		out[`stats ${q}`] = await read(`/sessions/stats${q ? `?${q}` : ""}`, w.a.headers);
		for (const tab of ["active", "completed", "archived"]) {
			const body = (await read(
				`/sessions?${q ? `${q}&` : ""}tab=${tab}&limit=100`,
				w.a.headers,
			)) as { sessions: Array<{ sessionId: string }>; total: number };
			out[`list ${q} ${tab}`] = { ids: body.sessions.map((s) => s.sessionId), total: body.total };
		}
	}
	out.groups = await read("/sessions/stats?group_by=owner", w.a.headers);
	return out;
}

async function healthCounters() {
	const res = await app.request("/api/v1/health");
	const body = (await res.json()) as Record<string, number>;
	return {
		skipHeaderDropped: body.skipHeaderDropped,
		foreignKeyDropped: body.foreignKeyDropped,
		ingestOwnerMismatch: body.ingestOwnerMismatch,
		ingestKeyBound: body.ingestKeyBound,
		sessionCreationLimited: body.sessionCreationLimited,
		unacknowledgeDropped: body.unacknowledgeDropped,
	};
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
	const start = Date.now();
	while (!(await cond())) {
		if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}
const settle = () => until(() => getInFlightCount() === 0);

async function post(
	path: "/hooks" | "/hooks/status",
	body: unknown,
	opts: { key?: string; skip?: string } = {},
) {
	const headers = opts.key ? bearerHeaders(opts.key) : new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("X-Agent-Type", "claude_code");
	if (opts.skip !== undefined) headers.set(SKIP_HEADER, opts.skip);
	return app.request(`/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const hook = (sessionId: string, eventName: string, extra: Record<string, unknown> = {}) => ({
	session_id: sessionId,
	hook_event_name: eventName,
	cwd: "/work/excluded",
	...extra,
});

async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}
async function eventCount(sessionId: string) {
	return (await getDb().select().from(events).where(eq(events.sessionId, sessionId))).length;
}

/** A normal first delivery: the session row appears, with the key's owner. */
async function createReal(sessionId: string, key: string) {
	const res = await post("/hooks", hook(sessionId, "SessionStart", { cwd: "/work/open" }), { key });
	expect(res.status).toBe(200);
	await until(async () => (await row(sessionId)) !== undefined);
	await settle();
}

const LIFECYCLE = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"Notification",
	"Stop",
	"StopFailure",
	"SessionEnd",
] as const;

describe("a skipped delivery creates no session row, so it is in no count, list or tab", () => {
	test("every lifecycle event, from an owned, a foreign and a service key, on both hook routes: the whole read model is unchanged and no row exists", async () => {
		const w = await world();
		await seedBaseline(w);
		const before = await snapshot(w);
		const rowsBefore = await getDb().select().from(sessions);
		const counters = await healthCounters();

		const ids: string[] = [];
		let delivered = 0;
		for (const [label, key] of [
			["owned", w.keyA.key],
			["foreign", w.keyB.key],
			["service", w.serviceKey.key],
		] as const) {
			for (const eventName of LIFECYCLE) {
				const id = `skipped-${label}-${eventName}`;
				ids.push(id);
				const res = await post("/hooks", hook(id, eventName), { key, skip: "1" });
				expect({ id, status: res.status }).toEqual({ id, status: 200 });
				delivered++;
			}
			const statusId = `skipped-${label}-status`;
			ids.push(statusId);
			const res = await post(
				"/hooks/status",
				{ session_id: statusId, status: "blocked", task: "private task" },
				{ key, skip: "true" },
			);
			expect(res.status).toBe(200);
			delivered++;
		}
		await settle();

		for (const id of ids) {
			expect({ id, exists: (await row(id)) !== undefined }).toEqual({ id, exists: false });
			expect({ id, events: await eventCount(id) }).toEqual({ id, events: 0 });
		}
		expect(await getDb().select().from(sessions)).toEqual(rowsBefore);
		expect(await snapshot(w)).toEqual(before);
		expect(await healthCounters()).toEqual({
			...counters,
			skipHeaderDropped: (counters.skipHeaderDropped ?? 0) + delivered,
		});
	});

	test("the same deliveries without the header do create rows and move the read model (the control: the snapshot can tell)", async () => {
		const w = await world();
		await seedBaseline(w);
		const before = await snapshot(w);

		await createReal("real-owned", w.keyA.key);
		await createReal("real-service", w.serviceKey.key);

		expect((await row("real-owned"))?.ownerUserId).toBe(w.a.id);
		expect((await row("real-service"))?.ownerUserId).toBeNull();
		expect(await snapshot(w)).not.toEqual(before);
		const mine = (await read("/sessions?owner=me&tab=active&limit=100", w.a.headers)) as {
			sessions: Array<{ sessionId: string }>;
		};
		expect(mine.sessions.map((s) => s.sessionId)).toContain("real-owned");
	});

	test("a status update with the header for a session that exists changes nothing about it", async () => {
		const w = await world();
		await createReal("status-existing", w.keyA.key);
		const rowBefore = await row("status-existing");
		const before = await snapshot(w);
		const res = await post(
			"/hooks/status",
			{ session_id: "status-existing", status: "blocked", task: "should not land" },
			{ key: w.keyA.key, skip: "1" },
		);
		expect(res.status).toBe(200);
		await settle();
		expect(await row("status-existing")).toEqual(rowBefore);
		expect(await snapshot(w)).toEqual(before);
	});
});

describe("a skipped delivery moves only the skip counter, whoever sent it", () => {
	async function expectOnlySkipMoved(
		deliver: () => Promise<void>,
		expectedSkips: number,
	): Promise<void> {
		const before = await healthCounters();
		await deliver();
		await settle();
		const after = await healthCounters();
		expect(after).toEqual({
			...before,
			skipHeaderDropped: (before.skipHeaderDropped ?? 0) + expectedSkips,
		});
	}

	test("a foreign owner's key on an owned session: no foreign-key drop, no owner mismatch, and the session is untouched", async () => {
		const w = await world();
		await createReal("fk-owned", w.keyA.key);
		const rowBefore = await row("fk-owned");
		const eventsBefore = await eventCount("fk-owned");
		await expectOnlySkipMoved(async () => {
			for (const eventName of ["PostToolUse", "Stop", "UserPromptSubmit"]) {
				const res = await post("/hooks", hook("fk-owned", eventName), {
					key: w.keyB.key,
					skip: "1",
				});
				expect(res.status).toBe(200);
			}
		}, 3);
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
		expect(getIngestOwnerMismatchCount()).toBe(0);
		expect(await row("fk-owned")).toEqual(rowBefore);
		expect(await eventCount("fk-owned")).toBe(eventsBefore);
	});

	test("an ownerless key that is not the session's recorded key: still only the skip counter", async () => {
		const w = await world();
		await seed([{ sessionId: "recorded", ownerUserId: w.a.id, ingestKeyId: w.serviceKey.id }]);
		const rowBefore = await row("recorded");
		await expectOnlySkipMoved(async () => {
			const res = await post("/hooks", hook("recorded", "PostToolUse"), {
				key: w.otherServiceKey.key,
				skip: "1",
			});
			expect(res.status).toBe(200);
		}, 1);
		expect(await row("recorded")).toEqual(rowBefore);
	});

	test("an ownerless key on an unowned, unbound session: the key is not bound to it", async () => {
		const w = await world();
		await seed([{ sessionId: "unbound" }]);
		await expectOnlySkipMoved(async () => {
			const res = await post("/hooks", hook("unbound", "PostToolUse"), {
				key: w.serviceKey.key,
				skip: "1",
			});
			expect(res.status).toBe(200);
		}, 1);
		expect(getIngestKeyBoundCount()).toBe(0);
		expect((await row("unbound"))?.ingestKeyId).toBeNull();
	});

	test("a key over its creation limit: the creation-limit counter stays flat, and skip requests spend none of the allowance", async () => {
		const w = await world();
		process.env[LIMIT_ENV] = "1";
		_resetSessionCreationLimitForTest();

		await expectOnlySkipMoved(async () => {
			for (let i = 0; i < 5; i++) {
				const res = await post("/hooks", hook(`limit-skip-${i}`, "SessionStart"), {
					key: w.keyA.key,
					skip: "1",
				});
				expect(res.status).toBe(200);
			}
		}, 5);
		expect(getSessionCreationLimitedCount()).toBe(0);

		// The allowance is untouched: one real creation still goes through, the next is limited.
		await createReal("limit-real-1", w.keyA.key);
		expect(getSessionCreationLimitedCount()).toBe(0);
		await post("/hooks", hook("limit-real-2", "SessionStart"), { key: w.keyA.key });
		await settle();
		expect(await row("limit-real-2")).toBeUndefined();
		expect(getSessionCreationLimitedCount()).toBe(1);

		// Over the limit now: a skip request is still only a skip.
		const skipsBefore = getSkipHeaderDropped();
		const res = await post("/hooks", hook("limit-real-3", "SessionStart"), {
			key: w.keyA.key,
			skip: "1",
		});
		expect(res.status).toBe(200);
		expect(getSkipHeaderDropped()).toBe(skipsBefore + 1);
		expect(getSessionCreationLimitedCount()).toBe(1);
		expect(await row("limit-real-3")).toBeUndefined();
	});

	test("a bad or missing key with the header is a 401 on both routes and counts nothing", async () => {
		await world();
		const before = await healthCounters();
		for (const path of ["/hooks", "/hooks/status"] as const) {
			const bad = await post(path, hook("x", "Stop"), { key: "ap_not-a-real-key", skip: "1" });
			expect({ path, status: bad.status }).toEqual({ path, status: 401 });
			const none = await post(path, hook("x", "Stop"), { skip: "1" });
			expect({ path, status: none.status }).toEqual({ path, status: 401 });
		}
		expect(await healthCounters()).toEqual(before);
	});
});

describe("a skipped acknowledge or un-acknowledge event has no side effect", () => {
	test("UserAcknowledge with the header, from the owner's own key, leaves a waiting session waiting; without the header it is acknowledged (the control)", async () => {
		const w = await world();
		await createReal("ack-1", w.keyA.key);
		await getDb()
			.update(sessions)
			.set({ lastAgentTurnCompletedAt: NOW(), isWorking: false })
			.where(eq(sessions.sessionId, "ack-1"));
		const waitingBefore = (await read("/sessions/stats?owner=me", w.a.headers)) as {
			operational: { waiting: number };
		};
		expect(waitingBefore.operational.waiting).toBe(1);

		const skipped = await post("/hooks", hook("ack-1", "UserAcknowledge"), {
			key: w.keyA.key,
			skip: "1",
		});
		expect(skipped.status).toBe(200);
		await settle();
		expect((await row("ack-1"))?.lastUserAcknowledgedAt).toBeNull();
		const stillWaiting = (await read("/sessions/stats?owner=me", w.a.headers)) as {
			operational: { waiting: number };
		};
		expect(stillWaiting.operational.waiting).toBe(1);

		await post("/hooks", hook("ack-1", "UserAcknowledge"), { key: w.keyA.key });
		await until(async () => (await row("ack-1"))?.lastUserAcknowledgedAt != null);
	});

	test("UserAcknowledge and UserUnacknowledge with the header for an unknown session: no row, and the un-acknowledge counter stays flat", async () => {
		const w = await world();
		const before = await healthCounters();
		for (const eventName of ["UserAcknowledge", "UserUnacknowledge"]) {
			const res = await post("/hooks", hook(`ack-unknown-${eventName}`, eventName), {
				key: w.keyA.key,
				skip: "1",
			});
			expect(res.status).toBe(200);
		}
		await settle();
		expect(await row("ack-unknown-UserAcknowledge")).toBeUndefined();
		expect(await row("ack-unknown-UserUnacknowledge")).toBeUndefined();
		expect(getIngestUnacknowledgeDroppedCount()).toBe(0);
		expect(await healthCounters()).toEqual({
			...before,
			skipHeaderDropped: (before.skipHeaderDropped ?? 0) + 2,
		});
	});

	test("UserUnacknowledge with the header for an acknowledged session leaves the acknowledgement alone", async () => {
		const w = await world();
		await createReal("unack-1", w.keyA.key);
		const stamp = NOW();
		await getDb()
			.update(sessions)
			.set({ lastAgentTurnCompletedAt: LONG_AGO, lastUserAcknowledgedAt: stamp })
			.where(eq(sessions.sessionId, "unack-1"));
		const res = await post("/hooks", hook("unack-1", "UserUnacknowledge"), {
			key: w.keyA.key,
			skip: "1",
		});
		expect(res.status).toBe(200);
		await settle();
		expect((await row("unack-1"))?.lastUserAcknowledgedAt).toBe(stamp);
		expect(getIngestUnacknowledgeDroppedCount()).toBe(0);
	});
});

describe("a session reported before its directory was excluded keeps its last state", () => {
	test("later deliveries are all skipped: the owner's counts show it at its last state, nobody else's counts move, and no owner changes", async () => {
		const w = await world();
		await seed([
			{ sessionId: "pre-working", ownerUserId: w.a.id, isWorking: true },
			{ sessionId: "pre-waiting", ownerUserId: w.a.id, lastAgentTurnCompletedAt: NOW() },
		]);
		const before = await snapshot(w);
		const rowsBefore = await getDb().select().from(sessions);

		for (const id of ["pre-working", "pre-waiting"]) {
			for (const eventName of ["PostToolUse", "Stop", "SessionEnd", "UserPromptSubmit"]) {
				const res = await post("/hooks", hook(id, eventName), { key: w.keyA.key, skip: "1" });
				expect(res.status).toBe(200);
			}
		}
		await settle();

		// No Stop ever arrives, so "working" stays working; the waiting one stays waiting.
		const mine = (await read("/sessions/stats?owner=me", w.a.headers)) as {
			operational: { working: number; waiting: number };
		};
		expect(mine.operational).toMatchObject({ working: 1, waiting: 1 });
		expect(await getDb().select().from(sessions)).toEqual(rowsBefore);
		expect(await snapshot(w)).toEqual(before);
	});

	test("the stale sweep is the only thing that ends it: a working session silent past the recovery window is cleared and completed with its owner kept; a recently active one is left alone", async () => {
		const w = await world();
		await seed([
			{
				sessionId: "sweep-old",
				ownerUserId: w.a.id,
				isWorking: true,
				lastActivityAt: LONG_AGO,
			},
			{ sessionId: "sweep-recent", ownerUserId: w.a.id, isWorking: true },
			{ sessionId: "sweep-other-owner", ownerUserId: w.b.id, isWorking: true },
		]);
		// A skipped Stop does not count as activity, so it cannot keep the old session alive.
		const res = await post("/hooks", hook("sweep-old", "Stop"), { key: w.keyA.key, skip: "1" });
		expect(res.status).toBe(200);
		await settle();
		expect((await row("sweep-old"))?.lastActivityAt).toBe(LONG_AGO);

		await updateStaleSessions();

		const old = await row("sweep-old");
		expect(old?.isWorking).toBe(false);
		expect(old?.status).toBe("completed");
		expect(old?.ownerUserId).toBe(w.a.id);
		expect((await row("sweep-recent"))?.isWorking).toBe(true);
		expect((await row("sweep-recent"))?.status).toBe("active");
		expect((await row("sweep-other-owner"))?.isWorking).toBe(true);
		const mine = (await read("/sessions/stats?owner=me", w.a.headers)) as {
			operational: { working: number };
			tabCounts: { active: number; completed: number };
		};
		expect(mine.operational.working).toBe(1);
		expect(mine.tabCounts).toMatchObject({ active: 1, completed: 1, archived: 0 });
	});
});
