/**
 * The machine filter and the per-machine grouping on the session list and the
 * dashboard counts.
 *
 * `?host=` names a machine: the supervisor's host name for a session a
 * supervisor launched, else the name its relay reported. `?host=<reserved>`
 * (UNKNOWN_HOST_PARAM) selects sessions with neither. It narrows the plain list,
 * the operational list, the narrow projection and every query in the stats poll,
 * and `group_by=host` counts each machine the way `group_by=owner` counts each
 * owner, so rows, totals and counts always describe the same set.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { UNKNOWN_HOST_PARAM } from "../../shared/machine-scope.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, projects, managedSessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(projects);
}
beforeEach(reset);
afterEach(reset);

const NOW = () => new Date().toISOString();
const UNKNOWN = encodeURIComponent(UNKNOWN_HOST_PARAM);

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

/** A session a supervisor launched: it has a managed row whose host name is the supervisor's. */
async function seedManaged(sessionId: string, hostName: string | null) {
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: `launch-${sessionId}`,
			supervisorId: "supervisor-1",
			hostName,
		});
}

async function get<T = Record<string, unknown>>(path: string, headers: Headers): Promise<T> {
	const res = await app.request(`/api/v1${path}`, { headers });
	expect({ path, status: res.status }).toEqual({ path, status: 200 });
	return (await res.json()) as T;
}

interface ListBody {
	sessions: Array<{ sessionId: string; machine?: string | null; ownerUserId: string | null }>;
	total: number;
	hostFilter?: { kind: string; host?: string };
}
const ids = (body: { sessions: Array<{ sessionId: string }> }) =>
	body.sessions.map((s) => s.sessionId).sort();

interface World {
	me: { id: string; headers: Headers };
	other: { id: string };
}

async function teamWorld(): Promise<World> {
	await setStoredMode("team");
	const me = await seedLocalUser("hf-me");
	const other = await seedLocalUser("hf-other");
	return { me: { id: me.id, headers: await cookieHeadersFor(me.id) }, other: { id: other.id } };
}

/**
 * Four kinds of machine: reported by a relay, a supervisor's own host name (which
 * outranks what the same session reported), a supervisor with no host name (so the
 * reported one stands), and none at all (null, blank, or a blank supervisor host).
 */
async function seedMachines(w: World) {
	const done = NOW();
	await getDb()
		.insert(projects)
		.values({ id: "p-scratch", name: "scratch", cwd: "/work/scratch", tags: ["scratch"] });
	await seed([
		{
			sessionId: "a-working",
			reportedHost: "alice-mbp",
			ownerUserId: w.me.id,
			isWorking: true,
			agentType: "codex_cli",
		},
		{
			sessionId: "a-waiting",
			reportedHost: "alice-mbp",
			ownerUserId: w.me.id,
			lastAgentTurnCompletedAt: done,
			displayName: "needle in alice",
		},
		{ sessionId: "a-idle", reportedHost: "alice-mbp", ownerUserId: w.me.id, status: "idle" },
		{
			sessionId: "a-done",
			reportedHost: "alice-mbp",
			ownerUserId: w.me.id,
			status: "completed",
			endedAt: done,
		},
		{
			sessionId: "a-archived",
			reportedHost: "alice-mbp",
			ownerUserId: w.me.id,
			status: "completed",
			endedAt: done,
			isArchived: true,
		},
		{
			sessionId: "a-scratch",
			reportedHost: "alice-mbp",
			ownerUserId: w.me.id,
			projectId: "p-scratch",
			isWorking: true,
		},
		{ sessionId: "b-work-1", reportedHost: "build-01", ownerUserId: w.other.id, isWorking: true },
		{ sessionId: "b-work-2", reportedHost: "build-01", ownerUserId: w.other.id, isWorking: true },
		{
			sessionId: "b-error",
			reportedHost: "build-01",
			ownerUserId: w.other.id,
			status: "failed",
			endedAt: done,
		},
		{
			sessionId: "b-done",
			reportedHost: "build-01",
			ownerUserId: w.me.id,
			status: "completed",
			endedAt: done,
		},
		// Supervisor-launched: the supervisor's host outranks the reported one.
		{
			sessionId: "e-waiting",
			reportedHost: "edge-02.local",
			ownerUserId: w.me.id,
			lastAgentTurnCompletedAt: done,
		},
		{ sessionId: "e-working", ownerUserId: w.other.id, isWorking: true },
		{
			sessionId: "e-done",
			reportedHost: "build-01",
			status: "completed",
			endedAt: done,
		},
		// A supervisor that recorded no host name: the reported one stands.
		{
			sessionId: "m-no-host",
			reportedHost: "build-01",
			ownerUserId: w.me.id,
			lastAgentTurnCompletedAt: done,
		},
		// A blank supervisor host and no reported one: no machine.
		{ sessionId: "m-blank-host", status: "completed", endedAt: done },
		// No machine at all.
		{ sessionId: "u-idle", status: "idle", ownerUserId: w.me.id },
		{ sessionId: "u-waiting", lastAgentTurnCompletedAt: done },
		{ sessionId: "u-blank", reportedHost: "   ", isWorking: true },
	]);
	await seedManaged("e-waiting", "edge-02");
	await seedManaged("e-working", "edge-02");
	await seedManaged("e-done", "edge-02");
	await seedManaged("m-no-host", null);
	await seedManaged("m-blank-host", "  ");
}

