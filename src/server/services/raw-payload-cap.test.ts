// Phase 5 growth mitigations (AGEN-16, D13/F29/F40/F56/F76): capping the
// rawPayload copy of tool_response independently of the DB column, and
// dropping the duplicate tool_input copy the toolInput column already
// carries. Every test uses its own session id and filters by it (harness
// rule 1); nothing here assumes an empty DB, so the file is safe on a
// shared Postgres database.

import { beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { processHookEvent, insertNormalizedEvents } = await import("./event-processor.js");
const {
	shapeHookRawPayload,
	createAssistantTranscriptEvent,
	normalizeStatusEvents,
	TOOL_RESPONSE_COLUMN_CHAR_CAP,
	TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP,
} = await import("./event-normalizer.js");
const { eq } = await import("drizzle-orm");

import type { HookEventPayload } from "../../shared/types.js";

beforeAll(() => initializeDatabase());

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
		})
		.execute();
}

async function storedRow(sessionId: string, eventType: string) {
	const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	const row = rows.find((r) => r.eventType === eventType);
	if (!row) {
		throw new Error(
			`no ${eventType} row for ${sessionId} (have: ${rows.map((r) => r.eventType).join(",")})`,
		);
	}
	return row;
}

describe("rawPayload.tool_response cap for hook tool rows (G1-G4)", () => {
	test("G1: a PostToolUse with a 10,000-char tool_response is capped at 4096 in rawPayload, flagged, and the column stays capped at 2000", async () => {
		const sid = newSessionId("g1");
		const big = "x".repeat(10_000);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g1",
				tool_response: big,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect((rawPayload.tool_response as string).length).toBe(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		expect(rawPayload.tool_response_truncated).toBe(true);
		expect(rawPayload.tool_response_chars).toBe(10_000);
		expect(row.toolResponse?.length).toBe(TOOL_RESPONSE_COLUMN_CHAR_CAP);
	});

	test("G1b: the same for PostToolUseFailure", async () => {
		const sid = newSessionId("g1b");
		const big = "y".repeat(10_000);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUseFailure",
				tool_name: "Bash",
				tool_use_id: "tu-g1b",
				tool_response: big,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUseFailure");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect((rawPayload.tool_response as string).length).toBe(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		expect(rawPayload.tool_response_truncated).toBe(true);
		expect(rawPayload.tool_response_chars).toBe(10_000);
		expect(row.toolResponse?.length).toBe(TOOL_RESPONSE_COLUMN_CHAR_CAP);
	});

	test("G2: an object tool_response whose serialized JSON exceeds the cap is capped, with the full serialized length recorded", async () => {
		const sid = newSessionId("g2");
		const obj = { output: "z".repeat(4_990) };
		const serializedLength = JSON.stringify(obj).length;
		expect(serializedLength).toBeGreaterThan(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g2",
				tool_response: obj,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload.tool_response).toBe(
			JSON.stringify(obj).slice(0, TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP),
		);
		expect((rawPayload.tool_response as string).length).toBe(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		expect(rawPayload.tool_response_truncated).toBe(true);
		expect(rawPayload.tool_response_chars).toBe(serializedLength);
	});

	test("G3: exactly 4096 chars is unchanged, with no flags", async () => {
		const sid = newSessionId("g3a");
		const exact = "a".repeat(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g3a",
				tool_response: exact,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload.tool_response).toBe(exact);
		expect(rawPayload).not.toHaveProperty("tool_response_truncated");
		expect(rawPayload).not.toHaveProperty("tool_response_chars");
	});

	test("G3: 4097 chars is capped", async () => {
		const sid = newSessionId("g3b");
		const over = "b".repeat(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP + 1);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g3b",
				tool_response: over,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect((rawPayload.tool_response as string).length).toBe(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
		expect(rawPayload.tool_response_truncated).toBe(true);
		expect(rawPayload.tool_response_chars).toBe(TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP + 1);
	});

	test("G4: PreToolUse is not capped", async () => {
		const sid = newSessionId("g4-pre");
		const big = "c".repeat(10_000);
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g4",
				tool_response: big,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PreToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload.tool_response).toBe(big);
		expect(rawPayload).not.toHaveProperty("tool_response_truncated");
	});

	test("G4: UserPromptSubmit is not capped", async () => {
		const sid = newSessionId("g4-prompt");
		const payload: HookEventPayload = {
			session_id: sid,
			hook_event_name: "UserPromptSubmit",
			prompt: "hello",
		};
		await processHookEvent(payload, "claude_code");
		const row = await storedRow(sid, "UserPromptSubmit");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload).not.toHaveProperty("tool_response_truncated");
		expect(rawPayload).toEqual(payload as unknown as Record<string, unknown>);
	});

	test("G4: transcript rows are not capped", async () => {
		const sid = newSessionId("g4-transcript");
		await mkSession(sid);
		const big = "d".repeat(10_000);
		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent(big, { tool_response: big }, "claude_transcript_text"),
		]);
		const row = await storedRow(sid, "TranscriptAssistantMessage");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload.tool_response).toBe(big);
	});
});

