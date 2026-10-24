import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { EventCategory } from "../../../shared/types.js";
import "./__test_db.js";
import {
	seedEvent,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedSession,
} from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { parseDbTimestamp } = await import("../util/db-time.js");
const { controlActions, events, sessions } = await import("../../db/schema/index.js");
const {
	SESSION_END_EVENT_TYPES,
	TURN_END_EVENT_TYPES,
	TURN_START_EVENT_TYPES,
	boundaryOf,
	computeTurnKey,
	isTurnStale,
	isValidTurnId,
} = await import("./turn-identity.js");

/** Every category. The record form makes a new EventCategory a compile error here until it is listed. */
const CATEGORY_FLAGS: Record<EventCategory, true> = {
	prompt: true,
	assistant_message: true,
	progress_update: true,
	plan_update: true,
	tool_event: true,
	status_update: true,
	system_event: true,
	permission_event: true,
	user_ack: true,
	ai_proposal_pending: true,
	ai_proposal: true,
	ai_report: true,
	ai_hitl_request: true,
	ai_hitl_response: true,
	ai_continue_sent: true,
	ai_continue_blocked: true,
	ai_error: true,
};
const EVENT_CATEGORIES = Object.keys(CATEGORY_FLAGS) as EventCategory[];

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(controlActions);
	await getDb().delete(events);
	await getDb().delete(sessions);
});

let n = 0;
async function session(agentType: "claude_code" | "codex_cli" = "claude_code") {
	n += 1;
	const sessionId = `ti-${n}-${crypto.randomUUID().slice(0, 6)}`;
	await seedSession(sessionId, { agentType });
	return { sessionId, agentType };
}

describe("boundaryOf", () => {
	test("the listed event types map to their boundary by set equality, whatever the category", () => {
		const mapped = new Map<string, string>();
		const types = [...TURN_END_EVENT_TYPES, ...SESSION_END_EVENT_TYPES, ...TURN_START_EVENT_TYPES];
		for (const eventType of types) {
			const boundaries = new Set<string | null>();
			for (const category of [null, ...EVENT_CATEGORIES.filter((c) => !c.startsWith("ai_"))]) {
				boundaries.add(boundaryOf({ eventType, category }));
			}
			expect(boundaries.size, eventType).toBe(1);
			mapped.set(eventType, [...boundaries][0] as string);
		}
		expect(new Set([...mapped].filter(([, b]) => b === "turn_end").map(([t]) => t))).toEqual(
			new Set([
				"Stop",
				"HeadlessTaskCompleted",
				"HeadlessTaskFailed",
				"HeadlessPromptCompleted",
				"HeadlessPromptFailed",
			]),
		);
		expect(new Set([...mapped].filter(([, b]) => b === "session_end").map(([t]) => t))).toEqual(
			new Set(["SessionEnd", "ManagedSessionStopped"]),
		);
		expect(new Set([...mapped].filter(([, b]) => b === "turn_start").map(([t]) => t))).toEqual(
			new Set(["UserPromptSubmit", "HeadlessPromptSubmitted", "InteractivePromptSubmitted"]),
		);
		// Named members.
		expect(boundaryOf({ eventType: "HeadlessPromptCompleted", category: "system_event" })).toBe(
			"turn_end",
		);
		expect(boundaryOf({ eventType: "InteractivePromptSubmitted", category: "prompt" })).toBe(
			"turn_start",
		);
	});

	test("everything else is null, and every ai_ category is null even under a boundary's name", () => {
		for (const eventType of [
			"PreToolUse",
			"PostToolUse",
			"Interrupt",
			"SubagentStop",
			"AiReport",
			"Notification",
		]) {
			expect(boundaryOf({ eventType, category: "tool_event" }), eventType).toBeNull();
		}
		const aiCategories = EVENT_CATEGORIES.filter((c) => c.startsWith("ai_"));
		expect(aiCategories.length).toBe(8);
		for (const category of aiCategories) {
			expect(boundaryOf({ eventType: "Stop", category }), category).toBeNull();
			expect(boundaryOf({ eventType: "AiContinueSent", category }), category).toBeNull();
		}
	});
});

