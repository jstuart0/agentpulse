/**
 * The applied owner scope is echoed on every response it shaped, so a caller
 * that asked for a scope can verify the server honoured it instead of
 * trusting that an older server understood the parameter. The stats response
 * also carries `total`: every session in the applied scope (scratch excluded
 * when asked), so a client learns whether the caller owns anything without a
 * second list request.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, projects } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { getStats } = await import("../services/session-tracker.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
	await getDb().delete(projects);
}
beforeEach(reset);
afterEach(reset);

const NOW = () => new Date().toISOString();

async function world() {
	await setStoredMode("team");
	const me = await seedLocalUser("echo-me");
	const other = await seedLocalUser("echo-other");
	const key = await seedKey("echo-service", ["ingest"]);
	await getDb()
		.insert(projects)
		.values([{ id: "p-scratch", name: "scratch-area", cwd: "/scratch", tags: ["scratch"] }]);
	const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
		sessionId,
		agentType: "claude_code",
		status: "active",
		displayName: sessionId,
		metadata: {},
		startedAt: NOW(),
		lastActivityAt: NOW(),
		...extra,
	});
	await getDb()
		.insert(sessions)
		.values([
			row("mine-1", { ownerUserId: me.id }),
			row("mine-2", { ownerUserId: me.id, projectId: "p-scratch" }),
			row("other-1", { ownerUserId: other.id }),
			row("unassigned-1"),
			row("service-1", { ingestKeyId: key.id }),
		] as never);
	return { me, other, headers: await cookieHeadersFor(me.id) };
}

async function get(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("ownerScope on GET /sessions", () => {
	test("each value echoes what was applied; me carries the resolved id", async () => {
		const w = await world();
		const cases: Array<[string, unknown]> = [
			["", { kind: "all" }],
			["?owner=all", { kind: "all" }],
			["?owner=me", { kind: "me", userId: w.me.id }],
			[`?owner=${w.other.id}`, { kind: "user", userId: w.other.id }],
			["?owner=unassigned", { kind: "unassigned" }],
			["?owner=service", { kind: "service" }],
		];
		for (const [query, expected] of cases) {
			const { status, body } = await get(`/sessions${query}`, w.headers);
			expect({ query, status, scope: body.ownerScope }).toEqual({
				query,
				status: 200,
				scope: expected,
			});
		}
	});

	test("the operational list and the narrow projection echo it too", async () => {
		const w = await world();
		const operational = await get("/sessions?operational=idle&owner=me", w.headers);
		expect(operational.body.ownerScope).toEqual({ kind: "me", userId: w.me.id });
		const projected = await get("/sessions?fields=sessionId&owner=unassigned", w.headers);
		expect(projected.body.ownerScope).toEqual({ kind: "unassigned" });
	});
});

describe("owner=me through an API key", () => {
	test("a key owned by a user is scoped to that user, whatever its scope", async () => {
		const w = await world();
		const owned = await seedKey("echo-owned-observe", ["observe"], w.me.id);
		const list = await get("/sessions?owner=me", bearerHeaders(owned.key));
		expect(list.status).toBe(200);
		expect(list.body.ownerScope).toEqual({ kind: "me", userId: w.me.id });
		const ids = (list.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId).sort();
		expect(ids).toEqual(["mine-1", "mine-2"]);
		const stats = await get("/sessions/stats?owner=me", bearerHeaders(owned.key));
		expect(stats.body.ownerScope).toEqual({ kind: "me", userId: w.me.id });
		expect(stats.body.total).toBe(2);
	});

	test("a key with no owning user is refused me instead of being shown everyone", async () => {
		const w = await world();
		const ownerless = await seedKey("echo-ownerless", ["observe"], null);
		for (const path of ["/sessions?owner=me", "/sessions/stats?owner=me"]) {
			const res = await get(path, bearerHeaders(ownerless.key));
			expect({ path, status: res.status, error: res.body.error }).toEqual({
				path,
				status: 400,
				error: "owner_me_unavailable",
			});
		}
		// still fine to ask for anyone else
		expect((await get("/sessions?owner=service", bearerHeaders(ownerless.key))).status).toBe(200);
		expect(w.me.id).toBeTruthy();
	});
});

describe("owner=me is resolved to the caller before any computation is shared", () => {
	test("two members asking for me at the same moment each get their own counts", async () => {
		const w = await world();
		const other = await cookieHeadersFor(w.other.id);
		const [mine, theirs] = await Promise.all([
			get("/sessions/stats?owner=me", w.headers),
			get("/sessions/stats?owner=me", other),
		]);
		expect(mine.body.ownerScope).toEqual({ kind: "me", userId: w.me.id });
		expect(mine.body.total).toBe(2);
		expect(theirs.body.ownerScope).toEqual({ kind: "me", userId: w.other.id });
		expect(theirs.body.total).toBe(1);
		const [mineList, theirList] = await Promise.all([
			get("/sessions?owner=me&operational=idle", w.headers),
			get("/sessions?owner=me&operational=idle", other),
		]);
		expect(mineList.body.total).toBe(2);
		expect(theirList.body.total).toBe(1);
	});
});

describe("ownerScope on GET /sessions/stats", () => {
	test("the poll and the per-owner grouping echo it", async () => {
		const w = await world();
		const poll = await get("/sessions/stats?owner=me", w.headers);
		expect(poll.body.ownerScope).toEqual({ kind: "me", userId: w.me.id });
		const bare = await get("/sessions/stats", w.headers);
		expect(bare.body.ownerScope).toEqual({ kind: "all" });
		const grouped = await get("/sessions/stats?group_by=owner&owner=service", w.headers);
		expect(grouped.body.ownerScope).toEqual({ kind: "service" });
		const groupedAll = await get("/sessions/stats?group_by=owner", w.headers);
		expect(groupedAll.body.ownerScope).toEqual({ kind: "all" });
	});
});

describe("total on GET /sessions/stats", () => {
	test("counts every session in the applied scope", async () => {
		const w = await world();
		expect((await get("/sessions/stats", w.headers)).body.total).toBe(5);
		expect((await get("/sessions/stats?owner=me", w.headers)).body.total).toBe(2);
		expect((await get(`/sessions/stats?owner=${w.other.id}`, w.headers)).body.total).toBe(1);
		expect((await get("/sessions/stats?owner=unassigned", w.headers)).body.total).toBe(1);
		expect((await get("/sessions/stats?owner=service", w.headers)).body.total).toBe(1);
	});

	test("honours excludeScratch like every other count", async () => {
		const w = await world();
		const hidden = await get("/sessions/stats?owner=me&excludeScratch=true", w.headers);
		expect(hidden.body.total).toBe(1);
		const all = await get("/sessions/stats?excludeScratch=true", w.headers);
		expect(all.body.total).toBe(4);
	});

	test("an owner with nothing reads zero", async () => {
		const w = await world();
		await getDb().delete(sessions);
		expect((await get("/sessions/stats?owner=me", w.headers)).body.total).toBe(0);
	});
});

describe("scratchHidden on GET /sessions/stats", () => {
	async function addScratchFor(ownerUserId: string | null, count: number) {
		const rows = Array.from({ length: count }, (_, i) => ({
			sessionId: `extra-scratch-${ownerUserId ?? "none"}-${i}`,
			agentType: "claude_code",
			status: "completed",
			endedAt: NOW(),
			displayName: "extra",
			metadata: {},
			startedAt: NOW(),
			lastActivityAt: NOW(),
			projectId: "p-scratch",
			ownerUserId,
		}));
		await getDb()
			.insert(sessions)
			.values(rows as never);
	}

	test("counts the sessions in the applied scope that scratch exclusion left out", async () => {
		const w = await world();
		await addScratchFor(w.other.id, 3);
		// me: mine-2 is scratch (1). everyone: mine-2 plus the three added (4).
		const mine = await get("/sessions/stats?owner=me&excludeScratch=true", w.headers);
		expect(mine.body.scratchHidden).toBe(1);
		const everyone = await get("/sessions/stats?excludeScratch=true", w.headers);
		expect(everyone.body.scratchHidden).toBe(4);
		const others = await get(`/sessions/stats?owner=${w.other.id}&excludeScratch=true`, w.headers);
		expect(others.body.scratchHidden).toBe(3);
	});

	test("is zero when scratch is not excluded, and when there is no scratch workspace", async () => {
		const w = await world();
		expect((await get("/sessions/stats?owner=me", w.headers)).body.scratchHidden).toBe(0);
		expect((await get("/sessions/stats?excludeScratch=false", w.headers)).body.scratchHidden).toBe(
			0,
		);
		await getDb().delete(sessions);
		await getDb().delete(projects);
		expect((await get("/sessions/stats?excludeScratch=true", w.headers)).body.scratchHidden).toBe(
			0,
		);
	});

	test("what is hidden plus what the response counts is the whole scope", async () => {
		const w = await world();
		await addScratchFor(w.me.id, 2);
		const all = (await get("/sessions/stats", w.headers)).body;
		const hidden = (await get("/sessions/stats?excludeScratch=true", w.headers)).body;
		expect((hidden.total as number) + (hidden.scratchHidden as number)).toBe(all.total as number);
	});

	test("it rides on the same statements: lookup, aggregate, scan", async () => {
		await world();
		const calls = await countDbCalls(async () => {
			await getStats({ excludeScratch: true });
		});
		expect(calls).toBe(3);
	});
});