describe("GET /sessions?host=", () => {
	test("a machine returns exactly its sessions and the matching total", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const cases: Array<[string, string[]]> = [
			["host=alice-mbp", ["a-archived", "a-done", "a-idle", "a-scratch", "a-waiting", "a-working"]],
			["host=build-01", ["b-done", "b-error", "b-work-1", "b-work-2", "m-no-host"]],
			["host=edge-02", ["e-done", "e-waiting", "e-working"]],
			[`host=${UNKNOWN}`, ["m-blank-host", "u-blank", "u-idle", "u-waiting"]],
			["host=no-such-box", []],
		];
		for (const [query, expected] of cases) {
			const body = await get<ListBody>(`/sessions?${query}&limit=100`, w.me.headers);
			expect({ query, ids: ids(body), total: body.total }).toEqual({
				query,
				ids: [...expected].sort(),
				total: expected.length,
			});
		}
		const everyone = await get<ListBody>("/sessions?limit=100", w.me.headers);
		expect(everyone.total).toBe(18);
		expect((await get<ListBody>("/sessions?host=&limit=100", w.me.headers)).total).toBe(18);
	});

	test("the supervisor's host outranks what the session reported, and a reported one is not a second name for it", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const byReported = await get<ListBody>("/sessions?host=edge-02.local", w.me.headers);
		expect(byReported.sessions).toEqual([]);
		const bySupervisor = await get<ListBody>("/sessions?host=edge-02&limit=100", w.me.headers);
		expect(ids(bySupervisor)).toContain("e-waiting");
		// A session reporting build-01 that a supervisor launched on edge-02 is on edge-02.
		const build = await get<ListBody>("/sessions?host=build-01&limit=100", w.me.headers);
		expect(ids(build)).not.toContain("e-done");
	});

	test("the match is exact: another case or a prefix is another machine", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		for (const near of ["Alice-MBP", "alice", "alice-mbp ", "alice-mbp.local", "build", "edge-0"]) {
			const body = await get<ListBody>(`/sessions?host=${encodeURIComponent(near)}`, w.me.headers);
			// A trailing space is trimmed to the real name, which exists.
			expect({ near, total: body.total }).toEqual({
				near,
				total: near === "alice-mbp " ? 6 : 0,
			});
		}
	});

	test("rows carry their effective machine", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const body = await get<ListBody>("/sessions?limit=100", w.me.headers);
		const machine = (id: string) => body.sessions.find((s) => s.sessionId === id)?.machine;
		expect(machine("a-working")).toBe("alice-mbp");
		expect(machine("e-waiting")).toBe("edge-02");
		expect(machine("e-done")).toBe("edge-02");
		expect(machine("m-no-host")).toBe("build-01");
		expect(machine("m-blank-host")).toBeNull();
		expect(machine("u-blank")).toBeNull();
		expect(machine("u-idle")).toBeNull();
	});

	test("the applied filter is echoed on every list shape", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const echo = async (query: string) =>
			(await get<ListBody>(`/sessions${query}`, w.me.headers)).hostFilter;
		expect(await echo("")).toEqual({ kind: "all" });
		expect(await echo("?host=")).toEqual({ kind: "all" });
		expect(await echo("?host=alice-mbp")).toEqual({ kind: "host", host: "alice-mbp" });
		expect(await echo(`?host=${UNKNOWN}`)).toEqual({ kind: "unknown" });
		expect(await echo("?host=alice-mbp&operational=idle")).toEqual({
			kind: "host",
			host: "alice-mbp",
		});
		expect(await echo("?host=alice-mbp&fields=sessionId")).toEqual({
			kind: "host",
			host: "alice-mbp",
		});
		expect(await echo("?host=alice-mbp&tab=active")).toEqual({ kind: "host", host: "alice-mbp" });
		const nobody = "00000000-0000-4000-8000-000000000000";
		expect(await echo(`?host=alice-mbp&owner=${nobody}`)).toEqual({
			kind: "host",
			host: "alice-mbp",
		});
	});

	test("composes with owner, tab, status, search, scratch, agent type, project and paging", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const q = async (query: string) =>
			ids(await get<ListBody>(`/sessions?limit=100&${query}`, w.me.headers));
		expect(await q("host=alice-mbp&owner=me&tab=active")).toEqual([
			"a-idle",
			"a-scratch",
			"a-waiting",
			"a-working",
		]);
		expect(await q("host=alice-mbp&owner=me&tab=active&excludeScratch=true")).toEqual([
			"a-idle",
			"a-waiting",
			"a-working",
		]);
		expect(await q("host=alice-mbp&tab=completed")).toEqual(["a-done"]);
		expect(await q("host=alice-mbp&tab=archived")).toEqual(["a-archived"]);
		expect(await q(`host=build-01&owner=${w.other.id}`)).toEqual([
			"b-error",
			"b-work-1",
			"b-work-2",
		]);
		expect(await q("host=build-01&owner=me")).toEqual(["b-done", "m-no-host"]);
		expect(await q("host=alice-mbp&status=idle")).toEqual(["a-idle"]);
		expect(await q("host=alice-mbp&q=needle")).toEqual(["a-waiting"]);
		expect(await q("host=build-01&q=needle")).toEqual([]);
		expect(await q("host=alice-mbp&agent_type=codex_cli")).toEqual(["a-working"]);
		expect(await q("host=alice-mbp&projectId=p-scratch")).toEqual(["a-scratch"]);
		expect(await q(`host=${UNKNOWN}&owner=unassigned&tab=active`)).toEqual([
			"u-blank",
			"u-waiting",
		]);
		const paged = await get<ListBody>("/sessions?host=alice-mbp&limit=2&offset=4", w.me.headers);
		expect(paged.total).toBe(6);
		expect(paged.sessions).toHaveLength(2);
	});

	test("composes with an operational list and with the narrow projection", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const op = async (state: string, host: string) =>
			ids(
				await get<ListBody>(`/sessions?operational=${state}&host=${host}&limit=100`, w.me.headers),
			);
		expect(await op("working", "build-01")).toEqual(["b-work-1", "b-work-2"]);
		expect(await op("error", "build-01")).toEqual(["b-error"]);
		expect(await op("waiting", "build-01")).toEqual(["m-no-host"]);
		expect(await op("waiting", "edge-02")).toEqual(["e-waiting"]);
		expect(await op("waiting", UNKNOWN)).toEqual(["u-waiting"]);
		const projected = await get<{ sessions: Array<{ sessionId: string }> }>(
			"/sessions?fields=sessionId&host=edge-02&owner=me",
			w.me.headers,
		);
		expect(ids(projected)).toEqual(["e-waiting"]);
		const projectedTab = await get<{ sessions: Array<{ sessionId: string }> }>(
			`/sessions?fields=sessionId&host=${UNKNOWN}&tab=completed`,
			w.me.headers,
		);
		expect(ids(projectedTab)).toEqual(["m-blank-host"]);
	});

	test("an operational match past the first page is found, with the filtered total", async () => {
		const w = await teamWorld();
		const rows: SeedRow[] = [];
		for (let i = 0; i < 120; i += 1) {
			rows.push({
				sessionId: `bulk-${String(i).padStart(3, "0")}`,
				reportedHost: "alice-mbp",
				lastAgentTurnCompletedAt: NOW(),
				lastActivityAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i + 10)).toISOString(),
			});
		}
		rows.push({
			sessionId: "bulk-old-elsewhere",
			reportedHost: "build-01",
			lastAgentTurnCompletedAt: NOW(),
			lastActivityAt: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)).toISOString(),
		});
		await seed(rows);
		const body = await get<ListBody>(
			"/sessions?operational=waiting&host=build-01&limit=10",
			w.me.headers,
		);
		expect(ids(body)).toEqual(["bulk-old-elsewhere"]);
		expect(body.total).toBe(1);
		const paged = await get<ListBody>(
			"/sessions?operational=waiting&host=alice-mbp&limit=10&offset=115",
			w.me.headers,
		);
		expect(paged.total).toBe(120);
		expect(paged.sessions).toHaveLength(5);
	});

	test("solo mode filters the same way", async () => {
		await seed([
			{ sessionId: "solo-a", reportedHost: "alice-mbp" },
			{ sessionId: "solo-b", reportedHost: "build-01" },
			{ sessionId: "solo-c" },
		]);
		const me = await seedLocalUser("hf-solo");
		const headers = await cookieHeadersFor(me.id);
		expect(ids(await get<ListBody>("/sessions?host=alice-mbp", headers))).toEqual(["solo-a"]);
		expect(ids(await get<ListBody>(`/sessions?host=${UNKNOWN}`, headers))).toEqual(["solo-c"]);
		expect(ids(await get<ListBody>("/sessions", headers))).toEqual(["solo-a", "solo-b", "solo-c"]);
	});
});

