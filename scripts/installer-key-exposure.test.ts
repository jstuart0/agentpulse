/**
 * AGEN-49/H2 (xander) regression: the direct-hook installers (scripts/
 * setup-hooks.sh for claude_code/codex_cli/copilot_cli, and the served
 * /setup.sh route, which configures all three in one pass) must never
 * write the literal API key into a world-readable file.
 *
 * hook-auth-header and ~/.agentpulse/env (both 0600, written by
 * ap_write_private_no_follow) are always-allowed homes for the raw value.
 * ~/.claude/settings.json (user/global scope) is now ALSO an allowed home
 * for it, but only at mode 0600 — Claude Code's native HTTP hook expands
 * $AGENTPULSE_API_KEY from its own process env, which a GUI/IDE/stale-
 * terminal launch never has, so the literal key trades that silent-401
 * risk away, made acceptable by tightening the file. A project-scope
 * .claude/settings.json (a repo file that may be committed) must NEVER
 * carry the literal key, at any permission — it keeps the env-var/
 * allowedEnvVars form unconditionally.
 *
 * A key is always supplied (--key), so ap_check_auth_before_write's own
 * network probe is never reached (it returns immediately once a key is
 * present) — no live server is needed, matching the existing
 * scripts/setup-hooks-copilot.test.ts convention of an intentionally
 * unreachable http://localhost:1.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";

const { setup } = await import("../src/server/routes/setup.js");

const INSTALLER = join(import.meta.dir, "setup-hooks.sh");
const KEY = "ap_regression_secret_do_not_leak";
const UNREACHABLE_URL = "http://localhost:1";
const DEFAULT_PATH = process.env.PATH ?? "/usr/bin:/bin";

/** Files the key is always allowed to appear in, and only at mode 0600. */
const ALWAYS_PRIVATE_FILENAMES = new Set(["hook-auth-header", "env"]);

async function servedSetupSh(): Promise<string> {
	const app = new Hono();
	app.route("/", setup);
	const res = await app.request("/setup.sh");
	return res.text();
}

async function run(args: string[], home: string, path: string = DEFAULT_PATH, cwd?: string) {
	const proc = Bun.spawn(["bash", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: path, HOME: home },
		cwd,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, out: stdout + stderr };
}

/**
 * Walks every file under `root` (dotfiles included — every path we care
 * about lives under a dot-directory: .claude, .codex, .copilot, .agentpulse)
 * and asserts the raw key only ever appears in an allow-listed filename, and
 * only when that file is mode 0600. `allowSettingsJson` widens the allow
 * list to include settings.json (user/global-scope trees only — never pass
 * this for a project-scope tree, where settings.json must never carry the
 * key at all).
 */
async function assertKeyOnlyInPrivateFiles(
	root: string,
	opts: { allowSettingsJson?: boolean } = {},
) {
	const allowed = opts.allowSettingsJson
		? new Set([...ALWAYS_PRIVATE_FILENAMES, "settings.json"])
		: ALWAYS_PRIVATE_FILENAMES;
	const checked: string[] = [];
	for await (const rel of new Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
		const full = join(root, rel);
		const content = await Bun.file(full)
			.text()
			.catch(() => "");
		if (!content.includes(KEY)) continue;
		checked.push(rel);
		const filename = rel.split("/").at(-1) ?? rel;
		expect(allowed.has(filename)).toBe(true);
		const mode = (await stat(full)).mode & 0o777;
		expect(mode).toBe(0o600);
	}
	return checked;
}

