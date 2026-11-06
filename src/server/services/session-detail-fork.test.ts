/**
 * What the session detail says about a fork and the session it came from (AGEN-117 phase 6, server half):
 *  - the two fields a continued session carries at the top of its DTO, with a shape check;
 *  - `continuedIn` on the observed session: the newest fork, whether it is live, and nothing for a deleted one,
 *    in one statement;
 *  - `continuedFrom` on a fork: the observed session's name, or that it is archived or gone;
 *  - the fork's first timeline row, written by the real settle, says which settings apply before any prompt.
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres. The statement count is
 * SQLite-only (the meter wraps the raw handle).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { forkFirstRowContent } from "../../shared/claude-fork-copy.js";
import { CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import { CLAUDE_TAKEOVER } from "../../shared/session-resume.js";
import type { Actor } from "../auth/actor.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { clearInstanceSettings } from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { controlActions, events, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { cleanApprovalFixtures } = await import("../test-utils/codex-approvals-harness.js");
const { bindObservedSession } = await import("./session-binding.js");
const control = await import("./control-actions.js");
const { getSessionDetail } = await import("./session-detail.js");
const { mapSessionDto } = await import("./session-dto.js");
const { ENFORCES_LAUNCH_PRIVILEGES } = await import("./launch-compatibility.js");
const { installStatementMeter } = await import("../test-utils/statement-meter.js");

beforeAll(() => initializeDatabase());

const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
async function reset() {
	await cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const SOLO: Actor = { userId: null, label: "anonymous", role: "admin", mode: "solo" };
const CWD = "/work/project";
const MIN = 60_000;
const T0 = Math.floor(Date.now() / 1000) * 1000;
const SOURCE_NAME = "refactor the parser";
const HOST_NAME = "studio-mac";

async function seedHost(): Promise<string> {
	const id = `detail-host-${crypto.randomUUID().slice(0, 8)}`;
	hostsUsed.push(id);
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: HOST_NAME,
			platform: "darwin",
			arch: "arm64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: [CLAUDE_TAKEOVER, CLAUDE_TURN_CONTROL, ENFORCES_LAUNCH_PRIVILEGES],
				executables: {
					claude: {
						available: true,
						command: "claude",
						resolvedPath: "/usr/bin/claude",
						source: "auto",
					},
				},
			} as Record<string, unknown>,
			trustedRoots: ["/work"],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60 * MIN).toISOString(),
			enrollmentState: "active",
			ownerUserId: null,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

async function seedObserved(): Promise<string> {
	const id = crypto.randomUUID();
	sessionsUsed.push(id);
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			agentType: "claude_code",
			cwd: CWD,
			displayName: SOURCE_NAME,
			lastActivityAt: new Date(T0 - 10 * MIN).toISOString(),
			isWorking: false,
			status: "idle",
		});
	return id;
}

/** Takes S over, all the way through the real claim and settle, and returns the new fork's id. */
async function continueSession(sourceId: string, hostId: string, mode: "ask" | "restricted") {
	const result = await bindObservedSession(
		sourceId,
		{ targetSupervisorId: hostId, sameMachineConfirmed: true },
		SOLO,
		{ now: () => T0 },
	);
	const forkId = (result.action.metadata as { forkSessionId: string }).forkSessionId;
	sessionsUsed.push(forkId);
	await control.claimNextControlAction(hostId);
	await control.updateControlAction({
		actionId: result.action.id,
		supervisorId: hostId,
		status: "succeeded",
		provedCwd: CWD,
		permissionMode: mode,
	});
	return forkId;
}

const detail = async (id: string) => {
	const read = await getSessionDetail(id);
	if (!read) throw new Error(`no session ${id}`);
	return read.session;
};

