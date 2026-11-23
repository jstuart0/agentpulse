/**
 * The relay refreshes the installed statusline only when its bytes are known (an older release's digest), and
 * writes the bytes it hashed. That holds only if every writer of `~/.claude/statusline-agentpulse.sh` writes the
 * same bytes: the file `scripts/statusline.sh` itself. Three writers copy it: the relay installer (spliced into
 * `setup-relay.sh` and read back out by the relay), `setup-hooks.sh --statusline` and `bin/cli.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../src/server/installers.ts";
import { clientDigests, extractRelayInstallerParts } from "../src/shared/relay-installer-parts.ts";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
const STATUSLINE = read("scripts/statusline.sh");
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the statusline's writers carry scripts/statusline.sh", () => {
	test("the relay installer's splice, read back out the way a relay reads it, is the file", () => {
		const built = buildRelayInstaller(INSTALLER_SOURCES, "https://agentpulse.example.test");
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const extracted = extractRelayInstallerParts(built.script);
		expect(extracted.ok).toBe(true);
		if (!extracted.ok) return;
		expect(extracted.parts.statusline.trimEnd()).toBe(STATUSLINE.trimEnd());
		// and the digest a manifest records for it is the digest of that text
		const digests = clientDigests({
			relay: extracted.parts.relay,
			statusline: extracted.parts.statusline,
			excludeCheck: "x",
		});
		return digests.then((d) => expect(d.statusline).toMatch(/^[0-9a-f]{64}$/));
	});

	test("setup-hooks.sh --statusline installs the file's bytes (a real run in a throwaway HOME)", () => {
		const home = mkdtempSync(join(tmpdir(), "ap-statusline-writers-"));
		dirs.push(home);
		const proc = Bun.spawnSync(
			[
				"bash",
				join(ROOT, "scripts", "setup-hooks.sh"),
				"--url",
				"http://127.0.0.1:1",
				"--key",
				"ap_writer_test",
				"--no-auth-check",
				"--statusline",
			],
			{
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(proc.exitCode, proc.stderr.toString() + proc.stdout.toString()).toBe(0);
		expect(readFileSync(join(home, ".claude", "statusline-agentpulse.sh"), "utf-8")).toBe(
			STATUSLINE,
		);
	}, 60_000);

	test("population floor: the three writers still copy scripts/statusline.sh (bin/cli.ts named)", () => {
		expect(read("bin/cli.ts")).toContain('"scripts", "statusline.sh"');
		expect(read("scripts/setup-hooks.sh")).toContain('"$self_dir/statusline.sh"');
		expect(read("scripts/setup-relay.sh")).toContain("# @@AGENTPULSE_STATUSLINE_SH@@");
	});
});
