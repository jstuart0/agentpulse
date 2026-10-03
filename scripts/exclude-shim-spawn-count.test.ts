/**
 * Pins the latency budget of the generated POSIX sh exclusion snippet as
 * EXTERNAL-COMMAND COUNTS (not wall time, which is machine-dependent):
 *
 *  - no rules file                                   -> 0
 *  - AGENTPULSE_SKIP set to an allowlisted value     -> 0
 *  - rules present                                   -> a small fixed count
 *    that does NOT grow with the number of rules (1 / 10 / 100 identical)
 *  - each rule containing a symlink component        -> at most +1
 *  - an invalid rules file fails closed within the same fixed budget
 *
 * Counting is by real process executions through a PATH of counting
 * wrappers (see exclude-spawn-count-helpers.ts), so an extra `id`, `ls`,
 * `tr`, `sed`... added anywhere in the snippet is noticed no matter what
 * it is. Run under /bin/sh, dash and `bash --posix` (named skips when a
 * shell isn't installed, same convention as the parity suite).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBashExcludeScript,
	buildBashExcludeSnippet,
	buildBashHookCommand,
} from "../src/shared/hook-command.js";
import {
	type CountedRun,
	type CountedShell,
	buildCountingBin,
	buildHookStubs,
	findAbsoluteUtilityCalls,
	runCounted,
	runCountedHook,
	runCountedScript,
} from "./exclude-spawn-count-helpers.js";

/** The executions of a run with rules present: `id -u`, then one `ls` for the directory and one for the file. */
const RULES_PRESENT = ["id", "ls", "ls"];
/** The only absolute-path utility call the snippet may contain: the external pwd for a non-ASCII path on macOS. */
const ALLOWED_ABSOLUTE = ["/bin/pwd"];
/** The one-liner names its interpreter explicitly, so the check never runs under the login shell. */
const ALLOWED_ABSOLUTE_IN_HOOK = ["/bin/sh"];

/** Resolved to an absolute path: the run's PATH is the counting dir, so a bare name would resolve to (and count) a wrapper for the shell itself. */
function detect(
	name: string,
	bin: string,
	args: string[] = [],
): (CountedShell & { name: string }) | null {
	try {
		const absolute = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).trim();
		execFileSync(absolute, [...args, "-c", "true"], { stdio: "ignore" });
		return { name, bin: absolute, args };
	} catch {
		return null;
	}
}

const CANDIDATES: { label: string; shell: (CountedShell & { name: string }) | null }[] = [
	{ label: "sh", shell: { name: "sh", bin: "/bin/sh" } },
	{ label: "dash", shell: detect("dash", "dash") },
	{ label: "bash --posix", shell: detect("bash --posix", "bash", ["--posix"]) },
];

const SNIPPET = buildBashExcludeSnippet();

// A real (symlink-free) scratch root: on macOS the default tmpdir sits
// under /var -> /private/var, which would turn every rule into a
// "contains a symlink component" rule and defeat the no-symlink cases.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-spawn-count-")));
let binDir = "";
let runIndex = 0;

