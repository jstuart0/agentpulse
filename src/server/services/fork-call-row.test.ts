/** AGEN-122 (F14, F51): the per-kind whitelist for a fork row's payload. Pure; no database. */
import { describe, expect, test } from "bun:test";
import { FORK_CALL_OUTCOMES, FORK_TOOL_NAMES } from "../../shared/claude-fork-copy.js";
import { normalizeForkRowPayload } from "./fork-call-row.js";

const MARKED = { source: "claude_stream", claudeStreamRuntime: true } as const;
const EXTRAS = {
	command: "cat /etc/passwd",
	toolInput: { command: "x" },
	file_path: "/secret",
	output: "token=abc",
};

describe("normalizeForkRowPayload", () => {
	test("a payload without the marker is returned as it came", () => {
		const raw = { source: "other", command: "kept" };
		expect(normalizeForkRowPayload(raw)).toBe(raw);
		expect(normalizeForkRowPayload({ claudeStreamRuntime: "true", command: "x" })).toEqual({
			claudeStreamRuntime: "true",
			command: "x",
		});
	});

	test("a call row keeps its five keys and the three every kind keeps, nothing else", () => {
		const call = {
			...MARKED,
			kind: "call",
			tool: "Bash",
			toolOutcome: "failed",
			is_error: true,
			exit_code: 3,
			tool_use_id: "toolu_01AbC-_9",
		};
		expect(normalizeForkRowPayload({ ...call, ...EXTRAS })).toEqual(call);
	});

	test("every outcome and every tool name survives; mcp does; others do not", () => {
		for (const toolOutcome of FORK_CALL_OUTCOMES) {
			expect(normalizeForkRowPayload({ ...MARKED, kind: "call", toolOutcome }).toolOutcome).toBe(
				toolOutcome,
			);
		}
		for (const tool of [...FORK_TOOL_NAMES, "mcp"]) {
			expect(normalizeForkRowPayload({ ...MARKED, kind: "call", tool }).tool).toBe(tool);
		}
		for (const tool of ["mcp__server__tool", "Agent", "", 3, null]) {
			expect(normalizeForkRowPayload({ ...MARKED, kind: "call", tool })).not.toHaveProperty("tool");
		}
		expect(
			normalizeForkRowPayload({ ...MARKED, kind: "call", toolOutcome: "ran-ok" }),
		).not.toHaveProperty("toolOutcome");
	});

	test("type checks: exit_code an integer in [0, 255], tool_use_id 1 to 64 safe characters, is_error a boolean", () => {
		const exit = (exit_code: unknown) =>
			normalizeForkRowPayload({ ...MARKED, kind: "call", exit_code });
		for (const ok of [0, 1, 255]) expect(exit(ok).exit_code).toBe(ok);
		for (const bad of [
			-1,
			256,
			300,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"3",
			null,
			[3],
			{ n: 3 },
		]) {
			expect(exit(bad), String(bad)).not.toHaveProperty("exit_code");
		}
		const id = (tool_use_id: unknown) =>
			normalizeForkRowPayload({ ...MARKED, kind: "call", tool_use_id });
		expect(id("a".repeat(64)).tool_use_id).toBe("a".repeat(64));
		for (const bad of ["", "a".repeat(65), "has space", "a/b", "a\nb", 7, null]) {
			expect(id(bad), String(bad)).not.toHaveProperty("tool_use_id");
		}
		expect(
			normalizeForkRowPayload({ ...MARKED, kind: "call", is_error: "true" }),
		).not.toHaveProperty("is_error");
		expect(normalizeForkRowPayload({ ...MARKED, kind: "call", is_error: false }).is_error).toBe(
			false,
		);
	});

	test("turn_unasked and turn_refused keep only the three", () => {
		for (const kind of ["turn_unasked", "turn_refused"]) {
			expect(
				normalizeForkRowPayload({
					...MARKED,
					kind,
					...EXTRAS,
					tool: "Bash",
					toolOutcome: "failed",
				}),
			).toEqual({
				...MARKED,
				kind,
			});
		}
	});

	test("an unknown kind keeps only source, kind and the marker", () => {
		expect(
			normalizeForkRowPayload({ ...MARKED, kind: "future_kind", ...EXTRAS, status: "completed" }),
		).toEqual({
			...MARKED,
			kind: "future_kind",
		});
		// A kind that is not a short word is dropped, the rest of the row still stores.
		expect(normalizeForkRowPayload({ ...MARKED, kind: "x y/z", ...EXTRAS })).toEqual({ ...MARKED });
		expect(normalizeForkRowPayload({ ...MARKED, kind: { a: 1 }, ...EXTRAS })).toEqual({
			...MARKED,
		});
	});

	test("a turn or lifecycle event (no kind) keeps its status and code as short words", () => {
		expect(
			normalizeForkRowPayload({ claudeStreamRuntime: true, status: "turn_error", ...EXTRAS }),
		).toEqual({
			claudeStreamRuntime: true,
			status: "turn_error",
		});
		expect(
			normalizeForkRowPayload({
				...MARKED,
				status: "interrupted",
				code: "interrupted_before_send",
			}),
		).toEqual({ ...MARKED, status: "interrupted", code: "interrupted_before_send" });
		expect(normalizeForkRowPayload({ ...MARKED, status: "has a command in it: rm -rf /" })).toEqual(
			{ ...MARKED },
		);
	});

	test("a source that is not a short word is dropped", () => {
		expect(
			normalizeForkRowPayload({ claudeStreamRuntime: true, kind: "call", source: "a b" }),
		).toEqual({
			claudeStreamRuntime: true,
			kind: "call",
		});
	});
});
