/**
 * Runs the GENERATED shell hook command (the real one a Codex or Copilot
 * hooks file carries) with `sh -c`, `dash -c`, `bash --posix -c` and `zsh -c`
 * (the login shell Codex uses on macOS), against a stub `curl` on PATH, and
 * checks what the gate and the installed check do to it:
 *
 *  - no rules file and no skip variable: the payload is sent, exactly as
 *    before the check existed, with no script needed;
 *  - an excluded directory, an allowlisted AGENTPULSE_SKIP, invalid rules, an
 *    unset HOME, or a rules file with no (or an untrusted) script: nothing is
 *    sent, the temp payload is removed, the Codex native marker is still
 *    written;
 *  - the script is run only when it and its directory are owned by the user
 *    and not group/world-writable, and only as a regular file;
 *  - the hook always exits 0 with nothing on stdout or stderr, and the
 *    parent returns without waiting for the (detached) check.
 *
 * Every run uses a throwaway HOME and TMPDIR; nothing here talks to a
 * network or touches a real home directory.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hookCommand from "../src/shared/hook-command.js";
import { buildBashHookCommand } from "../src/shared/hook-command.js";

/** The installed check; empty until the generator can produce it. */
function scriptText(): string {
	const build = (hookCommand as unknown as Record<string, unknown>).buildBashExcludeScript;
	return typeof build === "function" ? (build as () => string)() : "";
}

const BASE = "http://localhost:4000";
const SESSION_ID = "sess-abc-123";
const PAYLOAD = JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Stop" });
const CLEANUP_DEADLINE_MS = 12_000;

// Each run waits for a detached shell to finish; leave room for a loaded host.
setDefaultTimeout(30_000);

interface Shell {
	name: string;
	bin: string;
	args: string[];
}

function detect(name: string, bin: string, args: string[] = []): Shell | null {
	try {
		const absolute = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).trim();
		execFileSync(absolute, [...args, "-c", "true"], { stdio: "ignore" });
		return { name, bin: absolute, args };
	} catch {
		return null;
	}
}

const SHELLS: Shell[] = [
	{ name: "sh", bin: "/bin/sh", args: [] },
	detect("dash", "dash"),
	detect("bash --posix", "bash", ["--posix"]),
	detect("zsh", "zsh"),
].filter((s): s is Shell => s !== null);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-hook-exclude-")));
const stubDir = join(scratch, "stubs");
let runIndex = 0;

beforeAll(() => {
	mkdirSync(stubDir, { recursive: true });
	// A stub curl: records its arguments and the payload file it was given.
	const curl = join(stubDir, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh
payload=""
for a; do
  case "$a" in @*) payload="\${a#@}" ;; esac
done
{
  printf 'CURL'
  for a; do printf ' [%s]' "$a"; done
  printf '\\n'
  if [ -n "$payload" ] && [ -f "$payload" ]; then printf 'BODY %s\\n' "$(cat "$payload")"; fi
} >> "$AP_CURL_LOG"
`,
	);
	chmodSync(curl, 0o755);
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface Sandbox {
	home: string;
	tmp: string;
	cwd: string;
	log: string;
	root: () => string;
}

function newSandbox(): Sandbox {
	const root = join(scratch, `run-${++runIndex}`);
	const home = join(root, "home");
	const tmp = join(root, "tmp");
	const cwd = join(root, "work");
	for (const dir of [home, tmp, cwd]) mkdirSync(dir, { recursive: true });
	return { home, tmp, cwd, log: join(root, "curl.log"), root: () => root };
}

function installScript(home: string, text: string = scriptText()): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "exclude-check.sh");
	rmSync(file, { force: true });
	writeFileSync(file, text);
	chmodSync(file, 0o500);
	return file;
}

/** A rules file in a private directory, and (unless told not to) the installed check next to it. */
function writeRules(
	home: string,
	lines: string[],
	fileMode = 0o600,
	opts: { script?: boolean } = {},
): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	const file = join(dir, "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`);
	chmodSync(file, fileMode);
	if (opts.script !== false) installScript(home);
	return file;
}