beforeAll(() => {
	binDir = buildCountingBin(scratch);
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function newHome(): string {
	const home = join(scratch, `home-${++runIndex}`);
	mkdirSync(home, { recursive: true });
	return home;
}

function writeRules(home: string, lines: string[], mode = 0o600): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	const file = join(dir, "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`);
	chmodSync(file, mode);
	return file;
}

function plainRules(home: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => join(home, `proj-${i}`));
}

function run(
	shell: CountedShell,
	home: string,
	cwd: string,
	skip?: string,
	snippet: string = SNIPPET,
): CountedRun {
	const log = join(scratch, `spawn-${++runIndex}.log`);
	const result = runCounted(shell, binDir, log, snippet, { home, cwd, skip });
	// The snippet itself must stay silent whatever the path through it.
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
	return result;
}

describe("exclude snippet — shape", () => {
	test("never invokes a system utility by absolute path, except the one named exception (which would bypass the counter)", () => {
		expect(findAbsoluteUtilityCalls(SNIPPET, ALLOWED_ABSOLUTE)).toEqual([]);
		expect(
			findAbsoluteUtilityCalls(buildBashExcludeSnippet({ platform: "darwin" }), ALLOWED_ABSOLUTE),
		).toEqual([]);
	});

	test("the absolute-path detector catches bare, quoted and substituted forms", () => {
		for (const text of [
			"/usr/bin/x -P",
			'x=$("/usr/bin/x" -P)',
			"x=$('/usr/bin/x' -P)",
			"x=$(/bin/x)",
			'"/sbin/x"',
			"a; /usr/sbin/x",
			"`/bin/x`",
		]) {
			expect(findAbsoluteUtilityCalls(text), text).toHaveLength(1);
		}
		expect(findAbsoluteUtilityCalls("x=$(/bin/pwd -P)", ["/bin/pwd"])).toEqual([]);
		expect(findAbsoluteUtilityCalls("echo /home/user/bin/x")).toEqual([]);
	});

	test("the counting helper reports a hang as a timeout, not as a missing marker", () => {
		const log = join(scratch, "timeout.log");
		const hanging = "sleep 5\nap_excluded=0";
		expect(() =>
			runCounted({ bin: "/bin/sh" }, binDir, log, hanging, {
				home: scratch,
				cwd: scratch,
				timeoutMs: 300,
			}),
		).toThrow(/timed out/);
	});
});

for (const { label, shell } of CANDIDATES) {
	if (!shell) {
		test.skip(`${label} not found on PATH — spawn-count coverage for this shell skipped this run`, () => {});
		continue;
	}

	describe(`exclude snippet — external command budget [${label}]`, () => {
		test("no rules file: zero external commands", () => {
			const home = newHome();
			const cwd = join(home, "work");
			mkdirSync(cwd);
			const r = run(shell, home, cwd);
			expect(r.excluded).toBe(false);
			expect(r.commands).toEqual([]);
		});

		for (const skip of ["1", "true", " TRUE ", "Yes\r", "\ton\n"]) {
			test(`AGENTPULSE_SKIP=${JSON.stringify(skip)}: zero external commands, even with a rules file present`, () => {
				const home = newHome();
				writeRules(home, plainRules(home, 10));
				const r = run(shell, home, home, skip);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual([]);
			});
		}

		test("a non-allowlisted skip value does not short-circuit", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 3));
			const r = run(shell, home, home, "2");
			expect(r.excluded).toBe(false);
			expect(r.commands).toEqual(RULES_PRESENT);
		});

		describe("rules present: the exact list, independent of the rule count", () => {
			for (const n of [1, 10, 100]) {
				test(`${n} rule(s), cwd matches none: exactly id, ls, ls and not excluded`, () => {
					const home = newHome();
					writeRules(home, plainRules(home, n));
					const cwd = join(home, "elsewhere");
					mkdirSync(cwd);
					const r = run(shell, home, cwd);
					expect(r.excluded).toBe(false);
					expect(r.commands).toEqual(RULES_PRESENT);
				});
			}

			test("100 rules, cwd under the LAST rule: excluded, same list", () => {
				const home = newHome();
				const rules = plainRules(home, 100);
				writeRules(home, rules);
				const cwd = join(rules[99] as string, "sub");
				mkdirSync(cwd, { recursive: true });
				const r = run(shell, home, cwd);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual(RULES_PRESENT);
			});

			test("100 rules, cwd under the FIRST rule: excluded, same list", () => {
				const home = newHome();
				const rules = plainRules(home, 100);
				writeRules(home, rules);
				const cwd = join(rules[0] as string, "sub");
				mkdirSync(cwd, { recursive: true });
				const r = run(shell, home, cwd);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual(RULES_PRESENT);
			});
		});

		describe("the invalid-rules marker", () => {
			test("a valid file with no stale marker runs no `rm`", () => {
				const home = newHome();
				writeRules(home, plainRules(home, 3));
				const r = run(shell, home, home);
				expect(r.commands).toEqual(RULES_PRESENT);
			});

			test("a valid file removes a stale marker: one extra `rm`", () => {
				const home = newHome();
				writeRules(home, plainRules(home, 3));
				const marker = join(home, ".agentpulse", "exclude.invalid");
				writeFileSync(marker, "");
				const r = run(shell, home, home);
				expect(r.excluded).toBe(false);
				expect(existsSync(marker)).toBe(false);
				expect(r.commands).toEqual([...RULES_PRESENT, "rm"]);
			});
		});

		describe("rules with a symlink component cost no extra executions", () => {
			for (const k of [1, 10]) {
				test(`${k} symlink rule(s) among 100: exactly id, ls, ls, and they still match`, () => {
					const home = newHome();
					const real = join(home, "real");
					mkdirSync(join(real, "sub"), { recursive: true });
					const link = join(home, "link");
					symlinkSync(real, link);
					const rules = plainRules(home, 100 - k);
					for (let i = 0; i < k; i++) rules.push(join(link, `via-link-${i}`));
					writeRules(home, rules);

					const cwd = join(home, "elsewhere");
					mkdirSync(cwd);
					const r = run(shell, home, cwd);
					expect(r.excluded).toBe(false);
					expect(r.commands).toEqual(RULES_PRESENT);

					mkdirSync(join(real, "via-link-0", "deep"), { recursive: true });
					const hit = run(shell, home, join(real, "via-link-0", "deep"));
					expect(hit.excluded).toBe(true);
					expect(hit.commands).toEqual(RULES_PRESENT);
				});
			}
		});

		describe("an invalid rules file fails closed; exact lists per case", () => {
			test("group-writable file with 100 rules: id, ls, ls, and a marker", () => {
				const home = newHome();
				writeRules(home, plainRules(home, 100), 0o660);
				const r = run(shell, home, home);
				expect(r.excluded).toBe(true);
				expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(true);
				expect(r.commands).toEqual(RULES_PRESENT);
			});

			test("rules file that is a symlink: id, ls (stops before the file's own ls), and a marker", () => {
				const home = newHome();
				const real = join(home, "real-exclude");
				writeFileSync(real, `${plainRules(home, 100).join("\n")}\n`);
				mkdirSync(join(home, ".agentpulse"), { recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				symlinkSync(real, join(home, ".agentpulse", "exclude"));
				const r = run(shell, home, home);
				expect(r.excluded).toBe(true);
				expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(true);
				expect(r.commands).toEqual(["id", "ls"]);
			});

			test("an invalid LINE in the middle of 100 rules: id, ls, ls", () => {
				const home = newHome();
				const rules = plainRules(home, 100);
				rules[50] = "relative/not-absolute";
				writeRules(home, rules);
				const r = run(shell, home, home);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual(RULES_PRESENT);
			});

			test("a group-writable directory: id, ls, and no marker", () => {
				const home = newHome();
				writeRules(home, plainRules(home, 100));
				chmodSync(join(home, ".agentpulse"), 0o770);
				const r = run(shell, home, home);
				chmodSync(join(home, ".agentpulse"), 0o700);
				expect(r.excluded).toBe(true);
				expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(false);
				expect(r.commands).toEqual(["id", "ls"]);
			});

			test("an empty HOME: nothing executed, excluded", () => {
				const r = run(shell, "", scratch);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual([]);
			});

			test.skipIf(process.getuid?.() === 0)(
				"an unsearchable .agentpulse directory: nothing executed, excluded",
				() => {
					const home = newHome();
					writeRules(home, plainRules(home, 3));
					chmodSync(join(home, ".agentpulse"), 0o000);
					const r = run(shell, home, scratch);
					chmodSync(join(home, ".agentpulse"), 0o700);
					expect(r.excluded).toBe(true);
					expect(r.commands).toEqual([]);
				},
			);
		});

		describe("non-ASCII paths, with the macOS case rule forced on every host", () => {
			// The external pwd is named by absolute path, so the counting PATH
			// cannot see it (the parity suite counts it from an `sh -x` trace);
			// everything the counter CAN see stays at the fixed list.
			const DARWIN = buildBashExcludeSnippet({ platform: "darwin" });
			test("a rule and a cwd with an accented name: still exactly id, ls, ls", () => {
				const home = newHome();
				const dir = join(home, "caf\u00e9");
				mkdirSync(join(dir, "sub"), { recursive: true });
				writeRules(home, [dir, ...plainRules(home, 5)]);
				const r = run(shell, home, join(dir, "sub"), undefined, DARWIN);
				expect(r.excluded).toBe(true);
				expect(r.commands).toEqual(RULES_PRESENT);
			});
		});
	});
}

