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
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("agentpulse setup (AGEN-49): the API key never lands in ~/.claude/settings.json", () => {
	test("--key supplied: settings.json still references $AGENTPULSE_API_KEY, never the literal value", async () => {
		const home = await mkdtemp(join(tmpdir(), "ap-cli-setup-agen49-"));
		try {
			const res = await runSetup(home, [
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_secret_cli_value",
			]);
			expect(res.code).toBe(0);

			const settings = await Bun.file(join(home, ".claude", "settings.json")).text();
			expect(settings).not.toContain("ap_secret_cli_value");
			expect(settings).toContain("$AGENTPULSE_API_KEY");
			expect(settings).toContain("allowedEnvVars");

			// The real value still lands in the private, 0600 env file — this
			// isn't "no key was ever written anywhere," just "not in the
			// world-readable one."
			const envFile = await Bun.file(join(home, ".agentpulse", "env")).text();
			expect(envFile).toContain("ap_secret_cli_value");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
