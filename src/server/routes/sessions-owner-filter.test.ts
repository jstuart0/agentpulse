/**
 * Owner scope on the session list and the dashboard counts.
 *
 * `?owner=` takes `me`, a user id, `unassigned`, `service`, or `all`/absent.
 * One scope narrows the plain list, the operational list, and every query in
 * the stats poll, so the rows, the total, the tab counts and the four
 * operational counts all describe the same set. It composes with
 * operational=, q=, status=, agent_type=, excludeScratch and paging.
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
const LONG_AGO = "2020-01-01T00:00:00.000Z";

interface World {
	me: { id: string; headers: Headers };
	other: { id: string };
	third: { id: string };
	serviceKeyId: string;
}

async function world(): Promise<World> {
	await setStoredMode("team");
	const me = await seedLocalUser("of-me");
	const other = await seedLocalUser("of-other");
	const third = await seedLocalUser("of-third");
	const serviceKey = await seedKey("of-service", ["ingest"]);
	return {
		me: { id: me.id, headers: await cookieHeadersFor(me.id) },
		other: { id: other.id },
		third: { id: third.id },
		serviceKeyId: serviceKey.id,
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

async function get<T = Record<string, unknown>>(path: string, headers: Headers): Promise<T> {
	const res = await app.request(`/api/v1${path}`, { headers });
	expect({ path, status: res.status }).toEqual({ path, status: 200 });
	return (await res.json()) as T;
}

interface ListBody {
	sessions: Array<{ sessionId: string; ownerUserId: string | null; ownerKind: string }>;
	total: number;
}
const ids = (body: ListBody) => body.sessions.map((s) => s.sessionId).sort();

describe("GET /sessions?owner=", () => {
	async function seedBuckets(w: World) {
		await seed([
			{ sessionId: "mine-1", ownerUserId: w.me.id },
			{ sessionId: "mine-2", ownerUserId: w.me.id },
			{ sessionId: "other-1", ownerUserId: w.other.id },
			{ sessionId: "other-2", ownerUserId: w.other.id },
			{ sessionId: "other-3", ownerUserId: w.other.id },
			{ sessionId: "unassigned-1" },
			{ sessionId: "unassigned-2" },
			{ sessionId: "service-1", ingestKeyId: w.serviceKeyId },
			{ sessionId: "service-2", ingestKeyId: w.serviceKeyId },
		]);
	}

	test("each owner value returns exactly its sessions and the matching total", async () => {
		const w = await world();
		await seedBuckets(w);
		const cases: Array<[string, string[]]> = [
			["owner=me", ["mine-1", "mine-2"]],
			[`owner=${w.me.id}`, ["mine-1", "mine-2"]],
			[`owner=${w.other.id}`, ["other-1", "other-2", "other-3"]],
			[`owner=${w.third.id}`, []],
			["owner=unassigned", ["unassigned-1", "unassigned-2"]],
			["owner=service", ["service-1", "service-2"]],
			[
				"owner=all",
				[
					"mine-1",
					"mine-2",
					"other-1",
					"other-2",
					"other-3",
					"unassigned-1",
					"unassigned-2",
					"service-1",
					"service-2",
				],
			],
		];
		for (const [query, expected] of cases) {
			const body = await get<ListBody>(`/sessions?${query}&limit=100`, w.me.headers);
			expect({ query, ids: ids(body), total: body.total }).toEqual({
				query,
				ids: [...expected].sort(),
				total: expected.length,
			});
		}
		const absent = await get<ListBody>("/sessions?limit=100", w.me.headers);
		expect(absent.total).toBe(9);
	});

	test("rows carry the owner id and kind", async () => {
		const w = await world();
		await seedBuckets(w);
		const body = await get<ListBody>("/sessions?limit=100", w.me.headers);
		const byId = new Map(body.sessions.map((s) => [s.sessionId, s]));
		expect(byId.get("mine-1")).toMatchObject({ ownerUserId: w.me.id, ownerKind: "user" });
		expect(byId.get("unassigned-1")).toMatchObject({ ownerUserId: null, ownerKind: "unassigned" });
		expect(byId.get("service-1")).toMatchObject({ ownerUserId: null, ownerKind: "service" });
	});

	test("an unknown value is 400 invalid_owner and nothing is listed", async () => {
		const w = await world();
		for (const bad of ["bogus", "ME", "me,all", "unassigned2", "1 OR 1=1"]) {
			const res = await app.request(`/api/v1/sessions?owner=${encodeURIComponent(bad)}`, {
				headers: w.me.headers,
			});
			expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
			expect(((await res.json()) as { error: string }).error).toBe("invalid_owner");
		}
		const stats = await app.request("/api/v1/sessions/stats?owner=bogus", {
			headers: w.me.headers,
		});
		expect(stats.status).toBe(400);
	});

	test("a user id that matches nobody is still validated: a bad request is 400, a good one is empty", async () => {
		const w = await world();
		const nobody = "00000000-0000-4000-8000-000000000000";
		const status = async (query: string) =>
			(await app.request(`/api/v1/sessions?owner=${nobody}&${query}`, { headers: w.me.headers }))
				.status;
		expect(await status("fields=x")).toBe(400);
		expect(await status("fields=sessionId&operational=idle")).toBe(400);
		expect(await status("operational=bogus")).toBe(400);
		expect(await status("tab=bogus")).toBe(400);
		expect(await status("tab=active&status=active")).toBe(400);
		expect(await status("limit=0")).toBe(400);
		expect(await status("fields=sessionId")).toBe(200);
		const empty = await get<ListBody>(`/sessions?owner=${nobody}&tab=active`, w.me.headers);
		expect(empty.total).toBe(0);
		expect(empty.sessions).toEqual([]);
	});

	test("me with no user id is 400 owner_me_unavailable (an ownerless key; auth disabled)", async () => {
		await world();
		const keyless = await seedKey("of-keyless", ["manage"]);
		for (const path of ["/sessions?owner=me", "/sessions/stats?owner=me"]) {
			const res = await app.request(`/api/v1${path}`, { headers: bearerHeaders(keyless.key) });
			expect({ path, status: res.status }).toEqual({ path, status: 400 });
			expect(((await res.json()) as { error: string }).error).toBe("owner_me_unavailable");
		}
	});

	test("TRUNCATION: the caller owns only the 10 oldest of 130, owner=me&limit=100 returns those 10", async () => {
		const w = await world();
		const rows: SeedRow[] = [];
		for (let i = 0; i < 130; i += 1) {
			const mine = i < 10;
			rows.push({
				sessionId: `t-${String(i).padStart(3, "0")}`,
				ownerUserId: mine ? w.me.id : w.other.id,
				// i = 0..9 are the oldest.
				lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			});
		}
		await seed(rows);
		const body = await get<ListBody>("/sessions?owner=me&limit=100", w.me.headers);
		expect(ids(body)).toEqual(rows.slice(0, 10).map((r) => r.sessionId));
		expect(body.total).toBe(10);
		// And the unscoped first page does not contain any of them: the scoping is real.
		const everyone = await get<ListBody>("/sessions?limit=100", w.me.headers);
		expect(everyone.sessions.some((s) => s.ownerUserId === w.me.id)).toBe(false);
		expect(everyone.total).toBe(130);
	});

	test("composes with status, agent_type, project and excludeScratch on the plain list", async () => {
		const w = await world();
		await getDb()
			.insert(projects)
			.values([
				{ id: "p-scratch", name: "scratch", cwd: "/work/scratch", tags: ["scratch"] },
				{ id: "p-real", name: "real", cwd: "/work/real", tags: [] },
			]);
		await seed([
			{ sessionId: "c-active-real", ownerUserId: w.me.id, projectId: "p-real" },
			{ sessionId: "c-active-scratch", ownerUserId: w.me.id, projectId: "p-scratch" },
			{ sessionId: "c-idle", ownerUserId: w.me.id, status: "idle", agentType: "codex_cli" },
			{ sessionId: "c-other", ownerUserId: w.other.id, projectId: "p-real" },
		]);
		const q = async (query: string) =>
			ids(await get<ListBody>(`/sessions?owner=me&${query}`, w.me.headers));
		expect(await q("status=idle")).toEqual(["c-idle"]);
		expect(await q("agent_type=codex_cli")).toEqual(["c-idle"]);
		expect(await q("projectId=p-real")).toEqual(["c-active-real"]);
		expect(await q("excludeScratch=true")).toEqual(["c-active-real", "c-idle"]);
		const scratchFree = await get<ListBody>("/sessions?owner=me&excludeScratch=true", w.me.headers);
		expect(scratchFree.total).toBe(2);
	});

	test("fields= honours owner and q", async () => {
		const w = await world();
		await seed([
			{ sessionId: "f-mine-alpha", ownerUserId: w.me.id, displayName: "alpha job" },
			{ sessionId: "f-mine-beta", ownerUserId: w.me.id, displayName: "beta job" },
			{ sessionId: "f-other-alpha", ownerUserId: w.other.id, displayName: "alpha job" },
		]);
		const res = await get<{ sessions: Array<{ sessionId: string }> }>(
			"/sessions?fields=sessionId&owner=me&q=alpha",
			w.me.headers,
		);
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["f-mine-alpha"]);
		const unscoped = await get<{ sessions: Array<{ sessionId: string }> }>(
			"/sessions?fields=sessionId",
			w.me.headers,
		);
		expect(unscoped.sessions).toHaveLength(3);
	});
});

describe("fields= projection honours tab and excludeScratch", () => {
	async function seedProjection(w: World) {
		await getDb()
			.insert(projects)
			.values([
				{ id: "p-scratch", name: "scratch", cwd: "/work/scratch", tags: ["scratch"] },
				{ id: "p-real", name: "real", cwd: "/work/real", tags: [] },
			]);
		await seed([
			{ sessionId: "pj-active-real", ownerUserId: w.me.id, projectId: "p-real" },
			{ sessionId: "pj-active-scratch", ownerUserId: w.me.id, projectId: "p-scratch" },
			{ sessionId: "pj-idle", ownerUserId: w.me.id, status: "idle" },
			{ sessionId: "pj-done", ownerUserId: w.me.id, status: "completed", endedAt: NOW() },
			{ sessionId: "pj-archived", ownerUserId: w.me.id, isArchived: true },
		]);
	}
	const projected = async (w: World, query: string) =>
		(
			await get<{ sessions: Array<{ sessionId: string }> }>(
				`/sessions?fields=sessionId&owner=me&${query}`,
				w.me.headers,
			)
		).sessions
			.map((s) => s.sessionId)
			.sort();

	test("excludeScratch=true leaves out the scratch workspace's sessions", async () => {
		const w = await world();
		await seedProjection(w);
		expect(await projected(w, "excludeScratch=true")).toEqual([
			"pj-active-real",
			"pj-archived",
			"pj-done",
			"pj-idle",
		]);
		expect(await projected(w, "excludeScratch=false")).toContain("pj-active-scratch");
	});

	test("tab lists exactly that tab, matching the full list's tab", async () => {
		const w = await world();
		await seedProjection(w);
		expect(await projected(w, "tab=active")).toEqual([
			"pj-active-real",
			"pj-active-scratch",
			"pj-idle",
		]);
		expect(await projected(w, "tab=completed")).toEqual(["pj-done"]);
		expect(await projected(w, "tab=archived")).toEqual(["pj-archived"]);
		expect(await projected(w, "tab=active&excludeScratch=true")).toEqual([
			"pj-active-real",
			"pj-idle",
		]);
		const full = await get<ListBody>("/sessions?owner=me&tab=active", w.me.headers);
		expect(ids(full)).toEqual(await projected(w, "tab=active"));
	});
});

describe("operational=waiting composed with owner and q", () => {
	test("a match that exists only past the first page is found, and the total is the scoped total", async () => {
		const w = await world();
		const recent = (i: number) => new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString();
		const rows: SeedRow[] = [];
		// 120 newer waiting rows of mine that do not match, one older match, and a
		// newer match that belongs to somebody else.
		for (let i = 0; i < 120; i += 1) {
			rows.push({
				sessionId: `w-${String(i).padStart(3, "0")}`,
				ownerUserId: w.me.id,
				displayName: "routine",
				lastAgentTurnCompletedAt: NOW(),
				lastActivityAt: recent(i + 10),
			});
		}
		rows.push({
			sessionId: "w-needle-mine",
			ownerUserId: w.me.id,
			displayName: "needle in the haystack",
			lastAgentTurnCompletedAt: NOW(),
			lastActivityAt: recent(0),
		});
		rows.push({
			sessionId: "w-needle-other",
			ownerUserId: w.other.id,
			displayName: "needle in the haystack",
			lastAgentTurnCompletedAt: NOW(),
			lastActivityAt: recent(500),
		});
		await seed(rows);
		const body = await get<ListBody>(
			"/sessions?owner=me&operational=waiting&q=needle&limit=10",
			w.me.headers,
		);
		expect(ids(body)).toEqual(["w-needle-mine"]);
		expect(body.total).toBe(1);

		const paged = await get<ListBody>(
			"/sessions?owner=me&operational=waiting&limit=10&offset=115",
			w.me.headers,
		);
		expect(paged.total).toBe(121);
		expect(paged.sessions).toHaveLength(6);
	});

	test("status narrows an operational list the same way it narrows a plain one", async () => {
		const w = await world();
		await seed([
			{
				sessionId: "s-active-waiting",
				ownerUserId: w.me.id,
				lastAgentTurnCompletedAt: NOW(),
			},
			{
				sessionId: "s-idle-waiting",
				ownerUserId: w.me.id,
				status: "idle",
				lastAgentTurnCompletedAt: NOW(),
			},
		]);
		const both = await get<ListBody>("/sessions?owner=me&operational=waiting", w.me.headers);
		expect(ids(both)).toEqual(["s-active-waiting", "s-idle-waiting"]);
		const narrowed = await get<ListBody>(
			"/sessions?owner=me&operational=waiting&status=idle",
			w.me.headers,
		);
		expect(ids(narrowed)).toEqual(["s-idle-waiting"]);
		expect(narrowed.total).toBe(1);
	});

	test("excludeScratch applies to an operational list and to a plain one alike", async () => {
		const w = await world();
		await getDb()
			.insert(projects)
			.values({ id: "p-scratch-2", name: "scratch2", cwd: "/work/s2", tags: ["scratch"] });
		await seed([
			{
				sessionId: "x-scratch",
				ownerUserId: w.me.id,
				projectId: "p-scratch-2",
				lastAgentTurnCompletedAt: NOW(),
			},
			{ sessionId: "x-plain", ownerUserId: w.me.id, lastAgentTurnCompletedAt: NOW() },
		]);
		const operational = await get<ListBody>(
			"/sessions?owner=me&operational=waiting&excludeScratch=true",
			w.me.headers,
		);
		const plain = await get<ListBody>("/sessions?owner=me&excludeScratch=true", w.me.headers);
		expect(ids(operational)).toEqual(["x-plain"]);
		expect(ids(plain)).toEqual(["x-plain"]);
		expect(plain.total).toBe(1);
	});
});

interface StatsBody {
	ownerScope: { kind: string; userId?: string };
	total: number;
	scratchHidden: number;
	activeSessions: number;
	totalSessionsToday: number;
	completedCount: number;
	archivedCount: number;
	tabCounts: { active: number; completed: number; archived: number };
	totalToolUsesToday: number;
	byAgentType: Record<string, number>;
	truncated: boolean;
	operational: { waiting: number; working: number; idle: number; error: number };
}

describe("GET /sessions/stats?owner=", () => {
	async function seedStatsWorld(w: World) {
		const done = NOW();
		await seed([
			// Mine: one of each operational state, a completed row, an archived row.
			{ sessionId: "m-working", ownerUserId: w.me.id, isWorking: true, totalToolUses: 5 },
			{
				sessionId: "m-waiting",
				ownerUserId: w.me.id,
				agentType: "codex_cli",
				lastAgentTurnCompletedAt: done,
				totalToolUses: 7,
			},
			{
				sessionId: "m-idle",
				ownerUserId: w.me.id,
				status: "idle",
				startedAt: LONG_AGO,
				totalToolUses: 100,
			},
			{
				sessionId: "m-error",
				ownerUserId: w.me.id,
				status: "failed",
				endedAt: done,
				totalToolUses: 0,
			},
			{
				sessionId: "m-completed",
				ownerUserId: w.me.id,
				status: "completed",
				endedAt: done,
				totalToolUses: 2,
			},
			{
				sessionId: "m-archived",
				ownerUserId: w.me.id,
				status: "completed",
				endedAt: done,
				isArchived: true,
				totalToolUses: 3,
			},
			// Somebody else: two working, one completed, one archived.
			{ sessionId: "o-working-1", ownerUserId: w.other.id, isWorking: true, totalToolUses: 11 },
			{ sessionId: "o-working-2", ownerUserId: w.other.id, isWorking: true, totalToolUses: 13 },
			{
				sessionId: "o-completed",
				ownerUserId: w.other.id,
				status: "completed",
				endedAt: done,
				totalToolUses: 17,
			},
			{
				sessionId: "o-archived",
				ownerUserId: w.other.id,
				status: "completed",
				endedAt: done,
				isArchived: true,
				totalToolUses: 19,
			},
			// Unassigned and service-key rows.
			{ sessionId: "u-working", isWorking: true, totalToolUses: 1 },
			{ sessionId: "s-completed", ingestKeyId: w.serviceKeyId, status: "completed", endedAt: done },
		]);
	}

	test("every count in the poll describes the caller's own set", async () => {
		const w = await world();
		await seedStatsWorld(w);
		const mine = await get<StatsBody>("/sessions/stats?owner=me", w.me.headers);
		expect(mine).toEqual({
			ownerScope: { kind: "me", userId: w.me.id },
			total: 6,
			scratchHidden: 0,
			activeSessions: 2,
			totalSessionsToday: 5,
			completedCount: 1,
			archivedCount: 1,
			tabCounts: { active: 4, completed: 1, archived: 1 },
			totalToolUsesToday: 17,
			byAgentType: { claude_code: 1, codex_cli: 1, copilot_cli: 0 },
			truncated: false,
			operational: { waiting: 1, working: 1, idle: 1, error: 1 },
		});
	});

	test("the unscoped poll is unchanged, and owner=all equals no owner", async () => {
		const w = await world();
		await seedStatsWorld(w);
		const everyone = await get<StatsBody>("/sessions/stats", w.me.headers);
		expect(everyone).toEqual({
			ownerScope: { kind: "all" },
			total: 12,
			scratchHidden: 0,
			activeSessions: 5,
			totalSessionsToday: 11,
			completedCount: 3,
			archivedCount: 2,
			tabCounts: { active: 7, completed: 3, archived: 2 },
			totalToolUsesToday: 17 + 11 + 13 + 17 + 19 + 1,
			byAgentType: { claude_code: 4, codex_cli: 1, copilot_cli: 0 },
			truncated: false,
			operational: { waiting: 1, working: 4, idle: 1, error: 1 },
		});
		expect(await get<StatsBody>("/sessions/stats?owner=all", w.me.headers)).toEqual(everyone);
	});

	test("unassigned, service and a named user each scope the counts", async () => {
		const w = await world();
		await seedStatsWorld(w);
		const unassigned = await get<StatsBody>("/sessions/stats?owner=unassigned", w.me.headers);
		expect(unassigned.operational).toEqual({ waiting: 0, working: 1, idle: 0, error: 0 });
		expect(unassigned.completedCount).toBe(0);
		const service = await get<StatsBody>("/sessions/stats?owner=service", w.me.headers);
		expect(service.operational).toEqual({ waiting: 0, working: 0, idle: 0, error: 0 });
		expect(service.completedCount).toBe(1);
		const other = await get<StatsBody>(`/sessions/stats?owner=${w.other.id}`, w.me.headers);
		expect(other.operational.working).toBe(2);
		expect(other.completedCount).toBe(1);
		expect(other.archivedCount).toBe(1);
		expect(other.totalToolUsesToday).toBe(11 + 13 + 17 + 19);
	});

	test("the list total, the stats counts and the operational filter agree under one scope", async () => {
		const w = await world();
		await seedStatsWorld(w);
		const stats = await get<StatsBody>("/sessions/stats?owner=me", w.me.headers);
		for (const state of ["waiting", "working", "idle", "error"] as const) {
			const list = await get<ListBody>(
				`/sessions?owner=me&operational=${state}&limit=100`,
				w.me.headers,
			);
			expect({ state, total: list.total }).toEqual({ state, total: stats.operational[state] });
		}
		const all = await get<ListBody>("/sessions?owner=me&limit=100", w.me.headers);
		expect(all.total).toBe(6);
	});
});

interface GroupRow {
	ownerUserId: string | null;
	ownerKind: string;
	total: number;
	active: number;
	idle: number;
	completed: number;
	tabCounts: { active: number; completed: number; archived: number };
	working: number;
	waiting: number;
	error: number;
}
interface GroupsBody {
	groups: GroupRow[];
	truncated: boolean;
}

describe("GET /sessions/stats?group_by=owner", () => {
	async function seedMany(w: World) {
		await seed([
			{ sessionId: "g-m-1", ownerUserId: w.me.id, isWorking: true },
			{ sessionId: "g-m-2", ownerUserId: w.me.id, lastAgentTurnCompletedAt: NOW() },
			{ sessionId: "g-m-3", ownerUserId: w.me.id, lastAgentTurnCompletedAt: NOW() },
			{ sessionId: "g-m-4", ownerUserId: w.me.id, status: "completed", endedAt: NOW() },
			{ sessionId: "g-o-1", ownerUserId: w.other.id, status: "failed", endedAt: NOW() },
			{ sessionId: "g-o-2", ownerUserId: w.other.id, status: "idle" },
			{ sessionId: "g-t-1", ownerUserId: w.third.id, isWorking: true },
			{ sessionId: "g-u-1" },
			{ sessionId: "g-s-1", ingestKeyId: w.serviceKeyId, lastAgentTurnCompletedAt: NOW() },
			{ sessionId: "g-s-2", ingestKeyId: w.serviceKeyId, status: "completed", endedAt: NOW() },
		]);
	}

	test("one row per owner, kinds named, sums equal the unfiltered totals", async () => {
		const w = await world();
		await seedMany(w);
		const body = await get<GroupsBody>("/sessions/stats?group_by=owner", w.me.headers);
		const stats = await get<StatsBody>("/sessions/stats", w.me.headers);
		const total = (await get<ListBody>("/sessions?limit=100", w.me.headers)).total;

		const sum = (key: keyof GroupRow) =>
			body.groups.reduce((acc, g) => acc + (g[key] as number), 0);
		expect(sum("total")).toBe(total);
		expect(sum("completed")).toBe(stats.completedCount);
		expect(sum("working")).toBe(stats.operational.working);
		expect(sum("waiting")).toBe(stats.operational.waiting);
		expect(sum("error")).toBe(stats.operational.error);
		expect(sum("idle")).toBe(stats.operational.idle);
		expect(body.truncated).toBe(false);

		const mine = body.groups.find((g) => g.ownerUserId === w.me.id);
		expect(mine).toEqual({
			ownerUserId: w.me.id,
			ownerKind: "user",
			total: 4,
			active: 3,
			idle: 0,
			completed: 1,
			tabCounts: { active: 3, completed: 1, archived: 0 },
			working: 1,
			waiting: 2,
			error: 0,
		});
		const unassigned = body.groups.find((g) => g.ownerKind === "unassigned");
		expect(unassigned).toMatchObject({ ownerUserId: null, total: 1, idle: 1, active: 1 });
		const service = body.groups.find((g) => g.ownerKind === "service");
		expect(service).toMatchObject({ ownerUserId: null, total: 2, waiting: 1, completed: 1 });
		expect(body.groups).toHaveLength(5);
	});

	test("a named owner's waiting count equals the number seeded", async () => {
		const w = await world();
		await seedMany(w);
		const body = await get<GroupsBody>("/sessions/stats?group_by=owner", w.me.headers);
		expect(body.groups.find((g) => g.ownerUserId === w.me.id)?.waiting).toBe(2);
		const list = await get<ListBody>(
			`/sessions?owner=${w.me.id}&operational=waiting`,
			w.me.headers,
		);
		expect(list.total).toBe(2);
	});

	test("one grouped pass: the statement count does not grow with the number of owners", async () => {
		const w = await world();
		await seed([{ sessionId: "n-1", ownerUserId: w.me.id }, { sessionId: "n-2" }]);
		const few = await countDbCalls(async () => {
			await get("/sessions/stats?group_by=owner", w.me.headers);
		});
		const more = await Promise.all(
			Array.from({ length: 6 }, (_, i) => seedLocalUser(`n-extra-${i}`)),
		);
		await seed(more.map((u, i) => ({ sessionId: `n-extra-${i}`, ownerUserId: u.id })));
		const many = await countDbCalls(async () => {
			await get("/sessions/stats?group_by=owner", w.me.headers);
		});
		expect(many).toBe(few);
	});

	test("an unknown group_by is 400 invalid_group_by", async () => {
		const w = await world();
		const res = await app.request("/api/v1/sessions/stats?group_by=host", {
			headers: w.me.headers,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_group_by");
	});
});

describe("solo mode and auth disabled", () => {
	test("owner=me in solo with a signed-in caller is just a filter, and nothing else about the list changes", async () => {
		const me = await seedLocalUser("of-solo");
		await seed([{ sessionId: "solo-a", ownerUserId: me.id }, { sessionId: "solo-b" }]);
		const headers = await cookieHeadersFor(me.id);
		const all = await get<ListBody>("/sessions", headers);
		expect(ids(all)).toEqual(["solo-a", "solo-b"]);
		const mine = await get<ListBody>("/sessions?owner=me", headers);
		expect(ids(mine)).toEqual(["solo-a"]);
		const unassigned = await get<ListBody>("/sessions?owner=unassigned", headers);
		expect(ids(unassigned)).toEqual(["solo-b"]);
	});
});
