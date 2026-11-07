/**
 * AGEN-117 T12, the server half of the turn guard: a Claude prompt holds the session's control lock for the
 * whole turn, so a second prompt is `control_busy` until the turn ends.
 *
 *  - the host renews the lock (`running` reports); a renewal changes the lock's expiry and nothing else;
 *  - the expiry that fails a stale action releases the lock only if nobody renewed it in the meantime;
 *  - a late report can't overwrite a finished action;
 *  - a launched headless session's first turn is the launch, and a prompt is refused while it is `running`;
 *  - a Stop pre-empts a running Claude prompt, on a host that advertises `claude_turn_control`;
 *  - a supervisor registering again frees what its previous process held.
 *
 * DB-touching: runs on both dialects. The barrier tests assert the backend they run on, so a Postgres run
 * that silently fell back to SQLite fails instead of passing vacuously.
 */
import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	CLAUDE_STOP,
	CLAUDE_TURN_CONTROL,
	CLAUDE_TURN_MAX_AGE_MS,
	CODEX_FOLLOW_UP_PROMPTS,
} from "../../shared/constants.js";
import {
	CONTROL_TIMEOUT_ERROR,
	HOST_RESTARTED_TURN_ERROR,
	STOPPED_BY_PERSON_ERROR,
} from "../../shared/managed-messages.js";
import type { Actor } from "../auth/actor.js";
import { TEST_BACKEND } from "../test-utils/backend.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };
const HOST = "sup-A";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const control = await import("./control-actions.js");
const {
	queuePromptAction,
	queueStopAction,
	claimNextControlAction,
	updateControlAction,
	expireStaleControlLock,
	enqueueStopInTx,
	failRunningClaudePromptsOfRestartedHost,
} = control;
const { processHookEvent } = await import("./event-processor.js");
const { promptDeliverability } = await import("./ai/prompt-deliverability.js");
const auditService = await import("./ai/dispatch-audit-service.js");
const { updateLaunchDispatchStatus, failRunningHeadlessLaunchesOfRestartedHost } = await import(
	"./launch-dispatch.js"
);

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

/** A barrier test that ran on the wrong backend proves nothing: fail, never skip. */
function assertBackend() {
	expect(config.dialect).toBe(TEST_BACKEND);
}

async function seed(
	sessionId: string,
	opts: {
		agent?: string;
		mode?: string;
		launchStatus?: string;
		managedState?: string;
		features?: string[];
	} = {},
) {
	const agent = opts.agent ?? "claude_code";
	const launch = await seedOwnedLaunch(sessionId, HOST, {
		status: opts.launchStatus ?? "completed",
	});
	await getDb()
		.update(launchRequests)
		.set({
			agentType: agent,
			requestedLaunchMode: opts.mode ?? (agent === "codex_cli" ? "managed_codex" : "headless"),
			cwd: "/work/launch-dir",
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
			metadata: {},
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.launchId,
			supervisorId: HOST,
			managedState: opts.managedState ?? (agent === "codex_cli" ? "managed" : "headless"),
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	await setHostFeatures(
		opts.features ?? [CLAUDE_STOP, CLAUDE_TURN_CONTROL, CODEX_FOLLOW_UP_PROMPTS],
	);
	return launch;
}

const setHostFeatures = (features: string[]) =>
	getDb()
		.update(supervisors)
		.set({ capabilities: { version: 1, features } as never })
		.where(eq(supervisors.id, HOST));

const managedOf = async (sessionId: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, sessionId)))[0];
const actionOf = async (id: string) =>
	(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0];
const launchOf = async (id: string) =>
	(await getDb().select().from(launchRequests).where(eq(launchRequests.id, id)))[0];

const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return null;
	} catch (error) {
		// ControlBusyError carries no `code`; the route maps it to control_busy.
		if (error instanceof control.ControlBusyError) return "control_busy";
		return (error as { code?: string }).code ?? "no-code";
	}
};

/** A prompt the host has claimed: `running`, claimed by the owning host, holding the lock. */
async function runningPrompt(sessionId: string, text = "do the thing") {
	const queued = await queuePromptAction(sessionId, text, ACTOR);
	const claimed = await claimNextControlAction(HOST);
	expect(claimed?.id).toBe(queued.id);
	expect(claimed?.status).toBe("running");
	return queued.id;
}

const renew = (actionId: string, extra: Record<string, unknown> = {}) =>
	updateControlAction({ actionId, supervisorId: HOST, status: "running", ...extra });
const finish = (actionId: string, status: "succeeded" | "failed" = "succeeded") =>
	updateControlAction({
		actionId,
		supervisorId: HOST,
		status,
		error: status === "failed" ? "x" : null,
	});