describe("shapeHookRawPayload never mutates its input (G7)", () => {
	test("G7: p is deep-equal to a clone after shaping, including p.tool_input", () => {
		const p: HookEventPayload = {
			session_id: "g7",
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "tu-g7",
			tool_input: { command: "ls" },
			tool_response: "y".repeat(5_000),
		};
		const clone = structuredClone(p);

		shapeHookRawPayload(p, "PostToolUse");

		expect(p).toEqual(clone);
		expect(p.tool_input).toEqual(clone.tool_input);
	});
});

describe("rawPayload drops the duplicate tool_input for hook tool/permission rows (G8-G10)", () => {
	test("G8: a hook PostToolUse has no tool_input key, a tool_input_in_column marker, and the toolInput column matches; tool_use_id is preserved", async () => {
		const sid = newSessionId("g8");
		const toolInput = { command: "ls -la" };
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tu-g8",
				tool_input: toolInput,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PostToolUse");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload).not.toHaveProperty("tool_input");
		expect(rawPayload.tool_input_in_column).toBe(true);
		expect(row.toolInput).toEqual(toolInput);
		expect(rawPayload.tool_use_id).toBe("tu-g8");
	});

	test("G9: the same for PermissionRequest", async () => {
		const sid = newSessionId("g9");
		const toolInput = { file_path: "/etc/passwd" };
		await processHookEvent(
			{
				session_id: sid,
				hook_event_name: "PermissionRequest",
				tool_name: "Read",
				tool_use_id: "tu-g9",
				tool_input: toolInput,
			},
			"claude_code",
		);
		const row = await storedRow(sid, "PermissionRequest");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload).not.toHaveProperty("tool_input");
		expect(rawPayload.tool_input_in_column).toBe(true);
		expect(row.toolInput).toEqual(toolInput);
		expect(rawPayload.tool_use_id).toBe("tu-g9");
	});

	test("G10: UserPromptSubmit is unchanged, with no marker", async () => {
		const sid = newSessionId("g10-prompt");
		const payload: HookEventPayload = {
			session_id: sid,
			hook_event_name: "UserPromptSubmit",
			prompt: "hi there",
		};
		await processHookEvent(payload, "claude_code");
		const row = await storedRow(sid, "UserPromptSubmit");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload).not.toHaveProperty("tool_input_in_column");
		expect(rawPayload).toEqual(payload as unknown as Record<string, unknown>);
	});

	test("G10: a status row is unchanged, with no marker", async () => {
		const sid = newSessionId("g10-status");
		await mkSession(sid);
		const [statusEvent] = normalizeStatusEvents({ session_id: sid, status: "implementing" });
		await insertNormalizedEvents(sid, [statusEvent]);
		const row = await storedRow(sid, "SemanticStatusUpdate");
		const rawPayload = row.rawPayload as Record<string, unknown>;
		expect(rawPayload).not.toHaveProperty("tool_input_in_column");
	});
});