// ─── The installed script, run directly (what `exclude check` does) ───

const SCRIPT = buildBashExcludeScript();

for (const { label, shell: candidate } of CANDIDATES) {
	if (!candidate) continue;
	const shell: CountedShell = candidate;

	describe(`installed script — external command budget and exit status [${label}]`, () => {
		function runScript(home: string, cwd: string, skip?: string) {
			const log = join(scratch, `script-${++runIndex}.log`);
			const r = runCountedScript(shell, binDir, log, SCRIPT, { home, cwd, skip });
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
			return r;
		}

		test("no rules file: exit 42 (send), nothing executed", () => {
			const home = newHome();
			const r = runScript(home, home);
			expect(r.status).toBe(42);
			expect(r.commands).toEqual([]);
		});

		test("an allowlisted skip value: exit 1 (don't send), nothing executed", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 10));
			const r = runScript(home, home, "yes");
			expect(r.status).toBe(1);
			expect(r.commands).toEqual([]);
		});

		test("rules present, no match: exit 42, exactly id, ls, ls", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 100));
			const cwd = join(home, "elsewhere");
			mkdirSync(cwd);
			const r = runScript(home, cwd);
			expect(r.status).toBe(42);
			expect(r.commands).toEqual(RULES_PRESENT);
		});

		test("rules present, cwd matches: exit 1, same list", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 100));
			const r = runScript(home, home);
			expect(r.status).toBe(42);
			const cwd = join(home, "proj-99");
			mkdirSync(cwd);
			const hit = runScript(home, cwd);
			expect(hit.status).toBe(1);
			expect(hit.commands).toEqual(RULES_PRESENT);
		});

		test("an invalid rules file: exit 1, same list", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 3), 0o660);
			const r = runScript(home, home);
			expect(r.status).toBe(1);
			expect(r.commands).toEqual(RULES_PRESENT);
		});

		test("a stale marker next to valid rules: one extra rm", () => {
			const home = newHome();
			writeRules(home, plainRules(home, 3));
			writeFileSync(join(home, ".agentpulse", "exclude.invalid"), "");
			const r = runScript(home, home);
			expect(r.status).toBe(42);
			expect(r.commands).toEqual([...RULES_PRESENT, "rm"]);
		});

		test("a stale marker and no rules file in a trusted directory: cleared with id, ls, rm", () => {
			const home = newHome();
			mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
			const marker = join(home, ".agentpulse", "exclude.invalid");
			writeFileSync(marker, "");
			const r = runScript(home, home);
			expect(r.status).toBe(42);
			expect(existsSync(marker)).toBe(false);
			expect(r.commands).toEqual(["id", "ls", "rm"]);
		});
	});
}

