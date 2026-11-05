/**
 * Real processes, no Codex. Decoys are copies of Bun named `codex`, so `pgrep -x codex` lists
 * them the way it lists a person's own Codex sessions. The cleanup helper must signal only the processes that
 * carry this run's exact CODEX_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killOwnCodexProcesses, namesCodexHome, ownCodexPids } from "./lib/codex-own-pids.js";

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

darwinOnly("ownCodexPids and killOwnCodexProcesses", () => {
	let scratch: string;
	let codexBin: string;
	const started: ChildProcess[] = [];

	beforeAll(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "codex-own-pids-")));
		mkdirSync(join(scratch, "bin"));
		codexBin = join(scratch, "bin", "codex");
		// A copy of a system binary is killed by the OS on macOS; a copy of Bun runs.
		copyFileSync(process.execPath, codexBin);
		chmodSync(codexBin, 0o755);
	});

	afterAll(() => {
		// Only processes this file started, by recorded pid.
		for (const child of started) {
			try {
				if (child.pid) process.kill(child.pid, "SIGKILL");
			} catch {}
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	function startCodex(env: Record<string, string>, detached = false): ChildProcess {
		const child = spawn(codexBin, [...HOLD], { env, detached, stdio: "ignore" });
		started.push(child);
		return child;
	}

	test("a sibling home that extends this run's path, another home and no home all survive", async () => {
		const own = join(scratch, "home-a");
		const decoys = {
			otherHome: startCodex({ CODEX_HOME: join(scratch, "home-b") }),
			extendsOwn: startCodex({ CODEX_HOME: `${own}2` }),
			noHome: startCodex({}),
		};
		const ownProcess = startCodex({ CODEX_HOME: own }, true);
		// The grandchild is the shell's child, in the shell's own process group.
		const shell = spawn(
			"/bin/sh",
			["-c", `"$CODEX_BIN" -e "setTimeout(()=>{},600000)" & echo $!; wait`],
			{
				env: { CODEX_HOME: own, CODEX_BIN: codexBin },
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
		await until(() => {
			const listed = spawnSync("pgrep", ["-x", "codex"], { encoding: "utf8" }).stdout;
			return everyPid.every((pid) => listed.split("\n").includes(String(pid)));
		}, "every process to be listed by pgrep");
		await until(
			() => ownCodexPids(own).length >= 2 || ownCodexPids(`${own}2`).length >= 1,
			"environments to be readable",
		);

		const found = ownCodexPids(own);
		expect(
			found.includes(decoys.extendsOwn.pid as number),
			`decoy <own>2 (pid ${decoys.extendsOwn.pid}) was selected as this run's`,
		).toBe(false);
		expect(
			found.includes(decoys.otherHome.pid as number),
			"decoy with another home was selected",
		).toBe(false);
		expect(found.includes(decoys.noHome.pid as number), "decoy with no home was selected").toBe(
			false,
		);
		expect(found.sort((a, b) => a - b)).toEqual(
			[ownProcess.pid as number, grandchildPid].sort((a, b) => a - b),
		);

		killOwnCodexProcesses(own);
		await exited(ownProcess);
		await until(() => !alive(grandchildPid), "own grandchild to die");

		expect(alive(ownProcess.pid as number)).toBe(false);
		expect(alive(grandchildPid)).toBe(false);
		expect(
			alive(decoys.extendsOwn.pid as number),
			`decoy <own>2 (pid ${decoys.extendsOwn.pid}) was killed`,
		).toBe(true);
		expect(alive(decoys.otherHome.pid as number), "decoy with another home was killed").toBe(true);
		expect(alive(decoys.noHome.pid as number), "decoy with no home was killed").toBe(true);

		for (const decoy of Object.values(decoys)) process.kill(decoy.pid as number, "SIGKILL");
		await Promise.all(Object.values(decoys).map(exited));
		await exited(shell);
	});

	test("negative control: a substring filter selects the <own>2 decoy, so the test above can fail", async () => {
		const own = join(scratch, "home-c");
		const sibling = startCodex({ CODEX_HOME: `${own}2` });
		const substring = (command: string, home: string) => command.includes(`CODEX_HOME=${home}`);
		await until(
			() => ownCodexPids(`${own}2`).length >= 1,
			"the sibling's environment to be readable",
		);
		expect(ownCodexPids(own, substring)).toContain(sibling.pid as number);
		expect(ownCodexPids(own)).not.toContain(sibling.pid as number);
		process.kill(sibling.pid as number, "SIGKILL");
		await exited(sibling);
	});
});

describe("namesCodexHome", () => {
	test("whole token only", () => {
		expect(namesCodexHome("codex CODEX_HOME=/a/b HOME=/h", "/a/b")).toBe(true);
		expect(namesCodexHome("codex HOME=/h CODEX_HOME=/a/b", "/a/b")).toBe(true);
		expect(namesCodexHome("codex CODEX_HOME=/a/b2 HOME=/h", "/a/b")).toBe(false);
		expect(namesCodexHome("codex XCODEX_HOME=/a/b", "/a/b")).toBe(false);
		expect(namesCodexHome("codex CODEX_HOME=/a/bx", "/a/b")).toBe(false);
	});
	test("a home with regex characters matches literally", () => {
		expect(namesCodexHome("codex CODEX_HOME=/a.b", "/a.b")).toBe(true);
		expect(namesCodexHome("codex CODEX_HOME=/axb", "/a.b")).toBe(false);
	});
});
