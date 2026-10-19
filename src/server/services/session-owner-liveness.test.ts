/**
 * Phase 2 (2026-09-29-deliver-supervisor-auth-routing, r2/D18, F19/F20):
 * liveness reads must decide "is this session's supervisor connected" from
 * the owner of record, not the recorded (possibly stale/hijacked)
 * managed_sessions.supervisor_id column.
 *
 * Test contract items 60-66 (L1-L4, I1-I3, getSessionOwnerConnections,
 * listLiveOwnedManagedSessions).
 *
 * Deliberately its own file, not session-tracker.test.ts or
 * ai/intelligence-service.test.ts — both are under active sibling edits
 * (Risks → sibling overlap).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { config } = await import("../config.js");
const { toDbTimestamp } = await import("./util/db-time.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { managedSessions, sessions, supervisors } = await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { seedManagedSession, seedSupervisor } = await import("../test-utils/supervisor-fixture.js");
const { updateStaleSessions } = await import("./session-tracker.js");
const { processHookEvent } = await import("./event-processor.js");
const { heartbeatSupervisor } = await import("./supervisor-registry.js");
const { intelligenceForSession, intelligenceForSessions } = await import(
	"./ai/intelligence-service.js"
);
const { getSessionOwnerConnections, listLiveOwnedManagedSessions } = await import(
	"./session-ownership.js"
);

const MINUTE = 60 * 1000;

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			// Past the idle cutoff (5 min) but well within the end cutoff
			// (30 min), matching session-tracker.test.ts's "i1" fixture shape.
			lastActivityAt: isoAgo(10 * MINUTE),
		})
		.execute();
}

const seedSupervisorRow = (id: string, status: "connected" | "offline") =>
	seedSupervisor(id, {
		storedStatus: status,
		leaseOffsetMs: status === "connected" ? 60_000 : -200_000,
		leaseBaseMs: Date.now(),
	});

async function seedManagedRowRaw(
	sessionId: string,
	supervisorId: string,
	launchRequestId: string,
	managedState = "headless",
) {
	const now = new Date().toISOString();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId,
			supervisorId,
			managedState,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

/**
 * Seeds all five fixtures from the test contract:
 *  - HIJ-LIVE: recorded owner offline, launch claimant connected.
 *  - HIJ-DEAD: recorded owner connected, launch claimant offline.
 *  - LL-LIVE / LL-DEAD: launch-less, recorded owner connected/offline.
 *  - UNMANAGED: a sessions row only.
 */
async function seedFixtures() {
	await mkSession("HIJ-LIVE");
	await seedSupervisorRow("hij-live-owner", "offline");
	await seedSupervisorRow("hij-live-claimant", "connected");
	const hijLiveLaunch = await seedOwnedLaunch("HIJ-LIVE", "hij-live-claimant");
	await seedManagedRowRaw("HIJ-LIVE", "hij-live-owner", hijLiveLaunch.launchId);

	await mkSession("HIJ-DEAD");
	await seedSupervisorRow("hij-dead-owner", "connected");
	await seedSupervisorRow("hij-dead-claimant", "offline");
	const hijDeadLaunch = await seedOwnedLaunch("HIJ-DEAD", "hij-dead-claimant");
	await seedManagedRowRaw("HIJ-DEAD", "hij-dead-owner", hijDeadLaunch.launchId);

	await mkSession("LL-LIVE");
	await seedSupervisorRow("ll-live-owner", "connected");
	await seedManagedRowRaw("LL-LIVE", "ll-live-owner", "LL-LIVE");

	await mkSession("LL-DEAD");
	await seedSupervisorRow("ll-dead-owner", "offline");
	await seedManagedRowRaw("LL-DEAD", "ll-dead-owner", "LL-DEAD");

	await mkSession("UNMANAGED");
}

describe("updateStaleSessions — liveness by owner of record (F19)", () => {
	test("L1: HIJ-LIVE stays active (claimant is connected, stale recorded owner is offline)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "HIJ-LIVE"));
		expect(row?.status).toBe("active");
	});

	test("L2: HIJ-DEAD becomes idle (claimant is offline, stale recorded owner is connected)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "HIJ-DEAD"));
		expect(row?.status).toBe("idle");
	});

	test("L3/L4: launch-less rows follow their recorded owner unchanged (controls)", async () => {
		await seedFixtures();
		await updateStaleSessions();
		const [live] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "LL-LIVE"));
		expect(live?.status).toBe("active");
		const [dead] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "LL-DEAD"));
		expect(dead?.status).toBe("idle");
	});
});

