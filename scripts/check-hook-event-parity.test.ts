/**
 * Phase 5 (D12/D13, r6): the parity guard's no-stdout rule — proves the
 * check actually discriminates (a real command passes; a tampered one with
 * an appended `; echo ok` fails), and that the guard's Codex-shape rule
 * runs clean against the current tree.
 */
import { describe, expect, test } from "bun:test";
import { buildBashHookCommand } from "../src/shared/hook-command.js";
import { checkNoStdoutShape } from "./check-hook-event-parity.js";

describe("checkNoStdoutShape (guard self-test)", () => {
	test("a real generated command passes clean", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(checkNoStdoutShape(cmd, "test")).toEqual([]);
	});

	test("appending `; echo ok` is caught", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const tampered = `${cmd}; echo ok`;
		const violations = checkNoStdoutShape(tampered, "test");
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some((v) => v.includes("echo"))).toBe(true);
	});

	test("a bare `cat` (not `cat >`) is caught", () => {
		const violations = checkNoStdoutShape('cat "$t" ) </dev/null >/dev/null 2>&1 & exit 0', "test");
		expect(violations.some((v) => v.includes("bare cat"))).toBe(true);
	});

	test('`cat > "$t"` is not flagged as a bare cat', () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('cat > "$t"');
		expect(checkNoStdoutShape(cmd, "test").some((v) => v.includes("bare cat"))).toBe(false);
	});
});

describe("check-hook-event-parity.ts (the real guard, end to end)", () => {
	test("exits 0 against the current tree", async () => {
		const proc = Bun.spawn(["bun", "scripts/check-hook-event-parity.ts"], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});
});
