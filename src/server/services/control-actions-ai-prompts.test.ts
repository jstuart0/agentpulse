/**
 * The control-action queue as the watcher uses it: the conditional control
 * lock, the refusal messages the human routes still see, and the claim-time
 * limit on an AI prompt no supervisor took.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import {
	enableAiRuntime,
	seedAutoConfig,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProvider,
	setSetting,
} from "../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const schema = await import("../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	settings,
	supervisors,
	watcherConfigs,
	watcherProposals,
} = schema;
const feature = await import("./ai/feature.js");
const { AI_ACTOR, dispatchPrompt } = await import("./ai/proposal-resolution.js");
const queue = await import("./control-actions.js");

const originalDisableAuth = config.disableAuth;
let providerId = "";

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await getDb().delete(settings);
	feature.invalidateAiFlagsCache();
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

const HUMAN = { userId: "u-1", label: "user" } as const;
let n = 0;
const newSessionId = () => `ca-${++n}-${crypto.randomUUID().slice(0, 6)}`;

/** An auto send judged and queued the way the runner does it. */
async function queueAutoPrompt(sessionId: string) {
	(config as Record<string, unknown>).disableAuth = true;
	await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
	const turn = await seedFinishedTurn(sessionId);
	await seedAutoConfig({ sessionId, providerId });
	const result = await dispatchPrompt(
		sessionId,
		{ kind: "auto", continueKind: "run_tests" },
		AI_ACTOR,
		{ actorKind: "auto", proposalId: "p", triggerEventId: turn.stopId, turnKey: turn.turnKey },
	);
	if (!result.ok) throw new Error(`fixture dispatch refused: ${result.code}`);
	return result.controlActionId;
}

async function actionRow(id: string) {
	const [row] = await getDb().select().from(controlActions).where(eq(controlActions.id, id));
	return row;
}
async function managedRow(sessionId: string) {
	const [row] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	return row;
}
async function auditFor(controlActionId: string) {
	const [row] = await getDb()
		.select()
		.from(aiDispatchAudit)
		.where(eq(aiDispatchAudit.controlActionId, controlActionId));
	return row;
}

describe("the human queue functions keep their contract", () => {
	test("queuePromptAction takes the lock and returns the action; a second call is the same busy error as before", async () => {
		const sessionId = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(sessionId);
		const action = await queue.queuePromptAction(sessionId, "  Run the tests  ", HUMAN);
		expect(action).toMatchObject({
			sessionId,
			actionType: "prompt",
			status: "queued",
			requestedBy: "user",
		});
		expect((action.metadata as { prompt: string }).prompt).toBe("Run the tests");
		expect((await managedRow(sessionId))?.activeControlActionId).toBe(action.id);
		await expect(queue.queuePromptAction(sessionId, "again", HUMAN)).rejects.toThrow(
			"Another control action is already in progress for this session.",
		);
		await expect(queue.queuePromptAction(sessionId, "again", HUMAN)).rejects.toBeInstanceOf(
			queue.ControlBusyError,
		);
		expect(supervisorId).toContain("sup-");
	});

	test("every other refusal keeps its message", async () => {
		await expect(queue.queuePromptAction("nope", "x", HUMAN)).rejects.toThrow(
			"Session is not managed.",
		);
		await expect(queue.queuePromptAction("nope", "  ", HUMAN)).rejects.toThrow(
			"Prompt is required.",
		);
		await expect(queue.queueStopAction("nope", HUMAN)).rejects.toThrow("Session is not managed.");

		const noSession = newSessionId();
		await seedLiveManagedSession(noSession);
		await getDb().delete(sessions).where(eq(sessions.sessionId, noSession));
		// Without its session row the managed row goes with it (cascade); recreate only the managed row.
		await expect(queue.queuePromptAction(noSession, "x", HUMAN)).rejects.toThrow();
	});

	test("two concurrent human prompts queue exactly one; the lock is held by that one", async () => {
		const sessionId = newSessionId();
		await seedLiveManagedSession(sessionId);
		const outcomes = await Promise.allSettled([
			queue.queuePromptAction(sessionId, "first", HUMAN),
			queue.queuePromptAction(sessionId, "second", HUMAN),
		]);
		expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.find((o) => o.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(queue.ControlBusyError);
		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows).toHaveLength(1);
		expect((await managedRow(sessionId))?.activeControlActionId).toBe(rows[0]?.id);
	});

	test("a stop and a prompt compete for the same lock: one wins", async () => {
		const sessionId = newSessionId();
		await seedLiveManagedSession(sessionId);
		const outcomes = await Promise.allSettled([
			queue.queueStopAction(sessionId, HUMAN),
			queue.queuePromptAction(sessionId, "go", HUMAN),
		]);
		expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows).toHaveLength(1);
	});

	test("takeControlLock takes a free lock and never overwrites a held one (the conditional update is the race decider)", async () => {
		const sessionId = newSessionId();
		await seedLiveManagedSession(sessionId);
		const { withAdminLock } = await import("../db/admin-lock.js");
		const holder = (tx: unknown, id: string) =>
			queue.takeControlLock(tx, sessionId, id, new Date().toISOString());
		const outcomes = await withAdminLock(async (tx) => [
			await holder(tx, "first-holder"),
			await holder(tx, "second-holder"),
		]);
		expect(outcomes).toEqual([true, false]);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managed?.activeControlActionId).toBe("first-holder");
	});

	test("enqueuePromptInTx returns every refusal instead of throwing, and writes nothing for one", async () => {
		const sessionId = newSessionId();
		const { withAdminLock } = await import("../db/admin-lock.js");
		const refused = await withAdminLock((tx) =>
			queue.enqueuePromptInTx(tx, {
				sessionId,
				prompt: "x",
				actor: HUMAN,
				controlActionId: crypto.randomUUID(),
			}),
		);
		expect(refused).toEqual({ ok: false, reason: "not_managed" });

		await seedLiveManagedSession(sessionId);
		const held = await queue.queuePromptAction(sessionId, "first", HUMAN);
		const busy = await withAdminLock((tx) =>
			queue.enqueuePromptInTx(tx, {
				sessionId,
				prompt: "second",
				actor: HUMAN,
				controlActionId: crypto.randomUUID(),
			}),
		);
		expect(busy).toEqual({ ok: false, reason: "control_busy" });
		const rows = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(rows.map((r) => r.id)).toEqual([held.id]);
	});

	test("a launch that belongs to another host is refused launch_mismatch", async () => {
		const sessionId = newSessionId();
		await seedLiveManagedSession(sessionId);
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: null, requestedSupervisorId: "someone-else" })
			.where(eq(launchRequests.launchCorrelationId, sessionId));
		await expect(queue.queuePromptAction(sessionId, "x", HUMAN)).rejects.toThrow(
			"Launch request does not match session.",
		);
	});
});

