/**
 * AGEN-119, the server half of Stop turn: an `interrupt` control action ends what a continued Claude session
 * (a fork) is doing and keeps it open.
 *
 *  - it is refused in a fixed order (not managed, launch, runtime, no turn, host, feature) and is idempotent;
 *  - it takes NO lock: the running prompt keeps it, through the interrupt's success and its failure;
 *  - the claim re-judges it (age, feature, and that its target is still the running turn);
 *  - End session is the one authoritative terminal state when the two race, in both orders;
 *  - a host that registers again frees what it held; an interrupted end reads IDLE, not WAITING.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CLAUDE_STOP, CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import { HOST_RESTARTED_TURN_ERROR } from "../../shared/managed-messages.js";
import { CLAUDE_TAKEOVER } from "../../shared/session-resume.js";
import {
	CLAUDE_TURN_INTERRUPT,
	INTERRUPT_CLAIM_TTL_MS,
	SESSION_ENDED_FIRST,
	STOP_TURN_UPGRADE_MESSAGE,
	TURN_ALREADY_ENDED,
	interruptExpiredMessage,
} from "../../shared/stop-turn.js";
import type { Actor } from "../auth/actor.js";
import { TEST_BACKEND } from "../test-utils/backend.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };
const HOST = "sup-A";
const FEATURES = [CLAUDE_STOP, CLAUDE_TURN_CONTROL, CLAUDE_TAKEOVER, CLAUDE_TURN_INTERRUPT];

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const control = await import("./control-actions.js");
const {
	queuePromptAction,
	queueStopAction,
	queueInterruptAction,
	enqueueInterruptInTx,
	claimNextControlAction,
	updateControlAction,
	failRunningClaudePromptsOfRestartedHost,
} = control;
const { withAdminLock } = await import("../db/admin-lock.js");
const { applyManagedTurnBoundaries } = await import("./managed-session-state.js");
const { getOperationalStatus } = await import("../../shared/session-state.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

const setHostFeatures = (features: string[]) =>
	getDb()
		.update(supervisors)
		.set({ capabilities: { version: 1, features } as never })
		.where(eq(supervisors.id, HOST));

/** A continued Claude session: a Claude carrier launch that took over an observed session, on a live host. */
async function seedFork(
	sessionId: string,
	opts: { fork?: boolean; agent?: string; features?: string[]; host?: "live" | "none" } = {},
) {
	const agent = opts.agent ?? "claude_code";
	const launch = await seedOwnedLaunch(sessionId, HOST, { host: opts.host });
	await getDb()
		.update(launchRequests)
		.set({
			agentType: agent,
			requestedLaunchMode: agent === "codex_cli" ? "managed_codex" : "headless",
			cwd: "/work/launch-dir",
			metadata: opts.fork === false ? {} : { boundObservedSession: true },
		})
		.where(eq(launchRequests.id, launch.launchId));
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: agent,
			status: "active",
			lastActivityAt: now,
			metadata: { forkPermissionBranch: "ask" },
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.launchId,
			supervisorId: HOST,
			managedState: agent === "codex_cli" ? "managed" : "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	if (opts.host !== "none") await setHostFeatures(opts.features ?? FEATURES);
	return launch;
}

const managedOf = async (sessionId: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, sessionId)))[0];
const actionOf = async (id: string) =>
	(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0];
const sessionOf = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];

const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return null;
	} catch (error) {
		if (error instanceof control.ControlBusyError) return "control_busy";
		return (error as { code?: string }).code ?? (error as Error).name;
	}
};

/** A prompt the host has claimed: `running`, claimed by the owning host, holding the lock. */
async function runningPrompt(sessionId: string) {
	const queued = await queuePromptAction(sessionId, "do the thing", ACTOR);
	const claimed = await claimNextControlAction(HOST);
	expect(claimed?.id).toBe(queued.id);
	expect(claimed?.status).toBe("running");
	return queued.id;
}

