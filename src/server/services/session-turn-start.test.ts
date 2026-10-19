/**
 * `currentTurnStartedAt`: when the turn now in progress began.
 *
 *   UserPromptSubmit     starts a turn (its time)
 *   PreToolUse           starts one only when none is under way (a tool event inside a turn keeps its start)
 *   Stop / Interrupt     end it (null)
 *   SessionEnd, failure  end it (null)
 *   the stuck-working sweep ends it too
 *
 * Runs on both dialects. The value rides on every session row, so the socket frame carries it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { markSessionFailed, processHookEvent } = await import("./event-processor.js");
const { updateStaleSessions } = await import("./session-tracker.js");
const { sessionBus } = await import("./notifier.js");

import type { HookEventPayload } from "../../shared/types.js";

const originalDisableAuth = config.disableAuth;
beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

const hook = (session_id: string, hook_event_name: string, extra: Partial<HookEventPayload> = {}) =>
	({ session_id, hook_event_name, cwd: "/home/u/repo", ...extra }) as HookEventPayload;

async function turnStart(sessionId: string): Promise<string | null | undefined> {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row?.currentTurnStartedAt;
}

describe("the turn's start follows the working state", () => {
	test("a new session has no turn", async () => {
		await processHookEvent(hook("t1", "SessionStart"), "claude_code");
		expect(await turnStart("t1")).toBeNull();
	});

	test("a prompt starts a turn at its own time; Stop ends it", async () => {
		const before = Date.now();
		await processHookEvent(hook("t2", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		const started = await turnStart("t2");
		expect(typeof started).toBe("string");
		expect(Date.parse(started as string)).toBeGreaterThanOrEqual(before - 1);
		expect(Date.parse(started as string)).toBeLessThanOrEqual(Date.now());

		await processHookEvent(hook("t2", "Stop"), "claude_code");
		expect(await turnStart("t2")).toBeNull();
	});

	test("a tool event inside the turn keeps the start the prompt gave it", async () => {
		await processHookEvent(hook("t3", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		const started = await turnStart("t3");
		await Bun.sleep(15);
		await processHookEvent(hook("t3", "PreToolUse", { tool_name: "Read" }), "claude_code");
		await processHookEvent(hook("t3", "PostToolUse", { tool_name: "Read" }), "claude_code");
		expect(await turnStart("t3")).toBe(started as string);
	});

	test("a tool event with no prompt before it (an agent that sends none) starts the turn", async () => {
		await processHookEvent(hook("t4", "SessionStart"), "claude_code");
		await processHookEvent(hook("t4", "PreToolUse", { tool_name: "Read" }), "claude_code");
		expect(typeof (await turnStart("t4"))).toBe("string");
	});

	test("a new prompt after Stop starts a new turn, later than the first", async () => {
		await processHookEvent(hook("t5", "UserPromptSubmit", { prompt: "one" }), "claude_code");
		const first = await turnStart("t5");
		await processHookEvent(hook("t5", "Stop"), "claude_code");
		await Bun.sleep(15);
		await processHookEvent(hook("t5", "UserPromptSubmit", { prompt: "two" }), "claude_code");
		const second = await turnStart("t5");
		expect(Date.parse(second as string)).toBeGreaterThan(Date.parse(first as string));
	});

	test("Interrupt ends the turn", async () => {
		await processHookEvent(hook("t6", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		await processHookEvent(hook("t6", "Interrupt"), "claude_code");
		expect(await turnStart("t6")).toBeNull();
	});

	test("SessionEnd ends the turn", async () => {
		await processHookEvent(hook("t7", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		await processHookEvent(hook("t7", "SessionEnd"), "claude_code");
		expect(await turnStart("t7")).toBeNull();
	});

	test("a failed launch ends the turn", async () => {
		await processHookEvent(hook("t8", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		await markSessionFailed("t8");
		expect(await turnStart("t8")).toBeNull();
	});

	test("the stuck-working sweep clears a turn nothing has touched for hours", async () => {
		await processHookEvent(hook("t9", "UserPromptSubmit", { prompt: "go" }), "claude_code");
		const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		await getDb()
			.update(sessions)
			.set({ lastActivityAt: longAgo })
			.where(eq(sessions.sessionId, "t9"));
		await updateStaleSessions();
		expect(await turnStart("t9")).toBeNull();
	});
});

describe("the socket frame carries it", () => {
	test("the update a hook causes is broadcast with currentTurnStartedAt", async () => {
		const { app } = await import("../app.js");
		const seen: Array<Record<string, unknown>> = [];
		const listener = (session: unknown) => seen.push(session as Record<string, unknown>);
		sessionBus.on("session_updated", listener as never);
		sessionBus.on("session_created", listener as never);
		try {
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(hook("t10", "UserPromptSubmit", { prompt: "go" })),
			});
			expect(res.status).toBe(200);
			for (let i = 0; i < 200 && !seen.some((s) => s.sessionId === "t10"); i++) await Bun.sleep(10);
		} finally {
			sessionBus.off("session_updated", listener as never);
			sessionBus.off("session_created", listener as never);
		}
		const frame = seen.filter((s) => s.sessionId === "t10").at(-1);
		expect(frame).toBeDefined();
		expect(typeof frame?.currentTurnStartedAt).toBe("string");
	});
});