describe("a scope that names nobody still says which machine filter it applied", () => {
	const NOBODY = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

	test("the plain list, the narrow projection and every stats shape echo hostFilter", async () => {
		const w = await teamWorld();
		await seed([{ sessionId: "n-1", reportedHost: "build-01" }]);
		const echo = { kind: "host", host: "build-01" };
		const paths = [
			`/sessions?owner=${NOBODY}&host=build-01`,
			`/sessions?owner=${NOBODY}&host=build-01&fields=sessionId`,
			`/sessions/stats?owner=${NOBODY}&host=build-01`,
			`/sessions/stats?owner=${NOBODY}&host=build-01&group_by=host`,
			`/sessions/stats?owner=${NOBODY}&host=build-01&group_by=owner`,
		];
		for (const path of paths) {
			const body = await get<{ hostFilter?: unknown; sessions?: unknown[]; groups?: unknown[] }>(
				path,
				w.me.headers,
			);
			expect({ path, hostFilter: body.hostFilter }).toEqual({ path, hostFilter: echo });
			expect(body.sessions ?? body.groups ?? []).toEqual([]);
		}
	});
});

describe("host validation", () => {
	test("a value outside the grammar is 400 invalid_host with a capped echo, on the list and the stats", async () => {
		const w = await teamWorld();
		const long = "x".repeat(300);
		for (const bad of ["a\nb", "nul\u0000", "bidi‮name", long, `${UNKNOWN_HOST_PARAM}extra`]) {
			for (const path of ["/sessions", "/sessions/stats", "/sessions/stats?group_by=host&x=1"]) {
				const sep = path.includes("?") ? "&" : "?";
				const res = await app.request(`/api/v1${path}${sep}host=${encodeURIComponent(bad)}`, {
					headers: w.me.headers,
				});
				expect({ path, bad: bad.slice(0, 8), status: res.status }).toEqual({
					path,
					bad: bad.slice(0, 8),
					status: 400,
				});
				const body = (await res.json()) as { error: string; value?: string };
				expect(body.error).toBe("invalid_host");
				expect((body.value ?? "").length).toBeLessThanOrEqual(64);
			}
		}
	});

	test("a bad host is still refused when the owner names nobody, and with fields=", async () => {
		const w = await teamWorld();
		const nobody = "00000000-0000-4000-8000-000000000000";
		const status = async (query: string) =>
			(await app.request(`/api/v1/sessions?${query}`, { headers: w.me.headers })).status;
		expect(await status(`owner=${nobody}&host=${encodeURIComponent("a\nb")}`)).toBe(400);
		expect(await status(`fields=sessionId&host=${encodeURIComponent("a\nb")}`)).toBe(400);
		expect(await status(`owner=${nobody}&host=alice-mbp`)).toBe(200);
	});

	test("SQL-looking text is just a machine that does not exist", async () => {
		const w = await teamWorld();
		await seed([{ sessionId: "inj-1", reportedHost: "alice-mbp" }]);
		const body = await get<ListBody>(
			`/sessions?host=${encodeURIComponent("x' OR '1'='1")}`,
			w.me.headers,
		);
		expect(body.total).toBe(0);
	});
});