describe("refusals, in order", () => {
	test("a session that doesn't exist, and one that isn't managed", async () => {
		expect(await codeOf(queueInterruptAction("nope", ACTOR))).toBe("SessionNotFoundError");
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "unmanaged",
				displayName: "u",
				agentType: "claude_code",
				status: "active",
				metadata: {},
			})
			.execute();
		expect(await codeOf(queueInterruptAction("unmanaged", ACTOR))).toBe("SessionNotManagedError");
	});

	test("a launch that isn't the session's: launch_mismatch", async () => {
		const launch = await seedFork("s-launchless");
		await getDb().delete(launchRequests).where(eq(launchRequests.id, launch.launchId));
		expect(await codeOf(queueInterruptAction("s-launchless", ACTOR))).toBe("LaunchMismatchError");
	});

	test.each([
		["a launched headless Claude (not a continued session)", { fork: false }],
		["a Codex session", { agent: "codex_cli" }],
	] as const)(
		"%s: interrupt_not_supported, before the holder or the host are looked at",
		async (_n, opts) => {
			await seedFork("s-unsupported", { ...opts, host: "none" });
			expect(await codeOf(queueInterruptAction("s-unsupported", ACTOR))).toBe(
				"interrupt_not_supported",
			);
		},
	);

	test("no turn running: no_turn_running; a Stop in progress counts (End session first)", async () => {
		await seedFork("s-idle");
		expect(await codeOf(queueInterruptAction("s-idle", ACTOR))).toBe("no_turn_running");
		const prompt = await runningPrompt("s-idle");
		await queueStopAction("s-idle", ACTOR);
		expect((await actionOf(prompt))?.status).toBe("failed");
		expect(await codeOf(queueInterruptAction("s-idle", ACTOR))).toBe("no_turn_running");
	});

	test("host offline, host gone and a host without the feature", async () => {
		await seedFork("s-host");
		await runningPrompt("s-host");
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() })
			.where(eq(supervisors.id, HOST));
		const offline = await codeOf(queueInterruptAction("s-host", ACTOR));
		expect(offline).toBe("host_offline");
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
			.where(eq(supervisors.id, HOST));
		await setHostFeatures(FEATURES.filter((f) => f !== CLAUDE_TURN_INTERRUPT));
		const err = await queueInterruptAction("s-host", ACTOR).catch((e: Error) => e);
		expect((err as Error).name).toBe("HostUpgradeRequiredError");
		expect((err as Error).message).toBe(STOP_TURN_UPGRADE_MESSAGE);
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.actionType, "interrupt")),
		).toEqual([]);
	});
});

describe("the interrupt takes no lock", () => {
	test("it queues with the target named, leaves the prompt's lock alone, and an identical press returns the same action", async () => {
		await seedFork("s-lock");
		const prompt = await runningPrompt("s-lock");
		const lockBefore = (await managedOf("s-lock"))?.controlLockExpiresAt;
		const action = await queueInterruptAction("s-lock", ACTOR);
		expect(action).toMatchObject({ actionType: "interrupt", status: "queued" });
		expect(action.metadata).toEqual({ runtime: "claude_stream", targetPromptActionId: prompt });
		const managed = await managedOf("s-lock");
		expect(managed?.activeControlActionId).toBe(prompt);
		expect(managed?.controlLockExpiresAt).toBe(lockBefore);
		const again = await queueInterruptAction("s-lock", ACTOR);
		expect(again.id).toBe(action.id);
		const all = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.actionType, "interrupt"));
		expect(all).toHaveLength(1);
	});

	test("its success and its failure both leave the prompt as the holder", async () => {
		await seedFork("s-hold");
		const prompt = await runningPrompt("s-hold");
		const first = await queueInterruptAction("s-hold", ACTOR);
		const claimed = await claimNextControlAction(HOST);
		expect(claimed).toMatchObject({ id: first.id, status: "running", actionType: "interrupt" });
		await updateControlAction({
			actionId: first.id,
			supervisorId: HOST,
			status: "succeeded",
			metadata: { interrupted: true },
		});
		expect((await managedOf("s-hold"))?.activeControlActionId).toBe(prompt);
		const second = await queueInterruptAction("s-hold", ACTOR);
		expect(second.id).not.toBe(first.id);
		await claimNextControlAction(HOST);
		await updateControlAction({
			actionId: second.id,
			supervisorId: HOST,
			status: "failed",
			error: "x",
		});
		expect((await managedOf("s-hold"))?.activeControlActionId).toBe(prompt);
		expect((await actionOf(prompt))?.status).toBe("running");
	});

	test("the claim hands the interrupt over while the prompt still holds the lock", async () => {
		await seedFork("s-claim");
		await runningPrompt("s-claim");
		const queued = await queueInterruptAction("s-claim", ACTOR);
		const claimed = await claimNextControlAction(HOST);
		expect(claimed?.id).toBe(queued.id);
	});
});

