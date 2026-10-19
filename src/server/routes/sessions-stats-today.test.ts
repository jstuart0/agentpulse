/**
 * The "today" ledger on GET /sessions/stats: `completedToday`, `failedToday` and
 * `launchesToday`.
 *
 * "Today" is the server's local calendar day. A session counts on the day it ended:
 * a millisecond before local midnight is yesterday, midnight and a millisecond after
 * are today. The boundary is checked in this process's zone and again in child
 * processes under zones far from UTC (where local midnight isn't a UTC date boundary:
 * a zone can't be switched inside a running process, so the child is started with TZ
 * set and proves it took). Runs on both dialects.
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
const { sessions, projects, launchRequests, supervisors } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read by field name
type Body = Record<string, any>;

const CHILD_FLAG = "AGENTPULSE_STATS_TODAY_CHILD";
const inChild = process.env[CHILD_FLAG] === "1";
const FAR_ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Los_Angeles"];

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
	await getDb().delete(sessions);
	await getDb().delete(projects);
}
beforeEach(reset);
afterEach(reset);

function localMidnightMs(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
const iso = (ms: number) => new Date(ms).toISOString();

type SeedRow = Partial<typeof sessions.$inferInsert> & { sessionId: string };
async function seedSessions(rows: SeedRow[]) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values(
			rows.map((row) => ({
				agentType: "claude_code",
				status: "completed",
				displayName: row.sessionId,
				metadata: {},
				startedAt: iso(localMidnightMs() - 3 * 86_400_000),
				lastActivityAt: now,
				...row,
			})),
		);
}

type LaunchSeed = Partial<typeof launchRequests.$inferInsert>;
async function seedLaunches(rows: LaunchSeed[]) {
	await getDb()
		.insert(launchRequests)
		.values(
			rows.map((row) => ({
				launchCorrelationId: crypto.randomUUID(),
				agentType: "claude_code",
				cwd: "/tmp/x",
				status: "running",
				createdAt: new Date().toISOString(),
				...row,
			})) as never,
		);
}

async function seedSupervisor(hostName: string): Promise<string> {
	const id = crypto.randomUUID();
	await getDb().insert(supervisors).values({
		id,
		hostName,
		platform: "linux",
		arch: "x64",
		version: "1.0.0",
	});
	return id;
}

type Today = { completedToday: number; failedToday: number; launchesToday: number };
async function stats(headers: Headers, query = ""): Promise<Body> {
	const res = await app.request(`/api/v1/sessions/stats${query}`, { headers });
	expect(res.status).toBe(200);
	return (await res.json()) as Body;
}
const today = (body: Body): Today => ({
	completedToday: body.completedToday,
	failedToday: body.failedToday,
	launchesToday: body.launchesToday,
});

async function world() {
	await setStoredMode("team");
	const me = await seedLocalUser("st-me");
	const other = await seedLocalUser("st-other");
	return {
		me,
		other,
		mine: await cookieHeadersFor(me.id),
	};
}

describe("the day boundary in this process's time zone", () => {
	test("a session that ended 1 ms before local midnight is yesterday; at midnight and 1 ms after, today", async () => {
		if (inChild) {
			expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.TZ as string);
		}
		const w = await world();
		const midnight = localMidnightMs();
		await seedSessions([
			{ sessionId: "c-before", ownerUserId: w.me.id, endedAt: iso(midnight - 1) },
			{ sessionId: "c-at", ownerUserId: w.me.id, endedAt: iso(midnight) },
			{ sessionId: "c-after", ownerUserId: w.me.id, endedAt: iso(midnight + 1) },
			{
				sessionId: "f-before",
				ownerUserId: w.me.id,
				status: "failed",
				endedAt: iso(midnight - 1),
			},
			{ sessionId: "f-at", ownerUserId: w.me.id, status: "failed", endedAt: iso(midnight) },
			{
				sessionId: "f-after",
				ownerUserId: w.me.id,
				status: "failed",
				endedAt: iso(midnight + 1),
			},
		]);
		await seedLaunches([
			{ requestedByUserId: w.me.id, createdAt: iso(midnight - 1) },
			{ requestedByUserId: w.me.id, createdAt: iso(midnight) },
			{ requestedByUserId: w.me.id, createdAt: iso(midnight + 1) },
		]);
		const body = await stats(w.mine, "?owner=me");
		expect(today(body)).toEqual({
			completedToday: 2,
			failedToday: 2,
			launchesToday: 2,
		});
		// the poll says which day it means: this zone's local midnight, as an instant
		expect(body.todayStartsAt).toBe(iso(midnight));
		expect(Date.parse(body.todayStartsAt)).toBeLessThanOrEqual(Date.now());
		expect(Date.now() - Date.parse(body.todayStartsAt)).toBeLessThan(25 * 3_600_000);
	});
});

describe.skipIf(inChild)("the same boundary under zones far from UTC", () => {
	for (const zone of FAR_ZONES) {
		test(zone, async () => {
			const child = Bun.spawn(
				[process.execPath, "test", import.meta.path, "-t", "the day boundary in this process"],
				{
					cwd: process.cwd(),
					env: { ...process.env, TZ: zone, [CHILD_FLAG]: "1" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [out, err, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ zone, code, output: code === 0 ? "" : `${out}\n${err}` }).toEqual({
				zone,
				code: 0,
				output: "",
			});
		}, 120_000);
	}
});

describe("what each count means", () => {
	test("a session counts on the day it ended, not the day it started; running and idle sessions count nowhere", async () => {
		const w = await world();
		const midnight = localMidnightMs();
		await seedSessions([
			// started two days ago, ended today
			{
				sessionId: "long-run",
				ownerUserId: w.me.id,
				startedAt: iso(midnight - 2 * 86_400_000),
				endedAt: iso(midnight + 3_600_000),
			},
			// started today, still going
			{
				sessionId: "running",
				ownerUserId: w.me.id,
				status: "active",
				startedAt: iso(midnight + 1_000),
				endedAt: null,
			},
			{ sessionId: "idle", ownerUserId: w.me.id, status: "idle", endedAt: null },
			// ended yesterday, failed yesterday
			{
				sessionId: "old-ok",
				ownerUserId: w.me.id,
				endedAt: iso(midnight - 3_600_000),
			},
			{
				sessionId: "old-bad",
				ownerUserId: w.me.id,
				status: "failed",
				endedAt: iso(midnight - 3_600_000),
			},
			// ended today: a failure, and a session archived after it ended
			{
				sessionId: "new-bad",
				ownerUserId: w.me.id,
				status: "failed",
				endedAt: iso(midnight + 7_200_000),
			},
			{
				sessionId: "archived",
				ownerUserId: w.me.id,
				isArchived: true,
				endedAt: iso(midnight + 5_000),
			},
		]);
		const body = await stats(w.mine, "?owner=me");
		expect(today(body)).toEqual({ completedToday: 2, failedToday: 1, launchesToday: 0 });
		// the existing counts are untouched by the new ones
		expect(body.totalSessionsToday).toBe(1);
	});

	test("a failed session counts as failed only, and a completed one as completed only", async () => {
		const w = await world();
		const midnight = localMidnightMs();
		await seedSessions([
			{ sessionId: "ok", ownerUserId: w.me.id, endedAt: iso(midnight + 10) },
			{ sessionId: "bad", ownerUserId: w.me.id, status: "failed", endedAt: iso(midnight + 10) },
		]);
		const body = await stats(w.mine, "?owner=me");
		expect(body.completedToday + body.failedToday).toBe(2);
		expect(body.completedToday).toBe(1);
		expect(body.failedToday).toBe(1);
	});

	test("launches count when they were requested today and were real: drafts and rejected requests don't", async () => {
		const w = await world();
		const midnight = localMidnightMs();
		const today = iso(midnight + 60_000);
		await seedLaunches([
			{ requestedByUserId: w.me.id, status: "running", createdAt: today },
			{ requestedByUserId: w.me.id, status: "failed", createdAt: today },
			{ requestedByUserId: w.me.id, status: "completed", createdAt: today },
			{ requestedByUserId: w.me.id, status: "cancelled", createdAt: today },
			{ requestedByUserId: w.me.id, status: "draft", createdAt: today },
			{ requestedByUserId: w.me.id, status: "rejected", createdAt: today },
			{ requestedByUserId: w.me.id, status: "running", createdAt: iso(midnight - 60_000) },
		]);
		expect((await stats(w.mine, "?owner=me")).launchesToday).toBe(4);
	});
});

describe("the scope narrows the ledger like it narrows the counts", () => {
	test("the owner scope applies to sessions and to who requested a launch", async () => {
		const w = await world();
		const midnight = localMidnightMs();
		const at = iso(midnight + 1_000);
		await seedSessions([
			{ sessionId: "mine-ok", ownerUserId: w.me.id, endedAt: at },
			{ sessionId: "theirs-ok", ownerUserId: w.other.id, endedAt: at },
			{ sessionId: "theirs-bad", ownerUserId: w.other.id, status: "failed", endedAt: at },
			{ sessionId: "nobody-ok", ownerUserId: null, endedAt: at },
		]);
		await seedLaunches([
			{ requestedByUserId: w.me.id, createdAt: at },
			{ requestedByUserId: w.other.id, createdAt: at },
			{ requestedByUserId: w.other.id, createdAt: at },
			{ requestedByUserId: null, createdAt: at },
		]);
		expect(today(await stats(w.mine, "?owner=me"))).toEqual({
			completedToday: 1,
			failedToday: 0,
			launchesToday: 1,
		});
		expect(today(await stats(w.mine, `?owner=${w.other.id}`))).toEqual({
			completedToday: 1,
			failedToday: 1,
			launchesToday: 2,
		});
		expect(today(await stats(w.mine, "?owner=unassigned"))).toEqual({
			completedToday: 1,
			failedToday: 0,
			launchesToday: 1,
		});
		expect(today(await stats(w.mine))).toEqual({
			completedToday: 3,
			failedToday: 1,
			launchesToday: 4,
		});
	});

	test("the machine scope applies to sessions by their effective machine and to launches by the supervisor they went to", async () => {
		const w = await world();
		const at = iso(localMidnightMs() + 1_000);
		const alpha = await seedSupervisor("alpha");
		const beta = await seedSupervisor("beta");
		await seedSessions([
			{ sessionId: "on-alpha", reportedHost: "alpha", endedAt: at },
			{ sessionId: "on-beta", reportedHost: "beta", endedAt: at },
			{ sessionId: "on-beta-bad", reportedHost: "beta", status: "failed", endedAt: at },
			{ sessionId: "nowhere", endedAt: at },
		]);
		await seedLaunches([
			{ resolvedSupervisorId: alpha, createdAt: at },
			{ resolvedSupervisorId: beta, createdAt: at },
			{ claimedBySupervisorId: beta, resolvedSupervisorId: alpha, createdAt: at },
			{ createdAt: at },
		]);
		expect(today(await stats(w.mine, "?host=alpha"))).toEqual({
			completedToday: 1,
			failedToday: 0,
			launchesToday: 1,
		});
		expect(today(await stats(w.mine, "?host=beta"))).toEqual({
			completedToday: 1,
			failedToday: 1,
			launchesToday: 2,
		});
		expect(today(await stats(w.mine, `?host=${encodeURIComponent(UNKNOWN_HOST_PARAM)}`))).toEqual({
			completedToday: 1,
			failedToday: 0,
			launchesToday: 1,
		});
	});

	test("the scratch exclusion hides a scratch workspace's sessions from the ledger, and does not touch launches", async () => {
		const w = await world();
		const at = iso(localMidnightMs() + 1_000);
		const scratchId = crypto.randomUUID();
		await getDb()
			.insert(projects)
			.values({
				id: scratchId,
				cwd: "/tmp/scratch-st",
				name: "scratch-st",
				tags: ["scratch"],
				createdAt: at,
				updatedAt: at,
			} as never);
		await seedSessions([
			{ sessionId: "real", endedAt: at },
			{ sessionId: "scratch-ok", projectId: scratchId, endedAt: at },
			{ sessionId: "scratch-bad", projectId: scratchId, status: "failed", endedAt: at },
		]);
		await seedLaunches([{ createdAt: at }]);
		expect(today(await stats(w.mine, "?excludeScratch=true"))).toEqual({
			completedToday: 1,
			failedToday: 0,
			launchesToday: 1,
		});
		expect(today(await stats(w.mine))).toEqual({
			completedToday: 2,
			failedToday: 1,
			launchesToday: 1,
		});
	});
});

describe("empty and grouped stats", () => {
	test("a database with nothing in it says zero, not missing", async () => {
		const w = await world();
		expect(today(await stats(w.mine))).toEqual({
			completedToday: 0,
			failedToday: 0,
			launchesToday: 0,
		});
	});

	test("an empty scope still says when today began", async () => {
		const w = await world();
		const body = await stats(w.mine, `?owner=${crypto.randomUUID()}`);
		expect(body.todayStartsAt).toBe(iso(localMidnightMs()));
	});

	test("a scope naming no user gets the same shape, all zero", async () => {
		const w = await world();
		const real = await stats(w.mine, "?owner=me");
		const nobody = await stats(w.mine, `?owner=${crypto.randomUUID()}`);
		expect(Object.keys(nobody).sort()).toEqual(Object.keys(real).sort());
		expect(today(nobody)).toEqual({ completedToday: 0, failedToday: 0, launchesToday: 0 });
	});

	test("the grouped answers keep their shape: the ledger is on the plain poll only", async () => {
		const w = await world();
		const at = iso(localMidnightMs() + 1_000);
		await seedSessions([
			{ sessionId: "g1", ownerUserId: w.me.id, reportedHost: "alpha", endedAt: at },
		]);
		for (const groupBy of ["owner", "host"]) {
			const body = await stats(w.mine, `?group_by=${groupBy}`);
			expect(body.groups.length).toBeGreaterThan(0);
			for (const field of ["completedToday", "failedToday", "launchesToday", "todayStartsAt"]) {
				expect({ groupBy, field, present: field in body }).toEqual({
					groupBy,
					field,
					present: false,
				});
			}
		}
	});
});