interface StatsBody {
	ownerScope: { kind: string };
	hostFilter?: { kind: string; host?: string };
	total: number;
	scratchHidden: number;
	activeSessions: number;
	completedCount: number;
	archivedCount: number;
	tabCounts: { active: number; completed: number; archived: number };
	operational: { waiting: number; working: number; idle: number; error: number };
	truncated: boolean;
}

describe("GET /sessions/stats?host=", () => {
	test("every count describes the machine's own set and agrees with its lists", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const machines: Array<[string, number]> = [
			["alice-mbp", 6],
			["build-01", 5],
			["edge-02", 3],
			[UNKNOWN, 4],
		];
		for (const [host, total] of machines) {
			const stats = await get<StatsBody>(`/sessions/stats?host=${host}`, w.me.headers);
			expect({ host, total: stats.total }).toEqual({ host, total });
			expect(stats.hostFilter).toEqual(
				host === UNKNOWN ? { kind: "unknown" } : { kind: "host", host },
			);
			for (const state of ["waiting", "working", "idle", "error"] as const) {
				const list = await get<ListBody>(
					`/sessions?host=${host}&operational=${state}&limit=100`,
					w.me.headers,
				);
				expect({ host, state, total: list.total }).toEqual({
					host,
					state,
					total: stats.operational[state],
				});
			}
			for (const tab of ["active", "completed", "archived"] as const) {
				const list = await get<ListBody>(
					`/sessions?host=${host}&tab=${tab}&limit=100`,
					w.me.headers,
				);
				expect({ host, tab, total: list.total }).toEqual({
					host,
					tab,
					total: stats.tabCounts[tab],
				});
			}
			expect(stats.tabCounts.active + stats.tabCounts.completed + stats.tabCounts.archived).toBe(
				stats.total,
			);
		}
	});

	test("composes with the owner scope and the scratch toggle", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const mineOnAlice = await get<StatsBody>(
			"/sessions/stats?host=alice-mbp&owner=me",
			w.me.headers,
		);
		expect(mineOnAlice.total).toBe(6);
		expect(mineOnAlice.ownerScope.kind).toBe("me");
		const noScratch = await get<StatsBody>(
			"/sessions/stats?host=alice-mbp&owner=me&excludeScratch=true",
			w.me.headers,
		);
		expect(noScratch.total).toBe(5);
		expect(noScratch.scratchHidden).toBe(1);
		expect(noScratch.operational.working).toBe(1);
		const otherOnBuild = await get<StatsBody>(
			`/sessions/stats?host=build-01&owner=${w.other.id}`,
			w.me.headers,
		);
		expect(otherOnBuild.total).toBe(3);
		expect(otherOnBuild.operational).toEqual({ waiting: 0, working: 2, idle: 0, error: 1 });
		const none = await get<StatsBody>("/sessions/stats?host=no-such-box", w.me.headers);
		expect(none.total).toBe(0);
		expect(none.hostFilter).toEqual({ kind: "host", host: "no-such-box" });
	});

	test("without a host the poll is unchanged, and says every machine", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const stats = await get<StatsBody>("/sessions/stats", w.me.headers);
		expect(stats.total).toBe(18);
		expect(stats.hostFilter).toEqual({ kind: "all" });
	});
});