const expireLockNow = (sessionId: string) =>
	getDb()
		.update(managedSessions)
		.set({ controlLockExpiresAt: new Date(Date.now() - 1000).toISOString() })
		.where(eq(managedSessions.sessionId, sessionId));

describe("C1: one prompt holds the lock", () => {
	test("20 concurrent prompts to one session make one action and 19 control_busy", async () => {
		await seed("c1-claude");
		const outcomes = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) => queuePromptAction("c1-claude", `p${i}`, ACTOR)),
		);
		const ok = outcomes.filter((o) => o.status === "fulfilled");
		const busy = outcomes.filter(
			(o) => o.status === "rejected" && o.reason instanceof control.ControlBusyError,
		);
		expect([ok.length, busy.length]).toEqual([1, 19]);
		expect(await getDb().select().from(controlActions)).toHaveLength(1);
	});

	test("barrier: 20 callers that all saw the lock free, one conditional statement each, one winner (without the condition: 20)", async () => {
		assertBackend();
		await seed("c1-raw");
		const timestamp = new Date().toISOString();
		const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
		let arrived = 0;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const wins = await Promise.all(
			ids.map(async (id) => {
				arrived++;
				if (arrived === ids.length) open();
				await gate;
				return control.takeControlLock(getDb(), "c1-raw", id, timestamp);
			}),
		);
		expect(arrived).toBe(20);
		expect(wins.filter(Boolean)).toHaveLength(1);
		const holder = (await managedOf("c1-raw"))?.activeControlActionId;
		expect(holder).toBe(ids[wins.indexOf(true)]);
	});
});

describe("renewal: a running report keeps the lock, and nothing else", () => {
	test("it moves the lock's expiry later and leaves metadata, error and finishedAt alone", async () => {
		await seed("renew-1");
		const id = await runningPrompt("renew-1");
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() + 5_000).toISOString() })
			.where(eq(managedSessions.sessionId, "renew-1"));
		const before = await actionOf(id);
		const lockBefore = (await managedOf("renew-1"))?.controlLockExpiresAt as string;

		await renew(id, { metadata: { smuggled: true, prompt: "replaced" }, error: "not an error" });

		const after = await actionOf(id);
		const lockAfter = (await managedOf("renew-1"))?.controlLockExpiresAt as string;
		expect(after?.status).toBe("running");
		expect(after?.metadata).toEqual(before?.metadata as never);
		expect(after?.error).toBeNull();
		expect(after?.finishedAt).toBeNull();
		expect(new Date(lockAfter).getTime()).toBeGreaterThan(new Date(lockBefore).getTime() + 60_000);
		expect((await managedOf("renew-1"))?.activeControlActionId).toBe(id);
	});

	test("a renewal for an action that doesn't hold the lock changes the lock of nobody", async () => {
		await seed("renew-other");
		const id = await runningPrompt("renew-other");
		await finish(id);
		expect((await managedOf("renew-other"))?.activeControlActionId).toBeNull();
		await renew(id);
		const managed = await managedOf("renew-other");
		expect(managed?.activeControlActionId).toBeNull();
		expect(managed?.controlLockExpiresAt).toBeNull();
		expect((await actionOf(id))?.status).toBe("succeeded");
	});

	test("a renewal after a lapse that failed the action doesn't bring it back", async () => {
		await seed("renew-late");
		const id = await runningPrompt("renew-late");
		await expireLockNow("renew-late");
		await expireStaleControlLock(getDb(), "renew-late");
		expect((await actionOf(id))?.status).toBe("failed");
		await renew(id);
		const action = await actionOf(id);
		expect(action?.status).toBe("failed");
		expect(action?.error).toBe(CONTROL_TIMEOUT_ERROR);
		expect((await managedOf("renew-late"))?.activeControlActionId).toBeNull();
	});
});

describe("no resurrection: a finished action stays as it finished", () => {
	test.each(["running", "succeeded", "failed"] as const)(
		"a late %s report after a failure changes nothing",
		async (late) => {
			await seed(`late-${late}`);
			const id = await runningPrompt(`late-${late}`);
			await updateControlAction({
				actionId: id,
				supervisorId: HOST,
				status: "failed",
				error: "the first word",
			});
			const first = await actionOf(id);
			await updateControlAction({
				actionId: id,
				supervisorId: HOST,
				status: late,
				error: late === "failed" ? "a second word" : null,
			});
			const second = await actionOf(id);
			expect(second?.status).toBe("failed");
			expect(second?.error).toBe("the first word");
			expect(second?.finishedAt).toBe(first?.finishedAt as string);
			expect(second?.updatedAt).toBe(first?.updatedAt as string);
		},
	);

	test("a late success can't free the lock of the action that replaced it", async () => {
		await seed("late-lock");
		const first = await runningPrompt("late-lock");
		await updateControlAction({
			actionId: first,
			supervisorId: HOST,
			status: "failed",
			error: "x",
		});
		const second = await queuePromptAction("late-lock", "next", ACTOR);
		await updateControlAction({ actionId: first, supervisorId: HOST, status: "succeeded" });
		expect((await managedOf("late-lock"))?.activeControlActionId).toBe(second.id);
	});
});

