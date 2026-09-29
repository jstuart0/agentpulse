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

async function run(args: string[], home: string) {
	const proc = Bun.spawn(["bash", INSTALLER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		// A sanitized PATH with no `copilot` binary — deterministic
		// "not detected" regardless of what's installed on the host running
		// this suite (see installers-run.test.ts's sanitizedPath for the
		// same concern with a real Homebrew-installed copilot).
		env: { PATH: "/usr/bin:/bin", HOME: home },
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
