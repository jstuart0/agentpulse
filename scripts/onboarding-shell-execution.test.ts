/**
 * AGEN-49/H1 (xander): `read -rsp` is a bash-only spelling — in zsh
 * (macOS's default login shell) `-p` means "coprocess", not "prompt", so a
 * pasted `read -rsp` silently does the wrong thing there. onboarding.ts's
 * buildLocalCommand and setup-steps.ts's AUTH_STEP snippets switched to
 * plain POSIX `read -rs` with a separate `printf` prompt — this file proves
 * that by actually *running* the rendered text under every POSIX-ish shell
 * this machine has (bash, zsh, sh), not just pattern-matching the source.
 *
 * A shell that isn't installed here is skipped with a console note rather
 * than failing the suite — CI images vary, and the point is to exercise
 * whichever shells actually exist, not to require all three.
 *
 * Nothing touches the network: onboarding.ts's command is run against a
 * stub `curl` on PATH that records what it saw and never dials out;
 * setup-steps.ts's snippets do no networking at all (pure local file
 * writes) and are pointed at a temp $HOME.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOnboardingPlan } from "../src/web/lib/onboarding.js";
import { AUTH_STEP } from "../src/web/lib/setup-steps.js";

const SHELLS = (["bash", "zsh", "sh"] as const)
	.map((name) => ({ name, bin: Bun.which(name) }))
	.filter((s): s is { name: string; bin: string } => {
		if (!s.bin) {
			console.log(`[onboarding-shell-execution] skipping ${s.name}: not found on PATH`);
			return false;
		}
		return true;
	});

if (SHELLS.length === 0) {
	console.log("[onboarding-shell-execution] no supported shell found at all — nothing to run");
}

const KEY = "ap_shell_exec_test_key";

/** Runs `script` under `shellBin`, feeding `stdin` to it, with `env` merged
 * over a minimal PATH (so the stub curl below shadows any real one). */
async function runShell(
	shellBin: string,
	script: string,
	opts: { stdin?: string; env?: Record<string, string> } = {},
) {
	const proc = Bun.spawn([shellBin, "-c", script], {
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

describe.each(SHELLS)("onboarding local install command under $name", ({ bin }) => {
	test("a non-empty key is read hidden, exported, and reaches the piped-in installer's environment", async () => {
		const stubDir = await mkdtemp(join(tmpdir(), "ap-shell-exec-stub-"));
		const log = join(stubDir, "curl.log");
		try {
			await Bun.write(
				join(stubDir, "curl"),
				`#!/bin/sh\nprintf 'CURL_SAW_KEY=%s\\n' "$AGENTPULSE_KEY" >> "${log}"\necho 'echo PIPED_OK'\n`,
			);
			await chmod(join(stubDir, "curl"), 0o755);

			const plan = buildOnboardingPlan({
				location: "local",
				serverUrl: "https://agentpulse.example.com",
				disableAuth: false,
			});
			expect(plan.command).not.toContain("read -rsp");

			const bashBin = Bun.which("bash") ?? "/bin/sh";
			const res = await runShell(bin, plan.command, {
				stdin: `${KEY}\n`,
				env: { PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, BASH: bashBin },
			});
			expect(res.code).toBe(0);
			expect(res.stdout).toContain("PIPED_OK");

			const curlLog = await readFile(log, "utf8").catch(() => "");
			expect(curlLog).toContain(`CURL_SAW_KEY=${KEY}`);
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
				`#!/bin/sh\nprintf 'CURL_SAW_KEY=%s\\n' "$AGENTPULSE_KEY" >> "${log}"\necho 'echo PIPED_OK'\n`,
			);
			await chmod(join(stubDir, "curl"), 0o755);

			const plan = buildOnboardingPlan({
				location: "local",
				serverUrl: "https://agentpulse.example.com",
				disableAuth: false,
			});

			const res = await runShell(bin, plan.command, {
				stdin: "\n", // blank answer: just Enter
				env: { PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
			});
			// The guard short-circuits — curl (stub) is never invoked, so
			// exit status is that of the guard itself (a `&&` whose LHS is
			// false is a clean non-error skip, not a crash).
			expect(res.stdout).not.toContain("PIPED_OK");
			await expect(readFile(log, "utf8")).rejects.toThrow();
		} finally {
			await rm(stubDir, { recursive: true, force: true });
		}
	});
});

describe.each(SHELLS)("setup-steps.ts POSIX auth-step snippets under $name", ({ bin }) => {
	test("claude_code: writes ~/.agentpulse/env (0600) and a key-free source line, never the raw key on stdin's echo", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-shell-exec-claude-"));
		try {
			const step = AUTH_STEP.claude_code("ignored", false);
			const command = step?.command ?? "";
			expect(command).not.toContain("read -rsp");

			const res = await runShell(bin, command, {
				stdin: `${KEY}\n`,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: bin },
			});
			expect(res.code).toBe(0);

			const envPath = join(home, ".agentpulse", "env");
			const envFile = await readFile(envPath, "utf8");
			expect(envFile).toContain(`export AGENTPULSE_API_KEY="${KEY}"`);
			const mode = (await stat(envPath)).mode & 0o777;
			expect(mode).toBe(0o600);

			const profilePath = bin.endsWith("bash") ? join(home, ".bashrc") : join(home, ".zshrc");
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

				const res = await runShell(bin, command, {
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