interface HostGroup {
	host: string | null;
	total: number;
	active: number;
	idle: number;
	completed: number;
	tabCounts: { active: number; completed: number; archived: number };
	working: number;
	waiting: number;
	error: number;
}
interface HostGroupsBody {
	ownerScope: { kind: string };
	hostFilter: { kind: string; host?: string };
	groups: HostGroup[];
	truncated: boolean;
}

describe("GET /sessions/stats?group_by=host", () => {
	test("one row per machine by name, no machine last, with every count the owner grouping has", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const body = await get<HostGroupsBody>("/sessions/stats?group_by=host", w.me.headers);
		expect(body.groups.map((g) => g.host)).toEqual(["alice-mbp", "build-01", "edge-02", null]);
		expect(body.truncated).toBe(false);
		expect(body.hostFilter).toEqual({ kind: "all" });
		const alice = body.groups[0];
		expect(alice).toEqual({
			host: "alice-mbp",
			total: 6,
			active: 4,
			idle: 1,
			completed: 1,
			tabCounts: { active: 4, completed: 1, archived: 1 },
			working: 2,
			waiting: 1,
			error: 0,
		});
		expect(body.groups.find((g) => g.host === "edge-02")).toMatchObject({
			total: 3,
			working: 1,
			waiting: 1,
			completed: 1,
		});
		expect(body.groups.find((g) => g.host === null)).toMatchObject({ total: 4, idle: 1 });
	});

	test("each group's counts equal the totals of that machine's own lists, on every tab and state", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const body = await get<HostGroupsBody>("/sessions/stats?group_by=host", w.me.headers);
		const stats = await get<StatsBody>("/sessions/stats", w.me.headers);
		for (const group of body.groups) {
			const host = group.host === null ? UNKNOWN : encodeURIComponent(group.host);
			const all = await get<ListBody>(`/sessions?host=${host}&limit=100`, w.me.headers);
			expect({ host: group.host, total: all.total }).toEqual({
				host: group.host,
				total: group.total,
			});
			for (const tab of ["active", "completed", "archived"] as const) {
				const list = await get<ListBody>(`/sessions?host=${host}&tab=${tab}`, w.me.headers);
				expect({ host: group.host, tab, total: list.total }).toEqual({
					host: group.host,
					tab,
					total: group.tabCounts[tab],
				});
			}
			for (const state of ["waiting", "working", "idle", "error"] as const) {
				const list = await get<ListBody>(
					`/sessions?host=${host}&operational=${state}`,
					w.me.headers,
				);
				expect({ host: group.host, state, total: list.total }).toEqual({
					host: group.host,
					state,
					total: group[state],
				});
			}
			expect(group.active).toBe(group.waiting + group.working + group.idle + group.error);
		}
		const sum = (key: "total" | "working" | "waiting" | "error" | "idle" | "completed") =>
			body.groups.reduce((acc, g) => acc + g[key], 0);
		expect(sum("total")).toBe(stats.total);
		expect(sum("completed")).toBe(stats.completedCount);
		expect(sum("working")).toBe(stats.operational.working);
		expect(sum("waiting")).toBe(stats.operational.waiting);
		expect(sum("error")).toBe(stats.operational.error);
		expect(sum("idle")).toBe(stats.operational.idle);
	});

	test("composes with the owner scope and the scratch toggle", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const mine = await get<HostGroupsBody>("/sessions/stats?group_by=host&owner=me", w.me.headers);
		expect(mine.ownerScope.kind).toBe("me");
		expect(mine.groups.map((g) => [g.host, g.total])).toEqual([
			["alice-mbp", 6],
			["build-01", 2],
			["edge-02", 1],
			[null, 1],
		]);
		const noScratch = await get<HostGroupsBody>(
			"/sessions/stats?group_by=host&owner=me&excludeScratch=true",
			w.me.headers,
		);
		expect(noScratch.groups.find((g) => g.host === "alice-mbp")?.total).toBe(5);
		const stats = await get<StatsBody>(
			"/sessions/stats?owner=me&excludeScratch=true",
			w.me.headers,
		);
		expect(noScratch.groups.reduce((acc, g) => acc + g.total, 0)).toBe(stats.total);
	});

	test("with a machine named it is that machine's one group, and the owner grouping narrows to it", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const one = await get<HostGroupsBody>(
			"/sessions/stats?group_by=host&host=build-01",
			w.me.headers,
		);
		expect(one.hostFilter).toEqual({ kind: "host", host: "build-01" });
		expect(one.groups.map((g) => [g.host, g.total])).toEqual([["build-01", 5]]);
		const unknown = await get<HostGroupsBody>(
			`/sessions/stats?group_by=host&host=${UNKNOWN}`,
			w.me.headers,
		);
		expect(unknown.groups.map((g) => [g.host, g.total])).toEqual([[null, 4]]);
		const owners = await get<{
			hostFilter: unknown;
			groups: Array<{ ownerUserId: string | null; total: number }>;
		}>("/sessions/stats?group_by=owner&host=build-01", w.me.headers);
		expect(owners.hostFilter).toEqual({ kind: "host", host: "build-01" });
		const byOwner = Object.fromEntries(
			owners.groups.map((g) => [g.ownerUserId ?? "none", g.total]),
		);
		expect(byOwner).toEqual({ [w.me.id]: 2, [w.other.id]: 3 });
	});

	test("the owner grouping, narrowed to a machine, still adds up to that machine's total", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		const owners = await get<{ groups: Array<{ total: number }> }>(
			"/sessions/stats?group_by=owner&host=alice-mbp",
			w.me.headers,
		);
		const stats = await get<StatsBody>("/sessions/stats?host=alice-mbp", w.me.headers);
		expect(owners.groups.reduce((acc, g) => acc + g.total, 0)).toBe(stats.total);
	});

	test("an empty instance and a machine nobody uses give empty groups, not an error", async () => {
		const w = await teamWorld();
		const body = await get<HostGroupsBody>("/sessions/stats?group_by=host", w.me.headers);
		expect(body.groups).toEqual([]);
		expect(body.truncated).toBe(false);
		const nobody = "00000000-0000-4000-8000-000000000000";
		const named = await get<HostGroupsBody>(
			`/sessions/stats?group_by=host&owner=${nobody}`,
			w.me.headers,
		);
		expect(named.groups).toEqual([]);
		expect(named.hostFilter).toEqual({ kind: "all" });
	});

	test("an unknown group_by is still 400 invalid_group_by", async () => {
		const w = await teamWorld();
		const res = await app.request("/api/v1/sessions/stats?group_by=project", {
			headers: w.me.headers,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_group_by");
	});
});

