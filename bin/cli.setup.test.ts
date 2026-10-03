/**
 * D37/F243 (codex r2 disposition, xander re-verify): `agentpulse setup`
 * used to append the plaintext API key to ~/.zshrc or ~/.bashrc — the same
 * key hook-auth-header already treats as 0600. Now written to
 * ~/.agentpulse/env (0600, no-follow) instead, with only a key-free,
 * idempotent source line in the rc file.
 *
 * Real subprocess run (`bun bin/cli.ts setup`) against a temp HOME, no
 * network dependency — the server-reachability check is caught and
 * degrades gracefully (see bin/cli.ts's "Verify" section).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every case starts a bun process; several take 2.5-3.6 s of the 5 s default on a loaded machine.
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "cli.ts");

async function runSetup(home: string, args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(["bun", CLI, "setup", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			SHELL: "/bin/zsh",
			...env,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: stdout + stderr };
}

describe("agentpulse setup (D37/F243): the API key never lands in a shell rc file", () => {
	test("key goes to ~/.agentpulse/env (0600), .zshrc gets only a key-free source line", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-d37-"));
		try {
			const res = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_secret_cli_value",
			]);
			expect(res.code).toBe(0);

			const envPath = join(home, ".agentpulse", "env");
			const envFile = await Bun.file(envPath).text();
			expect(envFile).toContain('export AGENTPULSE_API_KEY="ap_secret_cli_value"');
			expect((await stat(envPath)).mode & 0o777).toBe(0o600);

			const rcFile = await Bun.file(join(home, ".zshrc")).text();
			expect(rcFile).not.toContain("ap_secret_cli_value");
			expect(rcFile).toContain('[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an existing plaintext export line is left alone, but a warning with removal instructions is printed", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-d37-warn-"));
		try {
			await Bun.write(
				join(home, ".zshrc"),
				'# old install\nexport AGENTPULSE_API_KEY="ap_old_plaintext"\n',
			);
			const res = await runSetup(home, ["--url", "http://127.0.0.1:1", "--key", "ap_new_value"]);
			expect(res.code).toBe(0);
			expect(res.out).toContain("already has a plaintext AGENTPULSE_API_KEY export");
			expect(res.out).toContain("sed -i.bak");

			const rcFile = await Bun.file(join(home, ".zshrc")).text();
			expect(rcFile).toContain('export AGENTPULSE_API_KEY="ap_old_plaintext"');

			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_new_value");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("re-running setup is idempotent: no duplicate source lines, env file overwritten cleanly", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-d37-idem-"));
		try {
			await runSetup(home, ["--url", "http://127.0.0.1:1", "--key", "ap_first_value"]);
			const res2 = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_second_value",
			]);
			expect(res2.code).toBe(0);

			const rcFile = await Bun.file(join(home, ".zshrc")).text();
			const sourceLineCount = (
				rcFile.match(/\[ -f "\$HOME\/\.agentpulse\/env" \] && \. "\$HOME\/\.agentpulse\/env"/g) ??
				[]
			).length;
			expect(sourceLineCount).toBe(1);

			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_second_value");
			expect(envFile).not.toContain("ap_first_value");

			const agentpulseFiles = await readdir(join(home, ".agentpulse"));
			expect(agentpulseFiles.filter((f) => f === "env")).toHaveLength(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse setup (AGEN-49/H2, xander): --key supplied embeds the literal key in ~/.claude/settings.json, tightened to 0600", () => {
	test("--key supplied: settings.json carries the literal Authorization header, mode 0600", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-agen49-"));
		try {
			const res = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_secret_cli_value",
			]);
			expect(res.code).toBe(0);

			const settingsPath = join(home, ".claude", "settings.json");
			const settings = await Bun.file(settingsPath).text();
			// H2 (xander): Claude Code's native HTTP hook expands
			// $AGENTPULSE_API_KEY from its OWN process env — a GUI/IDE/stale-
			// terminal launch never sources ~/.agentpulse/env, so the env-var
			// form 401s silently there. User scope trades that reliability
			// gap for the literal key, made acceptable by tightening the file.
			expect(settings).toContain('Authorization": "Bearer ap_secret_cli_value');
			expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);

			// The real value also still lands in the private, 0600 env file,
			// for the other consumers of it (codex_cli/copilot_cli hooks,
			// the user's own shell).
			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_secret_cli_value");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("no --key (auth-disabled server): settings.json keeps the env-var/allowedEnvVars form, never a literal", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-agen49-nokey-"));
		try {
			const res = await runSetup(home, ["--url", "http://127.0.0.1:1"]);
			expect(res.code).toBe(0);

			const settings = await Bun.file(join(home, ".claude", "settings.json")).text();
			expect(settings).toContain("$AGENTPULSE_API_KEY");
			expect(settings).toContain("allowedEnvVars");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--key supplied: an existing settings.json keeps its other keys (merge, not overwrite)", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-agen49-merge-"));
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ theme: "dark", customSetting: 42 }, null, 2),
			);
			const res = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_secret_cli_value",
			]);
			expect(res.code).toBe(0);

			const settings = JSON.parse(await Bun.file(join(home, ".claude", "settings.json")).text());
			expect(settings.theme).toBe("dark");
			expect(settings.customSetting).toBe(42);
			expect(settings.hooks).toBeDefined();
			expect((await stat(join(home, ".claude", "settings.json"))).mode & 0o777).toBe(0o600);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--key supplied: a symlinked settings.json is refused, not written through", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-agen49-symlink-"));
		const decoyTarget = join(home, "decoy-settings.json");
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(decoyTarget, "should never change");
			await symlink(decoyTarget, join(home, ".claude", "settings.json"));

			const res = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_secret_cli_value",
			]);
			expect(res.code).not.toBe(0);
			// a plain explanation, not an uncaught exception with a stack
			expect(res.out).toContain("settings.json is a symbolic link");
			expect(res.out).toContain("without --key");
			expect(res.out).not.toMatch(/^\s+at .*\(.*:\d+:\d+\)/m);
			expect(res.out).not.toContain("error: ");

			const decoyContent = await Bun.file(decoyTarget).text();
			expect(decoyContent).toBe("should never change");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse setup installs the exclusion check next to the hooks", () => {
	test("writes ~/.agentpulse/exclude-check.sh (mode 0500) and a Codex hooks file small enough to read", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-script-"));
		try {
			const res = await runSetup(home, ["--url", "http://127.0.0.1:1", "--key", "ap_script_key"]);
			expect(res.code).toBe(0);
			const script = join(home, ".agentpulse", "exclude-check.sh");
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			expect(await Bun.file(script).text()).toBe(buildBashExcludeScript());
			expect((await stat(script)).mode & 0o777).toBe(0o500);
			expect(res.out).toContain("Exclusion check");
			const hooks = await Bun.file(join(home, ".codex", "hooks.json")).text();
			expect(hooks.length).toBeLessThan(40_000);
			expect(hooks).toContain("exclude-check.sh");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("re-running refreshes a stale copy and leaves a current one alone", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-script-refresh-"));
		try {
			const args = ["--url", "http://127.0.0.1:1", "--key", "ap_script_key"];
			await runSetup(home, args);
			const script = join(home, ".agentpulse", "exclude-check.sh");
			const first = (await stat(script)).ino;
			await runSetup(home, args);
			expect((await stat(script)).ino, "a current copy is not rewritten").toBe(first);
			const { chmod, writeFile } = await import("node:fs/promises");
			await chmod(script, 0o600);
			await writeFile(script, "#!/bin/sh\nexit 0\n");
			await runSetup(home, args);
			const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
			expect(await Bun.file(script).text()).toBe(buildBashExcludeScript());
			expect((await stat(script)).mode & 0o777).toBe(0o500);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an existing ~/.agentpulse is never loosened; a missing one is created 0700", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-script-mode-"));
		try {
			await runSetup(home, ["--url", "http://127.0.0.1:1", "--key", "ap_script_key"]);
			expect((await stat(join(home, ".agentpulse"))).mode & 0o777).toBe(0o700);
			const second = await mkdtemp(join(tmpdir(), "ap-cli-setup-script-mode2-"));
			try {
				const { chmod } = await import("node:fs/promises");
				await mkdir(join(second, ".agentpulse"));
				await chmod(join(second, ".agentpulse"), 0o750);
				await runSetup(second, ["--url", "http://127.0.0.1:1", "--key", "ap_script_key"]);
				expect((await stat(join(second, ".agentpulse"))).mode & 0o777).toBe(0o750);
			} finally {
				await rm(second, { recursive: true, force: true });
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a symlink where the script goes is refused with a message, and the setup still completes", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-script-link-"));
		try {
			await mkdir(join(home, ".agentpulse"), { mode: 0o700 });
			const victim = join(home, "victim");
			await Bun.write(victim, "keep");
			await symlink(victim, join(home, ".agentpulse", "exclude-check.sh"));
			const res = await runSetup(home, ["--url", "http://127.0.0.1:1", "--key", "ap_script_key"]);
			expect(res.code).toBe(0);
			expect(res.out).toContain("Exclusion check not installed");
			expect(await Bun.file(victim).text()).toBe("keep");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse setup resolves the home directory in one place", () => {
	async function runBare(env: Record<string, string>, cwd: string, args: string[]) {
		const proc = Bun.spawn(["bun", CLI, "setup", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: "/bin/zsh", ...env },
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		return { code: proc.exitCode, out: out + err };
	}

	test("neither HOME nor USERPROFILE set: it stops with a message and creates no literal '~' directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ap-cli-setup-nohome-"));
		try {
			const res = await runBare({}, cwd, ["--url", "http://127.0.0.1:1", "--statusline"]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("HOME");
			expect((await readdir(cwd)).sort()).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("USERPROFILE alone is used for the settings and for the statusline, so both land in the same place", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ap-cli-setup-userprofile-"));
		const profile = await mkdtemp(join(tmpdir(), "ap-cli-setup-profile-"));
		try {
			const res = await runBare({ USERPROFILE: profile }, cwd, [
				"--url",
				"http://127.0.0.1:1",
				"--statusline",
			]);
			expect(res.code, res.out).toBe(0);
			expect(await Bun.file(join(profile, ".claude", "settings.json")).exists()).toBe(true);
			expect(await Bun.file(join(profile, ".claude", "statusline-agentpulse.sh")).exists()).toBe(
				true,
			);
			expect((await readdir(cwd)).sort()).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(profile, { recursive: true, force: true });
		}
	});

	test("a symlinked settings.json with no key keeps its link and gets the hooks and the statusline written through", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-symlink-"));
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await mkdir(join(home, "dotfiles"), { recursive: true });
			const target = join(home, "dotfiles", "settings.json");
			await Bun.write(target, `${JSON.stringify({ theme: "dark" })}\n`);
			await symlink(target, join(home, ".claude", "settings.json"));
			const res = await runSetup(home, ["--url", "http://127.0.0.1:1", "--statusline"]);
			expect(res.code, res.out).toBe(0);
			const { lstat } = await import("node:fs/promises");
			expect((await lstat(join(home, ".claude", "settings.json"))).isSymbolicLink()).toBe(true);
			const after = JSON.parse(await Bun.file(target).text());
			expect(after.theme).toBe("dark");
			expect(Object.keys(after.hooks).length).toBeGreaterThan(0);
			expect(after.statusLine.command).toBe("~/.claude/statusline-agentpulse.sh");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse setup merges into an existing ~/.codex/hooks.json", () => {
	const theirs = {
		"x-other-tool": { enabled: true },
		hooks: {
			SessionStart: [
				{ matcher: "startup", hooks: [{ type: "command", command: "othertool start" }] },
			],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "othertool guard" }] }],
		},
	};
	const setupArgs = ["--url", "http://127.0.0.1:1", "--key", "ap_merge_value"];

	test("another tool's hooks and unknown keys survive; a re-run is byte-identical and writes nothing", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-merge-"));
		try {
			const hooksPath = join(home, ".codex", "hooks.json");
			await mkdir(join(home, ".codex"), { recursive: true });
			await Bun.write(hooksPath, `${JSON.stringify(theirs, null, 2)}\n`);

			const res1 = await runSetup(home, setupArgs);
			expect(res1.code).toBe(0);
			const merged = JSON.parse(await Bun.file(hooksPath).text());
			expect(merged["x-other-tool"]).toEqual({ enabled: true });
			expect(merged.hooks.SessionStart[0]).toEqual(theirs.hooks.SessionStart[0]);
			expect(merged.hooks.PreToolUse[0]).toEqual(theirs.hooks.PreToolUse[0]);
			expect(merged.hooks.SessionStart).toHaveLength(2);
			expect(Object.keys(merged.hooks)).toHaveLength(12);
			const bytes1 = await Bun.file(hooksPath).text();
			const ino1 = (await stat(hooksPath)).ino;
			const backups1 = (await readdir(join(home, ".codex"))).filter((f) =>
				f.includes("agentpulse-bak"),
			);
			expect(backups1).toHaveLength(1);

			const res2 = await runSetup(home, setupArgs);
			expect(res2.code).toBe(0);
			expect(res2.out).toContain("Codex hooks unchanged");
			expect(await Bun.file(hooksPath).text()).toBe(bytes1);
			expect((await stat(hooksPath)).ino).toBe(ino1);
			expect(
				(await readdir(join(home, ".codex"))).filter((f) => f.includes("agentpulse-bak")),
			).toHaveLength(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("malformed JSON is left untouched with a clear message and the rest of setup completes", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-merge-bad-"));
		try {
			const hooksPath = join(home, ".codex", "hooks.json");
			await mkdir(join(home, ".codex"), { recursive: true });
			await Bun.write(hooksPath, "{not json");
			const res = await runSetup(home, setupArgs);
			expect(res.code).toBe(0);
			expect(await Bun.file(hooksPath).text()).toBe("{not json");
			expect(res.out).toContain("Codex hooks not updated");
			expect(
				(await readdir(join(home, ".codex"))).filter((f) => f.includes("agentpulse-bak")),
			).toHaveLength(0);
			expect(await Bun.file(join(home, ".agentpulse", "env")).exists()).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a symlinked hooks.json is still refused and its target untouched", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-merge-link-"));
		try {
			await mkdir(join(home, ".codex"), { recursive: true });
			const decoy = join(home, "decoy.json");
			await Bun.write(decoy, "should never change\n");
			await symlink(decoy, join(home, ".codex", "hooks.json"));
			const res = await runSetup(home, setupArgs);
			expect(res.code).not.toBe(0);
			expect(await Bun.file(decoy).text()).toBe("should never change\n");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