function payloadFiles(tmp: string): string[] {
	return readdirSync(tmp).filter((n) => n.startsWith("agentpulse-hook."));
}

interface HookRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	parentMs: number;
	curlLog: string;
}

async function waitForCleanup(sb: Sandbox): Promise<void> {
	const deadline = Date.now() + CLEANUP_DEADLINE_MS;
	while (payloadFiles(sb.tmp).length > 0 && Date.now() < deadline) await Bun.sleep(25);
	if (payloadFiles(sb.tmp).length > 0) throw new Error("the detached hook body never finished");
}

async function runHook(
	shell: Shell,
	command: string,
	sb: Sandbox,
	env: Record<string, string | undefined> = {},
	extraPath: string[] = [],
): Promise<HookRun> {
	writeFileSync(sb.log, "");
	const path = [...extraPath, stubDir, "/usr/bin", "/bin"].join(":");
	const started = performance.now();
	const result = spawnSync(shell.bin, [...shell.args, "-c", command], {
		cwd: sb.cwd,
		input: PAYLOAD,
		encoding: "utf-8",
		env: {
			PATH: path,
			HOME: sb.home,
			TMPDIR: sb.tmp,
			AP_CURL_LOG: sb.log,
			...env,
		} as NodeJS.ProcessEnv,
	});
	const parentMs = performance.now() - started;
	await waitForCleanup(sb);
	return {
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		parentMs,
		curlLog: readFileSync(sb.log, "utf-8"),
	};
}

const CELLS = [
	{ agent: "codex_cli", direct: false, event: "Stop" },
	{ agent: "codex_cli", direct: true, event: "Stop" },
	{ agent: "copilot_cli", direct: false, event: "agentStop" },
	{ agent: "copilot_cli", direct: true, event: "agentStop" },
] as const;

function commandFor(cell: (typeof CELLS)[number]): string {
	return buildBashHookCommand({ baseUrl: BASE, ...cell });
}

function expectSilentExitZero(run: HookRun): void {
	expect(run.exitCode).toBe(0);
	expect(run.stdout).toBe("");
	expect(run.stderr).toBe("");
}