describe("the expiry that fails a stale action doesn't undo a renewal", () => {
	test("barrier: the renewal lands between the expiry's read and its write; the action keeps its lock and a second prompt is control_busy", async () => {
		assertBackend();
		await seed("gap");
		const id = await runningPrompt("gap");
		await expireLockNow("gap");

		await expireStaleControlLock(getDb(), "gap", Date.now, {
			afterLapseRead: async () => {
				await renew(id);
			},
		});

		const managed = await managedOf("gap");
		expect(managed?.activeControlActionId).toBe(id);
		expect(new Date(managed?.controlLockExpiresAt as string).getTime()).toBeGreaterThan(Date.now());
		expect((await actionOf(id))?.status).toBe("running");
		expect(await codeOf(queuePromptAction("gap", "second", ACTOR))).toBe("control_busy");
	});

	test("positive control: with no renewal in the gap the same lapse fails the action and frees the lock", async () => {
		await seed("gap-control");
		const id = await runningPrompt("gap-control");
		await expireLockNow("gap-control");
		let reached = false;
		await expireStaleControlLock(getDb(), "gap-control", Date.now, {
			afterLapseRead: async () => {
				reached = true;
			},
		});
		expect(reached).toBe(true);
		expect((await actionOf(id))?.status).toBe("failed");
		expect((await actionOf(id))?.error).toBe(CONTROL_TIMEOUT_ERROR);
		expect((await managedOf("gap-control"))?.activeControlActionId).toBeNull();
	});

	test("a lock still in date is left alone", async () => {
		await seed("in-date");
		const id = await runningPrompt("in-date");
		await expireStaleControlLock(getDb(), "in-date");
		expect((await actionOf(id))?.status).toBe("running");
		expect((await managedOf("in-date"))?.activeControlActionId).toBe(id);
	});
});

describe("a renewal in flight while the turn ends", () => {
	async function settled(sessionId: string, id: string) {
		const action = await actionOf(id);
		const managed = await managedOf(sessionId);
		expect(action?.status).toBe("succeeded");
		expect(action?.finishedAt).not.toBeNull();
		expect(managed?.activeControlActionId).toBeNull();
		expect(managed?.controlLockExpiresAt).toBeNull();
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.status, "running")),
		).toHaveLength(0);
	}

	test("renewal first, then completed: no running row, no held lock", async () => {
		await seed("order-a");
		const id = await runningPrompt("order-a");
		await renew(id);
		await finish(id);
		await settled("order-a", id);
	});

	test("completed first, then the renewal: no running row, no held lock", async () => {
		await seed("order-b");
		const id = await runningPrompt("order-b");
		await finish(id);
		await renew(id);
		await settled("order-b", id);
	});

	test("barrier: completed lands between the renewal's read and its write", async () => {
		assertBackend();
		await seed("order-c");
		const id = await runningPrompt("order-c");
		await updateControlAction(
			{ actionId: id, supervisorId: HOST, status: "running" },
			{ afterActionRead: async () => void (await finish(id)) },
		);
		await settled("order-c", id);
	});

	test("(non-discriminating: the status guard on the renewal and the release guard both hold it) barrier: a renewal lands between the completion's read and its write", async () => {
		assertBackend();
		await seed("order-d");
		const id = await runningPrompt("order-d");
		await updateControlAction(
			{ actionId: id, supervisorId: HOST, status: "succeeded" },
			{ afterActionRead: async () => void (await renew(id)) },
		);
		await settled("order-d", id);
	});
});

