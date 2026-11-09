/**
 * The rules a live OpenCode canary keeps, held in CI with no OpenCode (AGEN-141, phase 0): the sandbox
 * assertion before every spawn (each variable unset, outside scratch, under a forbidden path), the argv
 * allowlist, the child's environment by set equality, stdin closed, the pin check, the kill timer, nothing
 * killed by name, and no stray spawn of `opencode` anywhere else. A stand-in executable with its own pin
 * stands in for OpenCode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OPENCODE_PINS, type OpenCodePin } from "./lib/opencode-canary-pins.js";
import {
	NETWORK_PROFILE,
	SANDBOX_DIR_VARS,
	assertAllowedOpenCodeArgs,
	assertOpenCodeSandbox,
	buildOpenCodeEnv,
	scanCanarySource,
	scanText,
} from "./lib/opencode-canary-safety.js";
import {
	assertPinnedBinary,
	cleanupSandbox,
	makeSandbox,
	runOpenCode,
	sha256File,
	startedPids,
} from "./lib/opencode-canary-spawn.js";
import { diffTrees, snapshotTree } from "./lib/opencode-canary-watch.js";
import { ownOpenCodePidsAny } from "./lib/opencode-own-pids.js";
import { namesEnvValue } from "./lib/own-pids.js";

let scratch: string;
let person: string;
let run: string;
let fake: string;
let pins: Record<"v1" | "v2", OpenCodePin>;

beforeAll(async () => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "opencode-safety-")));
	person = join(scratch, "person");
	for (const d of [
		".config/opencode",
		".local/share/opencode",
		".local/state/opencode",
		".cache/opencode",
		".agentpulse",
		".claude",
		".codex",
	]) {
		mkdirSync(join(person, d), { recursive: true });
	}
	run = join(scratch, "run");
	mkdirSync(run, { recursive: true });
	fake = join(run, "fake-opencode");
	writeFileSync(
		fake,
		`#!/bin/sh
echo "$1" > "$PROBE_OUT.args"
env | sort > "$PROBE_OUT.env"
pwd >> "$PROBE_OUT.env"
if read -r line; then echo "stdin-had-data" > "$PROBE_OUT.stdin"; else echo "stdin-eof" > "$PROBE_OUT.stdin"; fi
if [ "$2" = "sleep" ]; then sleep 30; fi
if [ "$2" = "net" ]; then
  curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PROBE_PORT/" > "$PROBE_OUT.loop" 2>/dev/null; echo " rc=$?" >> "$PROBE_OUT.loop"
  curl -s -m 3 -o /dev/null "https://104.16.6.34/" 2>/dev/null; echo "rc=$?" > "$PROBE_OUT.ext"
fi
echo 1.19.5
`,
	);
	chmodSync(fake, 0o755);
	const sha = await sha256File(fake);
	pins = {
		v1: { ...OPENCODE_PINS.v1, sha256: sha },
		v2: { ...OPENCODE_PINS.v2, sha256: sha },
	};
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const goodEnv = (label = "good") => {
	const sandbox = makeSandbox(run, label);
	return { sandbox, env: buildOpenCodeEnv(sandbox.paths) };
};
const assertSandbox = (env: Record<string, string | undefined>, cwd?: string) =>
	assertOpenCodeSandbox(env, run, cwd ?? join(run, "proj"), person);

describe("assertOpenCodeSandbox", () => {
	test("a full sandbox passes", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox(env)).not.toThrow();
	});

	test("HOME outside scratch throws", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox({ ...env, HOME: person })).toThrow();
		expect(() => assertSandbox({ ...env, HOME: join(scratch, "elsewhere") })).toThrow(
			"not strictly inside",
		);
	});

	test("XDG_RUNTIME_DIR unset throws", () => {
		const { env } = goodEnv();
		const { XDG_RUNTIME_DIR: _drop, ...rest } = env;
		expect(() => assertSandbox(rest)).toThrow("XDG_RUNTIME_DIR is not set");
	});

	test("OPENCODE_DISABLE_AUTOUPDATE missing throws", () => {
		const { env } = goodEnv();
		const { OPENCODE_DISABLE_AUTOUPDATE: _drop, ...rest } = env;
		expect(() => assertSandbox(rest)).toThrow("OPENCODE_DISABLE_AUTOUPDATE=1 is required");
	});

	test("OPENCODE_DISABLE_MODELS_FETCH missing or not 1 throws", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox({ ...env, OPENCODE_DISABLE_MODELS_FETCH: "0" })).toThrow(
			"OPENCODE_DISABLE_MODELS_FETCH=1 is required",
		);
	});

	for (const name of SANDBOX_DIR_VARS) {
		test(`${name} unset throws`, () => {
			const { env } = goodEnv();
			const copy: Record<string, string | undefined> = { ...env };
			copy[name] = undefined;
			expect(() => assertSandbox(copy)).toThrow(`${name} is not set`);
		});
		test(`${name} outside scratch throws`, () => {
			const { env } = goodEnv();
			expect(() => assertSandbox({ ...env, [name]: join(scratch, "other") })).toThrow();
		});
		test(`${name} relative throws`, () => {
			const { env } = goodEnv();
			expect(() => assertSandbox({ ...env, [name]: "rel/path" })).toThrow("absolute");
		});
		test(`${name} set to a real OpenCode directory throws`, () => {
			const { env } = goodEnv();
			for (const real of [
				join(person, ".config", "opencode"),
				join(person, ".local", "share", "opencode"),
				join(person, ".agentpulse"),
				join(person, ".claude"),
				join(person, ".codex"),
			]) {
				expect(() => assertSandbox({ ...env, [name]: real })).toThrow();
			}
		});
	}

	test("a directory under scratch that links to a real directory throws", () => {
		const { env, sandbox } = goodEnv("linked");
		const link = join(sandbox.stateDir, "link-to-real");
		symlinkSync(join(person, ".config", "opencode"), link);
		expect(() => assertSandbox({ ...env, XDG_CONFIG_HOME: link })).toThrow();
	});

	test("a cwd outside scratch throws, and one inside passes", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox(env, person)).toThrow();
		expect(() => assertSandbox(env, join(run, "proj"))).not.toThrow();
	});

	test("OPENCODE_CONFIG_DIR and OPENCODE_DB must be inside scratch when set", () => {
		const { env } = goodEnv();
		expect(() =>
			assertSandbox({ ...env, OPENCODE_CONFIG_DIR: join(person, ".config/opencode") }),
		).toThrow();
		expect(() => assertSandbox({ ...env, OPENCODE_DB: join(scratch, "x.db") })).toThrow();
		expect(() => assertSandbox({ ...env, OPENCODE_DB: join(run, "x.db") })).not.toThrow();
	});

	test("PATH is exactly /usr/bin:/bin and an unknown variable is refused", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox({ ...env, PATH: "/usr/bin:/bin:/opt/homebrew/bin" })).toThrow(
			"PATH",
		);
		expect(() => assertSandbox({ ...env, ANTHROPIC_API_KEY: "x" })).toThrow(
			"not an allowed variable",
		);
		expect(() => assertSandbox({ ...env, OPENCODE_PURE: "1" })).toThrow("not an allowed variable");
	});

	test("an extra path-valued variable outside scratch is refused", () => {
		const { env } = goodEnv();
		expect(() => assertSandbox({ ...env, PROBE_LOG: "/etc/passwd" })).toThrow(
			"outside the scratch",
		);
		expect(() => assertSandbox({ ...env, PROBE_LOG: join(run, "log") })).not.toThrow();
	});

	test("buildOpenCodeEnv refuses a name outside the extras pattern", () => {
		const { sandbox } = goodEnv();
		expect(() => buildOpenCodeEnv(sandbox.paths, { extra: { OPENAI_API_KEY: "x" } })).toThrow();
		expect(() => buildOpenCodeEnv(sandbox.paths, { extra: { PROBE_LOG: "x" } })).not.toThrow();
	});
});

describe("assertAllowedOpenCodeArgs", () => {
	const ok = (...args: string[]) => assertAllowedOpenCodeArgs(args, run);
	test("run, serve, --version and service start|stop|status pass", () => {
		expect(() => ok("--version")).not.toThrow();
		expect(() => ok("run", "--format", "json", "hello")).not.toThrow();
		expect(() => ok("run", "--standalone", "hello")).not.toThrow();
		expect(() => ok("serve", "--port", "0", "--hostname", "127.0.0.1")).not.toThrow();
		for (const sub of ["start", "stop", "status"]) expect(() => ok("service", sub)).not.toThrow();
	});
	test("upgrade, plugin, auth and uninstall are refused, first or buried", () => {
		for (const bad of ["upgrade", "plugin", "plugins", "auth", "uninstall"]) {
			expect(() => ok(bad)).toThrow();
			expect(() => ok("run", bad)).toThrow();
		}
	});
	test("service needs one of the three subcommands; other first words are refused", () => {
		expect(() => ok("service")).toThrow();
		expect(() => ok("service", "install")).toThrow();
		expect(() => ok("db", "path")).toThrow();
		expect(() => ok("debug", "paths")).toThrow();
		expect(() => ok()).toThrow();
		expect(() => ok("--version", "extra")).toThrow();
	});
	test("serve binds loopback only, and a path argument stays inside scratch", () => {
		expect(() => ok("serve", "--hostname", "0.0.0.0")).toThrow("loopback");
		expect(() => ok("serve", "--mdns")).toThrow();
		expect(() => ok("run", "--dir", "/etc")).toThrow("outside the scratch");
		expect(() => ok("run", "--dir", run)).toThrow("outside the scratch");
		expect(() => ok("run", "--dir", join(run, "proj"))).not.toThrow();
	});
});

describe("the spawner", () => {
	const start = (label: string, args: string[], extra: Record<string, string> = {}) => {
		mkdirSync(join(run, "proj"), { recursive: true });
		const sandbox = makeSandbox(run, label);
		const out = join(run, `${label}-out`);
		return {
			out,
			sandbox,
			options: {
				line: "v1" as const,
				bin: fake,
				args,
				sandbox,
				cwd: join(run, "proj"),
				extraEnv: { PROBE_OUT: out, ...extra },
				logBase: join(run, label),
				timeoutMs: 5000,
			},
		};
	};

	test("a binary that doesn't match its pin never runs", async () => {
		const { out, options } = start("badpin", ["--version"]);
		await expect(runOpenCode(options)).rejects.toThrow("not the pinned");
		expect(existsSync(`${out}.args`)).toBe(false);
		await expect(assertPinnedBinary("relative/opencode", "v1", pins)).rejects.toThrow("absolute");
	});

	test("the child's environment is exactly the built set (set equality), and stdin is closed", async () => {
		const { out, sandbox, options } = start("env", ["--version"]);
		const result = await runOpenCode(options, pins);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("1.19.5");
		const seen = readFileSync(`${out}.env`, "utf8")
			.split("\n")
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => l.split("=")[0])
			.filter((n) => n !== "PWD" && n !== "SHLVL" && n !== "_")
			.sort();
		const expected = Object.keys({
			...buildOpenCodeEnv(sandbox.paths, { extra: { PROBE_OUT: out } }),
		}).sort();
		expect(seen).toEqual(expected);
		expect(readFileSync(`${out}.stdin`, "utf8").trim()).toBe("stdin-eof");
		expect(readFileSync(`${out}.env`, "utf8")).not.toContain(person);
	});

	test("a failing sandbox check stops the spawn before it happens", async () => {
		const { out, options } = start("nosandbox", ["--version"]);
		await expect(runOpenCode({ ...options, cwd: person }, pins)).rejects.toThrow();
		expect(existsSync(`${out}.args`)).toBe(false);
		await expect(runOpenCode({ ...options, args: ["upgrade"] }, pins)).rejects.toThrow(
			"isn't allowed",
		);
		expect(existsSync(`${out}.args`)).toBe(false);
	});

	test("the child runs under the loopback-only network profile: loopback answers, everything else is refused", async () => {
		expect(NETWORK_PROFILE).toContain("(deny network-outbound)");
		expect(NETWORK_PROFILE).toContain('(allow network-outbound (remote ip "localhost:*"))');
		expect(NETWORK_PROFILE.match(/\(allow network-outbound/g)?.length).toBe(2);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
		try {
			const { out, options } = start("net", ["run", "net"], { PROBE_PORT: String(server.port) });
			await runOpenCode(options, pins);
			expect(readFileSync(`${out}.loop`, "utf8")).toContain("200");
			// rc 7: the connection was refused outright (a reachable host would give 0 or 60, a dead route 28).
			expect(readFileSync(`${out}.ext`, "utf8").trim()).toBe("rc=7");
		} finally {
			server.stop(true);
		}
	});

	test("the kill timer ends a child that doesn't exit, by its recorded group", async () => {
		const { options } = start("timer", ["run", "sleep"]);
		const result = await runOpenCode({ ...options, timeoutMs: 400 }, pins);
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGKILL");
		expect(startedPids.has(result.pid)).toBe(false);
	});

	test("cleanupSandbox leaves a stranger's process alone", async () => {
		const sandbox = makeSandbox(run, "cleanup");
		const sleeper = Bun.spawn(["sleep", "30"]);
		cleanupSandbox(sandbox);
		await Bun.sleep(100);
		expect(sleeper.killed || sleeper.exitCode !== null).toBe(false);
		sleeper.kill();
	});

	test("the env matcher takes only the whole token", () => {
		const dir = "/scratch/a/xdg-data";
		expect(namesEnvValue(`opencode X=1 XDG_DATA_HOME=${dir} Y=2`, "XDG_DATA_HOME", dir)).toBe(true);
		expect(namesEnvValue(`opencode XDG_DATA_HOME=${dir}-other`, "XDG_DATA_HOME", dir)).toBe(false);
		expect(namesEnvValue("opencode XDG_DATA_HOME=/home/p/.local/share", "XDG_DATA_HOME", dir)).toBe(
			false,
		);
	});
});

describe("real-state snapshots", () => {
	test("diffTrees reports added, changed and removed paths, and nothing when equal", () => {
		const root = join(scratch, "snap");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "a"), "1");
		const before = snapshotTree(root);
		expect(diffTrees(before, snapshotTree(root))).toEqual([]);
		writeFileSync(join(root, "b"), "2");
		writeFileSync(join(root, "a"), "12");
		const changes = diffTrees(before, snapshotTree(root));
		expect(changes.some((c) => c.startsWith("added") && c.endsWith("/b"))).toBe(true);
		expect(changes.some((c) => c.startsWith("changed") && c.includes("/a: f 1 "))).toBe(true);
		rmSync(join(root, "a"));
		expect(diffTrees(before, snapshotTree(root)).some((c) => c.startsWith("removed"))).toBe(true);
	});

	test("a directory that doesn't exist is an empty snapshot, and appearing is a change", () => {
		const root = join(scratch, "absent");
		const before = snapshotTree(root);
		expect(before.size).toBe(0);
		mkdirSync(root);
		expect(diffTrees(before, snapshotTree(root))).toEqual([`added ${root}`]);
	});
});

describe("the source scan", () => {
	test("a spawn of opencode outside the spawn module is a finding", () => {
		expect(
			scanText("scripts/x.ts", `spawn("/opt/opencode", ["run"]);`).map((f) => f.rule),
		).toContain("opencode-spawn");
		expect(
			scanText("scripts/x.ts", `Bun.spawn(["opencode", "run"]);`).map((f) => f.rule),
		).toContain("opencode-spawn");
		expect(scanText("scripts/lib/opencode-canary-spawn.ts", "spawn(options.bin, []);")).toEqual([]);
	});
	test("pkill, killall and pgrep-then-kill are findings", () => {
		for (const text of [
			"pkill opencode",
			"killall opencode",
			"xargs kill",
			"kill $(pgrep opencode)",
		]) {
			expect(scanText("scripts/x.ts", text).map((f) => f.rule)).toContain("kill-by-name");
		}
		expect(
			scanText("scripts/x.ts", `spawnSync("pgrep", ["-x", "opencode"])`).map((f) => f.rule),
		).toContain("process-search");
	});
	test("no non-spawn-module source in scripts/ or src/ spawns opencode or kills by name", () => {
		const root = join(import.meta.dir, "..");
		const files: Array<{ path: string; text: string }> = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				if (name === "node_modules" || name === ".git" || name === "dist") continue;
				const full = join(dir, name);
				const st = statSync(full);
				if (st.isDirectory()) walk(full);
				else if (/\.(ts|tsx|js|sh)$/.test(name) && !name.endsWith(".test.ts")) {
					files.push({ path: relative(root, full), text: readFileSync(full, "utf8") });
				}
			}
		};
		for (const d of ["scripts", "src", "bin"]) walk(join(root, d));
		expect(files.length).toBeGreaterThan(100);
		// The canary-owned files are the ones this rule is about; other canaries have their own scans.
		const mine = files.filter((f) => /opencode/i.test(f.path) || /opencode-observe/.test(f.path));
		expect(mine.length).toBeGreaterThanOrEqual(5);
		const findings = scanCanarySource(mine).filter((f) => f.rule !== "refused-subcommand");
		expect(findings).toEqual([]);
	});
});

describe("one scan for many data directories", () => {
	test("no directory selects nothing, and a directory no process names selects nothing", () => {
		expect(ownOpenCodePidsAny([])).toEqual([]);
		expect(ownOpenCodePidsAny(["/nonexistent/ap-no-such-run/xdg-data"])).toEqual([]);
	});
});