describe("isValidTurnId", () => {
	test("a short token is valid; spaces, 129 characters and non-strings are not", () => {
		expect(isValidTurnId("turn_1.a:b-2")).toBe(true);
		expect(isValidTurnId("a".repeat(128))).toBe(true);
		expect(isValidTurnId("a".repeat(129))).toBe(false);
		expect(isValidTurnId("has space")).toBe(false);
		expect(isValidTurnId("")).toBe(false);
		expect(isValidTurnId(5)).toBe(false);
		expect(isValidTurnId(null)).toBe(false);
	});
});

describe("computeTurnKey", () => {
	test("a Claude Stop keys by the prompt that started its turn; a planted turn_id is ignored", async () => {
		const s = await session("claude_code");
		const promptId = await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
		});
		const forged = await seedEvent(s.sessionId, {
			eventType: "Stop",
			category: "system_event",
			rawPayload: { turn_id: "T9" },
		});
		expect(await computeTurnKey(getDb(), s, { id: forged })).toBe(`p:${promptId}`);
	});

	test("the same Stop on a Codex session keys by its own turn_id; a 129-character or spaced id is ignored there too", async () => {
		const s = await session("codex_cli");
		const promptId = await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
		});
		const stop = await seedEvent(s.sessionId, {
			eventType: "Stop",
			category: "system_event",
			rawPayload: { turn_id: "T9" },
		});
		expect(await computeTurnKey(getDb(), s, { id: stop })).toBe("t:T9");
		for (const bad of ["x".repeat(129), "has space"]) {
			const id = await seedEvent(s.sessionId, {
				eventType: "Stop",
				category: "system_event",
				rawPayload: { turn_id: bad },
			});
			expect(await computeTurnKey(getDb(), s, { id })).toBe(`p:${promptId}`);
		}
	});

	test("a Codex prompt's turn_id keys a Stop that carries none", async () => {
		const s = await session("codex_cli");
		await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
			rawPayload: { turn_id: "T1" },
		});
		const stop = await seedEvent(s.sessionId, { eventType: "Stop", category: "system_event" });
		expect(await computeTurnKey(getDb(), s, { id: stop })).toBe("t:T1");
	});

	test("a managed turn keys by whichever prompt event is newest before it, and a launch turn is p:0", async () => {
		const s = await session();
		const launchEnd = await seedEvent(s.sessionId, {
			eventType: "HeadlessTaskCompleted",
			category: "system_event",
		});
		expect(await computeTurnKey(getDb(), s, { id: launchEnd })).toBe("p:0");
		const hookPrompt = await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
		});
		const submitted = await seedEvent(s.sessionId, {
			eventType: "HeadlessPromptSubmitted",
			category: "prompt",
		});
		const completed = await seedEvent(s.sessionId, {
			eventType: "HeadlessPromptCompleted",
			category: "system_event",
		});
		const stop = await seedEvent(s.sessionId, { eventType: "Stop", category: "system_event" });
		expect(hookPrompt).toBeLessThan(submitted);
		expect(await computeTurnKey(getDb(), s, { id: completed })).toBe(`p:${submitted}`);
		// The hook's own Stop for the same turn resolves to the same key.
		expect(await computeTurnKey(getDb(), s, { id: stop })).toBe(`p:${submitted}`);
	});

	test("a SessionEnd after a Stop, with no new prompt, keys the same", async () => {
		const s = await session();
		const turn = await seedFinishedTurn(s.sessionId);
		const end = await seedEvent(s.sessionId, { eventType: "SessionEnd", category: "system_event" });
		expect(await computeTurnKey(getDb(), s, { id: end })).toBe(turn.turnKey);
	});
});

