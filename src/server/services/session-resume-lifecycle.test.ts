/**
 * The resume lifecycle on the server (AGEN-115, phase 2): how a `resume` action ends, on every path, and
 * what each ending does to the rows, the session and the signals.
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres: real services, real
 * routes where a route is the subject, an injected clock only where a path reads one. Nothing here mocks
 * `updateControlAction`, `expireStaleControlLock` or the sweep.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import "../db/__test_db.js";
import { CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import { HOST_RESTARTED_SYNC_ERROR } from "../../shared/managed-messages.js";
import { RESUMES_SESSIONS, resumeFailureMessage } from "../../shared/session-resume.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	MIN,
	SOLO,
	TAKEOVER_CAPABILITIES,
	adminActor,
	cleanTakeoverFixtures,
	memberActor,
	seedDegradedLaunched,
	seedObservedSession,
	seedTakeoverHost,
	trackSession,
} from "../test-utils/takeover-fixtures.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions, events, launchRequests, managedSessions, sessions, supervisors } =
	await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { bindObservedSession, queueSessionResume } = await import("./session-binding.js");
const { BindRefusal } = await import("./bind-refusal.js");
const cx = await import("./control-actions.js");
const {
	upsertManagedSessionState,
	degradeCodexSessionsOfRestartedHost,
	appendManagedSessionEvents,
	_setAfterResumeCheckHookForTest,
} = await import("./managed-session-state.js");
const { SessionOwnershipError } = await import("./session-ownership.js");
const ownership = await import("./session-ownership.js");
const { processHookEvent, _setSessionEndSnapshotHookForTest } = await import(
	"./event-processor.js"
);
const { normalizeHookEvent } = await import("./event-normalizer.js");
const { getSession, updateStaleSessions } = await import("./session-tracker.js");
const { sessionBus } = await import("./notifier.js");
const wsRevalidation = await import("../ws/revalidation.js");
const { runSessionSweepTick } = await import("./session-sweep-tick.js");
const { classifyContinuability } = await import("./ai/continuability.js");
const { _resetSessionBindLimitForTest } = await import("./session-bind-limit.js");
const authz = await import("./authorization.js");

beforeAll(() => initializeDatabase());

const originalDisableAuth = config.disableAuth;
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	_resetSessionBindLimitForTest();
	_setSessionEndSnapshotHookForTest(null);
	_setAfterResumeCheckHookForTest(null);
	await cleanTakeoverFixtures();
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("lc-alice");
	const bob = await seedLocalUser("lc-bob");
	const admin = await seedLocalUser("lc-admin", "admin");
	return { alice, bob, admin };
}

// ── drivers ──────────────────────────────────────────────────────────────────

async function rows(sessionId: string) {
	const [launch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	const actions = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, sessionId));
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	const timeline = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	return { launch, managed, actions, session, timeline };
}

async function takeover(
	opts: {
		hostOwner?: string | null;
		sessionOwner?: string | null;
		actor?: Parameters<typeof bindObservedSession>[2];
		session?: Parameters<typeof seedObservedSession>[0];
		host?: string;
	} = {},
) {
	const host = opts.host ?? (await seedTakeoverHost({ ownerUserId: opts.hostOwner ?? null }));
	const id = await seedObservedSession({ ownerUserId: opts.sessionOwner ?? null, ...opts.session });
	const bound = await bindObservedSession(
		id,
		{ targetSupervisorId: host, sameMachineConfirmed: true },
		opts.actor ?? SOLO,
	);
	return { id, host, action: bound.action, launchId: bound.launchRequestId };
}

async function recovery(
	opts: { ownerUserId?: string | null; actor?: Parameters<typeof queueSessionResume>[1] } = {},
) {
	const host = await seedTakeoverHost({ ownerUserId: opts.ownerUserId ?? null });
	const seeded = await seedDegradedLaunched(host, { ownerUserId: opts.ownerUserId ?? null });
	const queued = await queueSessionResume(seeded.sessionId, opts.actor ?? SOLO);
	return { id: seeded.sessionId, host, launchId: seeded.launchId, action: queued.action };
}

async function claim(host: string) {
	const claimed = await cx.claimNextControlAction(host);
	if (!claimed) throw new Error("nothing to claim");
	return claimed;
}

function hostReportsManaged(
	host: string,
	ctx: { id: string; launchId: string; action: { id: string } },
	extra: Record<string, unknown> = {},
) {
	return upsertManagedSessionState(host, {
		sessionId: ctx.id,
		launchRequestId: ctx.launchId,
		managedState: "managed",
		status: "idle",
		providerThreadId: ctx.id,
		providerSyncState: "synced",
		clearProviderSyncError: true,
		resumeActionId: ctx.action.id,
		...extra,
	} as never);
}

function hostSays(
	host: string,
	action: { id: string },
	status: "succeeded" | "failed" | "running",
	error?: string,
) {
	return cx.updateControlAction({ actionId: action.id, supervisorId: host, status, error });
}

async function expireLock(id: string) {
	await getDb()
		.update(managedSessions)
		.set({ controlLockExpiresAt: new Date(Date.now() - 1000).toISOString() })
		.where(eq(managedSessions.sessionId, id));
}

async function actionOf(id: string) {
	const [row] = await getDb().select().from(controlActions).where(eq(controlActions.id, id));
	return row;
}

function snapshot(session: Record<string, unknown>) {
	return JSON.stringify(session);
}

// ── completeResumeAction (items 1, 2, 27) ───────────────────────────────────

describe("completeResumeAction", () => {
	test("a swept row comes back: ended state cleared, activity advanced, one ManagedSessionResumed event, not COMPLETED", async () => {
		const ctx = await takeover({
			session: {
				status: "completed",
				endedAt: new Date(Date.now() - 20 * MIN).toISOString(),
				metadata: {
					endedByEvent: { at: new Date(Date.now() - 20 * MIN).toISOString() },
					keep: "me",
				},
			},
		});
		const before = (await rows(ctx.id)).session;
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);

		await hostSays(ctx.host, ctx.action, "succeeded");

		const after = await rows(ctx.id);
		expect(after.session.endedAt).toBeNull();
		expect(after.session.status).toBe("idle");
		expect(after.session.isWorking).toBe(false);
		expect(after.session.currentTurnStartedAt).toBeNull();
		expect(Date.parse(after.session.lastActivityAt)).toBeGreaterThan(
			Date.parse(before.lastActivityAt),
		);
		const metadata = after.session.metadata as Record<string, unknown>;
		expect(metadata.endedByEvent).toBeUndefined();
		expect(typeof metadata.managedResumeAt).toBe("string");
		expect(metadata.keep).toBe("me");
		const resumed = after.timeline.filter((e) => e.eventType === "ManagedSessionResumed");
		expect(resumed.length).toBe(1);
		expect(resumed[0].category).toBe("system_event");
		expect(resumed[0].content).toBe("AgentPulse took over this session.");
		expect((await getSession(ctx.id))?.operationalStatus).not.toBe("completed");
		expect((await actionOf(ctx.action.id)).status).toBe("succeeded");
		expect(after.managed.activeControlActionId).toBeNull();
	});

	test("a recovery says so in its event, and keeps the row", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		const after = await rows(ctx.id);
		expect(after.timeline.map((e) => e.content)).toContain(
			"AgentPulse resumed this session. Any turn that was running when its process ended didn't finish.",
		);
		expect(after.managed.managedState).toBe("managed");
		expect(after.managed.providerSyncError).toBeNull();
	});

	test("it is a no-op unless the managed row names this launch and the action is still open", async () => {
		const ctx = await takeover();
		const stale = { ...ctx.action, launchRequestId: "some-other-launch" };
		expect(await cx.completeResumeAction(null, stale as never)).toEqual({ settled: false });
		expect((await actionOf(ctx.action.id)).status).toBe("queued");
		expect((await rows(ctx.id)).timeline).toEqual([]);

		await getDb()
			.update(controlActions)
			.set({ status: "failed" })
			.where(eq(controlActions.id, ctx.action.id));
		expect(await cx.completeResumeAction(null, ctx.action as never)).toEqual({ settled: false });
		expect((await rows(ctx.id)).session.metadata ?? {}).not.toHaveProperty("managedResumeAt");
	});

	test("a row still pending, though it names this launch, has not worked: nothing changes", async () => {
		const ctx = await takeover();
		expect((await rows(ctx.id)).managed.managedState).toBe("pending");
		expect(await cx.completeResumeAction(null, ctx.action as never)).toEqual({ settled: false });
		expect((await actionOf(ctx.action.id)).status).toBe("queued");
		expect((await rows(ctx.id)).timeline).toEqual([]);
	});

	test("a zero-row write inside the settle rolls the whole settle back", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await expect(
			cx.completeResumeAction(
				null,
				ctx.action as never,
				{
					afterWrites: async (tx: any) => {
						throw new Error("injected after the writes");
					},
				} as never,
			),
		).rejects.toThrow("injected");
		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("running");
		expect(after.timeline).toEqual([]);
		expect((after.session.metadata ?? {}) as object).not.toHaveProperty("managedResumeAt");
	});
});

describe("a native wait left by the crashed process is cleared; approvals are kept (D14)", () => {
	test("native ids and an anonymous count go, an approval: id stays, waiting status clears, other statuses stay", async () => {
		const hourAgo = Date.now() - 70 * MIN;
		const ctx = await takeover({
			session: {
				lastActivityMs: hourAgo,
				semanticStatus: "waiting",
				metadata: {
					permissionWait: { ids: ["native-1", "approval:abc"], anon: 2, prevStatus: "working" },
				},
			},
		});
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");

		const { session } = await rows(ctx.id);
		const wait = (session.metadata as Record<string, any>).permissionWait;
		expect(wait.ids).toEqual(["approval:abc"]);
		expect(wait.anon ?? 0).toBe(0);
		expect(session.semanticStatus).toBeNull();
	});

	test("with no approval id left the whole wait goes and the session isn't WAITING; testing stays testing", async () => {
		const ctx = await takeover({
			session: {
				lastActivityMs: Date.now() - 70 * MIN,
				semanticStatus: "testing",
				metadata: { permissionWait: { ids: ["native-1"], anon: 0, prevStatus: "working" } },
			},
		});
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");

		const { session } = await rows(ctx.id);
		expect((session.metadata as Record<string, unknown>).permissionWait).toBeUndefined();
		expect(session.semanticStatus).toBe("testing");
		expect((await getSession(ctx.id))?.operationalStatus).not.toBe("waiting");
	});
});

// ── failResumeAction (items 3, 4, 5, 6, 25) ─────────────────────────────────

describe("failResumeAction on a pending takeover", () => {
	test("both rows go, the action keeps its error, the session and its events are byte-identical, nobody gets the session, and the id can be bound again", async () => {
		const t = await team();
		const hostA = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const hostB = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const ctx = await takeover({ host: hostA, sessionOwner: null, actor: adminActor(t.admin.id) });
		const before = await rows(ctx.id);

		const outcome = await cx.failResumeAction(null, ctx.action as never, "the reason");

		expect(outcome).toMatchObject({ settled: true, sessionId: ctx.id });
		const after = await rows(ctx.id);
		expect(after.launch).toBeUndefined();
		expect(after.managed).toBeUndefined();
		expect(after.actions[0].status).toBe("failed");
		expect(after.actions[0].error).toBe("the reason");
		expect(snapshot(after.session)).toBe(snapshot(before.session));
		expect(after.session.ownerUserId).toBeNull();
		expect(after.timeline.length).toBe(before.timeline.length);

		await bindObservedSession(
			ctx.id,
			{ targetSupervisorId: hostB, sameMachineConfirmed: true },
			adminActor(t.admin.id),
		);
		expect((await rows(ctx.id)).managed.supervisorId).toBe(hostB);
	});

	test("a second settle is a no-op (racing paths produce one outcome)", async () => {
		const ctx = await takeover();
		await cx.failResumeAction(null, ctx.action as never, "first");
		expect(await cx.failResumeAction(null, ctx.action as never, "second")).toEqual({
			settled: false,
		});
		expect((await actionOf(ctx.action.id)).error).toBe("first");
	});

	test("a failed settle rolls back both writes together (the action stays running, the rows stay)", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await expect(
			cx.failResumeAction(null, (await actionOf(ctx.action.id)) as never, "x", {
				afterWrites: async () => {
					throw new Error("injected after the release");
				},
			} as never),
		).rejects.toThrow("injected");
		const after = await rows(ctx.id);
		expect(after.actions[0].status).toBe("running");
		expect(after.managed).toBeDefined();
		expect(after.launch).toBeDefined();
	});
});

describe("lock expiry (items 4, 12)", () => {
	test.each(["queued", "running"] as const)(
		"a %s takeover whose lock ran out is released with the timeout words",
		async (state) => {
			const ctx = await takeover();
			if (state === "running") await claim(ctx.host);
			await expireLock(ctx.id);

			await cx.expireStaleControlLock(getDb(), ctx.id);

			const after = await rows(ctx.id);
			expect(after.managed).toBeUndefined();
			expect(after.launch).toBeUndefined();
			expect(after.actions[0].status).toBe("failed");
			expect(after.actions[0].error).toBe(
				resumeFailureMessage("timeout", `${ctx.host}-name`, "takeover"),
			);
		},
	);

	test("takeover + degraded + expired is released too (the row's state doesn't save it)", async () => {
		const ctx = await takeover();
		await getDb()
			.update(managedSessions)
			.set({ managedState: "degraded" })
			.where(eq(managedSessions.sessionId, ctx.id));
		await expireLock(ctx.id);
		await cx.expireStaleControlLock(getDb(), ctx.id);
		expect((await rows(ctx.id)).managed).toBeUndefined();
	});

	test("either kind, the state report landed (managed, names this launch), the acknowledgement lost: succeeded", async () => {
		for (const make of [takeover, recovery]) {
			const ctx = await make();
			await claim(ctx.host);
			await hostReportsManaged(ctx.host, ctx);
			await expireLock(ctx.id);

			await cx.expireStaleControlLock(getDb(), ctx.id);

			const after = await rows(ctx.id);
			expect((await actionOf(ctx.action.id)).status).toBe("succeeded");
			expect(after.session.endedAt).toBeNull();
			expect(after.managed.managedState).toBe("managed");
			expect(after.managed.activeControlActionId).toBeNull();
		}
	});

	test("a recovery whose row is still degraded fails with the timeout words and keeps the row", async () => {
		const ctx = await recovery();
		await expireLock(ctx.id);
		await cx.expireStaleControlLock(getDb(), ctx.id);
		const after = await rows(ctx.id);
		expect(after.actions[0].status).toBe("failed");
		expect(after.actions[0].error).toBe(
			resumeFailureMessage("timeout", `${ctx.host}-name`, "recovery"),
		);
		expect(after.managed.managedState).toBe("degraded");
		expect(after.managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
		expect(after.managed.activeControlActionId).toBeNull();
		expect(after.launch).toBeDefined();
	});

	test("a lock that has not run out is left alone", async () => {
		const ctx = await takeover();
		await cx.expireStaleControlLock(getDb(), ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("queued");
	});
});

describe("the D10 table, row by row, for both kinds", () => {
	test("host says failed, takeover: released, action failed with the host's words", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostSays(ctx.host, ctx.action, "failed", "host words");
		const after = await rows(ctx.id);
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		expect(after.actions[0]).toMatchObject({ status: "failed", error: "host words" });
	});

	test("host says failed, recovery: the action fails, the row stays degraded, the lock is free", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await hostSays(ctx.host, ctx.action, "failed", "host words");
		const after = await rows(ctx.id);
		expect(after.actions[0].status).toBe("failed");
		expect(after.managed.managedState).toBe("degraded");
		expect(after.managed.activeControlActionId).toBeNull();
		expect(after.launch).toBeDefined();
	});

	test("claim refusal (a host that lost the feature), takeover: released with the upgrade words, and the claim moves on", async () => {
		const ctx = await takeover();
		await getDb()
			.update(supervisors)
			.set({ capabilities: { ...TAKEOVER_CAPABILITIES, features: [CODEX_FOLLOW_UP_PROMPTS] } })
			.where(eq(supervisors.id, ctx.host));
		expect(await cx.claimNextControlAction(ctx.host)).toBeNull();
		const after = await rows(ctx.id);
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		expect(after.actions[0].error).toBe(
			resumeFailureMessage("host_upgrade_required", `${ctx.host}-name`, "takeover"),
		);
	});

	test("claim refusal, recovery: failed, the row stays degraded", async () => {
		const ctx = await recovery();
		await getDb()
			.update(supervisors)
			.set({ capabilities: { ...TAKEOVER_CAPABILITIES, features: [] } })
			.where(eq(supervisors.id, ctx.host));
		await cx.claimNextControlAction(ctx.host);
		const after = await rows(ctx.id);
		expect(after.actions[0].error).toBe(
			resumeFailureMessage("host_upgrade_required", `${ctx.host}-name`, "recovery"),
		);
		expect(after.managed.managedState).toBe("degraded");
	});

	test("a resume candidate on an older host doesn't stop the claim reaching the next action", async () => {
		const old = await recovery();
		await getDb()
			.update(supervisors)
			.set({ capabilities: { ...TAKEOVER_CAPABILITIES, features: [CODEX_FOLLOW_UP_PROMPTS] } })
			.where(eq(supervisors.id, old.host));
		const stop = await seedDegradedLaunched(old.host);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "managed", providerSyncError: null })
			.where(eq(managedSessions.sessionId, stop.sessionId));
		await cx.queueStopAction(stop.sessionId, SOLO);

		const next = await cx.claimNextControlAction(old.host);

		expect(next?.actionType).toBe("stop");
		expect((await actionOf(old.action.id)).status).toBe("failed");
	});

	test("a non-resume candidate costs no capabilities read; a resume candidate adds exactly one", async () => {
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		// Two identical hosts, each with one session holding one queued action. Only the action's type differs.
		const stopHost = await seedTakeoverHost();
		const stopSession = await seedDegradedLaunched(stopHost);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "managed", providerSyncError: null })
			.where(eq(managedSessions.sessionId, stopSession.sessionId));
		await cx.queueStopAction(stopSession.sessionId, SOLO);
		const resume = await recovery();

		let stopClaim: unknown = null;
		const baseline = await countDbCalls(async () => {
			stopClaim = await cx.claimNextControlAction(stopHost);
		});
		let resumeClaim: unknown = null;
		const withResume = await countDbCalls(async () => {
			resumeClaim = await cx.claimNextControlAction(resume.host);
		});

		expect((stopClaim as { actionType: string }).actionType).toBe("stop");
		expect((resumeClaim as { actionType: string }).actionType).toBe("resume");
		// The one extra read is the host's capabilities (getSupervisor), and nothing else.
		expect(withResume).toBe(baseline + 1);
	});

	test("host restart, takeover: released with the restart words (before the degrade, so it is gone, not degraded)", async () => {
		const ctx = await takeover();
		await degradeCodexSessionsOfRestartedHost(ctx.host);
		const after = await rows(ctx.id);
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		expect(after.actions[0].error).toBe(
			resumeFailureMessage("restart", `${ctx.host}-name`, "takeover"),
		);
		expect(after.session).toBeDefined();
	});

	test("host restart, recovery: failed with the restart words, the row stays degraded", async () => {
		const ctx = await recovery();
		await degradeCodexSessionsOfRestartedHost(ctx.host);
		const after = await rows(ctx.id);
		expect(after.actions[0].error).toBe(
			resumeFailureMessage("restart", `${ctx.host}-name`, "recovery"),
		);
		expect(after.managed.managedState).toBe("degraded");
		expect(after.managed.activeControlActionId).toBeNull();
	});

	test("host says succeeded names this launch, either kind: completed", async () => {
		for (const make of [takeover, recovery]) {
			const ctx = await make();
			await claim(ctx.host);
			await hostReportsManaged(ctx.host, ctx);
			await hostSays(ctx.host, ctx.action, "succeeded");
			expect((await actionOf(ctx.action.id)).status).toBe("succeeded");
			expect(
				((await rows(ctx.id)).session.metadata as Record<string, unknown>).managedResumeAt,
			).toBeDefined();
		}
	});

	test("host says succeeded but the row doesn't name this launch: nothing changes", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await getDb()
			.update(managedSessions)
			.set({ launchRequestId: "another-launch" })
			.where(eq(managedSessions.sessionId, ctx.id));
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect((await actionOf(ctx.action.id)).status).toBe("running");
	});

	test("a host that says succeeded while the row never became managed has failed: the takeover is released", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		// No state report: the row is still pending, and it names this launch.
		await hostSays(ctx.host, ctx.action, "succeeded");
		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("failed");
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		expect(after.timeline.some((e) => e.eventType === "ManagedSessionResumed")).toBe(false);
	});

	test("the status route allows running, succeeded and failed for a resume, and nothing else", async () => {
		const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
		const ctx = await takeover();
		await claim(ctx.host);
		const credential = await createSupervisorCredential(ctx.host, "lc-status");
		const post = (status: string) =>
			app.request(`/api/v1/supervisors/${ctx.host}/control-actions/${ctx.action.id}/status`, {
				method: "POST",
				headers: new Headers({
					Authorization: `Bearer ${credential.token}`,
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({ status }),
			});
		for (const status of ["queued", "cancelled", "", "SUCCEEDED"]) {
			expect((await post(status)).status).toBe(400);
		}
		expect((await actionOf(ctx.action.id)).status).toBe("running");
		expect((await post("running")).status).toBe(200);
	});

	test("only the claiming host can settle its action", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		const other = await seedTakeoverHost();
		expect(await hostSays(other, ctx.action, "failed")).toBeNull();
		expect((await actionOf(ctx.action.id)).status).toBe("running");
	});
});

// ── racing endings (item 5) ─────────────────────────────────────────────────

describe("a late 'succeeded' and the expiry race", () => {
	test("after the expiry released the rows, a late succeeded changes nothing and the host's next report is refused", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await expireLock(ctx.id);
		await cx.expireStaleControlLock(getDb(), ctx.id);

		await hostSays(ctx.host, ctx.action, "succeeded");

		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("failed");
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		await expect(hostReportsManaged(ctx.host, ctx)).rejects.toBeInstanceOf(SessionOwnershipError);
		expect((await rows(ctx.id)).managed).toBeUndefined();
	});

	test.each([
		["succeeded first", true],
		["expiry first", false],
	])(
		"succeeded and expiry racing (%s): exactly one terminal outcome, never 'succeeded with the rows deleted'",
		async (_name, succeededFirst) => {
			const ctx = await takeover();
			await claim(ctx.host);
			await hostReportsManaged(ctx.host, ctx);
			await expireLock(ctx.id);
			const succeed = () => hostSays(ctx.host, ctx.action, "succeeded");
			const expire = () => cx.expireStaleControlLock(getDb(), ctx.id);

			await Promise.all(succeededFirst ? [succeed(), expire()] : [expire(), succeed()]);

			const after = await rows(ctx.id);
			const status = (await actionOf(ctx.action.id)).status;
			// The row names this launch and is managed, so either path completes it.
			expect(status).toBe("succeeded");
			expect(after.managed).toBeDefined();
			expect(after.timeline.filter((e) => e.eventType === "ManagedSessionResumed").length).toBe(1);
		},
	);

	test("failed and succeeded racing for a pending row: one outcome, rows consistent with it", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await Promise.all([
			hostSays(ctx.host, ctx.action, "failed", "host words"),
			hostSays(ctx.host, ctx.action, "succeeded"),
		]);
		const status = (await actionOf(ctx.action.id)).status;
		const after = await rows(ctx.id);
		if (status === "failed") expect(after.managed).toBeUndefined();
		else expect(after.managed).toBeDefined();
		expect(["failed", "succeeded"]).toContain(status);
	});
});

// ── late reports and D15 (items 8, 16) ──────────────────────────────────────

describe("a state report that carries resumeActionId", () => {
	test("clearProviderSyncError with an open action clears the error", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		expect((await rows(ctx.id)).managed.providerSyncError).toBeNull();
	});

	test("a bare providerSyncError: null doesn't clear it", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await upsertManagedSessionState(ctx.host, {
			sessionId: ctx.id,
			launchRequestId: ctx.launchId,
			managedState: "managed",
			providerSyncError: null,
		});
		expect((await rows(ctx.id)).managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});

	test("the flag with no resumeActionId is ignored", async () => {
		const ctx = await recovery();
		await upsertManagedSessionState(ctx.host, {
			sessionId: ctx.id,
			launchRequestId: ctx.launchId,
			managedState: "managed",
			clearProviderSyncError: true,
		} as never);
		expect((await rows(ctx.id)).managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});

	test("an absent field keeps the stored error, and HOST_RESTARTED survives any live null report", async () => {
		const ctx = await recovery();
		await upsertManagedSessionState(ctx.host, {
			sessionId: ctx.id,
			launchRequestId: ctx.launchId,
			providerSyncError: null,
		});
		expect((await rows(ctx.id)).managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});

	test("a replayed report on a degraded row is still held and ignores the flag", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await upsertManagedSessionState(
			ctx.host,
			{
				sessionId: ctx.id,
				launchRequestId: ctx.launchId,
				managedState: "managed",
				clearProviderSyncError: true,
				resumeActionId: ctx.action.id,
			} as never,
			{ replay: true },
		);
		const managed = (await rows(ctx.id)).managed;
		expect(managed.managedState).toBe("degraded");
		expect(managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});

	test.each([
		[
			"a released takeover",
			async () => {
				const ctx = await takeover();
				await cx.failResumeAction(null, ctx.action as never, "x");
				return ctx;
			},
		],
		[
			"a failed recovery",
			async () => {
				const ctx = await recovery();
				await cx.failResumeAction(null, ctx.action as never, "x");
				return ctx;
			},
		],
	])(
		"with the action closed (%s) the report is refused session_not_owned and writes nothing",
		async (_name, make) => {
			const ctx = await make();
			const before = await rows(ctx.id);
			await expect(hostReportsManaged(ctx.host, ctx)).rejects.toBeInstanceOf(SessionOwnershipError);
			const after = await rows(ctx.id);
			expect(after.session.lastActivityAt).toBe(before.session.lastActivityAt);
			expect(snapshot(after.managed ?? null)).toBe(snapshot(before.managed ?? null));
			if (before.managed) expect(after.managed.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
		},
	);

	test("for a deleted session the report is refused and the session is not recreated", async () => {
		const ctx = await takeover();
		await cx.failResumeAction(null, ctx.action as never, "x");
		await getDb().delete(sessions).where(eq(sessions.sessionId, ctx.id));
		await expect(hostReportsManaged(ctx.host, ctx)).rejects.toBeInstanceOf(SessionOwnershipError);
		expect((await rows(ctx.id)).session).toBeUndefined();
		expect((await rows(ctx.id)).managed).toBeUndefined();
	});

	test("an action id that belongs to another session is no key", async () => {
		const a = await takeover();
		const b = await takeover();
		await expect(
			hostReportsManaged(b.host, { id: b.id, launchId: b.launchId, action: a.action }),
		).rejects.toBeInstanceOf(SessionOwnershipError);
	});

	test("a settle that lands between the report's check and its writes never leaves the report's state on a released row", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		let reachedCheck!: () => void;
		const atCheck = new Promise<void>((resolve) => {
			reachedCheck = resolve;
		});
		let letReportGo!: () => void;
		const held = new Promise<void>((resolve) => {
			letReportGo = resolve;
		});
		_setAfterResumeCheckHookForTest(async () => {
			_setAfterResumeCheckHookForTest(null);
			reachedCheck();
			await held;
		});

		const report = hostReportsManaged(ctx.host, ctx);
		await atCheck;
		// Started from outside the report's transaction, and left to wait for it: on Postgres the action row
		// is held FOR SHARE, on SQLite the transaction slot is.
		const failing = cx.failResumeAction(null, ctx.action as never, "released meanwhile");
		await new Promise((resolve) => setTimeout(resolve, 100));
		letReportGo();
		await report;
		await failing;

		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("failed");
		// The invariant: never "action failed" with a managed row the report just wrote.
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
	});

	test("ownership is judged before the action: a foreign host learns nothing about an action's state", async () => {
		// Recoveries, whose rows survive a failure, so only the action's state differs between the two.
		const open = await recovery();
		const closed = await recovery();
		await cx.failResumeAction(null, closed.action as never, "x");
		const stranger = await seedTakeoverHost();
		const reasons: unknown[] = [];
		for (const ctx of [open, closed]) {
			const error = await hostReportsManaged(stranger, ctx).catch((e) => e);
			expect(error).toBeInstanceOf(SessionOwnershipError);
			reasons.push((error as { reason: string }).reason);
		}
		expect(reasons[0]).toBe(reasons[1]);
	});

	test("a report with no resumeActionId is unaffected", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await upsertManagedSessionState(ctx.host, {
			sessionId: ctx.id,
			launchRequestId: ctx.launchId,
			managedState: "managed",
			status: "idle",
		});
		expect((await rows(ctx.id)).managed.managedState).toBe("managed");
	});
});

// ── restart, offline hosts, the sweep (items 13, 14) ────────────────────────

describe("restart in the window", () => {
	test("a prompt action still fails as before", async () => {
		const host = await seedTakeoverHost();
		const seeded = await seedDegradedLaunched(host);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "managed", providerSyncError: null })
			.where(eq(managedSessions.sessionId, seeded.sessionId));
		const prompt = await cx.queuePromptAction(seeded.sessionId, "hello", SOLO);
		await degradeCodexSessionsOfRestartedHost(host);
		expect((await actionOf(prompt.id)).status).toBe("failed");
	});

	test("a takeover row released in the window leaves the session free to be bound again", async () => {
		const ctx = await takeover();
		await degradeCodexSessionsOfRestartedHost(ctx.host);
		const again = await seedTakeoverHost();
		await bindObservedSession(
			ctx.id,
			{ targetSupervisorId: again, sameMachineConfirmed: true },
			SOLO,
		);
		expect((await rows(ctx.id)).managed.supervisorId).toBe(again);
	});
});

describe("a stuck pending row (the restart path, the inactivity sweep and the watcher)", () => {
	async function stuckPending() {
		const host = await seedTakeoverHost();
		const id = await seedObservedSession({ lastActivityMs: Date.now() - 3 * 60 * MIN });
		const [launch] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: id,
				agentType: "codex_cli",
				cwd: "/work/project",
				status: "completed",
				requestedSupervisorId: host,
				claimedBySupervisorId: host,
				metadata: { boundObservedSession: true, boundByUserId: null },
			})
			.returning();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: id,
				launchRequestId: launch.id,
				supervisorId: host,
				providerThreadId: id,
				managedState: "pending",
				hostAffinityReason: "taken_over",
				hostName: `${host}-name`,
			});
		return { id, host, launch };
	}

	test("the restart path settles the resume action and releases; a pending row with no action degrades as before", async () => {
		const bound = await takeover();
		await degradeCodexSessionsOfRestartedHost(bound.host);
		expect((await rows(bound.id)).managed).toBeUndefined();
		expect((await actionOf(bound.action.id)).status).toBe("failed");

		const stuck = await stuckPending();
		await degradeCodexSessionsOfRestartedHost(stuck.host);
		expect((await rows(stuck.id)).managed.managedState).toBe("degraded");
	});

	test("while the row is pending under a live host the inactivity sweep leaves the session alone; after the release it doesn't", async () => {
		const ctx = await takeover({ session: { lastActivityMs: Date.now() - 20 * MIN } });
		await updateStaleSessions(Date.now());
		expect((await rows(ctx.id)).session.status).toBe("idle");
		const pendingListed = await ownership.listLiveOwnedManagedSessions(["pending"]);
		expect(pendingListed.map((r) => r.sessionId)).toContain(ctx.id);

		await cx.failResumeAction(null, ctx.action as never, "x");

		expect(
			(await ownership.listLiveOwnedManagedSessions(["pending"])).map((r) => r.sessionId),
		).not.toContain(ctx.id);
		await updateStaleSessions(Date.now() + 60 * MIN);
		expect((await rows(ctx.id)).session.status).toBe("completed");
	});

	test("the watcher can't report on a pending row whose host is offline; once released it can again", async () => {
		const ctx = await takeover();
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - MIN).toISOString() })
			.where(eq(supervisors.id, ctx.host));
		const input = async () => {
			const session = (await getSession(ctx.id)) as never;
			const managed = (await rows(ctx.id)).managed;
			const connected = (await ownership.getSessionOwnerConnections([ctx.id])).get(ctx.id);
			return {
				session,
				recentEvents: [
					{ eventType: "Stop", category: "system_event", createdAt: new Date().toISOString() },
				] as never,
				managedSession: managed ? { managedState: managed.managedState as never } : null,
				supervisorConnected: connected,
			};
		};
		const blocked = classifyContinuability(await input());
		expect(blocked).toMatchObject({ eligibleToReport: false, reason: "supervisor_offline" });

		await cx.expireStaleControlLock(getDb(), ctx.id);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(managedSessions.sessionId, ctx.id));
		await cx.sweepExpiredResumeActions();

		const freed = classifyContinuability(await input());
		expect(freed.eligibleToReport).toBe(true);
	});
});

describe("sweepExpiredResumeActions", () => {
	test("an offline host's takeover is released within the lapse with no other trigger", async () => {
		const ctx = await takeover();
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - MIN).toISOString() })
			.where(eq(supervisors.id, ctx.host));
		await expireLock(ctx.id);
		await cx.sweepExpiredResumeActions();
		expect((await rows(ctx.id)).managed).toBeUndefined();
		expect((await actionOf(ctx.action.id)).status).toBe("failed");
	});

	test("a revoked or removed host's too", async () => {
		const revoked = await takeover();
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, revoked.host));
		await expireLock(revoked.id);
		const removed = await takeover();
		await getDb().delete(supervisors).where(eq(supervisors.id, removed.host));
		await expireLock(removed.id);
		await cx.sweepExpiredResumeActions();
		for (const ctx of [revoked, removed]) {
			expect((await rows(ctx.id)).managed).toBeUndefined();
			expect((await actionOf(ctx.action.id)).status).toBe("failed");
		}
	});

	test("a rolled-back or downgraded host that was queued a resume ends released, through the sweep", async () => {
		const ctx = await takeover();
		// The host was rolled back to a supervisor that doesn't know `resume`: it never claims the action.
		await getDb()
			.update(supervisors)
			.set({ capabilities: { ...TAKEOVER_CAPABILITIES, features: [] } })
			.where(eq(supervisors.id, ctx.host));
		expect((await actionOf(ctx.action.id)).status).toBe("queued");
		await cx.sweepExpiredResumeActions();
		expect((await rows(ctx.id)).managed).toBeDefined();

		await expireLock(ctx.id);
		await cx.sweepExpiredResumeActions();

		const after = await rows(ctx.id);
		expect([after.managed, after.launch].map(Boolean)).toEqual([false, false]);
		expect(after.actions[0].status).toBe("failed");
	});

	test("it leaves a lock that hasn't lapsed, and an action that isn't a resume, alone", async () => {
		const ctx = await takeover();
		const stop = await seedDegradedLaunched(ctx.host);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "managed", providerSyncError: null })
			.where(eq(managedSessions.sessionId, stop.sessionId));
		const queued = await cx.queueStopAction(stop.sessionId, SOLO);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(managedSessions.sessionId, stop.sessionId));
		await cx.sweepExpiredResumeActions();
		expect((await rows(ctx.id)).managed).toBeDefined();
		expect((await actionOf(queued.id)).status).toBe("queued");
	});

	test("it settles the oldest 100 and the 101st waits", async () => {
		const host = await seedTakeoverHost();
		const ids: string[] = [];
		for (let i = 0; i < 101; i++) {
			const id = await seedObservedSession();
			await bindObservedSession(id, { targetSupervisorId: host, sameMachineConfirmed: true }, SOLO);
			ids.push(id);
		}
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(inArray(managedSessions.sessionId, ids));
		await cx.sweepExpiredResumeActions();
		const left = await getDb()
			.select()
			.from(managedSessions)
			.where(inArray(managedSessions.sessionId, ids));
		expect(left.length).toBe(1);
		await cx.sweepExpiredResumeActions();
		expect(
			(await getDb().select().from(managedSessions).where(inArray(managedSessions.sessionId, ids)))
				.length,
		).toBe(0);
	}, 60_000);
});

describe("the interval tick", () => {
	test("a throw in the resume sweep is caught and the same tick still runs the stale-session sweep", async () => {
		let staleRan = false;
		const errors = spyOn(console, "error");
		try {
			await runSessionSweepTick({
				sweepResume: async () => {
					throw new Error("sweep exploded");
				},
				updateStale: async () => {
					staleRan = true;
					return 0;
				},
			});
		} finally {
			errors.mockRestore();
		}
		expect(staleRan).toBe(true);
	});

	test("index.ts runs the tick, not the two sweeps by hand", () => {
		const text = readFileSync(join(REPO, "src/server/index.ts"), "utf8");
		expect(text).toContain("runSessionSweepTick");
		expect(text).not.toMatch(
			/setInterval\(async \(\) => \{\s*try \{\s*const ended = await updateStaleSessions/,
		);
	});
});

// ── recovery (item 9, 10, 22) ───────────────────────────────────────────────

describe("queueSessionResume", () => {
	test("queues a recovery action carrying the launch's own values, not the takeover's", async () => {
		const ctx = await recovery();
		const { actions, managed } = await rows(ctx.id);
		expect(actions.length).toBe(1);
		expect(actions[0].actionType).toBe("resume");
		expect(actions[0].status).toBe("queued");
		const metadata = actions[0].metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			resumeKind: "recovery",
			agentType: "codex_cli",
			cwd: "/work/launched",
			approvalPolicy: "default",
			sandboxMode: "read-only",
		});
		expect(metadata.threadId).toBe(managed.providerThreadId);
		// Not the takeover's pair (untrusted + workspace-write): the launch's own recorded values.
		expect(metadata.expectedEnforcedArgs).toEqual(["--sandbox", "read-only"]);
		expect(Object.hasOwn(metadata, "env")).toBe(false);
		expect(managed.activeControlActionId).toBe(actions[0].id);
	});

	test.each(["managed", "stopped", "completed", "failed", "pending"] as const)(
		"a %s row is not_resumable",
		async (state) => {
			const host = await seedTakeoverHost();
			const seeded = await seedDegradedLaunched(host);
			await getDb()
				.update(managedSessions)
				.set({ managedState: state })
				.where(eq(managedSessions.sessionId, seeded.sessionId));
			const error = await queueSessionResume(seeded.sessionId, SOLO).catch((e) => e);
			expect(error).toBeInstanceOf(BindRefusal);
			expect(error).toMatchObject({ code: "not_resumable", status: 409 });
			expect((await rows(seeded.sessionId)).actions).toEqual([]);
		},
	);

	test("a missing or malformed thread id, a non-Codex launch and an unmanaged session are not_resumable", async () => {
		const host = await seedTakeoverHost();
		const noThread = await seedDegradedLaunched(host, { threadId: null });
		const badThread = await seedDegradedLaunched(host, { threadId: "not-a-uuid" });
		const claude = await seedDegradedLaunched(host);
		await getDb()
			.update(launchRequests)
			.set({ agentType: "claude_code" })
			.where(eq(launchRequests.id, claude.launchId));
		for (const id of [noThread.sessionId, badThread.sessionId, claude.sessionId]) {
			expect(await queueSessionResume(id, SOLO).catch((e) => e)).toMatchObject({
				code: "not_resumable",
			});
		}
		const bare = await seedObservedSession();
		expect(await queueSessionResume(bare, SOLO).catch((e) => e)).toBeInstanceOf(BindRefusal);
	});

	test("a launch row that is another host's, or whose directory left the trusted roots, queues nothing", async () => {
		const host = await seedTakeoverHost();
		const seeded = await seedDegradedLaunched(host);
		await getDb()
			.update(launchRequests)
			.set({ cwd: "/srv/elsewhere" })
			.where(eq(launchRequests.id, seeded.launchId));
		expect(await queueSessionResume(seeded.sessionId, SOLO).catch((e) => e)).toMatchObject({
			code: "cwd_not_trusted",
		});
		expect((await rows(seeded.sessionId)).actions).toEqual([]);

		const other = await seedDegradedLaunched(host);
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: "someone-else", requestedSupervisorId: "someone-else" })
			.where(eq(launchRequests.id, other.launchId));
		expect(await queueSessionResume(other.sessionId, SOLO).catch((e) => e)).toBeInstanceOf(
			BindRefusal,
		);
		expect((await rows(other.sessionId)).actions).toEqual([]);
	});

	test("host offline, gone and without the feature queue nothing", async () => {
		const offline = await seedTakeoverHost({ leaseMs: -MIN });
		const gone = await seedTakeoverHost({ enrollmentState: "revoked" });
		const old = await seedTakeoverHost({
			capabilities: { ...TAKEOVER_CAPABILITIES, features: [CODEX_FOLLOW_UP_PROMPTS] },
		});
		const expected = ["host_offline", "host_gone", "host_upgrade_required"];
		for (const [i, host] of [offline, gone, old].entries()) {
			const seeded = await seedDegradedLaunched(host);
			expect(await queueSessionResume(seeded.sessionId, SOLO).catch((e) => e)).toMatchObject({
				code: expected[i],
			});
			expect((await rows(seeded.sessionId)).actions).toEqual([]);
		}
	});

	test("a second request while the first holds the lock is refused", async () => {
		const ctx = await recovery();
		expect(await queueSessionResume(ctx.id, SOLO).catch((e) => e)).toMatchObject({
			code: "not_resumable",
		});
		expect((await rows(ctx.id)).actions.length).toBe(1);
	});

	test("it uses the session rule (assertCanBindSession) and no host-owner check", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: null });
		const seeded = await seedDegradedLaunched(host, { ownerUserId: t.alice.id });
		expect(
			await queueSessionResume(seeded.sessionId, memberActor(t.bob.id)).catch((e) => e),
		).toMatchObject({ code: "session_not_found" });
		await queueSessionResume(seeded.sessionId, memberActor(t.alice.id));
		expect((await rows(seeded.sessionId)).actions.length).toBe(1);
	});

	test("the audit line is session_resumed with the real actor", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const seeded = await seedDegradedLaunched(host, { ownerUserId: t.alice.id });
		const log = spyOn(console, "log");
		try {
			await queueSessionResume(seeded.sessionId, memberActor(t.alice.id));
			const line = log.mock.calls
				.map((c) => String(c[0]))
				.find((x) => x.includes('"session_resumed"'));
			expect(JSON.parse(line as string)).toMatchObject({
				kind: "session_resumed",
				by: t.alice.id,
				sessionId: seeded.sessionId,
			});
		} finally {
			log.mockRestore();
		}
	});

	test("a failed recovery leaves the row degraded and the launch intact", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await hostSays(ctx.host, ctx.action, "failed", "no");
		const after = await rows(ctx.id);
		expect(after.managed.managedState).toBe("degraded");
		expect(after.launch).toBeDefined();
	});

	test("double failure, server half: a managed row with no runtime goes degraded on the host's idle report, and then qualifies", async () => {
		const host = await seedTakeoverHost();
		const seeded = await seedDegradedLaunched(host);
		await getDb()
			.update(managedSessions)
			.set({ managedState: "managed", providerSyncError: null, providerSyncState: "synced" })
			.where(eq(managedSessions.sessionId, seeded.sessionId));
		expect(await queueSessionResume(seeded.sessionId, SOLO).catch((e) => e)).toMatchObject({
			code: "not_resumable",
		});

		await upsertManagedSessionState(host, {
			sessionId: seeded.sessionId,
			launchRequestId: seeded.launchId,
			managedState: "degraded",
			status: "idle",
			providerSyncState: "failed",
			providerSyncError: "Connection to Codex lost.",
		});

		await queueSessionResume(seeded.sessionId, SOLO);
		expect((await rows(seeded.sessionId)).actions.length).toBe(1);
	});
});

// ── the /resume route (items 10, 24) ────────────────────────────────────────

const ORIGIN = "http://localhost:3000";

function resumePost(sessionId: string, headers: Headers) {
	const merged = new Headers(headers);
	merged.set("Content-Type", "application/json");
	return app.request(`/api/v1/sessions/${sessionId}/resume`, {
		method: "POST",
		headers: merged,
		body: "{}",
	});
}

describe("POST /sessions/:id/resume", () => {
	test("the 501 stub is gone: the real handler answers, and /fork still says not implemented", async () => {
		const host = await seedTakeoverHost();
		const ctx = { id: (await seedDegradedLaunched(host)).sessionId };
		const user = await seedLocalUser("lc-solo");
		const headers = await cookieHeadersFor(user.id);
		headers.set("Origin", ORIGIN);
		const res = await resumePost(ctx.id, headers);
		expect(res.status).toBe(202);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as {
			action: { actionType: string; metadata?: Record<string, unknown> };
		};
		expect(body.action.actionType).toBe("resume");
		expect(body.action.metadata?.env).toBeUndefined();

		const fork = await app.request(`/api/v1/sessions/${ctx.id}/fork`, { method: "POST", headers });
		expect(fork.status).toBe(501);
		const source = readFileSync(join(REPO, "src/server/routes/sessions.ts"), "utf8");
		expect(source).not.toContain("Resume is not implemented");
	});

	test("a manage key is human_required; an ingest key insufficient_scope; the cookie human succeeds with the same body", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const seeded = await seedDegradedLaunched(host, { ownerUserId: t.alice.id });
		const manage = await seedKey("lc-manage", ["manage"], t.alice.id);
		const ingest = await seedKey("lc-ingest", ["ingest"], t.alice.id);
		const viaManage = await resumePost(seeded.sessionId, bearerHeaders(manage.key));
		expect([viaManage.status, ((await viaManage.json()) as { error: string }).error]).toEqual([
			403,
			"human_required",
		]);
		const viaIngest = await resumePost(seeded.sessionId, bearerHeaders(ingest.key));
		expect(viaIngest.status).toBe(403);
		const human = await cookieHeadersFor(t.alice.id);
		human.set("Origin", ORIGIN);
		expect((await resumePost(seeded.sessionId, human)).status).toBe(202);
	});

	test("origin gate: a foreign Origin and a cookie with no Origin are 403 bad_origin; a member on another's session is 404", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const seeded = await seedDegradedLaunched(host, { ownerUserId: t.alice.id });
		const evil = await cookieHeadersFor(t.alice.id);
		evil.set("Origin", "https://evil.example");
		expect((await resumePost(seeded.sessionId, evil)).status).toBe(403);
		expect((await resumePost(seeded.sessionId, await cookieHeadersFor(t.alice.id))).status).toBe(
			403,
		);
		const bob = await cookieHeadersFor(t.bob.id);
		bob.set("Origin", ORIGIN);
		const foreign = await resumePost(seeded.sessionId, bob);
		const missing = await resumePost(crypto.randomUUID(), bob);
		expect(foreign.status).toBe(404);
		expect(await foreign.text()).toBe(await missing.text());
		expect((await rows(seeded.sessionId)).actions).toEqual([]);
	});

	test("the limiter is shared with /bind: the 11th request across both in a minute is 429 and queues nothing", async () => {
		const user = await seedLocalUser("lc-limit");
		const headers = await cookieHeadersFor(user.id);
		headers.set("Origin", ORIGIN);
		const host = await seedTakeoverHost();
		const bindBody = JSON.stringify({ targetSupervisorId: host, sameMachineConfirmed: true });
		for (let i = 0; i < 5; i++) {
			const id = await seedObservedSession({ agentType: "claude_code" });
			await app.request(`/api/v1/sessions/${id}/bind`, {
				method: "POST",
				headers: new Headers({
					...Object.fromEntries(headers),
					"Content-Type": "application/json",
				}),
				body: bindBody,
			});
		}
		for (let i = 0; i < 5; i++) await resumePost(crypto.randomUUID(), headers);
		const seeded = await seedDegradedLaunched(host);
		const eleventh = await resumePost(seeded.sessionId, headers);
		expect(eleventh.status).toBe(429);
		expect((await rows(seeded.sessionId)).actions).toEqual([]);
	});
});

// ── the reserved event, SessionEnd fence, prompt on pending ─────────────────

describe("ManagedSessionResumed is the server's alone", () => {
	test("a hook can't write it and a supervisor can't either", async () => {
		expect(
			normalizeHookEvent(
				{ hook_event_name: "ManagedSessionResumed", session_id: "x" } as never,
				"codex_cli",
			),
		).toEqual([]);
		expect(
			normalizeHookEvent(
				{ hook_event_name: "managedsessionresumed", session_id: "x" } as never,
				"codex_cli",
			),
		).toEqual([]);
		const ctx = await takeover();
		await expect(
			appendManagedSessionEvents(ctx.host, ctx.id, [
				{ eventType: "ManagedSessionResumed", category: "system_event", content: "x" },
			]),
		).rejects.toThrow();
	});

	test("a supervisor event that names it as its provider event type is refused too", async () => {
		const ctx = await takeover();
		await expect(
			appendManagedSessionEvents(ctx.host, ctx.id, [
				{
					eventType: "ManagedWarning",
					category: "system_event",
					providerEventType: "ManagedSessionResumed",
					content: "x",
				},
			]),
		).rejects.toThrow();
	});

	test("the event it writes makes no boundary", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		const { boundaryOf } = await import("./ai/turn-identity.js");
		const event = (await rows(ctx.id)).timeline.find(
			(e) => e.eventType === "ManagedSessionResumed",
		);
		expect(event).toBeDefined();
		expect(boundaryOf(event as never)).toBeNull();
	});
});

describe("a SessionEnd after a resume (D14)", () => {
	const sessionEnd = (id: string) => ({ hook_event_name: "SessionEnd", session_id: id }) as never;

	test("before a resume it ends the session as it always did (the control)", async () => {
		const id = await seedObservedSession();
		await processHookEvent(sessionEnd(id), "codex_cli");
		const { session } = await rows(id);
		expect(session.status).toBe("completed");
		expect(session.endedAt).not.toBeNull();
	});

	test("after a resume it is stored but ends nothing, and sets no latch", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");

		await processHookEvent(sessionEnd(ctx.id), "codex_cli");

		const { session, timeline } = await rows(ctx.id);
		expect(session.status).toBe("idle");
		expect(session.endedAt).toBeNull();
		expect((session.metadata as Record<string, unknown>).endedByEvent).toBeUndefined();
		expect(timeline.some((e) => e.eventType === "SessionEnd")).toBe(true);
	});

	test("it is permanent: a later SessionEnd never ends the session through hooks", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		for (let i = 0; i < 2; i++) await processHookEvent(sessionEnd(ctx.id), "codex_cli");
		expect((await rows(ctx.id)).session.endedAt).toBeNull();
	});

	test("a SessionEnd that read its snapshot before the resume committed does not overwrite the fence", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		_setSessionEndSnapshotHookForTest(async () => {
			_setSessionEndSnapshotHookForTest(null);
			await hostSays(ctx.host, ctx.action, "succeeded");
		});

		await processHookEvent(sessionEnd(ctx.id), "codex_cli");

		const { session } = await rows(ctx.id);
		expect(typeof (session.metadata as Record<string, unknown>).managedResumeAt).toBe("string");
		expect(session.status).toBe("idle");
		expect(session.endedAt).toBeNull();
	});

	test.each(["Stop", "Interrupt"])(
		"a %s with a turn id that read its snapshot before the resume settled leaves the fence and the trimmed wait alone",
		async (hookName) => {
			const ctx = await takeover({
				session: {
					lastActivityMs: Date.now() - 70 * MIN,
					metadata: {
						endedByEvent: { at: new Date(Date.now() - 80 * MIN).toISOString() },
						permissionWait: { ids: ["native-1", "approval:abc"], anon: 1, prevStatus: "working" },
					},
				},
			});
			await claim(ctx.host);
			await hostReportsManaged(ctx.host, ctx);
			_setSessionEndSnapshotHookForTest(async () => {
				_setSessionEndSnapshotHookForTest(null);
				await hostSays(ctx.host, ctx.action, "succeeded");
			});

			await processHookEvent(
				{ hook_event_name: hookName, session_id: ctx.id, turn_id: "turn-1" } as never,
				"codex_cli",
			);

			const metadata = (await rows(ctx.id)).session.metadata as Record<string, any>;
			expect(typeof metadata.managedResumeAt).toBe("string");
			expect(metadata.endedByEvent).toBeUndefined();
			expect(metadata.permissionWait?.ids ?? []).not.toContain("native-1");
			// The event's own effect is applied, to the fresh row.
			expect(metadata.closedTurnIds).toContain("turn-1");

			// And a forged SessionEnd afterwards still ends nothing.
			await processHookEvent(
				{ hook_event_name: "SessionEnd", session_id: ctx.id } as never,
				"codex_cli",
			);
			const { session } = await rows(ctx.id);
			expect(session.endedAt).toBeNull();
			expect(session.status).not.toBe("completed");
		},
	);

	test("a supervisor state report can neither set nor clear managedResumeAt", async () => {
		const ctx = await takeover();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx, {
			metadata: { managedResumeAt: "2000-01-01T00:00:00.000Z" },
		});
		expect(((await rows(ctx.id)).session.metadata ?? {}) as object).not.toHaveProperty(
			"managedResumeAt",
		);

		await hostSays(ctx.host, ctx.action, "succeeded");
		const stamped = ((await rows(ctx.id)).session.metadata as Record<string, unknown>)
			.managedResumeAt;
		await upsertManagedSessionState(ctx.host, {
			sessionId: ctx.id,
			metadata: { managedResumeAt: null, other: 1 },
		} as never);
		const metadata = (await rows(ctx.id)).session.metadata as Record<string, unknown>;
		expect(metadata.managedResumeAt).toBe(stamped);
		expect(metadata.other).toBe(1);
	});

	test("a recovered launched session gets the same fence", async () => {
		const ctx = await recovery();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		await processHookEvent(sessionEnd(ctx.id), "codex_cli");
		expect((await rows(ctx.id)).session.endedAt).toBeNull();
	});
});

describe("a prompt to a pending row (D21)", () => {
	test("answers control_busy while a takeover holds the lock, and never reaches the managed-state check", async () => {
		const ctx = await takeover();
		const error = await cx.queuePromptAction(ctx.id, "hello", SOLO).catch((e) => e);
		expect(error).toBeInstanceOf(cx.ControlBusyError);
		expect(error).not.toBeInstanceOf(cx.ManagedStateNotContinuableError);
	});

	test("narrow: a pending row with no active action keeps the old not-continuable answer", async () => {
		const ctx = await takeover();
		await cx.failResumeAction(null, ctx.action as never, "x");
		const host = ctx.host;
		const id = await seedObservedSession();
		const [launch] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: id,
				agentType: "codex_cli",
				cwd: "/work/project",
				status: "running",
				requestedSupervisorId: host,
				claimedBySupervisorId: host,
			})
			.returning();
		await getDb().insert(managedSessions).values({
			sessionId: id,
			launchRequestId: launch.id,
			supervisorId: host,
			managedState: "pending",
		});
		const error = await cx.queuePromptAction(id, "hello", SOLO).catch((e) => e);
		expect(error).toBeInstanceOf(cx.ManagedStateNotContinuableError);
	});

	test("a member's prompt and stop while the action holds the lock are refused; after success the owner rule decides", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const ctx = await takeover({ host, actor: adminActor(t.admin.id) });
		await expect(cx.queuePromptAction(ctx.id, "hi", memberActor(t.bob.id))).rejects.toBeInstanceOf(
			cx.ControlBusyError,
		);
		await expect(cx.queueStopAction(ctx.id, memberActor(t.bob.id))).rejects.toBeInstanceOf(
			cx.ControlBusyError,
		);
	});
});

// ── owner on success (item 26) ──────────────────────────────────────────────

describe("owner on success, never before and never after a failure (D6)", () => {
	async function adminTakesUnowned(hostOwner: string | null) {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: hostOwner === "alice" ? t.alice.id : null });
		const ctx = await takeover({ host, actor: adminActor(t.admin.id) });
		return { t, ctx, host };
	}

	test("the host's owner gets it", async () => {
		const { t, ctx } = await adminTakesUnowned("alice");
		expect((await rows(ctx.id)).session.ownerUserId).toBeNull();
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect((await rows(ctx.id)).session.ownerUserId).toBe(t.alice.id);
	});

	test("with an unowned host the admin who did it gets it", async () => {
		const { t, ctx } = await adminTakesUnowned(null);
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect((await rows(ctx.id)).session.ownerUserId).toBe(t.admin.id);
	});

	test("every failure leaves it unowned; the recorded key is untouched", async () => {
		const { ctx } = await adminTakesUnowned("alice");
		const before = (await rows(ctx.id)).session;
		await claim(ctx.host);
		await hostSays(ctx.host, ctx.action, "failed", "x");
		const after = (await rows(ctx.id)).session;
		expect(after.ownerUserId).toBeNull();
		expect(after.ingestKeyId).toBe(before.ingestKeyId);
	});

	test("an admin's owner change made after the bind is not overwritten", async () => {
		const { t, ctx } = await adminTakesUnowned("alice");
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.bob.id })
			.where(eq(sessions.sessionId, ctx.id));
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect((await rows(ctx.id)).session.ownerUserId).toBe(t.bob.id);
	});

	test("an assignee disabled mid-flight: the session stays unowned, the action still succeeds, and the log says so", async () => {
		const { t, ctx } = await adminTakesUnowned("alice");
		await disableUserDirectly(t.alice.id);
		const log = spyOn(console, "log");
		try {
			await claim(ctx.host);
			await hostReportsManaged(ctx.host, ctx);
			await hostSays(ctx.host, ctx.action, "succeeded");
			const line = log.mock.calls
				.map((c) => String(c[0]))
				.find((x) => x.includes("takeover_owner_unassignable"));
			expect(JSON.parse(line as string)).toMatchObject({
				sessionId: ctx.id,
				boundByUserId: t.admin.id,
			});
		} finally {
			log.mockRestore();
		}
		expect((await rows(ctx.id)).session.ownerUserId).toBeNull();
		expect((await actionOf(ctx.action.id)).status).toBe("succeeded");
	});

	test("an owned session never changes owner", async () => {
		const t = await team();
		const host = await seedTakeoverHost({ ownerUserId: t.alice.id });
		const ctx = await takeover({ host, sessionOwner: t.alice.id, actor: adminActor(t.admin.id) });
		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect((await rows(ctx.id)).session.ownerUserId).toBe(t.alice.id);
	});
});

// ── atomic expiry at the four call sites (item 28) ──────────────────────────

describe("expiry is atomic wherever it is reached", () => {
	async function expiredTakeover() {
		const ctx = await takeover();
		await claim(ctx.host);
		await expireLock(ctx.id);
		return ctx;
	}

	function failingRelease() {
		return spyOn(ownership, "releaseObservedBinding").mockImplementation(async () => {
			throw new Error("injected in the release");
		});
	}

	async function unchanged(ctx: { id: string; action: { id: string } }) {
		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("running");
		expect(after.managed).toBeDefined();
		expect(after.launch).toBeDefined();
	}

	test("from a claim poll (control-actions.ts, getDb())", async () => {
		const ctx = await expiredTakeover();
		const spy = failingRelease();
		try {
			await cx.claimNextControlAction(ctx.host).catch(() => undefined);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		await unchanged(ctx);
	});

	test("from prompt-deliverability.ts (getDb())", async () => {
		const ctx = await expiredTakeover();
		const { promptDeliverability } = await import("./ai/prompt-deliverability.js");
		const spy = failingRelease();
		try {
			await promptDeliverability(ctx.id).catch(() => undefined);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		await unchanged(ctx);
	});

	test("from the stop and prompt enqueue paths, which run inside the admin lock", async () => {
		const ctx = await expiredTakeover();
		const spy = failingRelease();
		try {
			await cx.queueStopAction(ctx.id, SOLO).catch(() => undefined);
			await cx.queuePromptAction(ctx.id, "hello", SOLO).catch(() => undefined);
		} finally {
			spy.mockRestore();
		}
		await unchanged(ctx);
	});

	test("a scan holds the four getDb() call sites of expireStaleControlLock", () => {
		const count = (file: string) =>
			(readFileSync(join(REPO, file), "utf8").match(/expireStaleControlLock\(getDb\(\)/g) ?? [])
				.length;
		// The claim poll's and the sweep's, both deliberately handed getDb(): the function settles a resume itself.
		expect(count("src/server/services/control-actions.ts")).toBe(2);
		expect(count("src/server/services/ai/prompt-deliverability.ts")).toBe(1);
		expect(count("src/server/services/ai/hitl-decision-service.ts")).toBe(2);
	});
});

describe("expireStaleControlLock inside someone else's transaction", () => {
	async function expiredRunning() {
		const ctx = await takeover();
		await claim(ctx.host);
		await expireLock(ctx.id);
		return ctx;
	}

	async function watchSignals() {
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
		const updated: unknown[] = [];
		const on = (s: unknown) => updated.push(s);
		sessionBus.on("session_updated", on);
		return {
			counts: () => ({ revalidations: revalidate.mock.calls.length, updates: updated.length }),
			stop: () => {
				sessionBus.off("session_updated", on);
				revalidate.mockRestore();
			},
		};
	}

	test("no signal inside the callback; exactly one session_updated and one revalidation after the commit", async () => {
		const ctx = await expiredRunning();
		const { withTransaction } = await import("../db/with-transaction.js");
		const watch = await watchSignals();
		try {
			const inside: Array<{ revalidations: number; updates: number }> = [];
			await withTransaction(async (tx) => {
				await cx.expireStaleControlLock(tx, ctx.id);
				inside.push(watch.counts());
			});
			expect(inside).toEqual([{ revalidations: 0, updates: 0 }]);
			expect(watch.counts()).toEqual({ revalidations: 1, updates: 1 });
		} finally {
			watch.stop();
		}
		expect((await rows(ctx.id)).managed).toBeUndefined();
	});

	test("the same inside the admin lock", async () => {
		const ctx = await expiredRunning();
		const { withAdminLock } = await import("../db/admin-lock.js");
		const watch = await watchSignals();
		try {
			await withAdminLock(async (tx) => {
				await cx.expireStaleControlLock(tx, ctx.id);
				expect(watch.counts()).toEqual({ revalidations: 0, updates: 0 });
			});
			expect(watch.counts()).toEqual({ revalidations: 1, updates: 1 });
		} finally {
			watch.stop();
		}
	});

	test("a callback that throws after the expiry: zero signals, rows unchanged", async () => {
		const ctx = await expiredRunning();
		const { withTransaction } = await import("../db/with-transaction.js");
		const watch = await watchSignals();
		try {
			await expect(
				withTransaction(async (tx) => {
					await cx.expireStaleControlLock(tx, ctx.id);
					throw new Error("the caller failed after the expiry");
				}),
			).rejects.toThrow("the caller failed");
			expect(watch.counts()).toEqual({ revalidations: 0, updates: 0 });
		} finally {
			watch.stop();
		}
		const after = await rows(ctx.id);
		expect((await actionOf(ctx.action.id)).status).toBe("running");
		expect(after.managed).toBeDefined();
		expect(after.launch).toBeDefined();
	});
});

// ── post-commit signals (item 29) ───────────────────────────────────────────

describe("post-commit signals", () => {
	async function watch<T>(fn: () => Promise<T>) {
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
		const updated: unknown[] = [];
		const on = (s: unknown) => updated.push(s);
		sessionBus.on("session_updated", on);
		try {
			await fn();
			return { revalidations: revalidate.mock.calls.length, updates: updated.length };
		} finally {
			sessionBus.off("session_updated", on);
			revalidate.mockRestore();
		}
	}

	test("fail and complete each lead to one session_updated and one revalidation", async () => {
		const failCtx = await takeover();
		await claim(failCtx.host);
		expect(await watch(() => hostSays(failCtx.host, failCtx.action, "failed", "x"))).toEqual({
			revalidations: 1,
			updates: 1,
		});
		const okCtx = await takeover();
		await claim(okCtx.host);
		await hostReportsManaged(okCtx.host, okCtx);
		expect(await watch(() => hostSays(okCtx.host, okCtx.action, "succeeded"))).toEqual({
			revalidations: 1,
			updates: 1,
		});
	});

	test("the sweep signals once per settled action, and not for a no-op", async () => {
		const ctx = await takeover();
		await expireLock(ctx.id);
		expect(await watch(() => cx.sweepExpiredResumeActions())).toEqual({
			revalidations: 1,
			updates: 1,
		});
		expect(await watch(() => cx.sweepExpiredResumeActions())).toEqual({
			revalidations: 0,
			updates: 0,
		});
		expect(await watch(() => cx.failResumeAction(null, ctx.action as never, "again"))).toEqual({
			revalidations: 0,
			updates: 0,
		});
	});
});

// ── drift guards (item 23) ──────────────────────────────────────────────────

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

describe("drift guards", () => {
	test("a resume action is failed only by failResumeAction and its named callers", () => {
		const callers = sourceFiles(join(REPO, "src/server"))
			.filter((file) =>
				/\b(failResumeAction|completeResumeAction)\(/.test(readFileSync(file, "utf8")),
			)
			.map((file) => relative(REPO, file))
			.sort();
		expect(callers).toEqual([
			"src/server/services/control-actions.ts",
			"src/server/services/managed-session-state.ts",
		]);
	});

	test("isTurnStale ignores a resume action: false after the takeover is queued and after it settles; a prompt action is the control", async () => {
		const { isTurnStale, computeTurnKey } = await import("./ai/turn-identity.js");
		const ctx = await takeover();
		const [trigger] = await getDb()
			.insert(events)
			.values({
				sessionId: ctx.id,
				eventType: "Stop",
				category: "system_event",
				source: "observed_hook",
				rawPayload: {},
				// Before the takeover was queued, as a turn that ended before anyone asked.
				createdAt: new Date(Date.now() - 15 * MIN).toISOString(),
			})
			.returning();
		const session = { sessionId: ctx.id, agentType: "codex_cli" } as never;
		const turnKey = await computeTurnKey(getDb(), session, { id: trigger.id, rawPayload: {} });

		expect(await isTurnStale(getDb(), session, turnKey, { id: trigger.id })).toBe(false);

		await claim(ctx.host);
		await hostReportsManaged(ctx.host, ctx);
		await hostSays(ctx.host, ctx.action, "succeeded");
		expect(await isTurnStale(getDb(), session, turnKey, { id: trigger.id })).toBe(false);

		// Control: a prompt action created after the trigger makes the same turn stale.
		await getDb()
			.insert(controlActions)
			.values({
				sessionId: ctx.id,
				actionType: "prompt",
				status: "queued",
				metadata: { prompt: "hello" },
			});
		expect(await isTurnStale(getDb(), session, turnKey, { id: trigger.id })).toBe(true);
	});
});

// Keep the imports the file's helpers share honest.
void authz;
void and;
void trackSession;
void RESUMES_SESSIONS;
