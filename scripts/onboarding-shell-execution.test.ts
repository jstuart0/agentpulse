/**
 * The setup snippets read the API key at a hidden prompt. `read -s` is a
 * bash/zsh/ksh extension, not POSIX: dash (the `sh` on Debian and Ubuntu)
 * rejects it, leaves the variable empty, and a snippet that carries on then
 * writes an empty credential. This file proves the rendered text works by
 * actually *running* it under every POSIX shell this machine has: /bin/sh,
 * dash, `bash --posix`, plus bash and zsh themselves. The shell used is part
 * of each test's name, so a run on a host without dash says so.
 *
 * Nothing touches the network: onboarding.ts's command is run against a
 * stub `curl` on PATH that records what it saw and never dials out;
 * setup-steps.ts's snippets do no networking at all (pure local file
 * writes) and are pointed at a temp $HOME.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildOnboardingPlan } from "../src/web/lib/onboarding.js";
import { AUTH_STEP } from "../src/web/lib/setup-steps.js";

type TestShell = { name: string; bin: string; args: string[] };

function findShells(): TestShell[] {
	const candidates: { name: string; bin: string | null | undefined; args: string[] }[] = [
		{ name: "/bin/sh", bin: existsSync("/bin/sh") ? "/bin/sh" : null, args: [] },
		{
			name: "dash",
			bin: Bun.which("dash") ?? (existsSync("/bin/dash") ? "/bin/dash" : null),
			args: [],
		},
		{ name: "bash --posix", bin: Bun.which("bash"), args: ["--posix"] },
		{ name: "bash", bin: Bun.which("bash"), args: [] },
		{ name: "zsh", bin: Bun.which("zsh"), args: [] },
	];
	return candidates.flatMap((c) => {
		if (!c.bin) {
			console.log(`[onboarding-shell-execution] skipping ${c.name}: not found`);
			return [];
		}
		return [{ name: c.name, bin: c.bin, args: c.args }];
	});
}

const SHELLS = findShells();

if (SHELLS.length === 0) {
	console.log("[onboarding-shell-execution] no supported shell found at all — nothing to run");
}

const KEY = "ap_shell_exec_test_key";

/** Runs `script` under `shellBin`, feeding `stdin` to it, with `env` merged
 * over a minimal PATH (so the stub curl below shadows any real one). */
async function runShell(
	shell: TestShell,
	script: string,
	opts: { stdin?: string; env?: Record<string, string> } = {},
) {
	const proc = Bun.spawn([shell.bin, ...shell.args, "-c", script], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...opts.env },
	});
	if (opts.stdin !== undefined) {
		proc.stdin.write(opts.stdin);
	}
	await proc.stdin.end();
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