for (const shell of SHELLS) {
	for (const cell of CELLS) {
		const label = `${cell.agent} ${cell.direct ? "direct" : "relay"} [${shell.name}]`;

		describe(`generated hook command — exclusion check, ${label}`, () => {
			const command = commandFor(cell);
			const markerPath = (sb: Sandbox) => join(sb.home, ".agentpulse", "codex-native", SESSION_ID);

			test("no rules file, no skip variable: the payload is sent, then cleaned up", async () => {
				const sb = newSandbox();
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toContain(`[${BASE}/api/v1/hooks?event=${cell.event}]`);
				expect(run.curlLog).toContain(`[X-Agent-Type: ${cell.agent}]`);
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
				expect(payloadFiles(sb.tmp)).toEqual([]);
			});

			test("a rule that matches the working directory: nothing is sent, payload removed", async () => {
				const sb = newSandbox();
				writeRules(sb.home, [sb.cwd]);
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(payloadFiles(sb.tmp)).toEqual([]);
				if (cell.agent === "codex_cli") {
					expect(existsSync(markerPath(sb)), "the Codex native marker is still written").toBe(true);
				}
			});

			test("a rule for a parent directory excludes a subdirectory", async () => {
				const sb = newSandbox();
				// a rule can't contain '..': name the resolved parent
				writeRules(sb.home, [realpathSync(join(sb.cwd, ".."))]);
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
			});

			test("rules that do not match: the payload is sent", async () => {
				const sb = newSandbox();
				writeRules(sb.home, [join(sb.home, "somewhere-else")]);
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
			});

			for (const skip of ["1", "true", " Yes\r", "\tON\n"]) {
				test(`AGENTPULSE_SKIP=${JSON.stringify(skip)}: nothing is sent`, async () => {
					const sb = newSandbox();
					const run = await runHook(shell, command, sb, { AGENTPULSE_SKIP: skip });
					expectSilentExitZero(run);
					expect(run.curlLog).toBe("");
					expect(payloadFiles(sb.tmp)).toEqual([]);
				});
			}

			test("the Codex native marker is still written when the skip variable stops the send", async () => {
				if (cell.agent !== "codex_cli") return;
				const sb = newSandbox();
				const run = await runHook(shell, command, sb, { AGENTPULSE_SKIP: "1" });
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(existsSync(markerPath(sb))).toBe(true);
			});

			test("the Codex native marker is still written when invalid rules stop the send", async () => {
				if (cell.agent !== "codex_cli") return;
				const sb = newSandbox();
				writeRules(sb.home, [join(sb.home, "x")], 0o660);
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(existsSync(markerPath(sb))).toBe(true);
			});

			test("a non-allowlisted skip value does not stop the send", async () => {
				const sb = newSandbox();
				const run = await runHook(shell, command, sb, { AGENTPULSE_SKIP: "0" });
				expectSilentExitZero(run);
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
			});

			test("invalid rules fail closed: nothing sent, and the invalid marker appears", async () => {
				const sb = newSandbox();
				writeRules(sb.home, [join(sb.home, "x")], 0o660);
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(existsSync(join(sb.home, ".agentpulse", "exclude.invalid"))).toBe(true);
			});

			test("a marker that can't be written does not strand the payload (a failed redirect on a special built-in would end the shell)", async () => {
				const sb = newSandbox();
				writeRules(sb.home, [join(sb.home, "x")], 0o660);
				// the invalid marker's path is a directory: writing it fails
				mkdirSync(join(sb.home, ".agentpulse", "exclude.invalid"));
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(payloadFiles(sb.tmp)).toEqual([]);
			});

			test("an empty HOME fails closed: nothing sent", async () => {
				const sb = newSandbox();
				const run = await runHook(shell, command, sb, { HOME: "" });
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
			});
		});
	}

	describe(`generated hook command — the agent never waits on the check [${shell.name}]`, () => {
		test("a slow exclusion check does not delay the hook's own exit", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "somewhere-else")]);
			// A stub `ls` that takes a second each time: the check runs `ls`, so the detached
			// body is slow while the parent must still return at once.
			const slowDir = join(scratch, `slow-${runIndex}`);
			mkdirSync(slowDir, { recursive: true });
			const realLs = execFileSync("sh", ["-c", "command -v ls"], { encoding: "utf-8" }).trim();
			writeFileSync(join(slowDir, "ls"), `#!/bin/sh\nsleep 1\nexec "${realLs}" "$@"\n`);
			chmodSync(join(slowDir, "ls"), 0o755);

			const command = commandFor({ agent: "codex_cli", direct: false, event: "Stop" });
			const run = await runHook(shell, command, sb, {}, [slowDir]);
			expectSilentExitZero(run);
			// The parent returned long before the multi-second check could finish ...
			expect(run.parentMs).toBeLessThan(2000);
			// ... and the check still ran to completion and let the send through.
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
		});
	});

	describe(`generated hook command — gate and trust [${shell.name}]`, () => {
		const command = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const copilotCommand = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "agentStop",
		});

		test("rules present and no script installed: nothing is sent (fail closed), payload removed", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "somewhere-else")], 0o600, { script: false });
			const run = await runHook(shell, command, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
			expect(payloadFiles(sb.tmp)).toEqual([]);
		});

		test("the script's verdict is what counts: only exit 42 sends; 0, 1, 2 and 3 do not", async () => {
			const sbSend = newSandbox();
			writeRules(sbSend.home, [join(sbSend.home, "x")]);
			installScript(sbSend.home, "#!/bin/sh\nexit 42\n");
			expect((await runHook(shell, command, sbSend)).curlLog).toContain(`BODY ${PAYLOAD}`);

			for (const status of [0, 1, 2, 3, 41, 43]) {
				const sbStop = newSandbox();
				writeRules(sbStop.home, [join(sbStop.home, "x")]);
				installScript(sbStop.home, `#!/bin/sh\nexit ${status}\n`);
				expect((await runHook(shell, command, sbStop)).curlLog, `exit ${status}`).toBe("");
			}
		});

		const damaged: [string, (full: string) => string][] = [
			["an empty script (a crashed install left a zero-length file)", () => ""],
			["a script that is only the shebang line", () => "#!/bin/sh\n"],
			[
				"a script that is only the shebang and the hash line",
				(full) => `${full.split("\n").slice(0, 2).join("\n")}\n`,
			],
			["a script cut off in the middle", (full) => full.slice(0, Math.floor(full.length / 2))],
			["a script with a syntax error", () => "#!/bin/sh\nif then fi (\n"],
		];
		for (const [name, make] of damaged) {
			test(`${name}: nothing is sent although rules exist`, async () => {
				const sb = newSandbox();
				writeRules(sb.home, [join(sb.home, "x")], 0o600, { script: false });
				installScript(sb.home, make(scriptText()));
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toBe("");
				expect(payloadFiles(sb.tmp)).toEqual([]);
			});
		}

		test("the check script installed and no rules file and no marker: the payload is sent, and the script is never run (a probe in its place proves it)", async () => {
			for (const cmd of [command, copilotCommand]) {
				const sb = newSandbox();
				mkdirSync(join(sb.home, ".agentpulse"), { mode: 0o700 });
				const ran = join(sb.root(), "script-ran");
				// A trusted script that leaves a footprint when run; sending needs exit 42.
				installScript(sb.home, `#!/bin/sh\n: > "${ran}"\nexit 42\n`);
				const run = await runHook(shell, cmd, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
				expect(existsSync(ran), "the script ran although there is no rules file").toBe(false);
			}
		});

		test("a stale invalid marker and no rules file: the check runs, clears the marker, and the payload is sent", async () => {
			const sb = newSandbox();
			installScript(sb.home);
			chmodSync(join(sb.home, ".agentpulse"), 0o700);
			const marker = join(sb.home, ".agentpulse", "exclude.invalid");
			writeFileSync(marker, "");
			const run = await runHook(shell, command, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
			expect(existsSync(marker), "the marker is gone").toBe(false);
		});

		test("a stale invalid marker, no rules file and no script: nothing is sent and the marker stays (a check must run)", async () => {
			const sb = newSandbox();
			mkdirSync(join(sb.home, ".agentpulse"), { mode: 0o700 });
			const marker = join(sb.home, ".agentpulse", "exclude.invalid");
			writeFileSync(marker, "");
			const run = await runHook(shell, command, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
			expect(existsSync(marker)).toBe(true);
		});

		test("the generated script, intact, sends when no rule matches (positive control for the damaged-script tests)", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "x")]);
			const run = await runHook(shell, command, sb);
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
		});

		test("the script runs under /bin/sh, not the login shell (a bash-only construct fails there as it would anywhere)", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "x")]);
			// Under /bin/sh this parses and exits 0; the point is that the command names the interpreter.
			installScript(
				sb.home,
				'#!/bin/sh\nif [ -n "$BASH_VERSION" ] || [ -n "$ZSH_VERSION" ]; then exit 42; fi\nexit 42\n',
			);
			expect(command).toContain('/bin/sh "$d/exclude-check.sh"');
			expectSilentExitZero(await runHook(shell, command, sb));
		});

		const untrusted: [string, (sb: Sandbox) => void][] = [
			[
				"a group-writable script",
				(sb) => chmodSync(join(sb.home, ".agentpulse", "exclude-check.sh"), 0o720),
			],
			[
				"a world-writable script",
				(sb) => chmodSync(join(sb.home, ".agentpulse", "exclude-check.sh"), 0o702),
			],
			["a group-writable directory", (sb) => chmodSync(join(sb.home, ".agentpulse"), 0o770)],
			["a world-writable directory", (sb) => chmodSync(join(sb.home, ".agentpulse"), 0o707)],
			[
				"a script that is a link to a good file",
				(sb) => {
					const real = join(sb.home, "real-check.sh");
					writeFileSync(real, "#!/bin/sh\nexit 42\n");
					chmodSync(real, 0o500);
					const link = join(sb.home, ".agentpulse", "exclude-check.sh");
					rmSync(link, { force: true });
					symlinkSync(real, link);
				},
			],
			[
				"a script that is a directory",
				(sb) => {
					const path = join(sb.home, ".agentpulse", "exclude-check.sh");
					rmSync(path, { force: true });
					mkdirSync(path);
				},
			],
		];
		for (const [name, mutate] of untrusted) {
			for (const [which, cmd] of [
				["Copilot", copilotCommand],
				["Codex", command],
			] as const) {
				test(`${name} (${which} command): the script is never run and nothing is sent`, async () => {
					const sb = newSandbox();
					writeRules(sb.home, [join(sb.home, "x")]);
					// A script that would send, so a send proves it ran.
					installScript(sb.home, "#!/bin/sh\nexit 42\n");
					mutate(sb);
					const run = await runHook(shell, cmd, sb);
					try {
						expectSilentExitZero(run);
						expect(run.curlLog).toBe("");
					} finally {
						chmodSync(join(sb.home, ".agentpulse"), 0o700);
					}
				});
			}
		}

		test("a script owned by someone else is refused (a stub id reports another uid)", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "x")]);
			installScript(sb.home, "#!/bin/sh\nexit 42\n");
			const fake = join(scratch, `fake-id-${runIndex}`);
			mkdirSync(fake, { recursive: true });
			writeFileSync(join(fake, "id"), "#!/bin/sh\necho 987654\n");
			chmodSync(join(fake, "id"), 0o755);
			const run = await runHook(shell, copilotCommand, sb, {}, [fake]);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		// Positive control for the next test: the same crafted listing with the
		// real uid in the owner column IS trusted, so the refusal below is the
		// column test and nothing else.
		function fakeLs(uidOwner: string, uidGroup: string): string {
			const fake = join(scratch, `fake-ls-${++runIndex}`);
			mkdirSync(fake, { recursive: true });
			writeFileSync(
				join(fake, "ls"),
				`#!/bin/sh
printf '%s\\n' "drwx------  2 ${uidOwner} ${uidGroup} 64 Jan  1 00:00 $2"
printf '%s\\n' "-r-x------  1 ${uidOwner} ${uidGroup} 90 Jan  1 00:00 $3"
`,
			);
			chmodSync(join(fake, "ls"), 0o755);
			return fake;
		}
		function myUid(): string {
			return String(process.getuid?.() ?? 0);
		}

		test("a listing that names this user as owner is trusted (positive control)", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "x")]);
			installScript(sb.home, "#!/bin/sh\nexit 42\n");
			const run = await runHook(shell, copilotCommand, sb, {}, [fakeLs(myUid(), "98765")]);
			expectSilentExitZero(run);
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
		});

		test("a file owned by someone else whose GROUP is this user's uid is refused (the owner column is read, not any column)", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "x")]);
			installScript(sb.home, "#!/bin/sh\nexit 42\n");
			const run = await runHook(shell, copilotCommand, sb, {}, [fakeLs("98765", myUid())]);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		test("a symlinked ~/.agentpulse pointing at a trusted directory still works", async () => {
			const sb = newSandbox();
			const real = join(sb.root(), "real-agentpulse");
			mkdirSync(real, { mode: 0o700 });
			writeFileSync(join(real, "exclude"), `${join(sb.home, "x")}\n`);
			chmodSync(join(real, "exclude"), 0o600);
			writeFileSync(join(real, "exclude-check.sh"), scriptText());
			chmodSync(join(real, "exclude-check.sh"), 0o500);
			symlinkSync(real, join(sb.home, ".agentpulse"));
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
		});

		test("a ~/.agentpulse that is a dangling link is invalid, not 'no rules': nothing is sent", async () => {
			const sb = newSandbox();
			symlinkSync(join(sb.home, "nowhere"), join(sb.home, ".agentpulse"));
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		test("a ~/.agentpulse that loops is invalid: nothing is sent", async () => {
			const sb = newSandbox();
			symlinkSync(join(sb.home, ".agentpulse"), join(sb.home, ".agentpulse"));
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		test("no ~/.agentpulse at all: sent as before, no script needed", async () => {
			const sb = newSandbox();
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
		});

		test("a rules file that is a symlink is not 'no rules': the script decides (invalid), nothing sent", async () => {
			const sb = newSandbox();
			const dir = join(sb.home, ".agentpulse");
			mkdirSync(dir, { mode: 0o700 });
			writeFileSync(join(sb.home, "real-rules"), `${join(sb.home, "x")}\n`);
			symlinkSync(join(sb.home, "real-rules"), join(dir, "exclude"));
			installScript(sb.home);
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		test("a rules file that is a symlink to nowhere is not 'no rules': the script decides (invalid), nothing sent", async () => {
			const sb = newSandbox();
			const dir = join(sb.home, ".agentpulse");
			mkdirSync(dir, { mode: 0o700 });
			symlinkSync(join(sb.home, "no-such-rules"), join(dir, "exclude"));
			installScript(sb.home);
			const run = await runHook(shell, copilotCommand, sb);
			expectSilentExitZero(run);
			expect(run.curlLog).toBe("");
		});

		test.skipIf(process.getuid?.() === 0)(
			"a ~/.agentpulse that can't be searched is not 'no rules': nothing is sent",
			async () => {
				const sb = newSandbox();
				mkdirSync(join(sb.home, ".agentpulse"), { mode: 0o700 });
				chmodSync(join(sb.home, ".agentpulse"), 0o000);
				try {
					const run = await runHook(shell, copilotCommand, sb);
					expectSilentExitZero(run);
					expect(run.curlLog).toBe("");
				} finally {
					chmodSync(join(sb.home, ".agentpulse"), 0o700);
				}
			},
		);

		// HUP, INT and TERM: the command's own traps name all three. (A background job of a
		// non-interactive shell ignores INT from the start, so that one can only pass by the body
		// finishing; HUP and TERM are the ones a kill actually exercises.)
		for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
			test(`the temp payload is removed even when the detached body is killed with ${signal}`, async () => {
				const sb = newSandbox();
				// A stub curl that records its parent (the detached body) and sleeps.
				const slow = join(scratch, `slow-curl-${++runIndex}`);
				mkdirSync(slow, { recursive: true });
				const pidFile = join(slow, "parent.pid");
				writeFileSync(join(slow, "curl"), `#!/bin/sh\necho $PPID > "${pidFile}"\nsleep 1\n`);
				chmodSync(join(slow, "curl"), 0o755);
				const path = [slow, stubDir, "/usr/bin", "/bin"].join(":");
				const result = spawnSync(shell.bin, [...shell.args, "-c", copilotCommand], {
					cwd: sb.cwd,
					input: PAYLOAD,
					encoding: "utf-8",
					env: {
						PATH: path,
						HOME: sb.home,
						TMPDIR: sb.tmp,
						AP_CURL_LOG: sb.log,
					} as NodeJS.ProcessEnv,
				});
				expect(result.status).toBe(0);
				const started = Date.now();
				while (!existsSync(pidFile) && Date.now() - started < 5000) await Bun.sleep(20);
				expect(existsSync(pidFile), "the detached body reached curl").toBe(true);
				expect(payloadFiles(sb.tmp).length, "the payload exists while curl runs").toBe(1);
				process.kill(Number(readFileSync(pidFile, "utf-8").trim()), signal);
				// The body is killed while curl sleeps for 1 s; a trap cleans up at once. Waiting only a
				// little longer than that fails fast with a clear message if nothing removes the payload
				// (without an EXIT trap the file would stay until the machine's temp sweep).
				const killedAt = Date.now();
				while (payloadFiles(sb.tmp).length > 0 && Date.now() - killedAt < 3000) await Bun.sleep(20);
				expect(
					payloadFiles(sb.tmp),
					`the payload was still there 3 s after ${signal} killed the body`,
				).toEqual([]);
			});
		}

		describe("the Codex native marker", () => {
			const markerFile = (sb: Sandbox) => join(sb.home, ".agentpulse", "codex-native", SESSION_ID);

			test("is created once on a normal run", async () => {
				const sb = newSandbox();
				await runHook(shell, command, sb);
				expect(existsSync(markerFile(sb))).toBe(true);
			});

			test("is not written through a symlink at the marker's path", async () => {
				const sb = newSandbox();
				const victim = join(sb.home, "victim");
				writeFileSync(victim, "keep");
				mkdirSync(join(sb.home, ".agentpulse", "codex-native"), { recursive: true });
				symlinkSync(victim, markerFile(sb));
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(readFileSync(victim, "utf-8")).toBe("keep");
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
			});

			test("is not written through a symlink at a dangling marker path", async () => {
				const sb = newSandbox();
				const victim = join(sb.home, "created-by-attack");
				mkdirSync(join(sb.home, ".agentpulse", "codex-native"), { recursive: true });
				symlinkSync(victim, markerFile(sb));
				await runHook(shell, command, sb);
				expect(existsSync(victim)).toBe(false);
			});

			test("is not written into a symlinked codex-native directory", async () => {
				const sb = newSandbox();
				const elsewhere = join(sb.home, "elsewhere");
				mkdirSync(elsewhere);
				mkdirSync(join(sb.home, ".agentpulse"), { recursive: true });
				symlinkSync(elsewhere, join(sb.home, ".agentpulse", "codex-native"));
				await runHook(shell, command, sb);
				expect(readdirSync(elsewhere)).toEqual([]);
			});

			test("a marker path that can't be created (a directory) does not end the shell: the payload is still sent", async () => {
				const sb = newSandbox();
				mkdirSync(markerFile(sb), { recursive: true });
				const run = await runHook(shell, command, sb);
				expectSilentExitZero(run);
				expect(run.curlLog).toContain(`BODY ${PAYLOAD}`);
			});
		});
	});
}

// What the stub curl was actually asked to do, token by token (the stub logs
// every argument in brackets), with the key file planted in a direct run.
for (const shell of SHELLS) {
	describe(`generated hook command — the executed curl argv [${shell.name}]`, () => {
		const argvOf = (log: string): string[] => {
			const line = log.split("\n").find((l) => l.startsWith("CURL "));
			return line ? [...line.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] as string) : [];
		};
		const head = (agent: string, event: string) => [
			"-sS",
			"--max-time",
			"2",
			"-o",
			"/dev/null",
			"-X",
			"POST",
			`${BASE}/api/v1/hooks?event=${event}`,
			"-H",
			"Content-Type: application/json",
			"-H",
			`X-Agent-Type: ${agent}`,
		];

		test("relay form: no auth header, the temp payload as --data-binary @file", async () => {
			const sb = newSandbox();
			const run = await runHook(shell, commandFor(CELLS[0]), sb);
			const argv = argvOf(run.curlLog);
			expect(argv.slice(0, -1)).toEqual([...head("codex_cli", "Stop"), "--data-binary"]);
			expect(argv.at(-1)).toMatch(
				new RegExp(`^@${sb.tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agentpulse-hook\\.`),
			);
		});

		test("direct form with a key file planted: -H @<key file> sits between the agent header and the payload", async () => {
			const sb = newSandbox();
			const keyFile = join(sb.home, ".agentpulse", "hook-auth-header");
			mkdirSync(join(sb.home, ".agentpulse"), { recursive: true });
			writeFileSync(keyFile, "Authorization: Bearer ap_test\n");
			const run = await runHook(shell, commandFor(CELLS[3]), sb);
			const argv = argvOf(run.curlLog);
			expect(argv.slice(0, -1)).toEqual([
				...head("copilot_cli", "agentStop"),
				"-H",
				`@${keyFile}`,
				"--data-binary",
			]);
			expect(argv.at(-1)).toMatch(/^@.*agentpulse-hook\./);
		});

		test("direct form with no key file (or an empty one): the same call without the header", async () => {
			for (const content of [null, ""]) {
				const sb = newSandbox();
				if (content !== null) {
					mkdirSync(join(sb.home, ".agentpulse"), { recursive: true });
					writeFileSync(join(sb.home, ".agentpulse", "hook-auth-header"), content);
				}
				const run = await runHook(shell, commandFor(CELLS[3]), sb);
				const argv = argvOf(run.curlLog);
				expect(argv.slice(0, -1)).toEqual([...head("copilot_cli", "agentStop"), "--data-binary"]);
			}
		});

		test("the send still happens with the check run (rules present, no match): same argv", async () => {
			const sb = newSandbox();
			writeRules(sb.home, [join(sb.home, "elsewhere")]);
			const run = await runHook(shell, commandFor(CELLS[0]), sb);
			expect(argvOf(run.curlLog).slice(0, -1)).toEqual([
				...head("codex_cli", "Stop"),
				"--data-binary",
			]);
		});
	});
}

describe("generated hook command — the curl invocation is unchanged", () => {
	// The exact text the command carried before the check was added.
	const relayCurl = (agent: string, event: string) =>
		`curl -sS --max-time 2 -o /dev/null -X POST '${BASE}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}' --data-binary "@$t"`;

	test("relay form carries the old curl text byte for byte", () => {
		for (const [agent, event] of [
			["codex_cli", "Stop"],
			["copilot_cli", "agentStop"],
		] as const) {
			const cmd = buildBashHookCommand({ baseUrl: BASE, direct: false, agent, event });
			expect(cmd).toContain(relayCurl(agent, event));
		}
	});

	test("direct form carries both old curl texts byte for byte", () => {
		for (const [agent, event] of [
			["codex_cli", "Stop"],
			["copilot_cli", "agentStop"],
		] as const) {
			const cmd = buildBashHookCommand({ baseUrl: BASE, direct: true, agent, event });
			expect(cmd).toContain(relayCurl(agent, event));
			expect(cmd).toContain(
				`curl -sS --max-time 2 -o /dev/null -X POST '${BASE}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}' -H "@$f" --data-binary "@$t"`,
			);
		}
	});
});

// The hook's one synchronous step is creating its temp payload file. When the temp directory can't be
// written to, the command must stop there in every rules state: nothing is sent (not even the states
// that would send), nothing is printed, it exits 0, and no half-made file is left behind.
describe("generated hook command, read-only TMPDIR", () => {
	type RulesState = { name: string; arrange: (sb: Sandbox) => void; sendsWhenWritable: boolean };
	const STATES: RulesState[] = [
		{ name: "no rules file", arrange: () => {}, sendsWhenWritable: true },
		{
			name: "rules that don't match",
			arrange: (sb) => void writeRules(sb.home, [join(sb.home, "somewhere-else")]),
			sendsWhenWritable: true,
		},
		{
			name: "a rule that matches the directory",
			arrange: (sb) => void writeRules(sb.home, [sb.cwd]),
			sendsWhenWritable: false,
		},
		{
			name: "an invalid rules file",
			arrange: (sb) => void writeRules(sb.home, [join(sb.home, "x")], 0o660),
			sendsWhenWritable: false,
		},
	];

	for (const shell of SHELLS) {
		for (const cell of CELLS) {
			for (const state of STATES) {
				test(`${cell.agent} ${cell.direct ? "direct" : "relay"} [${shell.name}], ${state.name}: silent exit 0, nothing sent, nothing left`, async () => {
					const command = commandFor(cell);

					// Positive control: with a writable TMPDIR this state sends, or doesn't, as the matrix says.
					const control = newSandbox();
					state.arrange(control);
					const controlRun = await runHook(shell, command, control);
					expectSilentExitZero(controlRun);
					expect(controlRun.curlLog !== "", "the control run's send").toBe(state.sendsWhenWritable);

					const sb = newSandbox();
					state.arrange(sb);
					chmodSync(sb.tmp, 0o500);
					try {
						const run = await runHook(shell, command, sb);
						expectSilentExitZero(run);
						expect(run.curlLog).toBe("");
						expect(payloadFiles(sb.tmp)).toEqual([]);
					} finally {
						chmodSync(sb.tmp, 0o700);
					}
				});
			}
		}
	}
});