describe("the DTO's fork fields: a shape check on server-owned metadata", () => {
	const base = { metadata: {}, ownerUserId: null, ingestKeyId: null } as never;
	test("both are read from the metadata and present only when well formed", () => {
		const mapped = (metadata: Record<string, unknown>) =>
			mapSessionDto({ ...(base as object), metadata } as never);
		expect(mapped({ forkedFromSessionId: "s-1", forkPermissionBranch: "ask" })).toMatchObject({
			forkedFromSessionId: "s-1",
			forkPermissionBranch: "ask",
		});
		expect(
			mapped({ forkedFromSessionId: "s-1", forkPermissionBranch: "restricted" }),
		).toMatchObject({
			forkPermissionBranch: "restricted",
		});
		// A mode that isn't one of the two is left out, and the fork still is one.
		const odd = mapped({ forkedFromSessionId: "s-1", forkPermissionBranch: "bypass" });
		expect(odd.forkedFromSessionId).toBe("s-1");
		expect("forkPermissionBranch" in odd).toBe(false);
		for (const bad of [{}, { forkedFromSessionId: 7 }, { forkedFromSessionId: "" }]) {
			const out = mapped({ ...bad, forkPermissionBranch: "ask" });
			expect("forkedFromSessionId" in out).toBe(false);
			expect("forkPermissionBranch" in out).toBe(false);
		}
	});
});

