/**
 * Phase 7 (D8): scripts/setup-hooks.sh --agent copilot_cli's two D8-specific
 * refusals — --scope project (Copilot's cloud agent loads .github/hooks/,
 * a path this installer doesn't write) and "Copilot CLI not detected".
 * Detection-gated writing (the positive path) is covered by
 * installers-run.test.ts's setup-relay.sh test; this file covers
 * setup-hooks.sh's own CLI-flag refusals directly, with no server needed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
			const profile = await Bun.file(join(home, ".profile"))
				.text()
				.catch(() => "");
			expect(profile).toContain("ap_from_argv");
			expect(profile).not.toContain("ap_from_env_should_be_overridden");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
