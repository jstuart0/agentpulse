/**
 * AGEN-117 P3, the server half of the stream runtime (T16, T18):
 *  - a prompt to a takeover fork is routed by its launch (`metadata.runtime`), refused when the fork is
 *    degraded, stopped or ended, and refused when it starts with a slash; a launched session is unchanged;
 *  - a fork's turn events (`claudeStreamRuntime`) move its working state exactly as a Codex turn's do, and a
 *    marker on the other agent's row moves nothing;
 *  - any hook post for a fork is dropped (200, nothing stored, counted), a launched session's is not;
 *  - the text of a message a stranger sent a fork is kept redacted in server-owned metadata, never in the
 *    session DTO, and only the owner or an admin reads it.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	CLAUDE_FORK_PEER_SYNC_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
} from "../../shared/managed-messages.js";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, events, launchRequests, managedSessions, sessions, supervisors } =
	await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const control = await import("./control-actions.js");
const { processHookEvent, processStatusUpdate } = await import("./event-processor.js");
const state = await import("./managed-session-state.js");
const { mapSessionDto } = await import("./session-dto.js");
const approvals = await import("./codex-approvals.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const counters = await import("../routes/ingest-counters.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
	counters._resetCountersForTest();
});

type Kind = "fork" | "launched" | "codex";

async function seed(
	sessionId: string,
	kind: Kind,
	opts: {
		managedState?: string;
		activeAction?: boolean;
		ownerUserId?: string | null;
		metadata?: Record<string, unknown>;
	} = {},
) {
	const launch = await seedOwnedLaunch(sessionId, "sup-A");
	const agent = kind === "codex" ? "codex_cli" : "claude_code";
	await getDb()
		.update(launchRequests)
		.set({
			agentType: agent,
			requestedLaunchMode: kind === "codex" ? "managed_codex" : "headless",
			cwd: "/work/launch-dir",
			model: "m-1",
			env: { FOO: "bar" },
			metadata: kind === "fork" ? { boundObservedSession: true } : {},
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
			isWorking: false,
			lastActivityAt: now,
			ownerUserId: opts.ownerUserId ?? null,
			metadata:
				kind === "fork"
					? { forkedFromSessionId: "src-1", ...opts.metadata }
					: (opts.metadata ?? {}),
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.launchId,
			supervisorId: "sup-A",
			managedState: opts.managedState ?? "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return launch;
}

const sessionRow = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
const actionsFor = async (id: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, id));

describe("prompts to a takeover fork", () => {
	test("are routed to the fork's live process by the launch, with no model, policy or env in the row", async () => {
		await seed("fork-1", "fork");
		const action = await control.queuePromptAction("fork-1", "carry on", ACTOR);
		const metadata = action.metadata as Record<string, unknown>;
		expect(metadata.runtime).toBe("claude_stream");
		expect(metadata.agentType).toBe("claude_code");
		expect(metadata.cwd).toBe("/work/launch-dir");
		for (const key of ["model", "approvalPolicy", "sandboxMode", "env"]) {
			expect(metadata, key).not.toHaveProperty(key);
		}
	});

	test("a launched headless Claude keeps its one-prompt shape and gains runtime claude_headless", async () => {
		await seed("launched-1", "launched", { managedState: "headless" });
		const action = await control.queuePromptAction("launched-1", "hi", ACTOR);
		const metadata = action.metadata as Record<string, unknown>;
		expect(metadata.runtime).toBe("claude_headless");
		expect(metadata).toMatchObject({ model: "m-1", env: { FOO: "bar" } });
	});

	test("a Codex prompt carries no runtime (absent means Codex)", async () => {
		await seed("codex-1", "codex");
		await getDb()
			.update(supervisors)
			.set({ capabilities: { version: 1, features: ["codex_follow_up_prompts"] } as never })
			.where(eq(supervisors.id, "sup-A"));
		const action = await control.queuePromptAction("codex-1", "hi", ACTOR);
		expect(action.metadata).not.toHaveProperty("runtime");
		expect((action.metadata as Record<string, unknown>).agentType).toBe("codex_cli");
	});

	test.each(["degraded", "stopped", "completed", "failed"])(
		"a fork in state %s is refused as not continuable, and nothing is queued",
		async (managedState) => {
			await seed("fork-s", "fork", { managedState });
			await expect(control.queuePromptAction("fork-s", "hi", ACTOR)).rejects.toBeInstanceOf(
				control.ManagedStateNotContinuableError,
			);
			expect(await actionsFor("fork-s")).toEqual([]);
		},
	);

	test("a launched Claude in a state a fork would be refused in is not refused (its path is unchanged)", async () => {
		await seed("launched-s", "launched", { managedState: "degraded" });
		const action = await control.queuePromptAction("launched-s", "hi", ACTOR);
		expect(action.actionType).toBe("prompt");
	});

	test("a fork still starting with an action holding its lock is busy, not 'not continuable'", async () => {
		await seed("fork-p", "fork", { managedState: "pending" });
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: "some-action" })
			.where(eq(managedSessions.sessionId, "fork-p"));
		await expect(control.queuePromptAction("fork-p", "hi", ACTOR)).rejects.toBeInstanceOf(
			control.ControlBusyError,
		);
	});

	test("a leading slash is refused prompt_unsafe with the fixed words; ! and # lines are queued", async () => {
		await seed("fork-slash", "fork");
		for (const text of ["/model opus", "   /clear", "\n/update-config"]) {
			const error = await control
				.queuePromptAction("fork-slash", text, ACTOR)
				.catch((e: Error) => e);
			expect(error, text).toBeInstanceOf(control.PromptUnsafeError);
			expect((error as Error).message).toBe(CLAUDE_FORK_SLASH_MESSAGE);
			expect((error as InstanceType<typeof control.PromptUnsafeError>).code).toBe("prompt_unsafe");
		}
		expect(await actionsFor("fork-slash")).toEqual([]);
		const bang = await control.queuePromptAction("fork-slash", "!x", ACTOR);
		expect(bang.status).toBe("queued");
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: null })
			.where(eq(managedSessions.sessionId, "fork-slash"));
		await getDb().delete(controlActions).execute();
		const hash = await control.queuePromptAction("fork-slash", "#123 is the bug", ACTOR);
		expect(hash.status).toBe("queued");
	});

	test("a launched session may start a prompt with a slash (only a fork refuses it)", async () => {
		await seed("launched-slash", "launched", { managedState: "headless" });
		const action = await control.queuePromptAction("launched-slash", "/compact", ACTOR);
		expect(action.actionType).toBe("prompt");
	});

	test("the refusal is not reachable by a session row that claims to be a fork: the launch decides", async () => {
		await seed("claims", "launched", {
			managedState: "headless",
			metadata: { forkedFromSessionId: "x" },
		});
		const action = await control.queuePromptAction("claims", "/compact", ACTOR);
		expect((action.metadata as Record<string, unknown>).runtime).toBe("claude_headless");
	});
});

describe("a fork's turn events move its working state", () => {
	const claudeMark = { claudeStreamRuntime: true };
	const submitted = (rawPayload: Record<string, unknown>) => ({
		eventType: "HeadlessPromptSubmitted",
		rawPayload,
	});
	const completed = (rawPayload: Record<string, unknown>) => ({
		eventType: "HeadlessPromptCompleted",
		rawPayload,
	});

	test("start sets working and acknowledges; end clears it and stamps the completion", async () => {
		await seed("fork-t", "fork");
		await state.applyManagedTurnBoundaries(getDb(), "fork-t", [submitted(claudeMark)], {
			late: false,
		});
		let row = await sessionRow("fork-t");
		expect(row?.isWorking).toBe(true);
		expect(row?.currentTurnStartedAt).not.toBeNull();
		expect(row?.lastUserAcknowledgedAt).not.toBeNull();
		await state.applyManagedTurnBoundaries(getDb(), "fork-t", [completed(claudeMark)], {
			late: false,
		});
		row = await sessionRow("fork-t");
		expect(row?.isWorking).toBe(false);
		expect(row?.lastAgentTurnCompletedAt).not.toBeNull();
	});

	test("the Claude marker on a Codex row, a Codex marker on a Claude row and an unmarked event move nothing", async () => {
		await seed("codex-t", "codex");
		await state.applyManagedTurnBoundaries(getDb(), "codex-t", [submitted(claudeMark)], {
			late: false,
		});
		expect((await sessionRow("codex-t"))?.isWorking).toBe(false);
		await seed("fork-t2", "fork");
		await state.applyManagedTurnBoundaries(
			getDb(),
			"fork-t2",
			[submitted({ codexRuntime: true })],
			{ late: false },
		);
		expect((await sessionRow("fork-t2"))?.isWorking).toBe(false);
		await state.applyManagedTurnBoundaries(
			getDb(),
			"fork-t2",
			[submitted({ source: "agentpulse_workspace" })],
			{ late: false },
		);
		expect((await sessionRow("fork-t2"))?.isWorking).toBe(false);
	});

	test("the Claude marker on a launched (non-fork) headless row moves nothing: its own hooks own that state", async () => {
		await seed("launched-t", "launched", { managedState: "headless" });
		await state.applyManagedTurnBoundaries(getDb(), "launched-t", [submitted(claudeMark)], {
			late: false,
		});
		const row = await sessionRow("launched-t");
		expect(row?.isWorking).toBe(false);
		expect(row?.currentTurnStartedAt).toBeNull();
		// ...while a stop still ends a launched row's turn, as before
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, "launched-t"));
		await state.applyManagedTurnBoundaries(
			getDb(),
			"launched-t",
			[{ eventType: "ManagedSessionStopped" }],
			{ late: false },
		);
		expect((await sessionRow("launched-t"))?.isWorking).toBe(false);
	});

	test("a Codex turn still moves a Codex row", async () => {
		await seed("codex-t2", "codex");
		await state.applyManagedTurnBoundaries(
			getDb(),
			"codex-t2",
			[submitted({ codexRuntime: true })],
			{ late: false },
		);
		expect((await sessionRow("codex-t2"))?.isWorking).toBe(true);
	});

	test("a late report can end a turn but never start one", async () => {
		await seed("fork-late", "fork");
		await state.applyManagedTurnBoundaries(getDb(), "fork-late", [submitted(claudeMark)], {
			late: true,
		});
		expect((await sessionRow("fork-late"))?.isWorking).toBe(false);
		await state.applyManagedTurnBoundaries(getDb(), "fork-late", [submitted(claudeMark)], {
			late: false,
		});
		await state.applyManagedTurnBoundaries(getDb(), "fork-late", [completed(claudeMark)], {
			late: true,
		});
		expect((await sessionRow("fork-late"))?.isWorking).toBe(false);
	});

	test("an idle report ends a working fork's turn", async () => {
		await seed("fork-idle", "fork");
		await state.applyManagedTurnBoundaries(getDb(), "fork-idle", [submitted(claudeMark)], {
			late: false,
		});
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-idle",
			agentType: "claude_code",
			status: "idle",
			managedState: "managed",
		});
		const row = await sessionRow("fork-idle");
		expect(row?.isWorking).toBe(false);
		expect(row?.lastAgentTurnCompletedAt).not.toBeNull();
	});
});

describe("hook posts for a fork are dropped", () => {
	const SENTINEL = "SENTINEL-hook-input-9d41";
	const hook = (sessionId: string, name: string, extra: Record<string, unknown> = {}) =>
		processHookEvent(
			{ session_id: sessionId, hook_event_name: name, tool_name: "Bash", ...extra } as never,
			"claude_code",
		);

	test("PreToolUse with a sentinel, Stop, PermissionRequest and SessionEnd: nothing stored, the counter moves, the wait is unchanged", async () => {
		await seed("fork-h", "fork");
		const before = await sessionRow("fork-h");
		for (const name of [
			"PreToolUse",
			"Stop",
			"PermissionRequest",
			"SessionEnd",
			"UserPromptSubmit",
		]) {
			const result = await hook("fork-h", name, {
				tool_input: { command: `echo ${SENTINEL}` },
				tool_use_id: "toolu_1",
			});
			expect(result.session, name).toBeNull();
		}
		expect(counters.getForkHookDroppedCount()).toBe(5);
		expect(await getDb().select().from(events).where(eq(events.sessionId, "fork-h"))).toEqual([]);
		const after = await sessionRow("fork-h");
		expect(after?.metadata).toEqual(before?.metadata);
		expect((after?.metadata as Record<string, unknown>).permissionWait).toBeUndefined();
		expect(after?.isWorking).toBe(before?.isWorking);
		expect(after?.status).toBe(before?.status);
		expect(JSON.stringify(after)).not.toContain(SENTINEL);
	});

	test("a status post for a fork is dropped too", async () => {
		await seed("fork-st", "fork");
		expect(
			await processStatusUpdate({ session_id: "fork-st", status: "testing", task: "x" } as never),
		).toBe(false);
		expect(counters.getForkHookDroppedCount()).toBe(1);
		expect((await sessionRow("fork-st"))?.semanticStatus).toBeNull();
	});

	test("negative control: the same hooks on a launched session are stored and nothing is counted", async () => {
		await seed("launched-h", "launched", { managedState: "headless" });
		const result = await hook("launched-h", "PreToolUse", {
			tool_input: { command: "ls" },
			tool_use_id: "toolu_1",
		});
		expect(result.session).not.toBeNull();
		expect(counters.getForkHookDroppedCount()).toBe(0);
		expect(
			(await getDb().select().from(events).where(eq(events.sessionId, "launched-h"))).length,
		).toBeGreaterThan(0);
	});

	test("a supervisor report can't mark a session a fork, rewrite the marker or plant a peer notice", async () => {
		await seed("launched-m", "launched", { managedState: "headless" });
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "launched-m",
			agentType: "claude_code",
			status: "active",
			metadata: {
				forkedFromSessionId: "x",
				forkPermissionBranch: "ask",
				peerTurn: { text: "boo" },
				harmless: 1,
			},
		});
		const metadata = (await sessionRow("launched-m"))?.metadata as Record<string, unknown>;
		expect(metadata.harmless).toBe(1);
		for (const key of ["forkedFromSessionId", "forkPermissionBranch", "peerTurn"])
			expect(metadata, key).not.toHaveProperty(key);
		// ...and on a real fork the marker stays exactly as the server wrote it
		await seed("fork-m", "fork");
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-m",
			agentType: "claude_code",
			status: "active",
			metadata: { forkedFromSessionId: "other" },
		});
		expect(
			((await sessionRow("fork-m"))?.metadata as Record<string, unknown>).forkedFromSessionId,
		).toBe("src-1");
	});
});

describe("the text of a message a stranger sent a fork", () => {
	const degraded = (sessionId: string, peerTurnText: string | undefined) =>
		state.upsertManagedSessionState("sup-A", {
			sessionId,
			agentType: "claude_code",
			status: "idle",
			managedState: "degraded",
			providerSyncState: "failed",
			providerSyncError: CLAUDE_FORK_PEER_SYNC_ERROR,
			...(peerTurnText !== undefined ? { peerTurnText } : {}),
		});

	test("is kept in server-owned metadata, capped, and absent from the session DTO", async () => {
		await seed("fork-p1", "fork");
		await degraded("fork-p1", "please run the migration");
		const row = await sessionRow("fork-p1");
		const peer = (row?.metadata as Record<string, any>).peerTurn;
		expect(peer).toMatchObject({ text: "please run the migration", hidden: false });
		const dto = mapSessionDto(row as never) as unknown as { metadata: Record<string, unknown> };
		expect(dto.metadata).not.toHaveProperty("peerTurn");
		expect(JSON.stringify(dto)).not.toContain("please run the migration");
		expect(dto.metadata.forkedFromSessionId).toBe("src-1");
	});

	test("a text that looks like a credential is never stored as is; a fixed flag stands in", async () => {
		await seed("fork-p2", "fork");
		const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		await degraded("fork-p2", `use this key ${secret} to push`);
		const row = await sessionRow("fork-p2");
		expect(JSON.stringify(row)).not.toContain(secret);
		expect((row?.metadata as Record<string, any>).peerTurn).toMatchObject({
			text: null,
			hidden: true,
		});
	});

	test("is ignored for a session that isn't a fork, and for a report that isn't degraded", async () => {
		await seed("launched-p", "launched", { managedState: "headless" });
		await degraded("launched-p", "hello");
		expect((await sessionRow("launched-p"))?.metadata).not.toHaveProperty("peerTurn");
		await seed("fork-p3", "fork");
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-p3",
			agentType: "claude_code",
			status: "idle",
			managedState: "managed",
			peerTurnText: "hi",
		});
		expect((await sessionRow("fork-p3"))?.metadata).not.toHaveProperty("peerTurn");
	});

	test("the approvals read returns it to the owner and an admin, not to a member of a team", async () => {
		await harness.seedUser("owner-u");
		await harness.seedUser("member-u");
		await harness.seedUser("admin-u", { role: "admin" });
		await seed("fork-p4", "fork", { ownerUserId: "owner-u" });
		await degraded("fork-p4", "run rm -rf in the build dir");
		const owner = await approvals.listApprovalsForSession(
			"fork-p4",
			harness.teamCaller("owner-u", "member"),
		);
		expect(owner.peerTurn).toEqual({ text: "run rm -rf in the build dir", hidden: false });
		const admin = await approvals.listApprovalsForSession(
			"fork-p4",
			harness.teamCaller("admin-u", "admin"),
		);
		expect(admin.peerTurn?.text).toBe("run rm -rf in the build dir");
		await expect(
			approvals.listApprovalsForSession("fork-p4", harness.teamCaller("member-u", "member")),
		).rejects.toMatchObject({ code: "not_owner" });
		const solo = await approvals.listApprovalsForSession("fork-p4", harness.SOLO_PERSON);
		expect(solo.peerTurn?.hidden).toBe(false);
	});

	test("a fork with nothing to report has no peerTurn on its list", async () => {
		await seed("fork-p5", "fork");
		const list = await approvals.listApprovalsForSession("fork-p5", harness.SOLO_PERSON);
		expect(list).not.toHaveProperty("peerTurn");
	});
});

describe("the host's acceptance of a prompt (I16)", () => {
	const queueAndClaim = async (sessionId: string) => {
		const queued = await control.queuePromptAction(sessionId, "carry on", ACTOR);
		const claimed = await control.claimNextControlAction("sup-A");
		expect(claimed?.id).toBe(queued.id);
		return queued.id;
	};
	const read = async (id: string) =>
		(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0];
	const acceptedAt = async (id: string) =>
		((await read(id))?.metadata as Record<string, unknown> | null)?.acceptedAt;

	test("a claim reads running and carries no acceptance; only the host's own acceptance report stamps it, once", async () => {
		await seed("fork-acc", "fork");
		const id = await queueAndClaim("fork-acc");
		expect((await read(id))?.status).toBe("running");
		expect(await acceptedAt(id)).toBeUndefined();
		// a plain renewal is not acceptance and leaves the metadata exactly as it was
		const before = (await read(id))?.metadata;
		await control.updateControlAction({ actionId: id, supervisorId: "sup-A", status: "running" });
		expect((await read(id))?.metadata).toEqual(before);
		await control.updateControlAction({
			actionId: id,
			supervisorId: "sup-A",
			status: "running",
			accepted: true,
		});
		const stamped = await acceptedAt(id);
		expect(typeof stamped).toBe("string");
		await control.updateControlAction({
			actionId: id,
			supervisorId: "sup-A",
			status: "running",
			accepted: true,
		});
		expect(await acceptedAt(id)).toBe(stamped);
		expect((await read(id))?.status).toBe("running");
		expect((await read(id))?.finishedAt).toBeNull();
	});

	test("a refusal that arrives after the claim is the action's end, and nothing was ever stamped", async () => {
		await seed("fork-ref", "fork");
		const id = await queueAndClaim("fork-ref");
		await control.updateControlAction({
			actionId: id,
			supervisorId: "sup-A",
			status: "failed",
			error: "Fixed words.",
		});
		const row = await read(id);
		expect(row?.status).toBe("failed");
		expect((row?.metadata as Record<string, unknown>).acceptedAt).toBeUndefined();
		// a late acceptance can't resurrect or stamp a finished action
		await control.updateControlAction({
			actionId: id,
			supervisorId: "sup-A",
			status: "running",
			accepted: true,
		});
		expect((await read(id))?.status).toBe("failed");
		expect(await acceptedAt(id)).toBeUndefined();
	});

	test("acceptance is only for a prompt, and only from the supervisor that claimed it", async () => {
		await seed("fork-acc2", "fork");
		const id = await queueAndClaim("fork-acc2");
		await control.updateControlAction({
			actionId: id,
			supervisorId: "sup-other",
			status: "running",
			accepted: true,
		});
		expect(await acceptedAt(id)).toBeUndefined();
	});
});

describe("who may drive a continued session that runs under the person's own settings (X17)", () => {
	const API_KEY: Actor = { userId: null, label: "api_key" };
	const prompt = (id: string, actor: Actor) => control.queuePromptAction(id, "carry on", actor);

	test("an API key, the watcher, a host and system work are refused human_required when the branch is ask", async () => {
		await seed("fork-ask", "fork", { metadata: { forkPermissionBranch: "ask" } });
		for (const label of ["api_key", "ai", "supervisor", "system"] as const) {
			const error = await prompt("fork-ask", { userId: null, label }).catch((e: Error) => e);
			expect(error, label).toBeInstanceOf(control.HumanRequiredError);
		}
		expect(await actionsFor("fork-ask")).toEqual([]);
	});

	test("a signed-in person, DISABLE_AUTH's anonymous caller and a Telegram chat pass", async () => {
		await seed("fork-ask2", "fork", { metadata: { forkPermissionBranch: "ask" } });
		for (const label of ["user", "anonymous", "telegram"] as const) {
			await getDb().delete(controlActions).execute();
			await getDb()
				.update(managedSessions)
				.set({ activeControlActionId: null })
				.where(eq(managedSessions.sessionId, "fork-ask2"));
			expect((await prompt("fork-ask2", { userId: null, label })).status, label).toBe("queued");
		}
	});

	test("a fork whose branch is missing or unknown is treated as ask; restricted lets a key through; a launched session is unaffected", async () => {
		await seed("fork-nobranch", "fork");
		await expect(prompt("fork-nobranch", API_KEY)).rejects.toBeInstanceOf(
			control.HumanRequiredError,
		);
		await seed("fork-weird", "fork", { metadata: { forkPermissionBranch: "yolo" } });
		await expect(prompt("fork-weird", API_KEY)).rejects.toBeInstanceOf(control.HumanRequiredError);
		await seed("fork-restricted", "fork", { metadata: { forkPermissionBranch: "restricted" } });
		expect((await prompt("fork-restricted", API_KEY)).status).toBe("queued");
		await seed("launched-key", "launched", { managedState: "headless" });
		expect((await prompt("launched-key", API_KEY)).status).toBe("queued");
	});
});

describe("the peer notice's reader and its end (X21)", () => {
	test("an unowned session in team mode shows it to an admin and not to a member, who can read the session", async () => {
		await harness.seedUser("member-x");
		await harness.seedUser("admin-x", { role: "admin" });
		await seed("fork-unowned", "fork");
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-unowned",
			agentType: "claude_code",
			status: "idle",
			managedState: "degraded",
			providerSyncState: "failed",
			peerTurnText: "hello there",
		});
		const member = await approvals.listApprovalsForSession(
			"fork-unowned",
			harness.teamCaller("member-x", "member"),
		);
		expect(member).not.toHaveProperty("peerTurn");
		const admin = await approvals.listApprovalsForSession(
			"fork-unowned",
			harness.teamCaller("admin-x", "admin"),
		);
		expect(admin.peerTurn?.text).toBe("hello there");
	});

	test("a successful resume clears it with the sync error; an ordinary report does not", async () => {
		await seed("fork-resume", "fork");
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-resume",
			agentType: "claude_code",
			status: "idle",
			managedState: "degraded",
			providerSyncState: "failed",
			peerTurnText: "hello there",
		});
		expect(
			((await sessionRow("fork-resume"))?.metadata as Record<string, any>).peerTurn?.text,
		).toBe("hello there");
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-resume",
			agentType: "claude_code",
			status: "idle",
			managedState: "managed",
		});
		expect(
			((await sessionRow("fork-resume"))?.metadata as Record<string, any>).peerTurn?.text,
		).toBe("hello there");
		// a resume report that names an open resume action clears it, with the sync error
		await getDb()
			.insert(controlActions)
			.values({
				id: "resume-1",
				sessionId: "fork-resume",
				actionType: "resume",
				requestedBy: "user",
				status: "running",
				claimedBySupervisorId: "sup-A",
				metadata: {},
			})
			.execute();
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-resume",
			agentType: "claude_code",
			status: "active",
			managedState: "managed",
			resumeActionId: "resume-1",
			clearProviderSyncError: true,
		});
		expect((await sessionRow("fork-resume"))?.metadata).not.toHaveProperty("peerTurn");
		// ...and one that names none is refused and changes nothing
		await state.upsertManagedSessionState("sup-A", {
			sessionId: "fork-resume",
			agentType: "claude_code",
			status: "idle",
			managedState: "degraded",
			providerSyncState: "failed",
			peerTurnText: "second one",
		});
		expect(
			((await sessionRow("fork-resume"))?.metadata as Record<string, any>).peerTurn?.text,
		).toBe("second one");
		await expect(
			state.upsertManagedSessionState("sup-A", {
				sessionId: "fork-resume",
				agentType: "claude_code",
				status: "active",
				managedState: "managed",
				resumeActionId: "no-such-action",
				clearProviderSyncError: true,
			}),
		).rejects.toBeDefined();
		expect(
			((await sessionRow("fork-resume"))?.metadata as Record<string, any>).peerTurn?.text,
		).toBe("second one");
	});
});

describe("the first-turn guard reads both timestamp formats (found while re-running P2's suite)", () => {
	const stamp = (msAgo: number, form: "iso" | "sqlite") => {
		const iso = new Date(Date.now() - msAgo).toISOString();
		return form === "iso" ? iso : iso.slice(0, 19).replace("T", " ");
	};
	test.each([
		["iso", 60_000, true],
		["sqlite", 60_000, true],
		["iso", 7 * 3_600_000, false],
		["sqlite", 7 * 3_600_000, false],
	] as const)(
		"a running headless launch stamped %s %d ms ago blocks a prompt: %s",
		async (form, msAgo, blocks) => {
			const id = `first-${form}-${msAgo}`;
			const launch = await seed(id, "launched", { managedState: "headless" });
			await getDb()
				.update(launchRequests)
				.set({ status: "running", updatedAt: stamp(msAgo, form) })
				.where(eq(launchRequests.id, launch.launchId));
			const result = await control.queuePromptAction(id, "hi", ACTOR).then(
				() => "queued",
				(e: Error) => e.constructor.name,
			);
			expect(result).toBe(blocks ? "ControlBusyError" : "queued");
		},
	);
});

describe("peerTurnRecord: nothing captured (P7-X2)", () => {
	test("an empty text from the host is stored as no text and not hidden; real text is unchanged", async () => {
		const { peerTurnRecord } = await import("./managed-session-state.js");
		expect(peerTurnRecord("", "t")).toEqual({ text: null, hidden: false, at: "t" });
		expect(peerTurnRecord("  \n", "t")).toEqual({ text: null, hidden: false, at: "t" });
		expect(peerTurnRecord("do the thing", "t")).toEqual({
			text: "do the thing",
			hidden: false,
			at: "t",
		});
	});
});
