import { describe, expect, test } from "bun:test";
import { compactEvent, compactRawPayload } from "./event-compact.js";

describe("compactRawPayload: the six members a phone reads, nothing else", () => {
	test("reads the hook's duration and a top-level outcome", () => {
		expect(
			compactRawPayload({ duration_ms: 1520, exit_code: 2, success: false, interrupted: true }),
		).toEqual({ duration_ms: 1520, exit_code: 2, success: false, interrupted: true });
	});

	test("accepts the camel-case spellings and emits the one normalised name", () => {
		expect(compactRawPayload({ durationMs: 40, exitCode: 0 })).toEqual({
			duration_ms: 40,
			exit_code: 0,
		});
	});

	test("lifts the outcome from a JSON tool response, top level or under metadata", () => {
		expect(
			compactRawPayload({ tool_response: JSON.stringify({ stdout: "x", exit_code: 1 }) }),
		).toEqual({ exit_code: 1 });
		expect(
			compactRawPayload({
				tool_response: JSON.stringify({ metadata: { exit_code: 7 }, is_error: true }),
			}),
		).toEqual({ exit_code: 7, is_error: true });
		expect(
			compactRawPayload({ tool_response: JSON.stringify({ interrupted: false, stdout: "" }) }),
		).toEqual({ interrupted: false });
	});

	test("a top-level member wins over the tool response", () => {
		expect(
			compactRawPayload({ exit_code: 0, tool_response: JSON.stringify({ exit_code: 9 }) }),
		).toEqual({ exit_code: 0 });
	});

	test("everything else is dropped, whatever its size or type", () => {
		expect(
			compactRawPayload({
				transcript_path: "/work/session/t.jsonl",
				cwd: "/work",
				tool_response: "plain text with exit_code 4",
				prompt: "p".repeat(50_000),
				nested: { duration_ms: 5 },
			}),
		).toBeUndefined();
	});

	test("members of the wrong type are ignored, not coerced", () => {
		expect(
			compactRawPayload({
				duration_ms: "1520",
				exit_code: 1.5,
				success: "yes",
				interrupted: 1,
				is_error: null,
			}),
		).toBeUndefined();
		expect(compactRawPayload({ duration_ms: -3 })).toBeUndefined();
		expect(compactRawPayload({ duration_ms: Number.POSITIVE_INFINITY })).toBeUndefined();
	});

	test("a tool response over the raw copy's cap, or one that is not an object, is not parsed", () => {
		const huge = JSON.stringify({ exit_code: 3, pad: "x".repeat(5000) });
		expect(compactRawPayload({ tool_response: huge })).toBeUndefined();
		expect(compactRawPayload({ tool_response: "[1,2]" })).toBeUndefined();
		expect(compactRawPayload({ tool_response: '{"exit_code": 3' })).toBeUndefined();
	});

	test("tool_use_id pairs a Pre and a Post event: kept when it is 1 to 64 characters, left out (never cut) otherwise", () => {
		expect(compactRawPayload({ tool_use_id: "toolu_01ABC" })).toEqual({
			tool_use_id: "toolu_01ABC",
		});
		const edge = "t".repeat(64);
		expect(compactRawPayload({ tool_use_id: edge })).toEqual({ tool_use_id: edge });
		expect(compactRawPayload({ tool_use_id: "t".repeat(65) })).toBeUndefined();
		for (const bad of ["", 5, null, { id: "x" }, ["x"]]) {
			expect(compactRawPayload({ tool_use_id: bad })).toBeUndefined();
		}
	});

	test("exit_code must be a safe integer; an unsafe one is ignored, and the next source is tried", () => {
		expect(compactRawPayload({ exit_code: 2 ** 53 })).toBeUndefined();
		expect(compactRawPayload({ exit_code: Number.MAX_SAFE_INTEGER })).toEqual({
			exit_code: Number.MAX_SAFE_INTEGER,
		});
		expect(compactRawPayload({ exit_code: 2 ** 53 + 2, exitCode: 4 })).toEqual({ exit_code: 4 });
		expect(
			compactRawPayload({ tool_response: JSON.stringify({ exit_code: 1e300 }) }),
		).toBeUndefined();
	});

	test("duration_ms is held to 2^31 - 1; the cap itself and anything below pass through", () => {
		expect(compactRawPayload({ duration_ms: 2 ** 31 - 1 })).toEqual({ duration_ms: 2 ** 31 - 1 });
		expect(compactRawPayload({ duration_ms: 2 ** 31 })).toEqual({ duration_ms: 2 ** 31 - 1 });
		expect(compactRawPayload({ duration_ms: 1e300 })).toEqual({ duration_ms: 2 ** 31 - 1 });
		expect(compactRawPayload({ duration_ms: 0 })).toEqual({ duration_ms: 0 });
		expect(compactRawPayload({ duration_ms: 12.5 })).toEqual({ duration_ms: 12.5 });
	});

	test("not an object: nothing", () => {
		for (const raw of [null, undefined, "text", 5, [{ duration_ms: 1 }]]) {
			expect(compactRawPayload(raw)).toBeUndefined();
		}
	});

	test("the subset is bounded: even a payload carrying every member stays under 200 bytes", () => {
		const subset = compactRawPayload({
			tool_use_id: "u".repeat(64),
			duration_ms: 123_456_789,
			exit_code: -2_147_483_648,
			success: false,
			interrupted: false,
			is_error: false,
		});
		expect(JSON.stringify(subset).length).toBeLessThan(200);
	});
});

describe("compactEvent and rawPayload", () => {
	test("the event carries only the subset; the input is untouched", () => {
		const event = {
			id: 1,
			content: "c",
			rawPayload: { duration_ms: 12, exit_code: 0, secret: "s".repeat(10_000) },
		};
		const compact = compactEvent(event);
		expect(compact.rawPayload).toEqual({ duration_ms: 12, exit_code: 0 });
		expect(event.rawPayload.secret).toHaveLength(10_000);
	});

	test("with nothing to keep, rawPayload is not in the event at all", () => {
		const compact = compactEvent({ id: 1, rawPayload: { cwd: "/work" } });
		expect("rawPayload" in compact).toBe(false);
		expect("rawPayload" in compactEvent({ id: 2 })).toBe(false);
	});
});
