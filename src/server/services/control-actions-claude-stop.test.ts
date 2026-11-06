/**
 * AGEN-110, the server half of Stop on a launched Claude session.
 *
 *  - The stop action says what the host should stop (`metadata.runtime`), computed from the launch and
 *    never from the session row, which any ingest key can create with an agent type of its choosing.
 *  - A Claude session that is told it stopped stops being "working", whichever way the host says so:
 *    the stopped event, a terminal report, or an idle report.
 *  - A cancelled report can't turn a finished launch into a cancelled one.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CLAUDE_STOP } from "../../shared/constants.js";
import { CLAUDE_STOP_UPGRADE_MESSAGE } from "../../shared/managed-messages.js";
import { STOP_NOT_SUPPORTED_MESSAGE } from "../../shared/stop-runtime.js";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { queueStopAction, queuePromptAction, stopRuntimeOf, claimNextControlAction } = await import(
	"./control-actions.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { processHookEvent } = await import("./event-processor.js");
const { applyManagedTurnBoundaries, upsertManagedSessionState } = await import(
	"./managed-session-state.js"
);
const { updateLaunchDispatchStatus } = await import("./launch-dispatch.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

async function seed(
	sessionId: string,
	opts: {
		agent: string;
		mode: string;
		launchMetadata?: Record<string, unknown>;
		managedState?: string;
		isWorking?: boolean;
		launchStatus?: string;
	},
) {
	const launch = await seedOwnedLaunch(sessionId, "sup-A", { status: opts.launchStatus });
	await getDb()
		.update(launchRequests)
		.set({
			agentType: opts.agent,
			requestedLaunchMode: opts.mode,
			cwd: "/work/launch-dir",
			metadata: opts.launchMetadata ?? {},
		})
		.where(eq(launchRequests.id, launch.launchId));
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: opts.agent,
			status: "active",
			isWorking: opts.isWorking ?? false,
			currentTurnStartedAt: opts.isWorking ? now : null,
			lastActivityAt: now,
			metadata: {},
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.launchId,
			supervisorId: "sup-A",
			managedState: opts.managedState ?? "headless",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return launch;
}

const runtimeOfStop = async (sessionId: string) => {
	const action = await queueStopAction(sessionId, ACTOR);
	expect(action.actionType).toBe("stop");
	return (action.metadata as Record<string, unknown> | null)?.runtime;
};

describe("the stop action names the runtime the host must stop", () => {
	test.each([
		["a Codex launch", { agent: "codex_cli", mode: "managed_codex" }, "codex"],
		["a headless Claude launch", { agent: "claude_code", mode: "headless" }, "claude_headless"],
		[
			"a Claude carrier that took over an observed session",
			{ agent: "claude_code", mode: "headless", launchMetadata: { boundObservedSession: true } },
			"claude_stream",
		],
		[
			"a Codex carrier that took over an observed thread",
			{ agent: "codex_cli", mode: "managed_codex", launchMetadata: { boundObservedSession: true } },
			"codex",
		],
	] as const)("%s", async (_name, opts, runtime) => {
		await seed("sess-runtime", { ...opts, managedState: "managed" });
		expect(await runtimeOfStop("sess-runtime")).toBe(runtime);
	});

	test("it follows the launch, not a session row that claims another agent", async () => {
		await seed("sess-forged", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await getDb()
			.update(sessions)
			.set({ agentType: "claude_code" })
			.where(eq(sessions.sessionId, "sess-forged"));
		expect(await runtimeOfStop("sess-forged")).toBe("codex");
	});

	test("a stop still queues, with no runtime, when the launch can't be found", async () => {
		const launch = await seed("sess-no-launch", { agent: "claude_code", mode: "headless" });
		await getDb().delete(launchRequests).where(eq(launchRequests.id, launch.launchId));
		const action = await queueStopAction("sess-no-launch", ACTOR);
		expect(action.metadata).toEqual({});
	});

	test("a second stop while one is open is still control_busy", async () => {
		await seed("sess-busy", { agent: "claude_code", mode: "headless" });
		await queueStopAction("sess-busy", ACTOR);
		await expect(queueStopAction("sess-busy", ACTOR)).rejects.toThrow();
	});
});

const workingRow = async (sessionId: string) => {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row as typeof sessions.$inferSelect;
};

describe("a Claude session that was told it stopped is no longer working", () => {
	test("the stopped event clears isWorking and the turn start", async () => {
		await seed("claude-stopped", { agent: "claude_code", mode: "headless", isWorking: true });
		await applyManagedTurnBoundaries(
			getDb(),
			"claude-stopped",
			[{ eventType: "ManagedSessionStopped" }],
			{ late: false },
		);
		const row = await workingRow("claude-stopped");
		expect(row.isWorking).toBe(false);
		expect(row.currentTurnStartedAt).toBeNull();
	});

	test("a terminal state report clears it", async () => {
		await seed("claude-terminal-report", {
			agent: "claude_code",
			mode: "headless",
			isWorking: true,
		});
		await upsertManagedSessionState("sup-A", {
			sessionId: "claude-terminal-report",
			agentType: "claude_code",
			status: "completed",
			managedState: "stopped",
		});
		expect((await workingRow("claude-terminal-report")).isWorking).toBe(false);
	});

	test("an idle report clears it and stamps the end of the turn once", async () => {
		await seed("claude-idle", { agent: "claude_code", mode: "headless", isWorking: true });
		await upsertManagedSessionState("sup-A", {
			sessionId: "claude-idle",
			agentType: "claude_code",
			status: "idle",
			managedState: "managed",
		});
		const row = await workingRow("claude-idle");
		expect(row.isWorking).toBe(false);
		expect(row.lastAgentTurnCompletedAt).not.toBeNull();
	});

	test("a Claude turn-end event still does nothing: only the stopped event is widened", async () => {
		await seed("claude-turn-end", { agent: "claude_code", mode: "headless", isWorking: true });
		await applyManagedTurnBoundaries(
			getDb(),
			"claude-turn-end",
			[{ eventType: "HeadlessPromptCompleted", rawPayload: { codexRuntime: true } }],
			{ late: false },
		);
		expect((await workingRow("claude-turn-end")).isWorking).toBe(true);
	});

	test("another agent's row is left alone by the stopped event", async () => {
		await seed("copilot-stopped", { agent: "claude_code", mode: "headless", isWorking: true });
		await getDb()
			.update(launchRequests)
			.set({ agentType: "copilot_cli" })
			.where(eq(launchRequests.launchCorrelationId, "copilot-stopped"));
		await getDb()
			.update(sessions)
			.set({ agentType: "copilot_cli" })
			.where(eq(sessions.sessionId, "copilot-stopped"));
		await applyManagedTurnBoundaries(
			getDb(),
			"copilot-stopped",
			[{ eventType: "ManagedSessionStopped" }],
			{ late: false },
		);
		expect((await workingRow("copilot-stopped")).isWorking).toBe(true);
	});
});

describe("a cancelled launch report", () => {
	const report = (launchId: string, status: "cancelled" | "completed") =>
		updateLaunchDispatchStatus({ supervisorId: "sup-A", launchId, status });
	const statusOf = async (launchId: string) =>
		(await getDb().select().from(launchRequests).where(eq(launchRequests.id, launchId)))[0]?.status;

	test("moves a running launch to cancelled", async () => {
		const launch = await seed("cancel-running", {
			agent: "claude_code",
			mode: "headless",
			launchStatus: "running",
		});
		const result = await report(launch.launchId, "cancelled");
		expect(result?.status).toBe("cancelled");
		expect(await statusOf(launch.launchId)).toBe("cancelled");
	});

	test.each(["completed", "failed"])(
		"leaves a %s launch as it was (Stop on an idle session must not rewrite history)",
		async (finished) => {
			const launch = await seed(`cancel-${finished}`, {
				agent: "claude_code",
				mode: "headless",
				launchStatus: finished,
			});
			const result = await report(launch.launchId, "cancelled");
			expect(result).not.toBeNull();
			expect(await statusOf(launch.launchId)).toBe(finished);
		},
	);

	test("a completed report still completes a running launch (the guard is for cancelled only)", async () => {
		const launch = await seed("complete-running", {
			agent: "claude_code",
			mode: "headless",
			launchStatus: "running",
		});
		await report(launch.launchId, "completed");
		expect(await statusOf(launch.launchId)).toBe("completed");
	});
});

const setHostFeatures = (features: string[]) =>
	getDb()
		.update(supervisors)
		.set({ capabilities: { version: 1, features } as never })
		.where(eq(supervisors.id, "sup-A"));

const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return null;
	} catch (error) {
		return (error as { code?: string }).code ?? "no-code";
	}
};
const actionRows = () => getDb().select().from(controlActions);

describe("a Claude stop needs a host that advertises claude_stop (old supervisors)", () => {
	test("a host without it refuses with host_upgrade_required, in words about Claude, and queues nothing", async () => {
		await seed("old-host-claude", { agent: "claude_code", mode: "headless" });
		await setHostFeatures(["codex_follow_up_prompts"]);
		let message = "";
		try {
			await queueStopAction("old-host-claude", ACTOR);
		} catch (error) {
			message = (error as Error).message;
			expect((error as { code?: string }).code).toBe("host_upgrade_required");
		}
		expect(message).toBe(CLAUDE_STOP_UPGRADE_MESSAGE);
		expect(await actionRows()).toHaveLength(0);
		const [managed] = await getDb().select().from(managedSessions);
		expect(managed?.activeControlActionId).toBeNull();
	});

	test("positive control: the same session on a host that advertises it queues the stop", async () => {
		await seed("new-host-claude", { agent: "claude_code", mode: "headless" });
		await setHostFeatures([CLAUDE_STOP]);
		expect((await queueStopAction("new-host-claude", ACTOR)).actionType).toBe("stop");
	});

	test.each(["claude_headless", "claude_stream"] as const)("%s needs it too", async (runtime) => {
		const opts =
			runtime === "claude_stream"
				? {
						agent: "claude_code",
						mode: "headless",
						launchMetadata: { boundObservedSession: true },
					}
				: { agent: "claude_code", mode: "headless" };
		await seed(`old-${runtime}`, opts);
		await setHostFeatures([]);
		expect(await codeOf(queueStopAction(`old-${runtime}`, ACTOR))).toBe("host_upgrade_required");
	});

	test("a Codex stop is not asked about claude_stop: a host with no features still stops it", async () => {
		await seed("old-host-codex", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await setHostFeatures([]);
		expect((await queueStopAction("old-host-codex", ACTOR)).actionType).toBe("stop");
	});

	test("a Codex stop costs fewer statements than a Claude stop: it reads no capabilities", async () => {
		await seed("count-codex", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await seed("count-claude", { agent: "claude_code", mode: "headless" });
		await setHostFeatures([CLAUDE_STOP]);
		const codex = await countDbCalls(
			async () => void (await queueStopAction("count-codex", ACTOR)),
		);
		const claude = await countDbCalls(
			async () => void (await queueStopAction("count-claude", ACTOR)),
		);
		// The Claude stop adds the owner lookup and the capabilities read; nothing else differs.
		expect(claude - codex).toBeGreaterThanOrEqual(2);
	});
});

describe("a stop with nothing to stop", () => {
	test("a Claude session whose managed state and launch have both ended is refused: nothing_to_stop", async () => {
		await seed("done-both", {
			agent: "claude_code",
			mode: "headless",
			managedState: "stopped",
			launchStatus: "completed",
		});
		expect(await codeOf(queueStopAction("done-both", ACTOR))).toBe("nothing_to_stop");
		expect(await actionRows()).toHaveLength(0);
	});

	test.each(["stopped", "completed", "failed"])(
		"managed state %s with a cancelled launch is refused too",
		async (managedState) => {
			await seed(`done-${managedState}`, {
				agent: "claude_code",
				mode: "headless",
				managedState,
				launchStatus: "cancelled",
			});
			expect(await codeOf(queueStopAction(`done-${managedState}`, ACTOR))).toBe("nothing_to_stop");
		},
	);

	test("a lost final report still gets its Stop: an ended managed state with a launch still running queues", async () => {
		await seed("lost-launch-report", {
			agent: "claude_code",
			mode: "headless",
			managedState: "stopped",
			launchStatus: "running",
		});
		expect((await queueStopAction("lost-launch-report", ACTOR)).actionType).toBe("stop");
	});

	test("a lost state report too: a live managed state with a finished launch queues", async () => {
		await seed("lost-state-report", {
			agent: "claude_code",
			mode: "headless",
			managedState: "headless",
			launchStatus: "completed",
		});
		expect((await queueStopAction("lost-state-report", ACTOR)).actionType).toBe("stop");
	});

	test("Codex is as it was: an ended Codex session still queues the stop", async () => {
		await seed("done-codex", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "stopped",
			launchStatus: "completed",
		});
		expect((await queueStopAction("done-codex", ACTOR)).actionType).toBe("stop");
	});
});

describe("after a Claude Stop the next prompt still goes through", () => {
	test("the stop action finishes, the session reads stopped, and queuePromptAction queues a prompt for it", async () => {
		await seed("stop-then-prompt", { agent: "claude_code", mode: "headless" });
		const stop = await queueStopAction("stop-then-prompt", ACTOR);
		await getDb()
			.update(controlActions)
			.set({ claimedBySupervisorId: "sup-A" })
			.where(eq(controlActions.id, stop.id));
		const { updateControlAction } = await import("./control-actions.js");
		await updateControlAction({ actionId: stop.id, supervisorId: "sup-A", status: "succeeded" });
		await upsertManagedSessionState("sup-A", {
			sessionId: "stop-then-prompt",
			agentType: "claude_code",
			status: "completed",
			managedState: "stopped",
		});
		const prompt = await queuePromptAction("stop-then-prompt", "carry on", ACTOR);
		expect(prompt.actionType).toBe("prompt");
		expect(prompt.status).toBe("queued");
		expect((prompt.metadata as Record<string, unknown>).launchMode).toBe("headless");
	});
});

const rowMetadata = async (sessionId: string) =>
	((await workingRow(sessionId)).metadata ?? {}) as Record<string, unknown>;
const hook = (sessionId: string, name: string) =>
	processHookEvent(
		{ session_id: sessionId, hook_event_name: name, tool_name: "Bash" } as never,
		"claude_code",
	);
const stoppedReport = (sessionId: string) =>
	upsertManagedSessionState("sup-A", {
		sessionId,
		agentType: "claude_code",
		status: "completed",
		managedState: "stopped",
	});
const runningReport = (sessionId: string) =>
	upsertManagedSessionState("sup-A", {
		sessionId,
		agentType: "claude_code",
		status: "active",
		managedState: "headless",
	});

describe("a late hook does not reopen a stopped Claude row (the D21 latch)", () => {
	test("the stopped report latches the row; a late tool hook and a late Stop hook leave it completed, ended and not working", async () => {
		await seed("latched", { agent: "claude_code", mode: "headless", isWorking: true });
		await stoppedReport("latched");
		expect((await rowMetadata("latched")).endedByEvent).toBeDefined();
		const ended = (await workingRow("latched")).endedAt;
		await hook("latched", "PreToolUse");
		await hook("latched", "PostToolUse");
		await hook("latched", "Stop");
		const row = await workingRow("latched");
		expect(row.status).toBe("completed");
		expect(row.isWorking).toBe(false);
		expect(row.endedAt).toBe(ended);
	});

	test("positive control: without the stopped report the same hook does reopen the row", async () => {
		await seed("unlatched", { agent: "claude_code", mode: "headless" });
		await getDb()
			.update(sessions)
			.set({ status: "completed", endedAt: new Date().toISOString() })
			.where(eq(sessions.sessionId, "unlatched"));
		await hook("unlatched", "PostToolUse");
		expect((await workingRow("unlatched")).status).toBe("active");
	});

	test("the next managed prompt reopens it: the running report lifts the latch, and the new run's hooks count", async () => {
		await seed("reopened", { agent: "claude_code", mode: "headless", isWorking: true });
		await stoppedReport("reopened");
		await runningReport("reopened");
		expect((await workingRow("reopened")).status).toBe("active");
		expect((await rowMetadata("reopened")).endedByEvent).toBeUndefined();
		// The new run's own hooks aren't held: a prompt starts the turn, a Stop hook ends it.
		await hook("reopened", "UserPromptSubmit");
		expect((await workingRow("reopened")).isWorking).toBe(true);
		await hook("reopened", "Stop");
		const row = await workingRow("reopened");
		expect(row.isWorking).toBe(false);
		expect(row.lastAgentTurnCompletedAt).not.toBeNull();
	});

	test("a user prompt hook reopens a latched row at once (UserPromptSubmit is exempt)", async () => {
		await seed("prompt-hook", { agent: "claude_code", mode: "headless" });
		await stoppedReport("prompt-hook");
		await hook("prompt-hook", "UserPromptSubmit");
		const row = await workingRow("prompt-hook");
		expect(row.status).toBe("active");
		expect(row.isWorking).toBe(true);
	});

	test("a Codex stop does not latch (its hooks never reach the session row)", async () => {
		await seed("codex-no-latch", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await upsertManagedSessionState("sup-A", {
			sessionId: "codex-no-latch",
			agentType: "codex_cli",
			status: "completed",
			managedState: "stopped",
		});
		expect((await rowMetadata("codex-no-latch")).endedByEvent).toBeUndefined();
	});

	test("a report that carries its own metadata leaves a latch the hook path set exactly as it was", async () => {
		await seed("hook-latch", { agent: "claude_code", mode: "headless" });
		const at = new Date().toISOString();
		await getDb()
			.update(sessions)
			.set({ metadata: { endedByEvent: { at } } })
			.where(eq(sessions.sessionId, "hook-latch"));
		await upsertManagedSessionState("sup-A", {
			sessionId: "hook-latch",
			agentType: "claude_code",
			status: "active",
			managedState: "headless",
			metadata: { progress: 1 },
		});
		const metadata = await rowMetadata("hook-latch");
		expect(metadata.endedByEvent).toEqual({ at });
		expect(metadata.progress).toBe(1);
	});

	test("a supervisor can't plant the latch through report metadata", async () => {
		await seed("planted", { agent: "claude_code", mode: "headless" });
		await upsertManagedSessionState("sup-A", {
			sessionId: "planted",
			agentType: "claude_code",
			status: "active",
			managedState: "headless",
			metadata: { endedByEvent: { at: new Date().toISOString() }, kept: 1 },
		});
		const metadata = await rowMetadata("planted");
		expect(metadata.endedByEvent).toBeUndefined();
		expect(metadata.kept).toBe(1);
	});
});

describe("a Stop on a session started in a terminal is refused at enqueue", () => {
	const terminal = { agent: "claude_code", mode: "interactive_terminal" };

	test("the launch still names its runtime", () => {
		expect(
			stopRuntimeOf({
				agentType: "claude_code",
				requestedLaunchMode: "interactive_terminal",
				metadata: {},
			}),
		).toBe("claude_terminal");
	});

	test("409-class refusal stop_not_supported, in fixed words, with nothing queued and no lock taken", async () => {
		await seed("term-stop", { ...terminal, managedState: "interactive_terminal" });
		let message = "";
		try {
			await queueStopAction("term-stop", ACTOR);
		} catch (error) {
			message = (error as Error).message;
			expect((error as { code?: string }).code).toBe("stop_not_supported");
		}
		expect(message).toBe(STOP_NOT_SUPPORTED_MESSAGE);
		expect(STOP_NOT_SUPPORTED_MESSAGE).toBe(
			"Stop isn't available for sessions started in a terminal yet. Stop it in that terminal.",
		);
		expect(await actionRows()).toHaveLength(0);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "term-stop"));
		expect(managed?.activeControlActionId).toBeNull();
	});

	test("it is judged before the host: an older host, an offline one or an ended session get the same answer", async () => {
		await seed("term-old", { ...terminal, managedState: "stopped", launchStatus: "completed" });
		await setHostFeatures([]);
		expect(await codeOf(queueStopAction("term-old", ACTOR))).toBe("stop_not_supported");
	});

	test("a headless Claude on the same host is not caught by it", async () => {
		await seed("term-control", { agent: "claude_code", mode: "headless" });
		expect((await queueStopAction("term-control", ACTOR)).actionType).toBe("stop");
	});
});

describe("a queued Claude stop is re-judged when a host claims it", () => {
	test("a host that no longer advertises claude_stop is not handed it: failed with the upgrade words, lock released", async () => {
		await seed("claim-old", { agent: "claude_code", mode: "headless" });
		await setHostFeatures([CLAUDE_STOP]);
		const queued = await queueStopAction("claim-old", ACTOR);
		await setHostFeatures([]);
		expect(await claimNextControlAction("sup-A")).toBeNull();
		const [row] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, queued.id));
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe(CLAUDE_STOP_UPGRADE_MESSAGE);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "claim-old"));
		expect(managed?.activeControlActionId).toBeNull();
	});

	test("positive control: a host that still advertises it claims the stop", async () => {
		await seed("claim-ok", { agent: "claude_code", mode: "headless" });
		await setHostFeatures([CLAUDE_STOP]);
		const queued = await queueStopAction("claim-ok", ACTOR);
		expect((await claimNextControlAction("sup-A"))?.id).toBe(queued.id);
	});

	test("a Codex stop is claimed by a host with no features", async () => {
		await seed("claim-codex", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await setHostFeatures([]);
		const queued = await queueStopAction("claim-codex", ACTOR);
		expect((await claimNextControlAction("sup-A"))?.id).toBe(queued.id);
	});
});

describe("the latch follows the launch's agent type, and only a live report lifts it", () => {
	test("a session row that claims codex over a Claude launch is latched when stopped", async () => {
		await seed("latch-launch-claude", { agent: "claude_code", mode: "headless" });
		await getDb()
			.update(sessions)
			.set({ agentType: "codex_cli" })
			.where(eq(sessions.sessionId, "latch-launch-claude"));
		await upsertManagedSessionState("sup-A", {
			sessionId: "latch-launch-claude",
			agentType: "claude_code",
			status: "completed",
			managedState: "stopped",
		});
		expect((await rowMetadata("latch-launch-claude")).endedByEvent).toBeDefined();
	});

	test("a session row that claims Claude over a Codex launch is not", async () => {
		await seed("latch-launch-codex", {
			agent: "codex_cli",
			mode: "managed_codex",
			managedState: "managed",
		});
		await getDb()
			.update(sessions)
			.set({ agentType: "claude_code" })
			.where(eq(sessions.sessionId, "latch-launch-codex"));
		await upsertManagedSessionState("sup-A", {
			sessionId: "latch-launch-codex",
			agentType: "codex_cli",
			status: "completed",
			managedState: "stopped",
		});
		expect((await rowMetadata("latch-launch-codex")).endedByEvent).toBeUndefined();
	});

	test("a replayed running report does not lift it (a live one does: see the reopen test above)", async () => {
		await seed("latch-replay", { agent: "claude_code", mode: "headless", isWorking: true });
		await stoppedReport("latch-replay");
		await upsertManagedSessionState(
			"sup-A",
			{
				sessionId: "latch-replay",
				agentType: "claude_code",
				status: "active",
				managedState: "headless",
			},
			{ replay: true },
		);
		expect((await rowMetadata("latch-replay")).endedByEvent).toBeDefined();
	});
});

describe("one list of finished launch statuses", () => {
	test("launch-dispatch.ts uses the shared set and defines no copy of its own", async () => {
		const { readFileSync } = await import("node:fs");
		const text = readFileSync(new URL("./launch-dispatch.ts", import.meta.url), "utf8");
		expect(text).toContain("FINISHED_LAUNCH_STATUSES");
		expect(text).toMatch(
			/import \{[^}]*FINISHED_LAUNCH_STATUSES[^}]*\} from "\.\.\/\.\.\/shared\/stop-runtime\.js"/,
		);
		expect(text).not.toMatch(/new Set\(\[\s*"completed",\s*"failed",\s*"cancelled"/);
	});
});