describe("continuedIn, continuedFrom and the first row, from a real settle", () => {
	test("S names its live fork; the fork names S; the fork's first row states the mode and the machine", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const before = JSON.stringify(
			(await getDb().select().from(sessions).where(eq(sessions.sessionId, sourceId)))[0],
		);
		const forkId = await continueSession(sourceId, host, "restricted");

		const s = await detail(sourceId);
		expect(s.continuedIn).toEqual({
			sessionId: forkId,
			name: `${SOURCE_NAME} (continued)`,
			live: true,
		});
		const n = await detail(forkId);
		expect(n.forkedFromSessionId).toBe(sourceId);
		expect(n.forkPermissionBranch).toBe("restricted");
		expect(n.continuedFrom).toEqual({ sessionId: sourceId, name: SOURCE_NAME, state: "available" });
		expect("continuedIn" in n).toBe(false);
		expect("continuedFrom" in s).toBe(false);

		const [first] = await getDb().select().from(events).where(eq(events.sessionId, forkId));
		expect(first?.eventType).toBe("ManagedSessionResumed");
		expect(first?.content).toBe(forkFirstRowContent("restricted", HOST_NAME, SOURCE_NAME));
		expect(first?.content).toContain("Send a prompt to carry on.");
		expect(first?.content).toContain(
			`Your Claude settings on ${HOST_NAME} aren't used in this session`,
		);
		// S's row was never written.
		expect(
			JSON.stringify(
				(await getDb().select().from(sessions).where(eq(sessions.sessionId, sourceId)))[0],
			),
		).toBe(before);
	});

	test("an ask fork's first row names the settings that still apply, the allow rules and the hooks, and the original by name", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const forkId = await continueSession(sourceId, host, "ask");
		const [first] = await getDb().select().from(events).where(eq(events.sessionId, forkId));
		expect(first?.content).toBe(forkFirstRowContent("ask", HOST_NAME, SOURCE_NAME));
		expect(first?.content).toContain("still apply in this session");
		expect(first?.content).toContain("anything a hook there answers");
		expect(first?.content).toContain(`continue ${SOURCE_NAME} again`);
		expect(first?.content).not.toMatch(/enforced/i);
	});

	test("an ended fork leaves S offering a new one; a deleted fork is no link at all", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const forkId = await continueSession(sourceId, host, "ask");
		await getDb()
			.update(managedSessions)
			.set({ managedState: "stopped" })
			.where(eq(managedSessions.sessionId, forkId));
		expect((await detail(sourceId)).continuedIn).toMatchObject({ sessionId: forkId, live: false });
		for (const state of ["pending", "managed", "degraded"]) {
			await getDb()
				.update(managedSessions)
				.set({ managedState: state })
				.where(eq(managedSessions.sessionId, forkId));
			expect((await detail(sourceId)).continuedIn?.live, state).toBe(true);
		}
		for (const state of ["stopped", "completed", "failed"]) {
			await getDb()
				.update(managedSessions)
				.set({ managedState: state })
				.where(eq(managedSessions.sessionId, forkId));
			expect((await detail(sourceId)).continuedIn?.live, state).toBe(false);
		}
		await getDb().delete(sessions).where(eq(sessions.sessionId, forkId));
		expect("continuedIn" in (await detail(sourceId))).toBe(false);
	});

	test("the newest of two forks is the one S names", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const first = await continueSession(sourceId, host, "ask");
		await getDb()
			.update(managedSessions)
			.set({ managedState: "stopped" })
			.where(eq(managedSessions.sessionId, first));
		await getDb()
			.update(controlActions)
			.set({ createdAt: new Date(T0 - 5 * MIN).toISOString() })
			.where(eq(controlActions.sessionId, sourceId));
		const second = await continueSession(sourceId, host, "restricted");
		expect((await detail(sourceId)).continuedIn).toMatchObject({ sessionId: second, live: true });
	});

	test("a fork says when its original is archived or gone, and never says gone for a read it couldn't make", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const forkId = await continueSession(sourceId, host, "ask");
		await getDb()
			.update(sessions)
			.set({ isArchived: true })
			.where(eq(sessions.sessionId, sourceId));
		expect((await detail(forkId)).continuedFrom).toEqual({
			sessionId: sourceId,
			name: SOURCE_NAME,
			state: "archived",
		});
		await getDb().delete(sessions).where(eq(sessions.sessionId, sourceId));
		expect((await detail(forkId)).continuedFrom).toEqual({
			sessionId: sourceId,
			name: null,
			state: "deleted",
		});
	});

	test("a session that was never observed and forked reads like any other: no fork fields", async () => {
		const sourceId = await seedObserved();
		const s = await detail(sourceId);
		for (const key of [
			"continuedIn",
			"continuedFrom",
			"forkedFromSessionId",
			"forkPermissionBranch",
		]) {
			expect(key in s, key).toBe(false);
		}
	});

	test.skipIf(config.dialect !== "sqlite")(
		"a session nobody continued costs nothing extra; one with a fork costs one more statement; a fork costs one read of its original",
		async () => {
			const host = await seedHost();
			const plainId = await seedObserved();
			const sourceId = await seedObserved();
			const forkId = await continueSession(sourceId, host, "ask");
			const count = async (id: string) => {
				const meter = installStatementMeter();
				try {
					await getSessionDetail(id);
					return meter.executions.slice();
				} finally {
					meter.restore();
				}
			};
			const plain = await count(plainId);
			const withFork = await count(sourceId);
			// The newest fork is found inside the session read, as a subquery: no statement of its own.
			expect(plain.some((e) => /json_extract/i.test(e.sql))).toBe(true);
			expect(withFork.length).toBe(plain.length + 1);
			// The one more is the fork's own row and managed state, by key.
			expect(withFork.filter((e) => e.params.includes(forkId))).toHaveLength(1);
			// A fork's detail reads its original once, by key.
			const originalRead = (await count(forkId)).filter((e) => e.params.includes(sourceId));
			expect(originalRead).toHaveLength(1);
			expect(originalRead[0]?.sql).toMatch(/is_archived/i);
		},
	);
});

