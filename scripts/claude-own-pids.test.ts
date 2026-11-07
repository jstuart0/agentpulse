/**
 * Real processes, no Claude (AGEN-117, phase 0). Decoys are copies of Bun named `claude`, so `pgrep -x claude`
 * lists them the way it lists a person's own sessions. The helper must signal only the processes that carry this
 * run's exact CLAUDE_CONFIG_DIR. A second half scans the Claude canary scripts for ways to signal by name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isClaudeCanaryFile, scanClaudeText } from "./lib/claude-canary-safety.js";
import {
	killOwnClaudeProcesses,
	namesClaudeConfigDir,
	ownClaudePids,
} from "./lib/claude-own-pids.js";

const ROOT = join(import.meta.dir, "..");
const HOLD = ["-e", "setTimeout(()=>{},600000)"];
const darwinOnly = process.platform === "darwin" ? describe : describe.skip;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("exit", () => resolve());
	});
}

darwinOnly("ownClaudePids and killOwnClaudeProcesses", () => {
	let scratch: string;
	let claudeBin: string;
	const started: ChildProcess[] = [];

	beforeAll(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-own-pids-")));
		mkdirSync(join(scratch, "bin"));
		claudeBin = join(scratch, "bin", "claude");
		// A copy of a system binary is killed by the OS on macOS; a copy of Bun runs.
		copyFileSync(process.execPath, claudeBin);
		chmodSync(claudeBin, 0o755);
	});

	afterAll(() => {
		// Only processes this file started, by recorded pid.
		for (const child of started) {
			try {
				if (child.pid) process.kill(child.pid, "SIGKILL");
			} catch {}
		}
		// The shell's grandchild isn't in `started`; it is this run's by environment, so the helper reaches it.
		killOwnClaudeProcesses(join(scratch, "cfg-a"), "SIGKILL");
		rmSync(scratch, { recursive: true, force: true });
	});

	function startClaude(env: Record<string, string>, detached = false): ChildProcess {
		const child = spawn(claudeBin, [...HOLD], { env, detached, stdio: "ignore" });
		started.push(child);
		return child;
	}

	test("another config dir, a dir that extends this run's path, and no config dir all survive; own and its grandchild die", async () => {
		const own = join(scratch, "cfg-a");
		const decoys = {
			otherDir: startClaude({ CLAUDE_CONFIG_DIR: join(scratch, "cfg-b") }),
			extendsOwn: startClaude({ CLAUDE_CONFIG_DIR: `${own}2` }),
			noDir: startClaude({}),
		};
		const ownProcess = startClaude({ CLAUDE_CONFIG_DIR: own }, true);
		const shell = spawn(
			"/bin/sh",
			["-c", `"$CLAUDE_BIN" -e "setTimeout(()=>{},600000)" & echo $!; wait`],
			{
				env: { CLAUDE_CONFIG_DIR: own, CLAUDE_BIN: claudeBin },
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		started.push(shell);
		const grandchildPid = await new Promise<number>((resolve) =>
			shell.stdout?.once("data", (d) => resolve(Number(String(d).trim()))),
		);

		const everyPid = [
			...Object.values(decoys).map((c) => c.pid as number),
			ownProcess.pid as number,
			grandchildPid,
		];
		// OS level: pgrep lists every one of them by name, so the filter alone is what separates them.
		await until(() => {
			const listed = spawnSync("pgrep", ["-x", "claude"], { encoding: "utf8" }).stdout.split("\n");
			return everyPid.every((pid) => listed.includes(String(pid)));
		}, "every process to be listed by pgrep");
		await until(
			() => ownClaudePids(own).length >= 2 && ownClaudePids(`${own}2`).length >= 1,
			"environments to be readable",
		);

		const found = ownClaudePids(own);
		expect(found.includes(decoys.extendsOwn.pid as number), "prefix-extending decoy selected").toBe(
			false,
		);
		expect(found.includes(decoys.otherDir.pid as number), "another config dir selected").toBe(
			false,
		);
		expect(found.includes(decoys.noDir.pid as number), "decoy with no config dir selected").toBe(
			false,
		);
		expect(found.sort((a, b) => a - b)).toEqual(
			[ownProcess.pid as number, grandchildPid].sort((a, b) => a - b),
		);

		killOwnClaudeProcesses(own);
		await exited(ownProcess);
		await until(() => !alive(grandchildPid), "own grandchild to die");
		expect(alive(ownProcess.pid as number)).toBe(false);
		expect(alive(decoys.extendsOwn.pid as number), "prefix-extending decoy was killed").toBe(true);
		expect(alive(decoys.otherDir.pid as number), "another config dir was killed").toBe(true);
		expect(alive(decoys.noDir.pid as number), "decoy with no config dir was killed").toBe(true);

		for (const decoy of Object.values(decoys)) process.kill(decoy.pid as number, "SIGKILL");
		await Promise.all(Object.values(decoys).map(exited));
		await exited(shell);
	});

	test("negative control: a substring filter selects the <own>2 decoy, so the test above can fail", async () => {
		const own = join(scratch, "cfg-c");
		const sibling = startClaude({ CLAUDE_CONFIG_DIR: `${own}2` });
		const substring = (command: string, dir: string) =>
			command.includes(`CLAUDE_CONFIG_DIR=${dir}`);
		await until(
			() => ownClaudePids(`${own}2`).length >= 1,
			"the sibling's environment to be readable",
		);
		expect(ownClaudePids(own, substring)).toContain(sibling.pid as number);
		expect(ownClaudePids(own)).not.toContain(sibling.pid as number);
		process.kill(sibling.pid as number, "SIGKILL");
		await exited(sibling);
	});

	test("the user's own sessions are never selected: nothing here names a throwaway config dir", () => {
		const mine = ownClaudePids(join(scratch, "no-such-run"));
		expect(mine).toEqual([]);
	});
});

describe("namesClaudeConfigDir", () => {
	test("matches the whole token only", () => {
		expect(namesClaudeConfigDir("claude CLAUDE_CONFIG_DIR=/a/b HOME=/h", "/a/b")).toBe(true);
		expect(namesClaudeConfigDir("claude HOME=/h CLAUDE_CONFIG_DIR=/a/b", "/a/b")).toBe(true);
		expect(namesClaudeConfigDir("claude CLAUDE_CONFIG_DIR=/a/b2 HOME=/h", "/a/b")).toBe(false);
		expect(namesClaudeConfigDir("claude XCLAUDE_CONFIG_DIR=/a/b", "/a/b")).toBe(false);
		expect(namesClaudeConfigDir("claude CLAUDE_CONFIG_DIR=/a/bx", "/a/b")).toBe(false);
		expect(namesClaudeConfigDir("claude CLAUDE_CONFIG_DIR=/a.b", "/a.b")).toBe(true);
		expect(namesClaudeConfigDir("claude CLAUDE_CONFIG_DIR=/axb", "/a.b")).toBe(false);
	});
});

describe("the scan of the Claude canary scripts", () => {
	test("finds nothing in the scripts as they are, and sees the files it is meant to", () => {
		const files: Array<{ path: string; text: string }> = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "node_modules") walk(full);
				} else if (/\.(ts|mjs|js|sh)$/.test(entry.name)) {
					files.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
				}
			}
		};
		walk(join(ROOT, "scripts"));
		expect(files.length).toBeGreaterThan(5);
		expect(files.some((f) => isClaudeCanaryFile(f.path))).toBe(true);
		expect(files.flatMap((f) => scanClaudeText(f.path, f.text))).toEqual([]);
	});

	test("pkill, killall, xargs kill and a kill by command substitution are flagged in a Claude canary file", () => {
		for (const planted of [
			'spawnSync("pkill", ["-f", "claude"]);',
			'execSync("killall claude");',
			'sh("pgrep -f claude | xargs kill -9");',
			"sh('kill -9 $(pgrep claude)');",
			"sh('kill $(cat /tmp/pid)');",
			"sh('kill `pgrep claude`');",
		]) {
			expect(
				scanClaudeText("scripts/claude-rogue.ts", planted).map((f) => f.rule),
				planted,
			).toContain("kill-by-name");
		}
	});

	test("a Claude spawn outside the spawner is flagged; inside it isn't; a comment is not code", () => {
		const planted =
			'import { spawn } from "node:child_process";\nspawn("/opt/homebrew/bin/claude", ["-p"]);';
		expect(scanClaudeText("scripts/rogue.ts", planted).map((f) => f.rule)).toContain(
			"claude-spawn",
		);
		expect(
			scanClaudeText("scripts/rogue.ts", 'Bun.spawn(["claude", "-p"])').map((f) => f.rule),
		).toContain("claude-spawn");
		expect(scanClaudeText("scripts/lib/claude-canary-spawn.ts", planted)).toEqual([]);
		expect(scanClaudeText("scripts/claude-x.ts", '// spawn("claude") pkill claude')).toEqual([]);
	});
});