describe("a launched session's first turn is the launch", () => {
	test("a prompt is control_busy while the headless launch is running, and the refusal costs no extra statement", async () => {
		await seed("first-open", { launchStatus: "completed" });
		const ok = await countDbCalls(async () => {
			await queuePromptAction("first-open", "a", ACTOR);
		});
		await seed("first-busy", { launchStatus: "running" });
		let code: string | null = "unset";
		const busy = await countDbCalls(async () => {
			code = await codeOf(queuePromptAction("first-busy", "a", ACTOR));
		});
		expect(code).toBe("control_busy");
		// The refusal is the lock statement matching no row: the same reads as a success, minus the insert.
		expect(busy).toBe(ok - 1);
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.sessionId, "first-busy")),
		).toHaveLength(0);
	});

	test("it applies to every Claude headless launch and no other mode or agent", async () => {
		await seed("first-terminal", { launchStatus: "running", mode: "interactive_terminal" });
		expect((await queuePromptAction("first-terminal", "a", ACTOR)).actionType).toBe("prompt");
		await seed("first-codex", { agent: "codex_cli", launchStatus: "running" });
		expect((await queuePromptAction("first-codex", "a", ACTOR)).actionType).toBe("prompt");
	});

	test("the launch leaves running when it ends, and the next prompt goes through", async () => {
		const launch = await seed("first-ends", { launchStatus: "running" });
		expect(await codeOf(queuePromptAction("first-ends", "a", ACTOR))).toBe("control_busy");
		await updateLaunchDispatchStatus({
			supervisorId: HOST,
			launchId: launch.launchId,
			status: "completed",
		});
		expect((await queuePromptAction("first-ends", "a", ACTOR)).actionType).toBe("prompt");
	});

	test("an old host keeps the launch predicate too (it is in the lock statement, not the feature)", async () => {
		await seed("first-old", { launchStatus: "running", features: [] });
		expect(await codeOf(queuePromptAction("first-old", "a", ACTOR))).toBe("control_busy");
	});

	test("Stop during the first turn is not blocked by it", async () => {
		await seed("first-stop", { launchStatus: "running" });
		const stop = await queueStopAction("first-stop", ACTOR);
		expect(stop.actionType).toBe("stop");
		expect((stop.metadata as { runtime?: string }).runtime).toBe("claude_headless");
	});

	test("supervisor restarted mid-first-turn: registration fails the launch, frees the session", async () => {
		const launch = await seed("first-restart", { launchStatus: "running" });
		await seed("first-restart-other-host", { launchStatus: "running" });
		await getDb()
			.update(launchRequests)
			.set({ claimedBySupervisorId: "sup-B", requestedSupervisorId: "sup-B" })
			.where(eq(launchRequests.launchCorrelationId, "first-restart-other-host"));

		const failed = await failRunningHeadlessLaunchesOfRestartedHost(HOST);

		expect(failed).toBe(1);
		const row = await launchOf(launch.launchId);
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(HOST_RESTARTED_TURN_ERROR);
		expect(
			(
				await getDb()
					.select()
					.from(launchRequests)
					.where(eq(launchRequests.launchCorrelationId, "first-restart-other-host"))
			)[0]?.status,
		).toBe("running");
		expect((await queuePromptAction("first-restart", "a", ACTOR)).actionType).toBe("prompt");
	});

	test("registration leaves a finished launch, an interactive one and a Codex one alone", async () => {
		const done = await seed("restart-done", { launchStatus: "completed" });
		const terminal = await seed("restart-terminal", {
			launchStatus: "running",
			mode: "interactive_terminal",
		});
		const codex = await seed("restart-codex", { agent: "codex_cli", launchStatus: "running" });
		expect(await failRunningHeadlessLaunchesOfRestartedHost(HOST)).toBe(0);
		expect((await launchOf(done.launchId))?.status).toBe("completed");
		expect((await launchOf(terminal.launchId))?.status).toBe("running");
		expect((await launchOf(codex.launchId))?.status).toBe("running");
	});
});

describe("registration frees what the previous process held", () => {
	test("a running Claude prompt of the host fails with fixed words and its lock is released", async () => {
		await seed("restart-prompt");
		const id = await runningPrompt("restart-prompt");
		const failed = await failRunningClaudePromptsOfRestartedHost(HOST);
		expect(failed).toBe(1);
		const action = await actionOf(id);
		expect(action?.status).toBe("failed");
		expect(action?.error).toBe(HOST_RESTARTED_TURN_ERROR);
		expect(action?.finishedAt).not.toBeNull();
		const managed = await managedOf("restart-prompt");
		expect(managed?.activeControlActionId).toBeNull();
		expect(managed?.controlLockExpiresAt).toBeNull();
		expect((await queuePromptAction("restart-prompt", "again", ACTOR)).actionType).toBe("prompt");
	});

	test("another host's prompt, a queued prompt, a Codex prompt and a stop are left alone", async () => {
		await seed("restart-keep-codex", { agent: "codex_cli" });
		const codexPrompt = await runningPrompt("restart-keep-codex");
		await seed("restart-keep-other");
		const other = await runningPrompt("restart-keep-other");
		await getDb()
			.update(controlActions)
			.set({ claimedBySupervisorId: "sup-B" })
			.where(eq(controlActions.id, other));
		await seed("restart-keep-stop");
		const stop = await queueStopAction("restart-keep-stop", ACTOR);
		await getDb()
			.update(controlActions)
			.set({ status: "running", claimedBySupervisorId: HOST })
			.where(eq(controlActions.id, stop.id));
		// Queued last, so the claims above (oldest first) never pick it.
		await seed("restart-keep-queued");
		const queued = await queuePromptAction("restart-keep-queued", "q", ACTOR);

		expect(await failRunningClaudePromptsOfRestartedHost(HOST)).toBe(0);

		expect((await actionOf(queued.id))?.status).toBe("queued");
		expect((await actionOf(codexPrompt))?.status).toBe("running");
		expect((await actionOf(stop.id))?.status).toBe("running");
		expect((await actionOf(other))?.status).toBe("running");
	});
});