describe("the claim re-judges the interrupt (C-M1)", () => {
	test("a target that finished before the claim: the interrupt fails 'already ended' and is never handed over", async () => {
		await seedFork("s-finished");
		const prompt = await runningPrompt("s-finished");
		const queued = await queueInterruptAction("s-finished", ACTOR);
		await updateControlAction({ actionId: prompt, supervisorId: HOST, status: "succeeded" });
		expect(await claimNextControlAction(HOST)).toBeNull();
		const row = await actionOf(queued.id);
		expect(row).toMatchObject({ status: "failed", error: TURN_ALREADY_ENDED });
	});

	test("a target a Stop failed: the same, and the next turn is untouched", async () => {
		await seedFork("s-stopped");
		await runningPrompt("s-stopped");
		const queued = await queueInterruptAction("s-stopped", ACTOR);
		// The Stop fails the interrupt in its own transaction, so build the race by hand: re-queue it as the Stop would leave it.
		await getDb()
			.update(controlActions)
			.set({ status: "queued", error: null })
			.where(eq(controlActions.id, queued.id));
		await queueStopAction("s-stopped", ACTOR);
		await getDb()
			.update(controlActions)
			.set({ status: "queued", error: null })
			.where(eq(controlActions.id, queued.id));
		const claimed = await claimNextControlAction(HOST);
		expect(claimed?.actionType).toBe("stop");
		const row = await actionOf(queued.id);
		expect(row).toMatchObject({ status: "failed", error: TURN_ALREADY_ENDED });
	});

	test("an interrupt older than a minute: dropped with the host's name in the words", async () => {
		await seedFork("s-old");
		await runningPrompt("s-old");
		const queued = await queueInterruptAction("s-old", ACTOR);
		await getDb()
			.update(controlActions)
			.set({ createdAt: new Date(Date.now() - INTERRUPT_CLAIM_TTL_MS - 5_000).toISOString() })
			.where(eq(controlActions.id, queued.id));
		expect(await claimNextControlAction(HOST)).toBeNull();
		expect((await actionOf(queued.id))?.error).toBe(interruptExpiredMessage(HOST));
	});

	test("a host that lost the feature since it was queued: failed with the upgrade words", async () => {
		await seedFork("s-feature");
		await runningPrompt("s-feature");
		const queued = await queueInterruptAction("s-feature", ACTOR);
		await setHostFeatures(FEATURES.filter((f) => f !== CLAUDE_TURN_INTERRUPT));
		expect(await claimNextControlAction(HOST)).toBeNull();
		expect(await actionOf(queued.id)).toMatchObject({
			status: "failed",
			error: STOP_TURN_UPGRADE_MESSAGE,
		});
	});
});

describe("End session and Stop turn racing: one terminal state (F54)", () => {
	function assertBackend() {
		expect(config.dialect).toBe(TEST_BACKEND);
	}

	test("End committed while the interrupt is queued: failed 'session was ended' in the Stop's transaction, the lock released once", async () => {
		assertBackend();
		await seedFork("s-race1");
		const prompt = await runningPrompt("s-race1");
		const queued = await queueInterruptAction("s-race1", ACTOR);
		const stop = await queueStopAction("s-race1", ACTOR);
		expect(await actionOf(queued.id)).toMatchObject({
			status: "failed",
			error: SESSION_ENDED_FIRST,
		});
		expect((await actionOf(prompt))?.status).toBe("failed");
		expect((await managedOf("s-race1"))?.activeControlActionId).toBe(stop.id);
	});

	test("End committed while the interrupt is running: the host's late success changes nothing", async () => {
		assertBackend();
		await seedFork("s-race2");
		await runningPrompt("s-race2");
		const queued = await queueInterruptAction("s-race2", ACTOR);
		expect((await claimNextControlAction(HOST))?.id).toBe(queued.id);
		const stop = await queueStopAction("s-race2", ACTOR);
		expect((await actionOf(queued.id))?.status).toBe("failed");
		await updateControlAction({
			actionId: queued.id,
			supervisorId: HOST,
			status: "succeeded",
			metadata: { interrupted: true },
		});
		expect(await actionOf(queued.id)).toMatchObject({
			status: "failed",
			error: SESSION_ENDED_FIRST,
		});
		// ...and it never released the Stop's lock.
		expect((await managedOf("s-race2"))?.activeControlActionId).toBe(stop.id);
	});

	test("the other order: Stop turn after End is no_turn_running, and nothing is queued", async () => {
		assertBackend();
		await seedFork("s-race3");
		await runningPrompt("s-race3");
		await queueStopAction("s-race3", ACTOR);
		expect(await codeOf(queueInterruptAction("s-race3", ACTOR))).toBe("no_turn_running");
	});

	test("barrier: the prompt finishes in the gap between the interrupt's read of the holder and its write: the claim still refuses it", async () => {
		assertBackend();
		await seedFork("s-race4");
		const prompt = await runningPrompt("s-race4");
		const result = await withAdminLock((tx) =>
			enqueueInterruptInTx(tx, { sessionId: "s-race4", actor: ACTOR }),
		);
		expect(result.ok).toBe(true);
		await updateControlAction({ actionId: prompt, supervisorId: HOST, status: "succeeded" });
		expect(await claimNextControlAction(HOST)).toBeNull();
		if (result.ok) expect((await actionOf(result.action.id))?.error).toBe(TURN_ALREADY_ENDED);
	});
});