describe.each(SHELLS)("onboarding local install command under $name", (shell) => {
	test("a non-empty key is read hidden, exported, and reaches the piped-in installer's environment", async () => {
		const stubDir = await mkdtemp(join(tmpdir(), "ap-shell-exec-stub-"));
		const log = join(stubDir, "curl.log");
		try {
			await Bun.write(
				join(stubDir, "curl"),
				`#!/bin/sh\ncat <<'EOF'\nprintf 'INSTALLER_SAW_KEY=%s\\n' "$AGENTPULSE_KEY" >> "${log}"\necho PIPED_OK\nEOF\n`,
			);
			await chmod(join(stubDir, "curl"), 0o755);

			const plan = buildOnboardingPlan({
				location: "local",
				serverUrl: "https://agentpulse.example.com",
				disableAuth: false,
			});
			expect(plan.command).not.toContain("read -rsp");

			const bashBin = Bun.which("bash") ?? "/bin/sh";
			const res = await runShell(shell, plan.command, {
				stdin: `${KEY}\n`,
				env: { PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, BASH: bashBin },
			});
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("PIPED_OK");

			const curlLog = await readFile(log, "utf8").catch(() => "");
			expect(curlLog).toContain(`INSTALLER_SAW_KEY=${KEY}`);
		} finally {
			await rm(stubDir, { recursive: true, force: true });
		}
	});

	test("an empty key never invokes curl (the [ -n ... ] && guard)", async () => {
		const stubDir = await mkdtemp(join(tmpdir(), "ap-shell-exec-stub-empty-"));
		const log = join(stubDir, "curl.log");
		try {
			await Bun.write(
				join(stubDir, "curl"),
				`#!/bin/sh\ncat <<'EOF'\nprintf 'INSTALLER_SAW_KEY=%s\\n' "$AGENTPULSE_KEY" >> "${log}"\necho PIPED_OK\nEOF\n`,
			);
			await chmod(join(stubDir, "curl"), 0o755);

			const plan = buildOnboardingPlan({
				location: "local",
				serverUrl: "https://agentpulse.example.com",
				disableAuth: false,
			});

			const res = await runShell(shell, plan.command, {
				stdin: "\n", // blank answer: just Enter
				env: { PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
			});
			// The guard short-circuits — curl (stub) is never invoked, so
			// exit status is that of the guard itself (a `&&` whose LHS is
			// false is a clean non-error skip, not a crash).
			expect(res.stdout).not.toContain("PIPED_OK");
			await expect(readFile(log, "utf8")).rejects.toThrow();
			expect(res.code).not.toBe(0);
			expect(res.stderr).toContain("No API key entered");
		} finally {
			await rm(stubDir, { recursive: true, force: true });
		}
	});
});

describe.each(SHELLS)("setup-steps.ts POSIX auth-step snippets under $name", (shell) => {
	test("claude_code: writes ~/.agentpulse/env (0600) and a key-free source line, never the raw key on stdin's echo", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-claude-"));
		try {
			const step = AUTH_STEP.claude_code("ignored", false);
			const command = step?.command ?? "";
			expect(command).not.toContain("read -rsp");

			const res = await runShell(shell, command, {
				stdin: `${KEY}\n`,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: shell.bin },
			});
			expect(res.code).toBe(0);

			const envPath = join(home, ".agentpulse", "env");
			const envFile = await readFile(envPath, "utf8");
			expect(envFile).toContain(`export AGENTPULSE_API_KEY="${KEY}"`);
			const mode = (await stat(envPath)).mode & 0o777;
			expect(mode).toBe(0o600);

			const profilePath =
				basename(shell.bin) === "bash" ? join(home, ".bashrc") : join(home, ".zshrc");
			const profile = await readFile(profilePath, "utf8").catch(() => "");
			expect(profile).not.toContain(KEY);
			expect(profile).toContain(".agentpulse/env");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("codex_cli/copilot_cli: writes hook-auth-header (0600), key never appears in stdout/stderr", async () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			const home = await mkdtemp(join(tmpdir(), `ap-shell-exec-${agent}-`));
			try {
				const step = AUTH_STEP[agent]("ignored", false);
				const command = step?.command ?? "";
				expect(command).not.toContain("read -rsp");

				const res = await runShell(shell, command, {
					stdin: `${KEY}\n`,
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
				});
				expect(res.code).toBe(0);
				expect(res.stdout).not.toContain(KEY);
				expect(res.stderr).not.toContain(KEY);

				const headerPath = join(home, ".agentpulse", "hook-auth-header");
				const header = await readFile(headerPath, "utf8");
				expect(header).toBe(`Authorization: Bearer ${KEY}\n`);
				const mode = (await stat(headerPath)).mode & 0o777;
				expect(mode).toBe(0o600);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		}
	});
});

describe.each(SHELLS)(
	"an empty or failed key read never writes a credential under $name",
	(shell) => {
		for (const [label, stdin] of [
			["blank answer (just Enter)", "\n"],
			["closed input (Ctrl-D, no data)", ""],
		] as const) {
			test(`${label}: no env file, no header file, clear error, non-zero exit`, async () => {
				for (const agent of ["claude_code", "codex_cli", "copilot_cli"] as const) {
					const home = await mkdtemp(join(tmpdir(), `ap-shell-exec-empty-${agent}-`));
					try {
						const command = AUTH_STEP[agent]("ignored", false)?.command ?? "";
						const res = await runShell(shell, command, {
							stdin,
							env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: shell.bin },
						});
						expect(res.code).not.toBe(0);
						expect(res.stderr).toContain("No API key entered");
						const file = agent === "claude_code" ? "env" : "hook-auth-header";
						await expect(readFile(join(home, ".agentpulse", file), "utf8")).rejects.toThrow();
						await expect(readFile(join(home, ".zshrc"), "utf8")).rejects.toThrow();
						await expect(readFile(join(home, ".bashrc"), "utf8")).rejects.toThrow();
					} finally {
						await rm(home, { recursive: true, force: true });
					}
				}
			});
		}
	},
);