describe("a forged Stop hook doesn't end a turn's lock", () => {
	test("a Stop hook for the session during a running prompt leaves the next prompt control_busy", async () => {
		await seed("forged-stop");
		await runningPrompt("forged-stop");
		await processHookEvent(
			{ hook_event_name: "Stop", session_id: "forged-stop", cwd: "/work/launch-dir" } as never,
			"claude_code",
		);
		expect(await codeOf(queuePromptAction("forged-stop", "next", ACTOR))).toBe("control_busy");
	});
});

describe("Stop pre-empts a running Claude prompt", () => {
	test("on a host with claude_turn_control the prompt fails 'Stopped by a person.' and the stop takes the lock", async () => {
		await seed("pre-1");
		const promptId = await runningPrompt("pre-1");

		const stop = await queueStopAction("pre-1", ACTOR);

		const prompt = await actionOf(promptId);
		expect(prompt?.status).toBe("failed");
		expect(prompt?.error).toBe(STOPPED_BY_PERSON_ERROR);
		expect(prompt?.finishedAt).not.toBeNull();
		// What a HITL delivery derives its state from: a failed action whose error isn't the timeout words.
		expect(prompt?.error).not.toBe(CONTROL_TIMEOUT_ERROR);
		const managed = await managedOf("pre-1");
		expect(managed?.activeControlActionId).toBe(stop.id);
		expect(new Date(managed?.controlLockExpiresAt as string).getTime()).toBeGreaterThan(Date.now());
		expect((await actionOf(stop.id))?.status).toBe("queued");
	});

	test("the prompt's later reports change nothing, and the stop keeps the lock", async () => {
		await seed("pre-later");
		const promptId = await runningPrompt("pre-later");
		const stop = await queueStopAction("pre-later", ACTOR);
		const before = await actionOf(promptId);

		await renew(promptId);
		await finish(promptId, "succeeded");
		await finish(promptId, "failed");

		const after = await actionOf(promptId);
		expect(after?.status).toBe("failed");
		expect(after?.error).toBe(STOPPED_BY_PERSON_ERROR);
		expect(after?.updatedAt).toBe(before?.updatedAt as string);
		expect((await managedOf("pre-later"))?.activeControlActionId).toBe(stop.id);
	});

	test("an older host (no claude_turn_control) keeps control_busy, and the prompt keeps running", async () => {
		await seed("pre-old", { features: [CLAUDE_STOP] });
		const promptId = await runningPrompt("pre-old");
		expect(await codeOf(queueStopAction("pre-old", ACTOR))).toBe("control_busy");
		expect((await actionOf(promptId))?.status).toBe("running");
		expect((await managedOf("pre-old"))?.activeControlActionId).toBe(promptId);
	});

	test("a queued prompt holds the lock and is not pre-empted", async () => {
		await seed("pre-queued");
		const queued = await queuePromptAction("pre-queued", "waiting", ACTOR);
		expect(await codeOf(queueStopAction("pre-queued", ACTOR))).toBe("control_busy");
		expect((await actionOf(queued.id))?.status).toBe("queued");
	});

	test.each([
		["a running resume", "resume"],
		["a running retry", "retry"],
		["a running stop", "stop"],
	] as const)("%s is not pre-empted", async (_name, actionType) => {
		await seed(`pre-holder-${actionType}`);
		const sessionId = `pre-holder-${actionType}`;
		const id = crypto.randomUUID();
		await getDb()
			.insert(controlActions)
			.values({
				id,
				sessionId,
				launchRequestId: (await managedOf(sessionId))?.launchRequestId,
				actionType,
				requestedBy: "user",
				status: "running",
				claimedBySupervisorId: HOST,
				metadata: { runtime: "claude_headless" },
			})
			.execute();
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: id,
				controlLockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, sessionId));
		expect(await codeOf(queueStopAction(sessionId, ACTOR))).toBe("control_busy");
		expect((await actionOf(id))?.status).toBe("running");
		expect((await managedOf(sessionId))?.activeControlActionId).toBe(id);
	});

	test("a running Codex prompt is not pre-empted by a Codex stop", async () => {
		await seed("pre-codex", { agent: "codex_cli" });
		const promptId = await runningPrompt("pre-codex");
		expect(await codeOf(queueStopAction("pre-codex", ACTOR))).toBe("control_busy");
		expect((await actionOf(promptId))?.status).toBe("running");
	});

	test("barrier: the holder changes between the stop's read and its write; the stop is control_busy and the new holder is untouched", async () => {
		assertBackend();
		await seed("pre-race");
		const firstPrompt = await runningPrompt("pre-race");
		let replacement = "";

		const result = await withAdminLock((tx) =>
			enqueueStopInTx(tx, {
				sessionId: "pre-race",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
				afterHolderRead: async (own: typeof tx) => {
					// The prompt ends and a new one is queued (and takes the lock) in the gap.
					await own
						.update(controlActions)
						.set({ status: "succeeded", finishedAt: new Date().toISOString() })
						.where(eq(controlActions.id, firstPrompt));
					await own
						.update(managedSessions)
						.set({ activeControlActionId: null, controlLockExpiresAt: null })
						.where(eq(managedSessions.sessionId, "pre-race"));
					const next = await control.enqueuePromptInTx(own, {
						sessionId: "pre-race",
						prompt: "second",
						actor: ACTOR,
						controlActionId: crypto.randomUUID(),
					});
					if (!next.ok) throw new Error("the replacement prompt should have been queued");
					replacement = next.action.id;
				},
			}),
		);

		expect(result).toEqual({ ok: false, reason: "control_busy" });
		expect(replacement).not.toBe("");
		expect((await actionOf(replacement))?.status).toBe("queued");
		expect((await managedOf("pre-race"))?.activeControlActionId).toBe(replacement);
		expect((await actionOf(firstPrompt))?.status).toBe("succeeded");
		expect((await actionOf(firstPrompt))?.error).toBeNull();
	});

	test("barrier: the holder finished in the gap but hasn't released the lock yet; the stop is control_busy and takes nothing", async () => {
		assertBackend();
		await seed("pre-finished");
		const promptId = await runningPrompt("pre-finished");
		const result = await withAdminLock((tx) =>
			enqueueStopInTx(tx, {
				sessionId: "pre-finished",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
				afterHolderRead: async (own) => {
					await own
						.update(controlActions)
						.set({ status: "succeeded", finishedAt: new Date().toISOString() })
						.where(eq(controlActions.id, promptId));
				},
			}),
		);
		expect(result).toEqual({ ok: false, reason: "control_busy" });
		expect((await actionOf(promptId))?.status).toBe("succeeded");
		expect((await actionOf(promptId))?.error).toBeNull();
		expect((await managedOf("pre-finished"))?.activeControlActionId).toBe(promptId);
	});

	test("barrier: the lock moved to another action while the read holder still reads running; the stop takes nothing from it", async () => {
		assertBackend();
		await seed("pre-moved");
		const promptId = await runningPrompt("pre-moved");
		const other = crypto.randomUUID();
		const result = await withAdminLock((tx) =>
			enqueueStopInTx(tx, {
				sessionId: "pre-moved",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
				afterHolderRead: async (own) => {
					await own.insert(controlActions).values({
						id: other,
						sessionId: "pre-moved",
						launchRequestId: (await managedOf("pre-moved"))?.launchRequestId,
						actionType: "resume",
						requestedBy: "user",
						status: "running",
						claimedBySupervisorId: HOST,
						metadata: {},
					});
					await own
						.update(managedSessions)
						.set({ activeControlActionId: other })
						.where(eq(managedSessions.sessionId, "pre-moved"));
				},
			}),
		);
		expect(result).toEqual({ ok: false, reason: "control_busy" });
		expect((await managedOf("pre-moved"))?.activeControlActionId).toBe(other);
		expect((await actionOf(promptId))?.status).toBe("running");
		expect((await actionOf(promptId))?.error).toBeNull();
	});

	test("positive control: the same barrier with no change in the gap pre-empts", async () => {
		assertBackend();
		await seed("pre-race-control");
		const promptId = await runningPrompt("pre-race-control");
		let reached = false;
		const result = await withAdminLock((tx) =>
			enqueueStopInTx(tx, {
				sessionId: "pre-race-control",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
				afterHolderRead: async () => {
					reached = true;
				},
			}),
		);
		expect(reached).toBe(true);
		expect(result.ok).toBe(true);
		expect((await actionOf(promptId))?.error).toBe(STOPPED_BY_PERSON_ERROR);
	});

	test("a Stop that is refused for another reason pre-empts nothing", async () => {
		await seed("pre-refused");
		const promptId = await runningPrompt("pre-refused");
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(0).toISOString() });
		expect(await codeOf(queueStopAction("pre-refused", ACTOR))).toBe("host_offline");
		expect((await actionOf(promptId))?.status).toBe("running");
		expect((await managedOf("pre-refused"))?.activeControlActionId).toBe(promptId);
	});
});

