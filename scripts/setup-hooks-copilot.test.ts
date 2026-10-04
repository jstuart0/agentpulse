/**
 * Phase 7 (D8): scripts/setup-hooks.sh --agent copilot_cli's two D8-specific
 * refusals — --scope project (Copilot's cloud agent loads .github/hooks/,
 * a path this installer doesn't write) and "Copilot CLI not detected".
 * Detection-gated writing (the positive path) is covered by
 * installers-run.test.ts's setup-relay.sh test; this file covers
 * setup-hooks.sh's own CLI-flag refusals directly, with no server needed.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests start real shell installers; under load one can take longer than Bun's 5 s default.
setDefaultTimeout(60_000);

const INSTALLER = join(import.meta.dir, "setup-hooks.sh");

// D8's own detection tests need a `copilot`-free PATH for a deterministic
// "not detected" outcome — but every agent branch shells out to python3
// (ap_codex_hooks_json / ap_copilot_hooks_json, and the Claude branch's
// `python3 -m json.tool` pretty-print), and this bare PATH has no fast
// python3 on it. On a machine where /usr/bin/python3 is Apple's Xcode-CLT
// stub rather than a real install, that blocks (sometimes indefinitely) on
// a GUI installer prompt instead of running — the exact class of flake
// installers-run.test.ts's sanitizedPath was built to dodge. F234's own
// tests below don't exercise Copilot detection at all, so they use
// DEFAULT_PATH's real PATH (a real, fast python3 included) instead.
const NO_COPILOT_PATH = "/usr/bin:/bin";
const DEFAULT_PATH = process.env.PATH ?? NO_COPILOT_PATH;

async function run(
	args: string[],
	home: string,
	extraEnv: Record<string, string> = {},
	path: string = NO_COPILOT_PATH,
) {
	const proc = Bun.spawn(["bash", INSTALLER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: path, HOME: home, ...extraEnv },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err };
}

describe("setup-hooks.sh --agent copilot_cli (D8)", () => {
	test("--scope project is refused: Copilot's cloud agent loads .github/hooks/, not this installer's path", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-setup-hooks-copilot-"));
		try {
			const res = await run(
				[
					"--url",
					"http://localhost:1",
					"--key",
					"ap_test",
					"--agent",
					"copilot_cli",
					"--scope",
					"project",
				],
				home,
			);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("--scope project is not supported");
			expect(res.out).toContain(".github/hooks/");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("copilot not detected (no binary on PATH, no ~/.copilot dir): refuses with a clear message, writes nothing", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-setup-hooks-copilot-"));
		try {
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_test", "--agent", "copilot_cli"],
				home,
			);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("Copilot CLI not detected");
			await expect(
				Bun.file(join(home, ".copilot", "hooks", "agentpulse.json")).exists(),
			).resolves.toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("F234 (Low): AGENTPULSE_KEY env var is an alternative to --key (keeps the key out of `ps`)", () => {
	test("no --key flag, AGENTPULSE_KEY set in the environment: the installer proceeds instead of erroring", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-setup-hooks-envkey-"));
		try {
			const res = await run(
				["--url", "http://localhost:1"],
				home,
				{ AGENTPULSE_KEY: "ap_from_env_not_argv" },
				DEFAULT_PATH,
			);
			expect(res.out).not.toContain("Error: --key is required");
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".claude", "settings.json")).text()).toContain(
				"claude_code",
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("neither --key nor AGENTPULSE_KEY: still refuses with the existing error", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-setup-hooks-envkey-"));
		try {
			const res = await run(["--url", "http://localhost:1"], home);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("Error: --key is required");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--key flag still overrides AGENTPULSE_KEY when both are present", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-setup-hooks-envkey-"));
		try {
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_from_argv"],
				home,
				// SHELL="/bin/sh" (neither zsh nor bash) makes the profile path
				// deterministic (~/.profile) rather than depending on this
				// test-runner's own $SHELL.
				{ AGENTPULSE_KEY: "ap_from_env_should_be_overridden", SHELL: "/bin/sh" },
				DEFAULT_PATH,
			);
			expect(res.code).toBe(0);
			// D37/F243: the key itself now lives in ~/.agentpulse/env (0600),
			// never the rc file — the rc file only gets a key-free source line.
			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_from_argv");
			expect(envFile).not.toContain("ap_from_env_should_be_overridden");
			const profile = await Bun.file(join(home, ".profile"))
				.text()
				.catch(() => "");
			expect(profile).not.toContain("ap_from_argv");
			expect(profile).not.toContain("ap_from_env_should_be_overridden");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("D37/F243: the API key never lands in a shell rc file", () => {
	test("claude_code: key goes to ~/.agentpulse/env (0600), rc file gets only a key-free source line", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-d37-claude-"));
		try {
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_secret_key_value"],
				home,
				{ SHELL: "/bin/sh" },
				DEFAULT_PATH,
			);
			expect(res.code).toBe(0);

			const envPath = join(home, ".agentpulse", "env");
			const envFile = await Bun.file(envPath).text();
			expect(envFile).toContain('export AGENTPULSE_API_KEY="ap_secret_key_value"');
			const mode = (await stat(envPath)).mode & 0o777;
			expect(mode).toBe(0o600);

			const profile = await Bun.file(join(home, ".profile")).text();
			expect(profile).not.toContain("ap_secret_key_value");
			expect(profile).toContain('[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("codex_cli: no profile write at all — no ~/.agentpulse/env, no rc file touched", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-d37-codex-"));
		try {
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_secret_key_value", "--agent", "codex_cli"],
				home,
				{ SHELL: "/bin/sh" },
				DEFAULT_PATH,
			);
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".agentpulse", "env")).exists()).toBe(false);
			const profileExists = await Bun.file(join(home, ".profile")).exists();
			if (profileExists) {
				const profile = await Bun.file(join(home, ".profile")).text();
				expect(profile).not.toContain("ap_secret_key_value");
				expect(profile).not.toContain("AGENTPULSE");
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("copilot_cli: no profile write at all — no ~/.agentpulse/env, no rc file touched", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-d37-copilot-"));
		const stubDir = await mkdtemp(join(tmpdir(), "ap-d37-copilot-stub-"));
		try {
			await Bun.write(join(stubDir, "copilot"), "#!/bin/sh\nexit 0\n");
			await chmod(join(stubDir, "copilot"), 0o755);
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_secret_key_value", "--agent", "copilot_cli"],
				home,
				{ SHELL: "/bin/sh" },
				`${stubDir}:${DEFAULT_PATH}`,
			);
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".agentpulse", "env")).exists()).toBe(false);
			const profileExists = await Bun.file(join(home, ".profile")).exists();
			if (profileExists) {
				const profile = await Bun.file(join(home, ".profile")).text();
				expect(profile).not.toContain("ap_secret_key_value");
				expect(profile).not.toContain("AGENTPULSE");
			}
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(stubDir, { recursive: true, force: true });
		}
	});

	test("an existing plaintext export line is left alone, but a warning with removal instructions is printed", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-d37-warn-"));
		try {
			await mkdir(home, { recursive: true });
			await Bun.write(
				join(home, ".profile"),
				'# old install\nexport AGENTPULSE_API_KEY="ap_old_plaintext_key"\n',
			);
			const res = await run(
				["--url", "http://localhost:1", "--key", "ap_new_key"],
				home,
				{ SHELL: "/bin/sh" },
				DEFAULT_PATH,
			);
			expect(res.code).toBe(0);
			expect(res.out).toContain("already has a plaintext AGENTPULSE_API_KEY export");
			expect(res.out).toContain("sed -i.bak");
			const profile = await Bun.file(join(home, ".profile")).text();
			expect(profile).toContain('export AGENTPULSE_API_KEY="ap_old_plaintext_key"');
			// The new key still lands in the protected file regardless.
			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_new_key");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