describe("intelligenceForSession / intelligenceForSessions — owner of record (F20)", () => {
	test("I1: HIJ-LIVE's reasonCode is not supervisor_offline", async () => {
		await seedFixtures();
		const intel = await intelligenceForSession("HIJ-LIVE");
		expect(intel?.reasonCode).not.toBe("supervisor_offline");
	});

	test("I2: HIJ-DEAD's reasonCode is supervisor_offline", async () => {
		await seedFixtures();
		const intel = await intelligenceForSession("HIJ-DEAD");
		expect(intel?.reasonCode).toBe("supervisor_offline");
	});

	test("I3: bulk path agrees with the single path across all four shapes", async () => {
		await seedFixtures();
		const map = await intelligenceForSessions(["HIJ-LIVE", "HIJ-DEAD", "LL-DEAD", "UNMANAGED"]);
		expect(map.size).toBe(4);
		expect(map.get("HIJ-LIVE")?.reasonCode).not.toBe("supervisor_offline");
		expect(map.get("HIJ-DEAD")?.reasonCode).toBe("supervisor_offline");
		expect(map.get("LL-DEAD")?.reasonCode).toBe("supervisor_offline");
		expect(map.get("UNMANAGED")?.reasonCode).not.toBe("supervisor_offline");
	});
});

describe("getSessionOwnerConnections", () => {
	test("returns owner-of-record connected state, keyed only by managed sessions", async () => {
		await seedFixtures();
		const result = await getSessionOwnerConnections([
			"HIJ-LIVE",
			"HIJ-DEAD",
			"LL-LIVE",
			"UNMANAGED",
		]);
		expect(result.get("HIJ-LIVE")).toBe(true);
		expect(result.get("HIJ-DEAD")).toBe(false);
		expect(result.get("LL-LIVE")).toBe(true);
		// Named member: UNMANAGED must be absent, not present-with-any-value —
		// callers rely on `.get()` returning undefined for an unmanaged session.
		expect(result.has("UNMANAGED")).toBe(false);
	});

	test("empty input returns an empty map with no query", async () => {
		const result = await getSessionOwnerConnections([]);
		expect(result.size).toBe(0);
	});
});

describe("listLiveOwnedManagedSessions", () => {
	test("returns exactly the sessions whose owner of record is connected AND in the requested states", async () => {
		await seedFixtures();
		// Named member: owner connected but wrong managed_state must be excluded.
		await mkSession("COMPLETED-BUT-CONNECTED");
		await seedSupervisorRow("completed-owner", "connected");
		await seedManagedRowRaw(
			"COMPLETED-BUT-CONNECTED",
			"completed-owner",
			"COMPLETED-BUT-CONNECTED",
			"completed",
		);

		const rows = await listLiveOwnedManagedSessions(["headless"]);
		expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set(["HIJ-LIVE", "LL-LIVE"]));
	});

	test("empty states returns [] with no query", async () => {
		expect(await listLiveOwnedManagedSessions([])).toEqual([]);
	});
});

// ─── AGEN-76: the lease decides, not the stored status column ───────────────

const HUNDRED_DAYS = 100 * 24 * 60 * 60 * 1000;

/** Stored "connected", lease 100 days old: the production shape. */
const seedStaleConnected = (id: string, extra: { enrollmentState?: string } = {}) =>
	seedSupervisor(id, {
		storedStatus: "connected",
		leaseOffsetMs: -HUNDRED_DAYS,
		leaseBaseMs: Date.now(),
		...extra,
	});