// ─── The one-liner: the whole hook command, per shell, exact lists ───

const hookPaths = { binDir: "", stubDir: "", countingSh: "" };
beforeAll(() => {
	const stubs = buildHookStubs(scratch);
	hookPaths.binDir = binDir;
	hookPaths.stubDir = stubs.stubDir;
	hookPaths.countingSh = stubs.countingSh;
});

const HOOK_SHELLS: { label: string; shell: (CountedShell & { name: string }) | null }[] = [
	...CANDIDATES,
	{ label: "zsh", shell: detect("zsh", "zsh") },
];

/** The ls/id/sh/id/ls/ls tail of a hook run that hands the decision to the installed check. */
const CHECK_RUN = ["ls", "id", "sh", "id", "ls", "ls"];

function hookCommand(agent: "codex_cli" | "copilot_cli", direct: boolean): string {
	return buildBashHookCommand({
		baseUrl: "http://localhost:4000",
		direct,
		agent,
		event: agent === "codex_cli" ? "Stop" : "agentStop",
	});
}

describe("hook command — shape", () => {
	test("the only absolute-path program it names is the explicit /bin/sh, and only once", () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			for (const direct of [false, true]) {
				expect(
					findAbsoluteUtilityCalls(hookCommand(agent, direct), ALLOWED_ABSOLUTE_IN_HOOK),
				).toEqual([]);
				expect(hookCommand(agent, direct).split("/bin/sh").length - 1).toBe(1);
			}
		}
	});
});