describe("claude_turn_control", () => {
	test("is the literal the host advertises and the server reads", () => {
		expect(CLAUDE_TURN_CONTROL).toBe("claude_turn_control");
	});
});

describe("P2-I1: the lapse's failure is the one thing a late report may replace", () => {
	test.each([
		["succeeded", null],
		["failed", "the turn broke"],
	] as const)("a late %s after the 90 s lapse replaces the timeout", async (status, error) => {
		await seed(`late-timeout-${status}`);
		const id = await runningPrompt(`late-timeout-${status}`);
		await expireLockNow(`late-timeout-${status}`);
		await expireStaleControlLock(getDb(), `late-timeout-${status}`);
		expect((await actionOf(id))?.error).toBe(CONTROL_TIMEOUT_ERROR);

		await updateControlAction({ actionId: id, supervisorId: HOST, status, error });

		const action = await actionOf(id);
		expect(action?.status).toBe(status);
		expect(action?.error).toBe(error);
	});

	test("the replacement frees nothing a newer action holds", async () => {
		await seed("late-timeout-lock");
		const id = await runningPrompt("late-timeout-lock");
		await expireLockNow("late-timeout-lock");
		await expireStaleControlLock(getDb(), "late-timeout-lock");
		const next = await queuePromptAction("late-timeout-lock", "next", ACTOR);
		await finish(id);
		expect((await managedOf("late-timeout-lock"))?.activeControlActionId).toBe(next.id);
	});

	test.each([
		["a pre-empting Stop", STOPPED_BY_PERSON_ERROR],
		["a host restart", HOST_RESTARTED_TURN_ERROR],
		["any other final word", "Claude exited"],
	])("after %s a late report changes nothing", async (_name, error) => {
		await seed("late-final");
		const id = await runningPrompt("late-final");
		await updateControlAction({ actionId: id, supervisorId: HOST, status: "failed", error });
		const before = await actionOf(id);
		await finish(id, "succeeded");
		const after = await actionOf(id);
		expect([after?.status, after?.error, after?.updatedAt]).toEqual([
			"failed",
			error,
			before?.updatedAt,
		]);
	});
});