describe("a supervisor stored as connected with an expired lease is not live (R1, R2)", () => {
	test("R1: getSessionOwnerConnections reports false", async () => {
		await seedStaleConnected("stale-sup");
		await seedManagedSession({
			sessionId: "R1",
			supervisorId: "stale-sup",
			managedState: "interactive_terminal",
		});
		expect((await getSessionOwnerConnections(["R1"])).get("R1")).toBe(false);
	});

	test("R2: listLiveOwnedManagedSessions excludes it, and a revoked host with a future lease", async () => {
		await seedStaleConnected("stale-sup");
		await seedSupervisor("revoked-sup", {
			leaseOffsetMs: 60_000,
			leaseBaseMs: Date.now(),
			enrollmentState: "revoked",
		});
		await seedSupervisor("live-sup", { leaseOffsetMs: 60_000, leaseBaseMs: Date.now() });
		for (const [sessionId, supervisorId] of [
			["R2-stale", "stale-sup"],
			["R2-revoked", "revoked-sup"],
			["R2-live", "live-sup"],
		] as const) {
			await seedManagedSession({ sessionId, supervisorId, managedState: "interactive_terminal" });
		}
		const rows = await listLiveOwnedManagedSessions(["interactive_terminal"]);
		expect(rows.map((r) => r.sessionId)).toEqual(["R2-live"]);
		expect(typeof rows[0]?.lastActivityAt).toBe("string");
	});
});

describe("the sweep follows the lease (L5)", () => {
	// The live host's session is silent 1 day: far past idle/end, inside the
	// 72 h ceiling, so only the lease protects it.
	const silentSince = (supervisorId: string) =>
		new Date(
			Date.now() - (supervisorId === "dead-host" ? HUNDRED_DAYS : 24 * 60 * MINUTE),
		).toISOString();

	test("L5: an interactive_terminal session under an expired lease completes in one tick; a live lease keeps it", async () => {
		await seedStaleConnected("dead-host");
		await seedSupervisor("live-host", { leaseOffsetMs: 60_000, leaseBaseMs: Date.now() });
		for (const [sessionId, supervisorId] of [
			["L5-dead", "dead-host"],
			["L5-live", "live-host"],
		] as const) {
			await seedManagedSession({
				sessionId,
				supervisorId,
				managedState: "interactive_terminal",
				session: {
					status: "active",
					isWorking: true,
					lastActivityAt: silentSince(supervisorId),
				},
			});
		}
		await updateStaleSessions();
		const [dead] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "L5-dead"));
		expect(dead?.status).toBe("completed");
		expect(dead?.isWorking).toBe(false);
		expect(dead?.endedAt).toBeTruthy();
		const [live] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "L5-live"));
		expect(live?.status).toBe("active");
		expect(live?.isWorking).toBe(true);
	});
});

describe("reopen after late heartbeat (R4)", () => {
	const row = async (id: string) =>
		(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];

	function seedSilent(sessionId: string, supervisorId: string) {
		return seedManagedSession({
			sessionId,
			supervisorId,
			managedState: "interactive_terminal",
			session: {
				status: "active",
				isWorking: true,
				lastActivityAt: new Date(Date.now() - HUNDRED_DAYS).toISOString(),
			},
		});
	}

	async function reopenAndGoQuiet(sessionId: string) {
		await processHookEvent(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: sessionId,
				prompt: "hello again",
			} as never,
			"claude_code",
		);
		const reopened = await row(sessionId);
		expect(reopened?.status).toBe("active");
		expect(reopened?.endedAt).toBeNull();

		// quiet again, past the end cutoff, not working
		await getDb()
			.update(sessions)
			.set({
				isWorking: false,
				lastActivityAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
			})
			.where(eq(sessions.sessionId, sessionId));
	}

	test("a heartbeat re-protects the reopened session; without one it completes", async () => {
		await seedStaleConnected("late-host");
		await seedStaleConnected("silent-host");
		await seedSilent("R4-beat", "late-host");
		await seedSilent("R4-silent", "silent-host");
		await updateStaleSessions();
		expect((await row("R4-beat"))?.status).toBe("completed");
		expect((await row("R4-silent"))?.status).toBe("completed");
		await reopenAndGoQuiet("R4-beat");
		await reopenAndGoQuiet("R4-silent");

		const beat = await heartbeatSupervisor("late-host");
		const T = Date.now();
		expect(Date.parse(beat?.heartbeatLeaseExpiresAt ?? "")).toBeGreaterThan(T);

		await updateStaleSessions(T);
		expect((await row("R4-beat"))?.status).toBe("active");
		expect((await row("R4-silent"))?.status).toBe("completed");
	});
});

// ─── D4: the managed-silence ceiling ────────────────────────────────────────