describe("what the machine filter costs the database", () => {
	const calls = (path: string, headers: Headers) =>
		countDbCalls(async () => {
			await get(path, headers);
		});

	test("a host adds no statement to the list, the operational list, the stats or the owner grouping", async () => {
		const w = await teamWorld();
		await seedMachines(w);
		for (const path of [
			"/sessions?limit=20",
			"/sessions?tab=active&limit=20",
			"/sessions?operational=waiting",
			"/sessions?fields=sessionId",
			"/sessions/stats",
			"/sessions/stats?group_by=owner",
		]) {
			const sep = path.includes("?") ? "&" : "?";
			await calls(path, w.me.headers);
			const plain = await calls(path, w.me.headers);
			const named = await calls(`${path}${sep}host=alice-mbp`, w.me.headers);
			const unknown = await calls(`${path}${sep}host=${UNKNOWN}`, w.me.headers);
			expect({ path, named, unknown }).toEqual({ path, named: plain, unknown: plain });
		}
	});

	test("the machine grouping costs one builder more than the owner grouping (one statement), however many machines there are", async () => {
		const w = await teamWorld();
		await seed([{ sessionId: "c-1", reportedHost: "alice-mbp" }, { sessionId: "c-2" }]);
		const few = await calls("/sessions/stats?group_by=host", w.me.headers);
		const owner = await calls("/sessions/stats?group_by=owner", w.me.headers);
		await seed(
			Array.from({ length: 8 }, (_, i) => ({
				sessionId: `c-extra-${i}`,
				reportedHost: `box-${i}`,
			})),
		);
		const many = await calls("/sessions/stats?group_by=host", w.me.headers);
		// The machine totals are one statement built from a subquery (the busiest
		// machines, with the count of the rest alongside), which the builder counter
		// sees as two builders: one more than the owner grouping, however many machines.
		expect({ few, many }).toEqual({ few: owner + 1, many: owner + 1 });
	});
});

