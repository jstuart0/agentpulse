/**
 * AGEN-91, the server half of the routing key. A prompt action is keyed by the *launch's* agent type, never
 * by the session row's (an ingest key can create a session row under a launch's id with an agent type of
 * its choosing). A Codex action carries no env, privileges or model: the follow-up sends nothing that could
 * widen the thread's sticky settings. The action's metadata is held equal to a committed fixture which the
 * supervisor's tests read too, so the two halves can't drift.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type Replacement,
	normaliseFollowUp,
	readOrUpdateFixture,
} from "../../shared/__fixtures__/followup-normalise.js";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };
const FIXTURE = new URL("../../shared/__fixtures__/codex-prompt-action.json", import.meta.url);

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { enqueuePromptInTx, queuePromptAction, LaunchMismatchError } = await import(
	"./control-actions.js"
);
const { withAdminLock } = await import("../db/admin-lock.js");

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
	opts: { launchAgent: string; sessionAgent: string; managedState?: string },
) {
	const launch = await seedOwnedLaunch(sessionId, "sup-A");
	await getDb()
		.update(launchRequests)
		.set({
			agentType: opts.launchAgent,
			requestedLaunchMode: opts.launchAgent === "codex_cli" ? "managed_codex" : "headless",
			cwd: "/work/launch-dir",
			model: "launch-model",
			approvalPolicy: "on-request",
			sandboxMode: "workspace-write",
			env: { SECRET_TOKEN: "launch-env-value" },
		})
		.where(eq(launchRequests.id, launch.launchId));
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: opts.sessionAgent,
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
			supervisorId: "sup-A",
			managedState: opts.managedState ?? "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return launch;
}

describe("a Codex launch's prompt action", () => {
	test("is keyed by the launch's agent type and carries no env, privileges or model", async () => {
		await seed("codex-sess-1", { launchAgent: "codex_cli", sessionAgent: "codex_cli" });
		const action = await queuePromptAction("codex-sess-1", "hello", ACTOR);
		const metadata = action.metadata as Record<string, unknown>;
		expect(metadata.agentType).toBe("codex_cli");
		for (const key of ["env", "approvalPolicy", "sandboxMode", "model"]) {
			expect(key in metadata, `${key} must not be in a Codex action`).toBe(false);
		}
		for (const key of ["cwd", "prompt", "managedState"]) {
			expect(key in metadata, `${key} must stay`).toBe(true);
		}
		expect(JSON.stringify(metadata)).not.toContain("launch-env-value");
	});

	test("equals the committed fixture (ids and the directory normalised)", async () => {
		const launch = await seed("codex-sess-fixture", {
			launchAgent: "codex_cli",
			sessionAgent: "codex_cli",
		});
		const action = await queuePromptAction("codex-sess-fixture", "hello", ACTOR);
		const replacements: Replacement[] = [
			["codex-sess-fixture", "<session>"],
			[launch.launchId, "<launch>"],
			[action.id, "<action>"],
			["/work/launch-dir", "<cwd>"],
		];
		const actual = normaliseFollowUp(action.metadata, replacements);
		expect(actual).toEqual(readOrUpdateFixture(FIXTURE, actual));
	});

	test("a Claude launch's action still carries them", async () => {
		await seed("claude-sess-1", { launchAgent: "claude_code", sessionAgent: "claude_code" });
		const action = await queuePromptAction("claude-sess-1", "hello", ACTOR);
		expect(action.metadata).toMatchObject({
			agentType: "claude_code",
			approvalPolicy: "on-request",
			sandboxMode: "workspace-write",
			model: "launch-model",
			env: { SECRET_TOKEN: "launch-env-value" },
		});
	});
});

describe("a session row that disagrees with its launch", () => {
	test("a hook-created Claude row under a Codex launch is refused launch_mismatch: no action row, no lock", async () => {
		await seed("forged-sess-1", { launchAgent: "codex_cli", sessionAgent: "claude_code" });
		const result = await withAdminLock((tx) =>
			enqueuePromptInTx(tx, {
				sessionId: "forged-sess-1",
				prompt: "hello",
				actor: ACTOR,
				controlActionId: crypto.randomUUID(),
			}),
		);
		expect(result).toEqual({ ok: false, reason: "launch_mismatch" });
		expect(await getDb().select().from(controlActions)).toEqual([]);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "forged-sess-1"));
		expect(managed?.activeControlActionId ?? null).toBeNull();
	});

	test("queuePromptAction raises the error the route already maps for that code", async () => {
		await seed("forged-sess-2", { launchAgent: "codex_cli", sessionAgent: "claude_code" });
		await expect(queuePromptAction("forged-sess-2", "hello", ACTOR)).rejects.toBeInstanceOf(
			LaunchMismatchError,
		);
	});

	test("POST /prompt answers it as it does today (400 with the error's words), queuing nothing", async () => {
		await seed("forged-route-1", { launchAgent: "codex_cli", sessionAgent: "claude_code" });
		const { config } = await import("../config.js");
		const { app } = await import("../app.js");
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await app.request("/api/v1/sessions/forged-route-1/prompt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "hello" }),
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe(
				new LaunchMismatchError().message,
			);
			expect(await getDb().select().from(controlActions)).toEqual([]);
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});

	test("the other way round (Codex row under a Claude launch) is refused too", async () => {
		await seed("forged-sess-3", { launchAgent: "claude_code", sessionAgent: "codex_cli" });
		await expect(queuePromptAction("forged-sess-3", "hello", ACTOR)).rejects.toBeInstanceOf(
			LaunchMismatchError,
		);
	});
});

describe("the normalisation both halves of the fixture comparison use", () => {
	const swap = (session: string, thread: string, turn: string): Replacement[] => [
		[session, "<session>"],
		[thread, "<thread>"],
		[turn, "<turn>"],
	];
	const run = (session: string, thread: string, turn: string, content: string) => ({
		eventType: "HeadlessPromptCompleted",
		content,
		occurredAt: `${session}-time`,
		rawPayload: { codexTurnId: turn, threadId: thread, note: `in ${session}` },
	});

	test("two runs with different ids normalise equal", () => {
		const a = normaliseFollowUp(
			run("s-1", "t-1", "u-1", "Codex finished the turn."),
			swap("s-1", "t-1", "u-1"),
		);
		const b = normaliseFollowUp(
			run("s-2", "t-2", "u-2", "Codex finished the turn."),
			swap("s-2", "t-2", "u-2"),
		);
		expect(a).toEqual(b);
		expect(a).not.toHaveProperty("occurredAt");
	});

	test("a changed content does not", () => {
		const a = normaliseFollowUp(
			run("s-1", "t-1", "u-1", "Codex finished the turn."),
			swap("s-1", "t-1", "u-1"),
		);
		const b = normaliseFollowUp(
			run("s-1", "t-1", "u-1", "Codex turn failed."),
			swap("s-1", "t-1", "u-1"),
		);
		expect(a).not.toEqual(b);
	});
});
