/**
 * The Claude canary's exit guard (AGEN-117, phase 7, P7-X1): it ends the process groups this run recorded and
 * the pids it started, removes what the run made, and leaves every other process alone. Real processes, no
 * Claude: `sleep` stands in, started by this test, and the one that is not recorded must survive.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeGuard, resetClaudeGuardForTest } from "./claude-canary-guard.js";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleeper = () => {
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	return child.pid as number;
};
const waitDead = async (pid: number) => {
	for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
	return !alive(pid);
};

const spare: number[] = [];
afterAll(() => {
	for (const pid of spare) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
});

describe("installClaudeGuard", () => {
	test("cleanup ends a recorded group, spares a process it did not record, removes the run's directory, and runs once", async () => {
		resetClaudeGuardForTest();
		const root = mkdtempSync(join(tmpdir(), "claude-guard-"));
		const made = join(root, "run");
		mkdirSync(made);
		writeFileSync(join(made, "home-file"), "x");
		const recorded = sleeper();
		const stranger = sleeper();
		spare.push(recorded, stranger);
		const exits: number[] = [];
		const guard = installClaudeGuard({ onExit: (code) => void exits.push(code) });
		guard.addGroup(recorded);
		guard.removeAtEnd(made);
		guard.cleanup();
		expect(await waitDead(recorded)).toBe(true);
		expect(alive(stranger)).toBe(true);
		expect(existsSync(made)).toBe(false);
		// Asked again, it does nothing: a second group recorded after the first cleanup is not signalled.
		const late = sleeper();
		spare.push(late);
		guard.addGroup(late);
		guard.cleanup();
		await Bun.sleep(150);
		expect(alive(late)).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("a group that was verified gone and forgotten is not signalled; fire() cleans up and then exits with the code", async () => {
		resetClaudeGuardForTest();
		const forgotten = sleeper();
		const recorded = sleeper();
		spare.push(forgotten, recorded);
		const exits: number[] = [];
		const guard = installClaudeGuard({ onExit: (code) => void exits.push(code) });
		guard.addGroup(forgotten);
		guard.forgetGroup(forgotten);
		guard.addGroup(recorded);
		guard.fire(2);
		expect(exits).toEqual([2]);
		expect(await waitDead(recorded)).toBe(true);
		expect(alive(forgotten)).toBe(true);
	});
});