describe("the machine on a row, the filter and the grouping are one definition", () => {
	/** Padding, case, spaces inside a name, blank and missing values, on both sides of the supervisor/reported split. */
	async function seedAwkwardMachines() {
		await seed([
			{ sessionId: "p-1", reportedHost: "My Box" },
			{ sessionId: "p-2", reportedHost: "my box" },
			{ sessionId: "p-3", reportedHost: "  padded-reported  " },
			{ sessionId: "p-4", reportedHost: "padded-reported" },
			{ sessionId: "p-5", reportedHost: "reported-only" },
			{ sessionId: "p-6", reportedHost: "outranked" },
			{ sessionId: "p-7", reportedHost: "outranked" },
			{ sessionId: "p-8", reportedHost: "fallback-name" },
			{ sessionId: "p-9", reportedHost: "fallback-name" },
			{ sessionId: "p-10", reportedHost: "" },
			{ sessionId: "p-11", reportedHost: "   " },
			{ sessionId: "p-12" },
			{ sessionId: "p-13" },
			{ sessionId: "p-14", reportedHost: "only-reported-with-blank-supervisor" },
			{ sessionId: "p-15", reportedHost: "192.0.2.7" },
			{ sessionId: "p-16", reportedHost: "100% sure_name" },
		]);
		await seedManaged("p-6", "  supervisor-padded  ");
		await seedManaged("p-7", "supervisor-padded");
		await seedManaged("p-8", "");
		await seedManaged("p-9", null);
		await seedManaged("p-12", "supervisor-only");
		await seedManaged("p-13", "   ");
		await seedManaged("p-14", "  ");
	}

	test("every row's machine selects exactly the rows that share it, and the grouping has one group per machine with that many", async () => {
		const w = await teamWorld();
		await seedAwkwardMachines();
		const all = await get<ListBody>("/sessions?limit=100", w.me.headers);
		expect(all.sessions).toHaveLength(16);
		const byMachine = new Map<string | null, string[]>();
		for (const row of all.sessions) {
			const key = row.machine ?? null;
			byMachine.set(key, [...(byMachine.get(key) ?? []), row.sessionId]);
		}
		expect([...byMachine.keys()].filter((m) => m !== null).sort()).toEqual([
			"100% sure_name",
			"192.0.2.7",
			"My Box",
			"fallback-name",
			"my box",
			"only-reported-with-blank-supervisor",
			"padded-reported",
			"reported-only",
			"supervisor-only",
			"supervisor-padded",
		]);
		const groups = await get<HostGroupsBody>("/sessions/stats?group_by=host", w.me.headers);
		expect(new Map(groups.groups.map((g) => [g.host, g.total]))).toEqual(
			new Map([...byMachine].map(([machine, rows]) => [machine, rows.length])),
		);
		for (const [machine, expected] of byMachine) {
			const host = machine === null ? UNKNOWN : encodeURIComponent(machine);
			const body = await get<ListBody>(`/sessions?host=${host}&limit=100`, w.me.headers);
			expect({ machine, ids: ids(body) }).toEqual({ machine, ids: [...expected].sort() });
			const stats = await get<StatsBody>(`/sessions/stats?host=${host}`, w.me.headers);
			expect({ machine, total: stats.total }).toEqual({ machine, total: expected.length });
		}
	});
});

