/**
 * AGEN-123: when a row of a continued session can offer "Details", and what the panel says.
 */
import { describe, expect, test } from "bun:test";
import type { ForkToolCallDto } from "../../../shared/fork-tool-calls.js";
import {
	DETAIL_BUTTON,
	NOT_CAPTURED_AFTER_MS,
	accessNote,
	adminOnOthersLine,
	callRowToolUseId,
	detailButtonLabel,
	indexCalls,
	missingDetailState,
	turnCallIds,
	turnEndedAtMs,
} from "./fork-detail-availability.js";

let id = 0;
const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const row = (kind: string, toolUseId: string | null, seconds = 0, over = {}) => ({
	id: ++id,
	eventType: "HeadlessStatus",
	createdAt: at(seconds),
	rawPayload: { source: "claude_stream", kind, ...(toolUseId ? { tool_use_id: toolUseId } : {}) },
	...over,
});
const marker = (eventType: string, seconds: number) => ({
	id: ++id,
	eventType,
	createdAt: at(seconds),
	rawPayload: {},
});
const record = (toolUseId: string, outcome = "unasked"): ForkToolCallDto => ({
	toolUseId,
	tool: "Bash",
	outcome,
	fromSubagent: false,
	input: null,
	inputTruncated: false,
	output: null,
	outputTruncated: false,
	redacted: false,
	createdAt: at(0),
});

describe("which row is a call's row", () => {
	test("only a per-call row of the fork's stream with a tool-use id", () => {
		expect(callRowToolUseId(row("call", "toolu_1"))).toBe("toolu_1");
		expect(callRowToolUseId(row("turn_unasked", null))).toBeNull();
		expect(callRowToolUseId(row("call", null))).toBeNull();
		expect(
			callRowToolUseId(row("call", "toolu_1", 0, { eventType: "HeadlessAssistantMessage" })),
		).toBeNull();
		expect(
			callRowToolUseId({
				eventType: "HeadlessStatus",
				createdAt: at(0),
				rawPayload: { source: "x", kind: "call", tool_use_id: "t" },
			}),
		).toBeNull();
		expect(callRowToolUseId({ eventType: "HeadlessStatus", createdAt: at(0) })).toBeNull();
	});
});

describe("a turn's calls, found from the rows between its boundaries", () => {
	const events = [
		marker("HeadlessPromptSubmitted", 0),
		row("call", "toolu_old", 1),
		row("turn_unasked", null, 2),
		marker("HeadlessPromptCompleted", 3),
		marker("HeadlessPromptSubmitted", 10),
		row("call", "toolu_a", 11),
		row("call", "toolu_b", 12),
		row("turn_unasked", null, 13),
		marker("HeadlessPromptCompleted", 14),
	];

	test("the summary row of the second turn lists that turn's calls, in order, and none of the first's", () => {
		expect(turnCallIds(events, 7)).toEqual(["toolu_a", "toolu_b"]);
		expect(turnCallIds(events, 2)).toEqual(["toolu_old"]);
	});

	test("a summary row with no call rows before it, back to the boundary, lists none", () => {
		expect(
			turnCallIds([marker("HeadlessPromptSubmitted", 0), row("turn_unasked", null, 1)], 1),
		).toEqual([]);
	});

	test("the end of a row's turn is the next end event; with none it is running, or over if the session isn't working", () => {
		expect(turnEndedAtMs(events, 5, true)).toBe(T0 + 14_000);
		expect(turnEndedAtMs(events, 1, true)).toBe(T0 + 3_000);
		const running = [marker("HeadlessPromptSubmitted", 0), row("call", "toolu_x", 1)];
		expect(turnEndedAtMs(running, 1, true)).toBeNull();
		expect(turnEndedAtMs(running, 1, false)).toBe(T0 + 1_000);
		// A later turn's start is not this turn's end.
		const nextStarted = [row("call", "toolu_y", 1), marker("HeadlessPromptSubmitted", 5)];
		expect(turnEndedAtMs(nextStarted, 0, true)).toBeNull();
	});
});

describe("ordering: a row before its detail, then the detail", () => {
	test("while the turn runs there is no control and no 'not captured'; after a refetch that finds it, there is a record", () => {
		const events = [marker("HeadlessPromptSubmitted", 0), row("call", "toolu_1", 1)];
		const before = indexCalls([]);
		expect(before.get("toolu_1")).toBeUndefined();
		// Running: the end isn't known, so a missing read says "arriving", never "not captured".
		const endedAt = turnEndedAtMs(events, 1, true);
		expect(endedAt).toBeNull();
		expect(missingDetailState(endedAt, T0 + 3_600_000)).toBe("arriving");
		const after = indexCalls([record("toolu_1")]);
		expect(after.get("toolu_1")?.tool).toBe("Bash");
	});

	test("'not captured' is said only for a turn that ended more than 60 s earlier", () => {
		expect(missingDetailState(T0, T0 + NOT_CAPTURED_AFTER_MS)).toBe("arriving");
		expect(missingDetailState(T0, T0 + NOT_CAPTURED_AFTER_MS + 1)).toBe("not_captured");
		expect(missingDetailState(T0, T0 + 5_000)).toBe("arriving");
		expect(missingDetailState(Number.NaN, T0)).toBe("arriving");
	});

	test("a record seen twice keeps the first", () => {
		const first = record("toolu_1", "unasked");
		const again = { ...record("toolu_1", "failed") };
		expect(indexCalls([first, again]).get("toolu_1")?.outcome).toBe("unasked");
	});
});

describe("words", () => {
	test("the control and its accessible name", () => {
		expect(DETAIL_BUTTON).toBe("Details");
		expect(detailButtonLabel("Bash")).toBe("Show what Bash ran");
	});

	test("an admin on someone else's session is told whose; an unowned one says so; the owner gets no note", () => {
		expect(adminOnOthersLine("Ana")).toBe(
			"This is Ana's session. Only they and admins can see this.",
		);
		expect(adminOnOthersLine(null)).toBe("This session has no owner. Only admins can see this.");
		expect(accessNote("admin_on_others", "Ana")).toBe(adminOnOthersLine("Ana"));
		expect(accessNote("allowed", "Ana")).toBeNull();
		expect(accessNote("allowed", null)).toBeNull();
	});
});