describe("claim-time limit on an AI prompt", () => {
	async function ageAction(id: string, ageMs: number) {
		await getDb()
			.update(controlActions)
			.set({ createdAt: new Date(Date.now() - ageMs).toISOString() })
			.where(eq(controlActions.id, id));
	}

	test("an AI prompt older than the limit is failed, its lock released and its audit row closed; it is never handed to the supervisor", async () => {
		const sessionId = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(sessionId);
		const id = await queueAutoPrompt(sessionId);
		await ageAction(id, queue.AI_PROMPT_CLAIM_TTL_MS + 61_000); // 121 s

		const claimed = await queue.claimNextControlAction(supervisorId);
		expect(claimed).toBeNull();
		const row = await actionRow(id);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe("Expired before a supervisor claimed it.");
		expect((await managedRow(sessionId))?.activeControlActionId).toBeNull();
		expect(await auditFor(id)).toMatchObject({
			outcome: "failed",
			refusalCode: "expired_unclaimed",
		});
	});

	test("a human prompt of the same age is still handed over", async () => {
		const sessionId = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(sessionId);
		const action = await queue.queuePromptAction(sessionId, "Run the tests", HUMAN);
		await ageAction(action.id, 121_000);
		const claimed = await queue.claimNextControlAction(supervisorId);
		expect(claimed?.id).toBe(action.id);
	});

	test("an AI prompt inside the limit is handed over, and the next candidate is considered after an expired one", async () => {
		const first = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(first);
		const expiredId = await queueAutoPrompt(first);
		await ageAction(expiredId, 120_000);
		const second = newSessionId();
		await getDb().delete(supervisors); // one supervisor owns both below
		await seedLiveManagedSession(second);
		await getDb()
			.update(managedSessions)
			.set({ supervisorId })
			.where(eq(managedSessions.sessionId, second));
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: supervisorId, requestedSupervisorId: supervisorId })
			.where(eq(launchRequests.launchCorrelationId, second));
		const fresh = await queue.queuePromptAction(second, "Run the tests", HUMAN);
		const claimed = await queue.claimNextControlAction(supervisorId);
		expect(claimed?.id).toBe(fresh.id);
		expect((await actionRow(expiredId))?.status).toBe("failed");
	});

	test("the real lock-expiry path closes the audit row of an unclaimed AI prompt, and leaves a claimed one alone", async () => {
		const unclaimed = newSessionId();
		await seedLiveManagedSession(unclaimed);
		const unclaimedId = await queueAutoPrompt(unclaimed);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(managedSessions.sessionId, unclaimed));
		await queue.expireStaleControlLock(getDb(), unclaimed);
		expect((await actionRow(unclaimedId))?.status).toBe("failed");
		expect(await auditFor(unclaimedId)).toMatchObject({
			outcome: "failed",
			refusalCode: "expired_unclaimed",
		});

		const claimed = newSessionId();
		const { supervisorId } = await seedLiveManagedSession(claimed);
		const claimedId = await queueAutoPrompt(claimed);
		expect((await queue.claimNextControlAction(supervisorId))?.id).toBe(claimedId);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(managedSessions.sessionId, claimed));
		await queue.expireStaleControlLock(getDb(), claimed);
		// It reached the supervisor, so its audit row still says it was sent.
		expect(await auditFor(claimedId)).toMatchObject({ outcome: "sent" });
	});

	test("the limit sits below the control-lock expiry", () => {
		expect(queue.AI_PROMPT_CLAIM_TTL_MS).toBeLessThan(90_000);
	});
});