describe("lists: a fork's row carries the fields at no extra cost, and card rows carry none", () => {
	test("a list row for the fork has both fields; the card allowlist is unchanged and holds neither", async () => {
		const host = await seedHost();
		const sourceId = await seedObserved();
		const forkId = await continueSession(sourceId, host, "restricted");
		const { getSessions, getSessionCards } = await import("./session-tracker.js");
		const { SESSION_CARD_FIELDS } = await import("./session-card.js");
		const listed = (await getSessions({ limit: 50 } as never)).sessions.find(
			(r) => r.sessionId === forkId,
		);
		expect(listed).toMatchObject({
			forkedFromSessionId: sourceId,
			forkPermissionBranch: "restricted",
		});
		// The list never resolves the link: that is the detail read's one extra statement.
		expect("continuedIn" in (listed as object)).toBe(false);
		expect("continuedFrom" in (listed as object)).toBe(false);
		expect(SESSION_CARD_FIELDS as readonly string[]).not.toContain("forkedFromSessionId");
		expect(SESSION_CARD_FIELDS as readonly string[]).not.toContain("forkPermissionBranch");
		expect(SESSION_CARD_FIELDS as readonly string[]).not.toContain("continuedIn");
		const card = (await getSessionCards({ limit: 50 } as never)).sessions.find(
			(r) => r.sessionId === forkId,
		);
		expect(card).toBeDefined();
		for (const key of [
			"forkedFromSessionId",
			"forkPermissionBranch",
			"continuedIn",
			"continuedFrom",
			"metadata",
		]) {
			expect(key in (card as object), key).toBe(false);
		}
	});

	test.skipIf(config.dialect !== "sqlite")(
		"the list costs the same number of statements with a fork row in it",
		async () => {
			const { getSessions } = await import("./session-tracker.js");
			const host = await seedHost();
			const sourceId = await seedObserved();
			const run = async () => {
				const meter = installStatementMeter();
				try {
					await getSessions({ limit: 50 } as never);
					return meter.executions.length;
				} finally {
					meter.restore();
				}
			};
			const before = await run();
			await continueSession(sourceId, host, "ask");
			expect(await run()).toBe(before);
		},
	);
});

describe("the detail read's lookup of the newest fork is an index seek, and only for Claude sessions", () => {
	test.skipIf(config.dialect !== "sqlite")(
		"EXPLAIN QUERY PLAN: the control_actions leg SEARCHes by idx_control_actions_session",
		async () => {
			const { getSqlite } = await import("../db/client.js");
			const sourceId = await seedObserved();
			const meter = installStatementMeter();
			let statement: { sql: string; params: unknown[] } | undefined;
			try {
				await getSessionDetail(sourceId);
				statement = meter.executions.find((e) => /from "?`?control_actions/i.test(e.sql));
			} finally {
				meter.restore();
			}
			expect(statement, "the read's SQL").toBeDefined();
			// Prepared and finalized here: a cached statement left open would hold a lock for the next test file.
			const explain = getSqlite().prepare(`EXPLAIN QUERY PLAN ${statement?.sql}`);
			let plan: string[];
			try {
				plan = (
					explain.all(...((statement?.params ?? []) as never[])) as Array<{ detail: string }>
				).map((r) => r.detail);
			} finally {
				explain.finalize();
			}
			const leg = plan.filter((d) => /control_actions/i.test(d));
			expect(leg.length).toBeGreaterThan(0);
			for (const d of leg) {
				expect(d, d).toMatch(/SEARCH/i);
				expect(d, d).toContain("idx_control_actions_session");
			}
			expect(plan.some((d) => /SCAN control_actions/i.test(d))).toBe(false);
		},
	);

	test.skipIf(config.dialect !== "sqlite")(
		"the lookup sits behind a claude_code CASE, so no other session's read reaches it",
		async () => {
			const sourceId = await seedObserved();
			const meter = installStatementMeter();
			try {
				await getSessionDetail(sourceId);
				const read = meter.executions.find((e) => /control_actions/i.test(e.sql));
				expect(read?.sql).toMatch(/case when [^)]*agent_type[^)]*= 'claude_code' then/i);
			} finally {
				meter.restore();
			}
		},
	);

	test("a Codex session with a succeeded resume action still reads no fork", async () => {
		const id = crypto.randomUUID();
		sessionsUsed.push(id);
		await getDb().insert(sessions).values({
			sessionId: id,
			agentType: "codex_cli",
			cwd: CWD,
			lastActivityAt: new Date().toISOString(),
			status: "idle",
		});
		await getDb()
			.insert(controlActions)
			.values({
				id: crypto.randomUUID(),
				sessionId: id,
				actionType: "resume",
				status: "succeeded",
				metadata: { forkSessionId: "x" },
			});
		expect("continuedIn" in (await detail(id))).toBe(false);
	});
});