describe("isTurnStale", () => {
	async function finished(agentType: "claude_code" | "codex_cli" = "claude_code") {
		const s = await session(agentType);
		const turn = await seedFinishedTurn(s.sessionId);
		return { s, ...turn };
	}

	test("a quiet finished turn is current", async () => {
		const t = await finished();
		expect(await isTurnStale(getDb(), t.s, t.turnKey, { id: t.stopId })).toBe(false);
	});

	test("a later prompt, tool start or permission event makes it stale", async () => {
		for (const later of [
			{ eventType: "UserPromptSubmit", category: "prompt" },
			{ eventType: "HeadlessPromptSubmitted", category: "prompt" },
			{ eventType: "PreToolUse", category: "tool_event" },
			{ eventType: "PermissionRequest", category: "permission_event" },
		]) {
			const t = await finished();
			await seedEvent(t.s.sessionId, later);
			expect({
				later: later.eventType,
				stale: await isTurnStale(getDb(), t.s, t.turnKey, { id: t.stopId }),
			}).toEqual({
				later: later.eventType,
				stale: true,
			});
		}
	});

	test("a SessionEnd that follows the Stop does not make the turn stale; a Stop for another turn does", async () => {
		const t = await finished("codex_cli");
		await getDb()
			.update(events)
			.set({ rawPayload: { turn_id: "T1" } })
			.where(eq(events.id, t.stopId));
		const key = "t:T1";
		await seedEvent(t.s.sessionId, {
			eventType: "SessionEnd",
			category: "system_event",
			rawPayload: { turn_id: "T1" },
		});
		expect(await isTurnStale(getDb(), t.s, key, { id: t.stopId })).toBe(false);
		await seedEvent(t.s.sessionId, {
			eventType: "Stop",
			category: "system_event",
			rawPayload: { turn_id: "T3" },
		});
		expect(await isTurnStale(getDb(), t.s, key, { id: t.stopId })).toBe(true);
	});

	test("Codex reorder: a Stop stored after the next turn's prompt is stale", async () => {
		const s = await session("codex_cli");
		await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
			rawPayload: { turn_id: "T1" },
		});
		await seedEvent(s.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
			rawPayload: { turn_id: "T2" },
		});
		const lateStop = await seedEvent(s.sessionId, {
			eventType: "Stop",
			category: "system_event",
			rawPayload: { turn_id: "T1" },
		});
		const key = await computeTurnKey(getDb(), s, { id: lateStop });
		expect(key).toBe("t:T1");
		expect(await isTurnStale(getDb(), s, key, { id: lateStop })).toBe(true);
	});

	test("a working session is stale", async () => {
		const t = await finished();
		await getDb()
			.update(sessions)
			.set({ isWorking: true })
			.where(eq(sessions.sessionId, t.s.sessionId));
		expect(await isTurnStale(getDb(), t.s, t.turnKey, { id: t.stopId })).toBe(true);
	});

	test("a prompt control action created after the trigger makes it stale in any status, and one before it does not", async () => {
		const t = await finished();
		const [stop] = await getDb().select().from(events).where(eq(events.id, t.stopId));
		const stopMs = parseDbTimestamp(stop?.createdAt) as number;
		await getDb()
			.insert(controlActions)
			.values({
				sessionId: t.s.sessionId,
				actionType: "prompt",
				requestedBy: "user",
				status: "completed",
				createdAt: new Date(stopMs - 60_000).toISOString(),
			});
		expect(await isTurnStale(getDb(), t.s, t.turnKey, { id: t.stopId })).toBe(false);
		await getDb()
			.insert(controlActions)
			.values({
				sessionId: t.s.sessionId,
				actionType: "prompt",
				requestedBy: "user",
				status: "failed",
				createdAt: new Date(stopMs + 60_000).toISOString(),
			});
		expect(await isTurnStale(getDb(), t.s, t.turnKey, { id: t.stopId })).toBe(true);
	});

	test("a managed session works the same through its own boundaries", async () => {
		const sessionId = `ti-managed-${crypto.randomUUID().slice(0, 6)}`;
		await seedLiveManagedSession(sessionId);
		const submitted = await seedEvent(sessionId, {
			eventType: "HeadlessPromptSubmitted",
			category: "prompt",
		});
		const completed = await seedEvent(sessionId, {
			eventType: "HeadlessPromptCompleted",
			category: "system_event",
		});
		const s = { sessionId, agentType: "claude_code" };
		const key = await computeTurnKey(getDb(), s, { id: completed });
		expect(key).toBe(`p:${submitted}`);
		expect(await isTurnStale(getDb(), s, key, { id: completed })).toBe(false);
		await seedEvent(sessionId, { eventType: "HeadlessPromptSubmitted", category: "prompt" });
		expect(await isTurnStale(getDb(), s, key, { id: completed })).toBe(true);
	});
});
