/**
 * The rules a live Claude canary keeps, held in CI with no Claude (AGEN-117, phase 0): the throwaway-home check
 * with its decoys, the spawner's argv allowlist, the child's environment by set equality, the key's absence
 * from argv and logs, the kill timer, and the `/tmp/cc-socks` scrub. A fake executable stands in for Claude.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertThrowawayClaudeHome } from "./lib/claude-canary-safety.js";
import {
	ClaudeStream,
	assertAllowedClaudeArgs,
	claudeEnv,
	scrubOwnSockets,
	startedPids,
} from "./lib/claude-canary-spawn.js";

let scratch: string;
let fakeHome: string;
let run: string;

beforeAll(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-safety-")));
	fakeHome = join(scratch, "person");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true });
	mkdirSync(join(fakeHome, ".agentpulse"), { recursive: true });
	mkdirSync(join(fakeHome, ".codex"), { recursive: true });
	writeFileSync(join(fakeHome, ".claude.json"), "{}");
	run = join(scratch, "run");
	mkdirSync(join(run, "home"), { recursive: true });
	mkdirSync(join(scratch, "run2"), { recursive: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("assertThrowawayClaudeHome", () => {
	const check = (name: "HOME" | "CLAUDE_CONFIG_DIR", value: string | undefined, root = run) =>
		assertThrowawayClaudeHome(name, value, root, fakeHome);

	test("a directory strictly inside the scratch root passes, and is returned as given", () => {
		const home = join(run, "home");
		expect(check("HOME", home)).toBe(home);
		expect(check("CLAUDE_CONFIG_DIR", join(run, "cfg"))).toBe(join(run, "cfg"));
	});

	test("unset, empty and relative are refused", () => {
		expect(() => check("HOME", undefined)).toThrow("not set");
		expect(() => check("CLAUDE_CONFIG_DIR", "")).toThrow("not set");
		expect(() => check("HOME", "cfg")).toThrow("absolute");
	});

	test("the person's home, ~/.claude, ~/.claude.json, ~/.agentpulse and ~/.codex, and what is inside them, are refused", () => {
		for (const bad of [
			fakeHome,
			join(fakeHome, ".claude"),
			join(fakeHome, ".claude", "projects"),
			join(fakeHome, ".claude.json"),
			join(fakeHome, ".agentpulse"),
			join(fakeHome, ".agentpulse", "supervisor"),
			join(fakeHome, ".codex"),
			join(fakeHome, ".codex", "sessions"),
		]) {
			expect(() => check("CLAUDE_CONFIG_DIR", bad, scratch), bad).toThrow();
		}
	});

	test("a directory above the person's home, and one that reaches it through a link in its parent, are refused", () => {
		expect(() =>
			assertThrowawayClaudeHome("HOME", scratch, realpathSync(tmpdir()), fakeHome),
		).toThrow("real home");
		const via = join(run, "via");
		symlinkSync(fakeHome, via);
		expect(() => check("CLAUDE_CONFIG_DIR", join(via, ".claude"))).toThrow("real home");
		expect(() => check("CLAUDE_CONFIG_DIR", join(via, "fresh"))).toThrow("real home");
	});

	test("a link inside the scratch root that points into the real ~/.claude is refused", () => {
		const link = join(run, "sneaky");
		symlinkSync(join(fakeHome, ".claude"), link);
		expect(() => check("CLAUDE_CONFIG_DIR", link)).toThrow("link");
	});

	test("a link to another throwaway directory is refused too: the path must be the real one", () => {
		mkdirSync(join(run, "elsewhere"), { recursive: true });
		const link = join(run, "inside-link");
		symlinkSync(join(run, "elsewhere"), link);
		expect(() => check("HOME", link)).toThrow("link");
	});

	test("a path that only shares a prefix with the scratch root is a different directory, and refused", () => {
		expect(() => check("HOME", join(scratch, "run2", "h"))).toThrow("scratch");
		expect(() => check("HOME", run)).toThrow("scratch");
		expect(() => check("HOME", `${run}2`)).toThrow("scratch");
	});
});

describe("assertAllowedClaudeArgs", () => {
	const stream = [
		"--output-format",
		"stream-json",
		"--input-format",
		"stream-json",
		"--model",
		"claude-haiku-5-5",
		"--max-budget-usd",
		"0.10",
	];
	test("--version, agents --json and a capped, model-named stream or print run pass", () => {
		for (const args of [
			["--version"],
			["agents", "--json"],
			stream,
			["-p", "x", ...stream.slice(4)],
		]) {
			expect(() => assertAllowedClaudeArgs(args)).not.toThrow();
		}
	});
	test("no arguments (a terminal interface), a subcommand, a bypass flag and a missing model or budget are refused", () => {
		for (const args of [
			[],
			["--resume", "x"],
			["agents"],
			["attach", "x"],
			["setup-token"],
			["auth", "status"],
			["update"],
			[...stream, "--dangerously-skip-permissions"],
			[...stream, "--permission-mode", "bypassPermissions"],
			[...stream, "--bg"],
			["--model", "claude-haiku-5-5", "--max-budget-usd", "0.10"],
			stream.filter((a) => a !== "--model" && a !== "claude-haiku-5-5"),
			stream.slice(0, 6),
			[...stream.slice(0, 6), "--max-budget-usd", "5"],
			[...stream.slice(0, 6), "--max-budget-usd", "abc"],
		]) {
			expect(() => assertAllowedClaudeArgs(args), args.join(" ")).toThrow();
		}
	});
	test("a run without --model passes only when it says so, and still needs the budget cap", () => {
		const noModel = stream.filter((a) => a !== "--model" && a !== "claude-haiku-5-5");
		expect(() => assertAllowedClaudeArgs(noModel)).toThrow("model");
		expect(() => assertAllowedClaudeArgs(noModel, [], true)).not.toThrow();
		expect(() => assertAllowedClaudeArgs(noModel.slice(0, 4), [], true)).toThrow("budget");
	});
	test("a credential in the argv is refused: by prefix, and by a named secret", () => {
		expect(() => assertAllowedClaudeArgs([...stream, "--settings", "sk-ant-api03-zzz"])).toThrow(
			"credential",
		);
		expect(() =>
			assertAllowedClaudeArgs([...stream, "--x", "hunter2-value"], ["hunter2-value"]),
		).toThrow("credential");
	});
});

const MARKERS = [
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"AI_AGENT",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"AWS_ACCESS_KEY_ID",
	"HTTPS_PROXY",
	"NODE_OPTIONS",
	"AGENTPULSE_API_KEY",
];

function withPollutedEnv<T>(fn: () => T): T {
	const saved = new Map(MARKERS.map((name) => [name, process.env[name]]));
	for (const name of MARKERS) process.env[name] = `inherited-${name}`;
	try {
		return fn();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function options(extra: Record<string, unknown> = {}) {
	return {
		scratchRoot: run,
		home: join(run, "home"),
		configDir: join(run, "cfg"),
		cwd: join(run, "home"),
		...extra,
	};
}

describe("the child's environment", () => {
	test("is exactly the allowlist: inherited markers do not appear (set equality)", () => {
		const env = withPollutedEnv(() => claudeEnv(options()));
		const expected = ["AGENTPULSE_SKIP", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME"];
		for (const name of ["PATH", "LANG", "SHELL", "TMPDIR"])
			if (process.env[name] !== undefined) expected.push(name);
		expect(Object.keys(env).sort()).toEqual(expected.sort());
		expect(env.AGENTPULSE_SKIP).toBe("1");
		expect(env.HOME).toBe(join(run, "home"));
	});
	test("with a key the set is the same plus ANTHROPIC_API_KEY, and an extra the caller names", () => {
		const base = Object.keys(withPollutedEnv(() => claudeEnv(options()))).sort();
		const env = withPollutedEnv(() =>
			claudeEnv(options({ key: "sk-ant-test", env: { HELPER_KEY: "v" } })),
		);
		expect(Object.keys(env).sort()).toEqual([...base, "ANTHROPIC_API_KEY", "HELPER_KEY"].sort());
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
	});
	test("an extra that is owned by the spawner or marks a parent session is refused", () => {
		for (const name of [
			"HOME",
			"CLAUDE_CONFIG_DIR",
			"CLAUDECODE",
			"CLAUDE_CODE_ENTRYPOINT",
			"ANTHROPIC_API_KEY",
			"AGENTPULSE_SKIP",
		]) {
			expect(() => claudeEnv(options({ env: { [name]: "x" } })), name).toThrow();
		}
	});
	test("at the OS level: a real child sees exactly that set (a shell adds PWD, SHLVL and _)", async () => {
		const fake = fakeClaude('env > "$OUT"; printf \'{"type":"system"}\\n\'');
		const out = join(scratch, "env.txt");
		const stream = withPollutedEnv(
			() =>
				new ClaudeStream(
					[...okArgs, out],
					options({
						bin: fake,
						key: "sk-ant-test-key-value-0123456789abcdef",
						env: { OUT: out },
						timeoutMs: 10_000,
					}),
				),
		);
		await stream.waitFor((l) => l.type === "system", 5000);
		await stream.finish();
		const seen = readFileSync(out, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("=")[0] as string)
			.filter((n) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(n))
			.sort();
		const expected = Object.keys(
			withPollutedEnv(() => claudeEnv(options({ key: "k", env: { OUT: out } }))),
		).sort();
		expect(seen).toEqual(expected);
		for (const marker of MARKERS.filter((m) => m !== "ANTHROPIC_API_KEY"))
			expect(seen).not.toContain(marker);
	});
});

const okArgs = [
	"--output-format",
	"stream-json",
	"--input-format",
	"stream-json",
	"--model",
	"claude-haiku-5-5",
	"--max-budget-usd",
	"0.10",
];

function fakeClaude(body: string): string {
	const path = join(scratch, `fake-${Math.random().toString(16).slice(2)}.sh`);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("the key never reaches argv or a log", () => {
	const key = `sk-ant-api03-${"Zq7".repeat(14)}`;
	test("a fake that echoes its environment and stderr leaves no key, prefix or 20-character suffix in the record", async () => {
		const fake = fakeClaude(
			'printf \'{"type":"system","leak":"%s"}\\n\' "$ANTHROPIC_API_KEY"; printf \'{"type":"tail","v":"%s"}\\n\' "$(printf %s "$ANTHROPIC_API_KEY" | tail -c 20)"; echo "$ANTHROPIC_API_KEY" >&2; sleep 0.3',
		);
		const logPath = join(scratch, "stream.jsonl");
		const stream = new ClaudeStream(
			okArgs,
			options({ bin: fake, key, logPath, timeoutMs: 10_000 }),
		);
		const line = await stream.waitFor((l) => l.type === "system", 5000);
		await stream.finish();
		const log = readFileSync(logPath, "utf8");
		// Positive control: the fake did print the key, so the redaction is what removed it.
		expect(String(line?.leak)).toBe(key);
		expect(stream.stderr).toContain("<KEY>");
		for (const needle of [key, key.slice(-20), "sk-ant-"]) {
			expect(log.includes(needle), `log has ${needle.slice(0, 8)}…`).toBe(false);
			expect(stream.stderr.includes(needle)).toBe(false);
		}
		expect(log).toContain("<KEY>");
		expect(log).toContain("<SFX>");
		expect(log).toContain("<SFX>");
	});
	test("the key as an argument is refused before anything starts", () => {
		expect(() => new ClaudeStream([...okArgs, "--settings", key], options({ key }))).toThrow(
			"credential",
		);
	});
});

describe("the kill timer", () => {
	test("ends a child that never exits, by the pid this run started", async () => {
		const fake = fakeClaude("exec sleep 120");
		const stream = new ClaudeStream(okArgs, options({ bin: fake, timeoutMs: 400 }));
		await stream.waitFor(() => false, 3000);
		expect(stream.isAlive()).toBe(false);
		expect(startedPids.has(stream.pid)).toBe(true);
		expect(() => process.kill(stream.pid, 0)).toThrow();
	});
});

describe("scrubOwnSockets", () => {
	test("removes an own dead pid's socket; keeps an own live pid's, a live non-own pid's and a dead non-own pid's", async () => {
		const dir = join(scratch, "socks");
		mkdirSync(dir);
		const dead = spawnSync("true");
		const deadNotOwn = spawnSync("true").pid as number;
		const ownDead = dead.pid as number;
		const live = spawn("sleep", ["30"], { stdio: "ignore" });
		const liveNotOwn = spawn("sleep", ["30"], { stdio: "ignore" });
		try {
			const pids = {
				ownDead,
				ownLive: live.pid as number,
				liveNotOwn: liveNotOwn.pid as number,
				deadNotOwn,
			};
			for (const pid of Object.values(pids)) writeFileSync(join(dir, `${pid}.sock`), "");
			writeFileSync(join(dir, "not-a-pid.sock"), "");
			const removed = scrubOwnSockets([ownDead, pids.ownLive], dir);
			expect(removed).toEqual([`${ownDead}.sock`]);
			expect(existsSync(join(dir, `${ownDead}.sock`))).toBe(false);
			for (const kept of [pids.ownLive, pids.liveNotOwn, deadNotOwn]) {
				expect(existsSync(join(dir, `${kept}.sock`)), `${kept}`).toBe(true);
			}
			expect(existsSync(join(dir, "not-a-pid.sock"))).toBe(true);
		} finally {
			live.kill("SIGKILL");
			liveNotOwn.kill("SIGKILL");
		}
	});
	test("a directory that doesn't exist is nothing to do", () => {
		expect(scrubOwnSockets([1], join(scratch, "none"))).toEqual([]);
	});
});