describe("P2-I2/X1: the first-turn guard", () => {
	// The contract: a headless launch blocks a prompt only while it is `running` and was last heard from
	// within the ceiling. Before it runs (claimed, launching) there is no turn yet; after, it has ended.
	test.each([
		["claimed", false],
		["launching", false],
		["awaiting_session", false],
		["running", true],
		["completed", false],
		["failed", false],
		["cancelled", false],
	] as const)("a headless launch %s blocks a prompt: %s", async (status, blocks) => {
		await seed(`guard-${status}`, { launchStatus: status });
		expect(await codeOf(queuePromptAction(`guard-${status}`, "a", ACTOR))).toBe(
			blocks ? "control_busy" : null,
		);
		expect(await hasFirstTurn(`guard-${status}`)).toBe(blocks);
	});

	const hasFirstTurn = (id: string) => control.hasRunningFirstTurn(getDb(), id);
	const ageLaunch = (id: string, ms: number) =>
		getDb()
			.update(launchRequests)
			.set({ updatedAt: new Date(Date.now() - ms).toISOString() })
			.where(eq(launchRequests.launchCorrelationId, id));

	test("the ceiling: running and 5 h quiet still blocks, running and 7 h quiet no longer does", async () => {
		expect(CLAUDE_TURN_MAX_AGE_MS).toBe(6 * 60 * 60 * 1000);
		await seed("guard-age-5h", { launchStatus: "running" });
		await ageLaunch("guard-age-5h", 5 * 3_600_000);
		expect(await codeOf(queuePromptAction("guard-age-5h", "a", ACTOR))).toBe("control_busy");
		await seed("guard-age-7h", { launchStatus: "running" });
		await ageLaunch("guard-age-7h", 7 * 3_600_000);
		expect(await codeOf(queuePromptAction("guard-age-7h", "a", ACTOR))).toBeNull();
	});

	test("the advisory twin agrees: Approve isn't offered during a first turn, and is after it", async () => {
		await seed("guard-deliver", { launchStatus: "running" });
		expect(await promptDeliverability("guard-deliver")).toEqual({
			deliverable: false,
			reason: "control_busy",
		});
		await getDb()
			.update(launchRequests)
			.set({ status: "completed" })
			.where(eq(launchRequests.launchCorrelationId, "guard-deliver"));
		expect(await promptDeliverability("guard-deliver")).toEqual({ deliverable: true });
	});

	test.each(["completed", "failed", "cancelled"] as const)(
		"CAS: a finished (%s) launch is never moved by a late or replayed report",
		async (finished) => {
			const launch = await seed(`cas-${finished}`, { launchStatus: finished });
			for (const status of ["running", "completed", "failed", "cancelled", "launching"] as const) {
				await updateLaunchDispatchStatus({
					supervisorId: HOST,
					launchId: launch.launchId,
					status,
					error: "late",
				});
			}
			const row = await launchOf(launch.launchId);
			expect(row?.status).toBe(finished);
			expect(row?.error).toBeNull();
		},
	);

	test("CAS in the write: a launch that finishes between the read and the write isn't reopened", async () => {
		const launch = await seed("cas-race", { launchStatus: "running" });
		// Read as running; finished before the write lands.
		const reading = updateLaunchDispatchStatus({
			supervisorId: HOST,
			launchId: launch.launchId,
			status: "running",
		});
		await getDb()
			.update(launchRequests)
			.set({ status: "completed" })
			.where(eq(launchRequests.id, launch.launchId));
		await reading;
		expect((await launchOf(launch.launchId))?.status).toBe("completed");
	});
});