describe("a host that registers again", () => {
	test("fails its queued and its running interrupts with the restart's words, and the prompt as before", async () => {
		await seedFork("s-restart-a");
		await seedFork("s-restart-b");
		const promptA = await runningPrompt("s-restart-a");
		await runningPrompt("s-restart-b");
		const running = await queueInterruptAction("s-restart-a", ACTOR);
		expect((await claimNextControlAction(HOST))?.id).toBe(running.id);
		const queued = await queueInterruptAction("s-restart-b", ACTOR);
		const failedPrompts = await failRunningClaudePromptsOfRestartedHost(HOST);
		expect(failedPrompts).toBe(2);
		expect(await actionOf(running.id)).toMatchObject({
			status: "failed",
			error: HOST_RESTARTED_TURN_ERROR,
		});
		expect(await actionOf(queued.id)).toMatchObject({
			status: "failed",
			error: HOST_RESTARTED_TURN_ERROR,
		});
		expect((await actionOf(promptA))?.error).toBe(HOST_RESTARTED_TURN_ERROR);
		// The new process claims nothing.
		expect(await claimNextControlAction(HOST)).toBeNull();
	});

	test("another host's interrupts are left alone", async () => {
		await seedFork("s-other");
		await runningPrompt("s-other");
		const queued = await queueInterruptAction("s-other", ACTOR);
		await failRunningClaudePromptsOfRestartedHost("some-other-host");
		expect((await actionOf(queued.id))?.status).toBe("queued");
	});
});

describe("the audit line", () => {
	test("names the person and the key, and is written once for a repeated press", async () => {
		await seedFork("s-audit");
		await runningPrompt("s-audit");
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await queueInterruptAction("s-audit", { userId: "u1", label: "user" }, { keyId: "key-9" });
			await queueInterruptAction("s-audit", { userId: "u1", label: "user" }, { keyId: "key-9" });
			const lines = log.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("session_turn_interrupted"))
				.map((l) => JSON.parse(l));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({
				kind: "session_turn_interrupted",
				by: "u1",
				actor: "user",
				keyId: "key-9",
				sessionId: "s-audit",
			});
		} finally {
			log.mockRestore();
		}
	});
});

describe("an interrupted end", () => {
	test("acknowledges the turn it ended, so the session reads IDLE; a plain failed end still reads WAITING", async () => {
		await seedFork("s-ack");
		await getDb()
			.update(sessions)
			.set({ isWorking: true, currentTurnStartedAt: new Date().toISOString() })
			.where(eq(sessions.sessionId, "s-ack"));
		await applyManagedTurnBoundaries(
			getDb(),
			"s-ack",
			[
				{
					eventType: "HeadlessPromptFailed",
					rawPayload: { claudeStreamRuntime: true, status: "interrupted" },
				},
			],
			{ late: false },
		);
		const stopped = (await sessionOf("s-ack")) as never;
		expect((stopped as { isWorking: boolean }).isWorking).toBe(false);
		expect((stopped as { lastUserAcknowledgedAt: string | null }).lastUserAcknowledgedAt).toBe(
			(stopped as { lastAgentTurnCompletedAt: string | null }).lastAgentTurnCompletedAt,
		);
		expect(getOperationalStatus(stopped as never)).toBe("idle");

		await seedFork("s-ack-failed");
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, "s-ack-failed"));
		await applyManagedTurnBoundaries(
			getDb(),
			"s-ack-failed",
			[
				{
					eventType: "HeadlessPromptFailed",
					rawPayload: { claudeStreamRuntime: true, status: "turn_error" },
				},
			],
			{ late: false },
		);
		expect(getOperationalStatus((await sessionOf("s-ack-failed")) as never)).toBe("waiting");
	});

	test("before-send: the code alone (a whitelist that dropped the status) still acknowledges", async () => {
		await seedFork("s-ack-bs");
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, "s-ack-bs"));
		await applyManagedTurnBoundaries(
			getDb(),
			"s-ack-bs",
			[
				{
					eventType: "HeadlessPromptFailed",
					rawPayload: { claudeStreamRuntime: true, code: "interrupted_before_send" },
				},
			],
			{ late: false },
		);
		expect(getOperationalStatus((await sessionOf("s-ack-bs")) as never)).toBe("idle");
	});

	test("a Codex marker with status 'interrupted' is an ordinary end: the acknowledgement is the fork's only", async () => {
		await seedFork("s-ack-codex", { agent: "codex_cli" });
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, "s-ack-codex"));
		await applyManagedTurnBoundaries(
			getDb(),
			"s-ack-codex",
			[
				{
					eventType: "HeadlessPromptFailed",
					rawPayload: { codexRuntime: true, status: "interrupted" },
				},
			],
			{ late: false },
		);
		expect(getOperationalStatus((await sessionOf("s-ack-codex")) as never)).toBe("waiting");
	});
});