const PYTHON = Bun.which("python3");

// Drives a snippet on a real pseudo-terminal. It waits for the prompt text (no
// fixed sleep), reports whether terminal echo was off while the prompt waited
// and back on afterwards, then either types a key or sends Ctrl-C.
const PTY_DRIVER = `
import os, pty, sys, time, select, json, termios, signal
cfg = json.loads(os.environ["AP_PTY_CFG"])
pid, fd = pty.fork()
if pid == 0:
    os.execv(cfg["argv"][0], cfg["argv"])
out = b""
state = {"status": None}
def reaped():
    if state["status"] is None:
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            state["status"] = st
    return state["status"] is not None
def pump(until, timeout):
    global out
    end = time.time() + timeout
    while time.time() < end:
        if until():
            return True
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                time.sleep(0.02)
                continue
            if d:
                out += d
    return until()
def echo_on():
    try:
        return bool(termios.tcgetattr(fd)[3] & termios.ECHO)
    except Exception:
        return None
saw = pump(lambda: b"API key:" in out or reaped(), 8)
at_prompt = echo_on() if b"API key:" in out and not reaped() else None
if b"API key:" in out and not reaped():
    os.write(fd, cfg["send"].encode())
exited = pump(reaped, 4)
if not exited:
    os.kill(pid, signal.SIGKILL)
    pump(reaped, 2)
pump(lambda: False, 0.2)
print(json.dumps({"out": out.decode("latin1"), "prompt_seen": b"API key:" in out,
    "echo_at_prompt": at_prompt, "echo_after": echo_on(), "exited_on_its_own": exited,
    "exit_code": (os.WEXITSTATUS(state["status"]) if state["status"] is not None and os.WIFEXITED(state["status"]) else None),
    "killed_by_signal": (os.WTERMSIG(state["status"]) if state["status"] is not None and os.WIFSIGNALED(state["status"]) else None)}))
`;

type PtyResult = {
	out: string;
	prompt_seen: boolean;
	echo_at_prompt: boolean | null;
	echo_after: boolean | null;
	exited_on_its_own: boolean;
	exit_code: number | null;
	killed_by_signal: number | null;
};

async function runOnPty(
	shell: TestShell,
	script: string,
	opts: { send: string; home: string; path?: string },
): Promise<PtyResult> {
	const proc = Bun.spawn([PYTHON as string, "-c", PTY_DRIVER], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: opts.path ?? process.env.PATH ?? "/usr/bin:/bin",
			HOME: opts.home,
			TERM: "dumb",
			AP_PTY_CFG: JSON.stringify({
				argv: [shell.bin, ...shell.args, "-c", script],
				send: opts.send,
			}),
		},
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	expect(err).toBe("");
	return JSON.parse(out) as PtyResult;
}

const codexSnippet = () => AUTH_STEP.codex_cli("ignored", false)?.command ?? "";
const claudeSnippet = () => AUTH_STEP.claude_code("ignored", false)?.command ?? "";