describe("AGEN-49/H2: the API key never lands in a world-readable file", () => {
	for (const agent of ["claude_code", "codex_cli", "copilot_cli"] as const) {
		test(`scripts/setup-hooks.sh --agent ${agent} (global scope)`, async () => {
			const home = await mkdtemp(join(tmpdir(), `ap-agen49-${agent}-`));
			const stubDir = await mkdtemp(join(tmpdir(), "ap-agen49-stub-"));
			try {
				let path = DEFAULT_PATH;
				if (agent === "copilot_cli") {
					await Bun.write(join(stubDir, "copilot"), "#!/bin/sh\nexit 0\n");
					await Bun.file(join(stubDir, "copilot")).exists(); // ensure flushed before chmod
					const { chmod } = await import("node:fs/promises");
					await chmod(join(stubDir, "copilot"), 0o755);
					path = `${stubDir}:${DEFAULT_PATH}`;
				}
				await run(
					[INSTALLER, "--url", UNREACHABLE_URL, "--key", KEY, "--agent", agent],
					home,
					path,
				);
				// Global scope: settings.json (claude_code only) is allowed to
				// carry the literal key, but only at 0600 — asserted below.
				await assertKeyOnlyInPrivateFiles(home, { allowSettingsJson: true });
				if (agent === "claude_code") {
					const settingsPath = join(home, ".claude", "settings.json");
					const settings = await Bun.file(settingsPath).text();
					expect(settings).toContain(`Bearer ${KEY}`);
					expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
				await rm(stubDir, { recursive: true, force: true });
			}
		});
	}

	test("scripts/setup-hooks.sh --scope project: the key never appears in the project dir, at any permission", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-project-home-"));
		const project = await mkdtemp(join(tmpdir(), "ap-agen49-project-cwd-"));
		try {
			await run(
				[INSTALLER, "--url", UNREACHABLE_URL, "--key", KEY, "--scope", "project"],
				home,
				DEFAULT_PATH,
				project,
			);
			// $HOME still gets ~/.agentpulse/env regardless of --scope
			// (D37/F243 runs unconditionally for claude_code) — allowed as
			// always. The project dir gets NO settings.json exception: a
			// literal key there would be a repo file that can be committed.
			await assertKeyOnlyInPrivateFiles(home, { allowSettingsJson: false });
			await assertKeyOnlyInPrivateFiles(project, { allowSettingsJson: false });

			const projectSettings = await Bun.file(join(project, ".claude", "settings.json")).text();
			expect(projectSettings).toContain("$AGENTPULSE_API_KEY");
			expect(projectSettings).toContain("allowedEnvVars");
			expect(projectSettings).not.toContain(KEY);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		}
	});

	test("scripts/setup-hooks.sh (global scope): an existing settings.json keeps its other keys", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-merge-"));
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ theme: "dark", customSetting: 42 }, null, 2),
			);
			const res = await run(
				[INSTALLER, "--url", UNREACHABLE_URL, "--key", KEY, "--scope", "global"],
				home,
			);
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

	test("scripts/setup-hooks.sh (global scope): a symlinked settings.json is refused, not written through", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-symlink-"));
		const decoyTarget = join(home, "decoy-settings.json");
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(decoyTarget, "should never change");
			await symlink(decoyTarget, join(home, ".claude", "settings.json"));

			const res = await run(
				[INSTALLER, "--url", UNREACHABLE_URL, "--key", KEY, "--scope", "global"],
				home,
			);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("refusing to write through a symlink");
			expect(await Bun.file(decoyTarget).text()).toBe("should never change");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("the served /setup.sh (claude_code + codex_cli + copilot_cli in one pass): the key is allowed only in settings.json (0600), hook-auth-header, and env", async () => {
		const script = await servedSetupSh();
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-served-"));
		try {
			await mkdir(join(home, ".copilot"), { recursive: true }); // trigger Copilot detection, no binary needed
			const file = join(home, "setup.sh");
			await Bun.write(file, script);
			await run([file, "--key", KEY, "--url", UNREACHABLE_URL], home);

			const checked = await assertKeyOnlyInPrivateFiles(home, { allowSettingsJson: true });

			const settingsPath = join(home, ".claude", "settings.json");
			const settings = await Bun.file(settingsPath).text();
			expect(settings).toContain(`Bearer ${KEY}`);
			expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
			expect(checked).toContain(".claude/settings.json");
			expect(checked).toContain(".agentpulse/hook-auth-header");
			expect(checked).toContain(".agentpulse/env");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("the served /setup.sh with no key (auth-disabled server): settings.json keeps the env-var/allowedEnvVars form", async () => {
		const script = await servedSetupSh();
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-served-nokey-"));
		try {
			const file = join(home, "setup.sh");
			await Bun.write(file, script);
			await run([file, "--url", UNREACHABLE_URL, "--no-auth-check"], home);

			await assertKeyOnlyInPrivateFiles(home, { allowSettingsJson: true });
			const settings = await Bun.file(join(home, ".claude", "settings.json")).text();
			expect(settings).toContain("$AGENTPULSE_API_KEY");
			expect(settings).toContain("allowedEnvVars");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("the served /setup.sh: an existing settings.json keeps its other keys", async () => {
		const script = await servedSetupSh();
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-served-merge-"));
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ theme: "dark", customSetting: 42 }, null, 2),
			);
			const file = join(home, "setup.sh");
			await Bun.write(file, script);
			const res = await run([file, "--key", KEY, "--url", UNREACHABLE_URL], home);
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

	test("the served /setup.sh: a symlinked settings.json is refused, not written through", async () => {
		const script = await servedSetupSh();
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-served-symlink-"));
		const decoyTarget = join(home, "decoy-settings.json");
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await Bun.write(decoyTarget, "should never change");
			await symlink(decoyTarget, join(home, ".claude", "settings.json"));
			const file = join(home, "setup.sh");
			await Bun.write(file, script);

			const res = await run([file, "--key", KEY, "--url", UNREACHABLE_URL], home);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("refusing to write through a symlink");
			expect(await Bun.file(decoyTarget).text()).toBe("should never change");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
