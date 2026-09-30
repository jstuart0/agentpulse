/**
 * F252 (Medium/High, xander D39 re-verify): ap_write_private_no_follow is
 * the shared primitive (inside the `# >>> agentpulse-hook-cmd` marker
 * block, verbatim across scripts/setup-hooks.sh, scripts/setup-relay.sh,
 * and the /setup.sh template rendered by src/server/routes/setup.ts) that
 * replaced the inline hook-auth-header (Codex/Copilot) and
 * ~/.agentpulse/env writers. Those inline blocks checked only the final
 * path component for a symlink and called `mkdir -p` BEFORE checking —
 * a symlinked ~/.agentpulse parent directory would let `mkdir -p`
 * silently succeed and the secret land wherever the parent symlink
 * points, unrefused. This ports F249's ordering: refuse if the parent is
 * a symlink, THEN mkdir, THEN refuse if the file itself is a symlink,
 * THEN the umask-077 temp write + mv.
 *
 * This sources the REAL function from each file (never reimplements it),
 * matching write-no-follow.test.ts's and check-auth-before-write.test.ts's
 * existing pattern. Unlike ap_write_no_follow (0644, stdin-fed, used for
 * hooks.json), ap_write_private_no_follow is 0600 and takes its content
 * as $2 directly (secrets are short, single-shot values, not streamed).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// D40 (F251): belt-and-braces — bunfig.toml's [test] preload already sets
// safe env defaults before any test file's own imports run, but this file
// dynamically imports src/server/routes/setup.ts (which statically imports
// config.js) via renderedSetupSh() below, so keep it self-sufficient too.
import "../src/server/db/__test_db.js";

const ROOT = join(import.meta.dir, "..");

function extractMarkerBlock(source: string): string {
	const startMarker = "# >>> agentpulse-hook-cmd";
	const endMarker = "# <<< agentpulse-hook-cmd";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error("agentpulse-hook-cmd markers not found");
	}
	return source.slice(start, end + endMarker.length);
}

async function renderedSetupSh(): Promise<string> {
	const { Hono } = await import("hono");
	const { setup } = await import("../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

type Site = { name: string; block: () => Promise<string> };

const SITES: Site[] = [
	{
		name: "scripts/setup-hooks.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf-8")),
	},
	{
		name: "scripts/setup-relay.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf-8")),
	},
	{
		name: "rendered GET /setup.sh",
		block: async () => extractMarkerBlock(await renderedSetupSh()),
	},
];

async function runWritePrivateNoFollow(
	block: string,
	path: string,
	content: string,
): Promise<{ code: number | null; stderr: string }> {
	const script = `${block}\nap_write_private_no_follow "$1" "$2"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", path, content], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

for (const site of SITES) {
	describe(`ap_write_private_no_follow (F252) — ${site.name}`, () => {
		let dir: string;

		function cleanup() {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}

		test("a symlinked parent directory is refused before mkdir -p can follow it", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-private-no-follow-"));
			try {
				const realDir = join(dir, "attacker-owned");
				mkdirSync(realDir);
				const fakeAgentpulseDir = join(dir, "fake-agentpulse");
				symlinkSync(realDir, fakeAgentpulseDir);
				const target = join(fakeAgentpulseDir, "hook-auth-header");

				const block = await site.block();
				const result = await runWritePrivateNoFollow(
					block,
					target,
					"Authorization: Bearer attacker-controlled\n",
				);
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/refusing to write into a symlinked directory/);
				expect(existsSync(join(realDir, "hook-auth-header"))).toBe(false);
			} finally {
				cleanup();
			}
		});

		test("a symlink at the final path is refused, target untouched", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-private-no-follow-"));
			try {
				const real = join(dir, "outside-target");
				writeFileSync(real, "should never change\n");
				const target = join(dir, "hook-auth-header");
				symlinkSync(real, target);

				const block = await site.block();
				const result = await runWritePrivateNoFollow(
					block,
					target,
					"Authorization: Bearer attacker-controlled\n",
				);
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/refusing to write through a symlink/);
				expect(readFileSync(real, "utf-8")).toBe("should never change\n");
			} finally {
				cleanup();
			}
		});

		test("a normal write succeeds at 0600, creating the parent directory if needed", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-private-no-follow-"));
			try {
				const target = join(dir, "agentpulse", "hook-auth-header");

				const block = await site.block();
				const result = await runWritePrivateNoFollow(
					block,
					target,
					"Authorization: Bearer ap_real_key\n",
				);
				expect(result.code).toBe(0);
				expect(readFileSync(target, "utf-8")).toBe("Authorization: Bearer ap_real_key\n");
				expect(statSync(target).mode & 0o777).toBe(0o600);
			} finally {
				cleanup();
			}
		});
	});
}