describe.each(SHELLS)("hidden prompt on a real terminal under $name", (shell) => {
	test.skipIf(!PYTHON)(
		"input is hidden while the prompt waits, the key is written, and echo is restored",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-pty-"));
			try {
				const r = await runOnPty(shell, codexSnippet(), { send: "ap_pty_secret_key\n", home });
				expect(r.prompt_seen).toBe(true);
				expect(r.echo_at_prompt).toBe(false);
				expect(r.out).not.toContain("ap_pty_secret_key");
				expect(r.exit_code).toBe(0);
				expect(r.echo_after).toBe(true);
				const header = await readFile(join(home, ".agentpulse", "hook-auth-header"), "utf8");
				expect(header).toBe("Authorization: Bearer ap_pty_secret_key\n");
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!PYTHON)(
		"Ctrl-C at the prompt aborts promptly, restores echo and writes nothing",
		async () => {
			for (const snippet of [codexSnippet(), claudeSnippet()]) {
				const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-ctrlc-"));
				try {
					// Run it from a parent that survives Ctrl-C, like the interactive
					// shell the snippet is pasted into; a bare `sh -c` would die with it
					// before the prompt's own cleanup could finish.
					const pasted = `trap : INT; ${snippet}; st=$?; sleep 0.5; exit $st`;
					const r = await runOnPty(shell, pasted, { send: "\x03", home });
					expect(r.prompt_seen, JSON.stringify(r)).toBe(true);
					expect(
						r.exited_on_its_own,
						`still waiting for Enter after Ctrl-C: ${JSON.stringify(r)}`,
					).toBe(true);
					expect(r.exit_code === 0).toBe(false);
					expect(r.echo_after).toBe(true);
					await expect(
						readFile(join(home, ".agentpulse", "hook-auth-header"), "utf8"),
					).rejects.toThrow();
					await expect(readFile(join(home, ".agentpulse", "env"), "utf8")).rejects.toThrow();
					await expect(readFile(join(home, ".zshrc"), "utf8")).rejects.toThrow();
					await expect(readFile(join(home, ".bashrc"), "utf8")).rejects.toThrow();
				} finally {
					await rm(home, { recursive: true, force: true });
				}
			}
		},
	);

	test.skipIf(!PYTHON)("when input cannot be hidden the key is refused, not shown", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-nostty-"));
		const bin = await mkdtemp(join(tmpdir(), "ap-shell-exec-fakestty-"));
		try {
			// A stty that can report its state but cannot turn echo off.
			await Bun.write(
				join(bin, "stty"),
				'#!/bin/sh\nif [ "$1" = "-g" ]; then echo saved; exit 0; fi\nexit 1\n',
			);
			await chmod(join(bin, "stty"), 0o755);
			const r = await runOnPty(shell, codexSnippet(), {
				send: "ap_pty_secret_key\n",
				home,
				path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			});
			expect(r.exited_on_its_own).toBe(true);
			expect(r.exit_code === 0).toBe(false);
			expect(r.out).toMatch(/can't hide/i);
			expect(r.out).not.toContain("ap_pty_secret_key");
			await expect(
				readFile(join(home, ".agentpulse", "hook-auth-header"), "utf8"),
			).rejects.toThrow();
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(bin, { recursive: true, force: true });
		}
	});
});

describe.each(SHELLS)(
	"the key and the user's shell state after the snippet under $name",
	(shell) => {
		test("no key variable or export is left behind, and the user's traps are untouched", async () => {
			const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-hygiene-"));
			try {
				for (const snippet of [claudeSnippet(), codexSnippet()]) {
					const script = `trap 'echo MY_TRAP' INT; ${snippet}; printf 'LEFT:%s:%s:%s:%s\\n' "\${key-unset}" "\${AGENTPULSE_KEY-unset}" "\${ap_key-unset}" "\${AGENTPULSE_API_KEY-unset}"; trap`;
					const res = await runShell(shell, script, {
						stdin: `${KEY}\n`,
						env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: shell.bin },
					});
					expect(res.stdout).toContain("LEFT:unset:unset:unset:unset");
					expect(res.stdout).toContain("echo MY_TRAP");
					expect(res.stdout + res.stderr).not.toContain(KEY);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});

		test("the onboarding command does not leave AGENTPULSE_KEY exported either", async () => {
			const stubDir = await mkdtemp(join(tmpdir(), "ap-shell-exec-stub-hygiene-"));
			try {
				await Bun.write(join(stubDir, "curl"), "#!/bin/sh\necho 'echo PIPED_OK'\n");
				await chmod(join(stubDir, "curl"), 0o755);
				const plan = buildOnboardingPlan({
					location: "local",
					serverUrl: "https://agentpulse.example.com",
					disableAuth: false,
				});
				const res = await runShell(
					shell,
					`${plan.command}\nprintf 'LEFT:%s:%s\\n' "\${AGENTPULSE_KEY-unset}" "\${ap_key-unset}"`,
					{
						stdin: `${KEY}\n`,
						env: { PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
					},
				);
				expect(res.stdout).toContain("PIPED_OK");
				expect(res.stdout).toContain("LEFT:unset:unset");
			} finally {
				await rm(stubDir, { recursive: true, force: true });
			}
		});
	},
);

describe.each(SHELLS)(
	"keys with unexpected characters, and failed writes, under $name",
	(shell) => {
		const bad = [
			'ap_x"; touch pwned; "',
			"ap key",
			"ap$(touch pwned)",
			"ap`touch pwned`",
			"ap\\x",
			"ap'x",
			"ap_é",
		];
		test("a key outside [A-Za-z0-9._-] is refused with a clear message and nothing is written", async () => {
			for (const typed of bad) {
				for (const agent of ["claude_code", "codex_cli"] as const) {
					const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-badkey-"));
					try {
						const command = AUTH_STEP[agent]("ignored", false)?.command ?? "";
						const res = await runShell(shell, command, {
							stdin: `${typed}\n`,
							env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: shell.bin },
						});
						expect(res.code, typed).not.toBe(0);
						expect(res.stderr, typed).toContain("can only contain");
						expect(res.stderr + res.stdout).not.toContain(typed);
						await expect(readFile(join(home, "pwned"), "utf8")).rejects.toThrow();
						await expect(readFile(join(process.cwd(), "pwned"), "utf8")).rejects.toThrow();
						await expect(readFile(join(home, ".agentpulse", "env"), "utf8")).rejects.toThrow();
						await expect(
							readFile(join(home, ".agentpulse", "hook-auth-header"), "utf8"),
						).rejects.toThrow();
					} finally {
						await rm(home, { recursive: true, force: true });
					}
				}
			}
		});

		test("allowed punctuation in a key is accepted", async () => {
			const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-okkey-"));
			try {
				const res = await runShell(shell, codexSnippet(), {
					stdin: "ap_Key-1.2_x\n",
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
				});
				expect(res.code).toBe(0);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});

		test("a refused write exits non-zero and does not go on to edit the profile", async () => {
			const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-nowrite-"));
			const elsewhere = await mkdtemp(join(tmpdir(), "ap-shell-exec-elsewhere-"));
			try {
				await symlink(elsewhere, join(home, ".agentpulse"));
				const res = await runShell(shell, claudeSnippet(), {
					stdin: `${KEY}\n`,
					env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: shell.bin },
				});
				expect(res.code).not.toBe(0);
				expect(res.stderr).toContain("refusing");
				await expect(readFile(join(home, ".zshrc"), "utf8")).rejects.toThrow();
				await expect(readFile(join(home, ".bashrc"), "utf8")).rejects.toThrow();
				await expect(readFile(join(elsewhere, "env"), "utf8")).rejects.toThrow();
			} finally {
				await rm(home, { recursive: true, force: true });
				await rm(elsewhere, { recursive: true, force: true });
			}
		});
	},
);