describe("managed-silence ceiling", () => {
	const HOUR = 60 * MINUTE;
	const originalCeiling = config.managedSessionMaxSilenceMs;
	afterEach(() => {
		(config as Record<string, unknown>).managedSessionMaxSilenceMs = originalCeiling;
	});

	const row = async (id: string) =>
		(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];

	async function liveHostSession(sessionId: string, lastActivityAt: string) {
		if (!(await getDb().select().from(supervisors).where(eq(supervisors.id, "live-host"))).length) {
			await seedSupervisor("live-host", { leaseOffsetMs: 60_000, leaseBaseMs: Date.now() });
		}
		await seedManagedSession({
			sessionId,
			supervisorId: "live-host",
			managedState: "interactive_terminal",
			session: { status: "active", isWorking: true, lastActivityAt },
		});
	}
	const silentFor = (ms: number) => new Date(Date.now() - ms).toISOString();

	test("ceiling: silent 73 h under a live host completes in one sweep", async () => {
		await liveHostSession("c-73", silentFor(73 * HOUR));
		await updateStaleSessions();
		const r = await row("c-73");
		expect(r?.status).toBe("completed");
		expect(r?.isWorking).toBe(false);
	});

	test("ceiling: silent for exactly the ceiling completes (strictly less than 72 h is protected)", async () => {
		const T = Date.now();
		await liveHostSession("c-exact", new Date(T - config.managedSessionMaxSilenceMs).toISOString());
		await liveHostSession(
			"c-just-in",
			new Date(T - config.managedSessionMaxSilenceMs + 1).toISOString(),
		);
		await updateStaleSessions(T);
		expect((await row("c-exact"))?.status).toBe("completed");
		expect((await row("c-just-in"))?.status).toBe("active");
	});

	test("ceiling: silent 71 h stays active and working", async () => {
		await liveHostSession("c-71", silentFor(71 * HOUR));
		await updateStaleSessions();
		const r = await row("c-71");
		expect(r?.status).toBe("active");
		expect(r?.isWorking).toBe(true);
	});

	test("ceiling: a configured 1 h ceiling completes a session silent 2 h", async () => {
		(config as Record<string, unknown>).managedSessionMaxSilenceMs = HOUR;
		await liveHostSession("c-2h", silentFor(2 * HOUR));
		await updateStaleSessions();
		expect((await row("c-2h"))?.status).toBe("completed");
	});

	test("ceiling: a ceiling-completed session reopens on the next hook", async () => {
		await liveHostSession("c-reopen", silentFor(73 * HOUR));
		await updateStaleSessions();
		expect((await row("c-reopen"))?.status).toBe("completed");
		await processHookEvent(
			{ hook_event_name: "UserPromptSubmit", session_id: "c-reopen", prompt: "back" } as never,
			"claude_code",
		);
		const r = await row("c-reopen");
		expect(r?.status).toBe("active");
		expect(r?.endedAt).toBeNull();
	});

	describe("stored timestamp forms (raw last_activity_at)", () => {
		const T = Date.now();
		const forms: [string, (ms: number) => string][] = [
			["ISO Z", (ms) => new Date(ms).toISOString()],
			["bare SQLite", (ms) => toDbTimestamp(new Date(ms))],
			["Postgres +00", (ms) => `${toDbTimestamp(new Date(ms))}.123456+00`],
		];
		for (const [name, format] of forms) {
			test(`ceiling: ${name} at T-71h59m is protected, at T-72h01m completes`, async () => {
				await liveHostSession("f-in", format(T - (71 * HOUR + 59 * MINUTE)));
				await liveHostSession("f-out", format(T - (72 * HOUR + MINUTE)));
				await updateStaleSessions(T);
				const inside = await row("f-in");
				expect(inside?.status).toBe("active");
				expect(inside?.isWorking).toBe(true);
				expect((await row("f-out"))?.status).toBe("completed");
			});
		}

		test("ceiling: a freshly active bare-format session under a live host is untouched by the sweep", async () => {
			await liveHostSession("f-fresh", toDbTimestamp(new Date(T - MINUTE)));
			await updateStaleSessions(T);
			const r = await row("f-fresh");
			expect(r?.status).toBe("active");
			expect(r?.isWorking).toBe(true);
		});

		test("ceiling: an unparseable last_activity_at stays protected", async () => {
			await liveHostSession("f-bad", "0000-00-00 00:00:00");
			await updateStaleSessions(T);
			const r = await row("f-bad");
			expect(r?.status).toBe("active");
			expect(r?.isWorking).toBe(true);
		});
	});
});
