/**
 * AGEN-69 phase 3 review fixes (P3-9, P3-10): a stored tool response is text, or
 * a JSON object cut at 2,000 characters whose newlines are the two characters
 * backslash-n. `readResponse` gives the real text and an exit code when the
 * response carries one.
 */
import { describe, expect, test } from "bun:test";
import { validationResult } from "./command-class.js";
import { readResponse } from "./response-text.js";

describe("P3-10 JSON-shaped responses", () => {
	test("a Claude Bash object: stdout then stderr, real newlines", () => {
		const stored = JSON.stringify({
			stdout: "a\nFAIL src/x.test.ts\nb",
			stderr: "warn",
			interrupted: false,
		});
		expect(readResponse(stored).text).toBe("a\nFAIL src/x.test.ts\nb\nwarn");
	});
	test("output and error keys are read too", () => {
		expect(readResponse(JSON.stringify({ output: "o1\no2" })).text).toBe("o1\no2");
		expect(readResponse(JSON.stringify({ error: "denied" })).text).toBe("denied");
	});
	test("an object cut at 2,000 characters in the middle of a string is still read", () => {
		const whole = JSON.stringify({ stdout: `${"line\n".repeat(600)}FAIL late`, stderr: "" });
		const cut = whole.slice(0, 2000);
		expect(cut.endsWith('"')).toBe(false);
		const read = readResponse(cut);
		expect(read.text.startsWith("line\nline\n")).toBe(true);
		expect(read.text).not.toContain("\\n");
		expect(read.text.split("\n").length).toBeGreaterThan(300);
	});
	test("pass, fail and exit-masked fixtures match on real newlines", () => {
		const pass = readResponse(JSON.stringify({ stdout: "ok  pkg 0.1s\n 4 pass\n 0 fail" })).text;
		const fail = readResponse(JSON.stringify({ stdout: "ok line\nFAIL src/a.test.ts\n" })).text;
		const err = readResponse(JSON.stringify({ stdout: "x", stderr: "\nerror: boom" })).text;
		expect(validationResult(pass, false, false)).toBe("ok");
		expect(validationResult(fail, false, false)).toBe("failed");
		expect(validationResult(err, false, false)).toBe("failed");
		const ok = readResponse(JSON.stringify({ stdout: "ok  pkg 0.1s\n 4 pass" })).text;
		expect(validationResult(ok, false, false)).toBe("ok");
		expect(validationResult(ok, false, true)).toBe("unknown");
	});
	test("without the unwrap, an escaped newline hides a line-start match (the defect)", () => {
		const raw = JSON.stringify({ stdout: "fine\nError: boom" });
		expect(/(^|\n)\s*(error|Error|ERROR)\b/.test(raw)).toBe(false);
		expect(/(^|\n)\s*(error|Error|ERROR)\b/.test(readResponse(raw).text)).toBe(true);
	});
	test("plain text, null, empty, arrays and invalid JSON come back as they are", () => {
		expect(readResponse("hi\n")).toEqual({ text: "hi\n", exitCode: null });
		expect(readResponse(null)).toEqual({ text: "", exitCode: null });
		expect(readResponse("")).toEqual({ text: "", exitCode: null });
		expect(readResponse("[1,2]").text).toBe("[1,2]");
		expect(readResponse("{not json").text).toBe("{not json");
		expect(readResponse('{"other":"x"}').text).toBe('{"other":"x"}');
	});
});

describe("P3-9 exit codes", () => {
	test("metadata.exit_code, exit_code and exitCode, also in a cut object", () => {
		expect(readResponse(JSON.stringify({ output: "x", metadata: { exit_code: 0 } })).exitCode).toBe(
			0,
		);
		expect(readResponse(JSON.stringify({ output: "x", metadata: { exit_code: 2 } })).exitCode).toBe(
			2,
		);
		expect(readResponse(JSON.stringify({ stdout: "x", exit_code: 1 })).exitCode).toBe(1);
		expect(readResponse(JSON.stringify({ stdout: "x", exitCode: 127 })).exitCode).toBe(127);
		const cut = JSON.stringify({ output: "y".repeat(3000), metadata: { exit_code: 3 } }).slice(
			0,
			2000,
		);
		expect(readResponse(cut).exitCode, "after the cut: not readable").toBeNull();
		const front = `{"metadata":{"exit_code":4},"output":"${"y".repeat(3000)}`.slice(0, 2000);
		expect(readResponse(front).exitCode).toBe(4);
	});
	test("no code in the response is null, never zero", () => {
		expect(readResponse("hi\n").exitCode).toBeNull();
		expect(readResponse(JSON.stringify({ stdout: "hi" })).exitCode).toBeNull();
		expect(readResponse(JSON.stringify({ stdout: "exit_code: 1" })).exitCode).toBeNull();
	});
});