describe("concurrent requests for different machines are not shared", () => {
	test("stats for two machines answered together are each their own machine's", async () => {
		const w = await teamWorld();
		await seed([
			{ sessionId: "k-a-1", reportedHost: "alice-mbp", isWorking: true },
			{ sessionId: "k-a-2", reportedHost: "alice-mbp", isWorking: true },
			{ sessionId: "k-a-3", reportedHost: "alice-mbp", isWorking: true },
			{ sessionId: "k-b-1", reportedHost: "build-01", isWorking: true },
		]);
		const [alice, build, unknown, everyone] = await Promise.all([
			get<StatsBody>("/sessions/stats?host=alice-mbp", w.me.headers),
			get<StatsBody>("/sessions/stats?host=build-01", w.me.headers),
			get<StatsBody>(`/sessions/stats?host=${UNKNOWN}`, w.me.headers),
			get<StatsBody>("/sessions/stats", w.me.headers),
		]);
		expect([alice.total, build.total, unknown.total, everyone.total]).toEqual([3, 1, 0, 4]);
		const [aliceOps, buildOps] = await Promise.all([
			get<ListBody>("/sessions?operational=working&host=alice-mbp", w.me.headers),
			get<ListBody>("/sessions?operational=working&host=build-01", w.me.headers),
		]);
		expect([aliceOps.total, buildOps.total]).toEqual([3, 1]);
	});
});
