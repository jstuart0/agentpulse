/**
 * AGEN-49 regression: the direct-hook installers (scripts/setup-hooks.sh for
 * claude_code/codex_cli/copilot_cli, and the served /setup.sh route, which
 * configures all three in one pass) must never write the literal API key
 * into a file that isn't privately permissioned. hook-auth-header and
 * ~/.agentpulse/env (both 0600, written by ap_write_private_no_follow) are
 * the only allowed homes for the raw value — settings.json, hooks.json,
 * agentpulse.json, and any backup file may reference $AGENTPULSE_API_KEY or
 * the hook-auth-header file, but never the key itself.
 *
 * A key is always supplied (--key), so ap_check_auth_before_write's own
 * network probe is never reached (it returns immediately once a key is
 * present) — no live server is needed, matching the existing
 * scripts/setup-hooks-copilot.test.ts convention of an intentionally
 * unreachable http://localhost:1.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

/** Files the key is allowed to appear in, and only at mode 0600. */
const ALLOWED_KEY_FILENAMES = new Set(["hook-auth-header", "env"]);

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
	await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return proc.exitCode;
}

/**
 * Walks every file under `root` (dotfiles included — every path we care
 * about lives under a dot-directory: .claude, .codex, .copilot, .agentpulse)
 * and asserts the raw key only ever appears in an allow-listed filename, and
 * only when that file is mode 0600.
 */
async function assertKeyOnlyInPrivateFiles(root: string) {
	const checked: string[] = [];
	for await (const rel of new Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
		const full = join(root, rel);
		const content = await Bun.file(full)
			.text()
			.catch(() => "");
		if (!content.includes(KEY)) continue;
		checked.push(rel);
		const filename = rel.split("/").at(-1) ?? rel;
		expect(ALLOWED_KEY_FILENAMES.has(filename)).toBe(true);
		const mode = (await stat(full)).mode & 0o777;
		expect(mode).toBe(0o600);
	}
	return checked;
}

describe("AGEN-49: the API key never lands in a world-readable file", () => {
	for (const agent of ["claude_code", "codex_cli", "copilot_cli"] as const) {
		test(`scripts/setup-hooks.sh --agent ${agent}`, async () => {
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
				await assertKeyOnlyInPrivateFiles(home);
			} finally {
				await rm(home, { recursive: true, force: true });
				await rm(stubDir, { recursive: true, force: true });
			}
		});
	}

	test("scripts/setup-hooks.sh --scope project: no literal key in the project dir either", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-project-home-"));
		const project = await mkdtemp(join(tmpdir(), "ap-agen49-project-cwd-"));
		try {
			await run(
				[INSTALLER, "--url", UNREACHABLE_URL, "--key", KEY, "--scope", "project"],
				home,
				DEFAULT_PATH,
				project,
			);
			await assertKeyOnlyInPrivateFiles(home);
			await assertKeyOnlyInPrivateFiles(project);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		}
	});

	test("the served /setup.sh (claude_code + codex_cli + copilot_cli in one pass) writes no literal key anywhere but the private files", async () => {
		const script = await servedSetupSh();
		const home = await mkdtemp(join(tmpdir(), "ap-agen49-served-"));
		try {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(home, ".copilot"), { recursive: true }); // trigger Copilot detection, no binary needed
			const file = join(home, "setup.sh");
			await Bun.write(file, script);
			await run([file, "--key", KEY, "--url", UNREACHABLE_URL], home);

			const checked = await assertKeyOnlyInPrivateFiles(home);

			// Positive control: a bug that silently wrote nothing at all would
			// pass the scan above for the wrong reason — prove the settings
			// file really was written, and really does carry the env-var form.
			const settings = await Bun.file(join(home, ".claude", "settings.json")).text();
			expect(settings).toContain("$AGENTPULSE_API_KEY");
			expect(settings).toContain("allowedEnvVars");
			expect(settings).not.toContain(KEY);
			expect(checked).toContain(".agentpulse/hook-auth-header");
			expect(checked).toContain(".agentpulse/env");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