describe("P2-X2: only a Claude prompt on a host with the feature renews", () => {
	const lockOf = async (id: string) => (await managedOf(id))?.controlLockExpiresAt as string;

	test("a running report for a stop, a resume or a Codex prompt leaves the lock where it was", async () => {
		for (const [name, actionType, agent] of [
			["x2-stop", "stop", "claude_code"],
			["x2-resume", "resume", "claude_code"],
			["x2-codex", "prompt", "codex_cli"],
		] as const) {
			await seed(name, { agent });
			const id = crypto.randomUUID();
			await getDb()
				.insert(controlActions)
				.values({
					id,
					sessionId: name,
					launchRequestId: (await managedOf(name))?.launchRequestId,
					actionType,
					requestedBy: "user",
					status: "running",
					claimedBySupervisorId: HOST,
					metadata: { agentType: agent },
				});
			const expiry = new Date(Date.now() + 20_000).toISOString();
			await getDb()
				.update(managedSessions)
				.set({ activeControlActionId: id, controlLockExpiresAt: expiry })
				.where(eq(managedSessions.sessionId, name));
			await renew(id);
			expect({ name, lock: await lockOf(name) }).toEqual({ name, lock: expiry });
		}
	});

	test("a host that doesn't advertise claude_turn_control can't renew", async () => {
		await seed("x2-old", { features: [CLAUDE_STOP] });
		const id = await runningPrompt("x2-old");
		const expiry = new Date(Date.now() + 20_000).toISOString();
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: expiry })
			.where(eq(managedSessions.sessionId, "x2-old"));
		await renew(id);
		expect(await lockOf("x2-old")).toBe(expiry);
	});

	test("positive control: the same prompt on a host with the feature does renew", async () => {
		await seed("x2-new");
		const id = await runningPrompt("x2-new");
		const expiry = new Date(Date.now() + 20_000).toISOString();
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: expiry })
			.where(eq(managedSessions.sessionId, "x2-new"));
		await renew(id);
		expect(new Date(await lockOf("x2-new")).getTime()).toBeGreaterThan(Date.now() + 60_000);
	});

	test("the hard ceiling: 6 h after the action was queued, a renewal can't carry the lock further", async () => {
		await seed("x2-cap");
		const id = await runningPrompt("x2-cap");
		const queuedAt = Date.now() - CLAUDE_TURN_MAX_AGE_MS + 10_000;
		await getDb()
			.update(controlActions)
			.set({ createdAt: new Date(queuedAt).toISOString() })
			.where(eq(controlActions.id, id));
		await renew(id);
		const lock = new Date(await lockOf("x2-cap")).getTime();
		expect(lock).toBeLessThanOrEqual(queuedAt + CLAUDE_TURN_MAX_AGE_MS);
		expect(lock).toBeLessThan(Date.now() + 60_000);
		// Past the ceiling the renewal leaves the lock lapsed, and the next prompt's expiry clears it.
		await getDb()
			.update(controlActions)
			.set({ createdAt: new Date(Date.now() - CLAUDE_TURN_MAX_AGE_MS - 60_000).toISOString() })
			.where(eq(controlActions.id, id));
		await renew(id);
		expect(new Date(await lockOf("x2-cap")).getTime()).toBeLessThan(Date.now());
		expect((await queuePromptAction("x2-cap", "again", ACTOR)).actionType).toBe("prompt");
	});
});

describe("P2-I6: the lapse's release and failure commit together", () => {
	test("a failure after the release rolls the release back", async () => {
		await seed("atomic-expire");
		const id = await runningPrompt("atomic-expire");
		await getDb()
			.update(controlActions)
			.set({ requestedBy: "ai", status: "queued" })
			.where(eq(controlActions.id, id));
		await expireLockNow("atomic-expire");
		const spy = spyOn(auditService, "markAuditExpiredUnclaimed").mockImplementation(async () => {
			throw new Error("injected after the release");
		});
		try {
			await expect(expireStaleControlLock(getDb(), "atomic-expire")).rejects.toThrow("injected");
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect((await managedOf("atomic-expire"))?.activeControlActionId).toBe(id);
		expect((await actionOf(id))?.status).toBe("queued");
	});
});