for (const { label, shell: candidate } of HOOK_SHELLS) {
	if (!candidate) {
		test.skip(`${label} not found on PATH — hook command spawn-count coverage for this shell skipped this run`, () => {});
		continue;
	}
	const shell: CountedShell = candidate;

	describe(`hook command — external command budget [${label}]`, () => {
		async function runHook(
			agent: "codex_cli" | "copilot_cli",
			direct: boolean,
			setup: (home: string) => void,
			opts: { skip?: string; cwd?: (home: string) => string } = {},
		) {
			const home = newHome();
			setup(home);
			const tmp = join(scratch, `tmp-${++runIndex}`);
			mkdirSync(tmp);
			const cwd = opts.cwd ? opts.cwd(home) : home;
			mkdirSync(cwd, { recursive: true });
			const log = join(scratch, `hook-${++runIndex}.log`);
			const r = await runCountedHook(shell, hookPaths, log, hookCommand(agent, direct), {
				home,
				cwd,
				tmp,
				skip: opts.skip,
			});
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
			// the two members of one pipeline start in no fixed order
			const commands = [...r.commands];
			const head = commands.indexOf("head");
			if (head > 0 && commands[head - 1] === "grep") commands.splice(head - 1, 2, "grep", "head");
			else if (head >= 0 && commands[head + 1] === "grep") commands.splice(head, 2, "grep", "head");
			return { ...r, commands, home };
		}
		const installScript = (home: string) => {
			const file = join(home, ".agentpulse", "exclude-check.sh");
			writeFileSync(file, SCRIPT);
			chmodSync(file, 0o500);
		};
		const withRules = (home: string, lines: string[]) => {
			writeRules(home, lines);
			installScript(home);
		};

		for (const direct of [false, true]) {
			const mode = direct ? "direct" : "relay";

			test(`${mode}, no rules file: nothing beyond mktemp, cat, curl and the cleanup rm`, async () => {
				const r = await runHook("copilot_cli", direct, () => {});
				expect(r.commands).toEqual(["mktemp", "cat", "curl", "rm"]);
			});

			test(`${mode}, the commonest state, the check script installed and no rules file: exactly the old command's spawns (the script is never run)`, async () => {
				const r = await runHook("copilot_cli", direct, (h) => {
					mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
					installScript(h);
				});
				expect(r.commands).toEqual(["mktemp", "cat", "curl", "rm"]);
			});

			test(`${mode}, Codex, the check script installed and no rules file: the marker's three additions only`, async () => {
				const r = await runHook("codex_cli", direct, (h) => {
					mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
					installScript(h);
				});
				expect(r.commands).toEqual(["mktemp", "cat", "grep", "head", "mkdir", "curl", "rm"]);
			});

			test(`${mode}, Codex, no rules file: the marker's grep, head and mkdir are the only additions`, async () => {
				const r = await runHook("codex_cli", direct, () => {});
				expect(r.commands).toEqual(["mktemp", "cat", "grep", "head", "mkdir", "curl", "rm"]);
			});

			test(`${mode}, skip variable set: no curl and nothing else`, async () => {
				const r = await runHook("copilot_cli", direct, () => {}, { skip: "TRUE" });
				expect(r.commands).toEqual(["mktemp", "cat", "rm"]);
			});

			test(`${mode}, rules present and not matching: the fixed list, then curl`, async () => {
				const r = await runHook("copilot_cli", direct, (h) => withRules(h, plainRules(h, 100)), {
					cwd: (h) => join(h, "elsewhere"),
				});
				expect(r.commands).toEqual(["mktemp", "cat", ...CHECK_RUN, "curl", "rm"]);
			});

			test(`${mode}, rules present and matching: the same list, no curl`, async () => {
				const r = await runHook("copilot_cli", direct, (h) => withRules(h, plainRules(h, 100)), {
					cwd: (h) => join(h, "proj-3", "deep"),
				});
				expect(r.commands).toEqual(["mktemp", "cat", ...CHECK_RUN, "rm"]);
			});

			test(`${mode}, a stale marker next to valid rules: one more rm`, async () => {
				const r = await runHook("copilot_cli", direct, (h) => {
					withRules(h, plainRules(h, 3));
					writeFileSync(join(h, ".agentpulse", "exclude.invalid"), "");
				});
				expect(r.commands).toEqual(["mktemp", "cat", ...CHECK_RUN, "rm", "curl", "rm"]);
			});
		}

		for (const direct of [false, true]) {
			test(`${direct ? "direct" : "relay"}, a stale marker and no rules file: the check runs once, clears the marker, and the send follows`, async () => {
				const r = await runHook("copilot_cli", direct, (h) => {
					mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
					installScript(h);
					writeFileSync(join(h, ".agentpulse", "exclude.invalid"), "");
				});
				expect(r.commands).toEqual([
					"mktemp",
					"cat",
					"ls",
					"id",
					"sh",
					"id",
					"ls",
					"rm",
					"curl",
					"rm",
				]);
				expect(existsSync(join(r.home, ".agentpulse", "exclude.invalid"))).toBe(false);
			});
		}

		test("a stale marker, no rules file and no script: only the ls, and nothing is sent", async () => {
			const r = await runHook("copilot_cli", false, (h) => {
				mkdirSync(join(h, ".agentpulse"), { mode: 0o700 });
				writeFileSync(join(h, ".agentpulse", "exclude.invalid"), "");
			});
			expect(r.commands).toEqual(["mktemp", "cat", "ls", "rm"]);
		});

		test("rules present but the script is missing: only the ls, and nothing is sent", async () => {
			const r = await runHook("copilot_cli", false, (h) => writeRules(h, plainRules(h, 3)));
			expect(r.commands).toEqual(["mktemp", "cat", "ls", "rm"]);
		});

		test("rules present and the script untrusted (group-writable): ls and id, no run, nothing sent", async () => {
			const r = await runHook("copilot_cli", false, (h) => {
				withRules(h, plainRules(h, 3));
				chmodSync(join(h, ".agentpulse", "exclude-check.sh"), 0o720);
			});
			expect(r.commands).toEqual(["mktemp", "cat", "ls", "id", "rm"]);
		});

		test("a non-ASCII rule adds nothing the counter can see", async () => {
			const r = await runHook(
				"copilot_cli",
				false,
				(h) => {
					const dir = join(h, "caf\u00e9");
					mkdirSync(dir, { recursive: true });
					withRules(h, [dir]);
				},
				{ cwd: (h) => join(h, "elsewhere") },
			);
			expect(r.commands).toEqual(["mktemp", "cat", ...CHECK_RUN, "curl", "rm"]);
		});
	});
}
