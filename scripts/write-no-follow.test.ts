/**
 * F232 (xander, Medium, Phase 7 panel): ap_write_no_follow is the shared
 * primitive (inside the `# >>> agentpulse-hook-cmd` marker block, verbatim
 * across scripts/setup-hooks.sh, scripts/setup-relay.sh, and the /setup.sh
 * template rendered by src/server/routes/setup.ts) that replaced a plain
 * `>` redirect / `cp` for the Codex/Copilot hooks.json write and its
 * timestamped backup — both of which follow a symlink at the destination.
 * ap_write_no_follow is used for BOTH the hooks-file path and the backup
 * path (same function, different `$1`), so testing it once at an arbitrary
 * caller-chosen path covers "symlink at the hooks path" and "symlink at
 * the backup path" identically — the function has no idea which call site
 * it's serving.
 *
 * This sources the REAL function from each file (never reimplements it),
 * matching hook-command-parity.test.ts's existing pattern.
 */
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

async function runWriteNoFollow(
	block: string,
	path: string,
	content: string,
): Promise<{ code: number | null; stderr: string }> {
	// Content arrives on the child's real stdin (not interpolated into the
	// script text) so JS-string newlines/quotes never have to round-trip
	// through bash's own (different-from-JSON) quoting rules.
	const script = `${block}\nap_write_no_follow ${JSON.stringify(path)}`;
	const proc = Bun.spawn(["bash", "-c", script], {
		stdin: new TextEncoder().encode(content),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

for (const site of SITES) {
	describe(`ap_write_no_follow (F232) — ${site.name}`, () => {
		let dir: string;

		function cleanup() {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}

		test("a symlink at the hooks-file path is refused, target untouched", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-no-follow-"));
			try {
				const real = join(dir, "outside-target");
				writeFileSync(real, "should never change\n");
				const target = join(dir, "hooks.json");
				symlinkSync(real, target);

				const block = await site.block();
				const result = await runWriteNoFollow(block, target, "attacker-controlled\n");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/refusing to write through a symlink/);
				expect(readFileSync(real, "utf-8")).toBe("should never change\n");
			} finally {
				cleanup();
			}
		});

		test("a symlink at the backup-file path is refused, target untouched (same primitive, a different path)", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-no-follow-"));
			try {
				const real = join(dir, "outside-target");
				writeFileSync(real, "should never change\n");
				const backupPath = join(dir, "hooks.json.agentpulse-bak.20260929T000000Z");
				symlinkSync(real, backupPath);

				const block = await site.block();
				const result = await runWriteNoFollow(block, backupPath, "old hooks content\n");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/refusing to write through a symlink/);
				expect(readFileSync(real, "utf-8")).toBe("should never change\n");
			} finally {
				cleanup();
			}
		});

		test("a symlinked parent directory is refused", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-no-follow-"));
			try {
				const realDir = join(dir, "real-dir");
				mkdirSync(realDir);
				const symlinkedDir = join(dir, "symlinked-dir");
				symlinkSync(realDir, symlinkedDir);
				const target = join(symlinkedDir, "hooks.json");

				const block = await site.block();
				const result = await runWriteNoFollow(block, target, "attacker-controlled\n");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/refusing to write into a symlinked directory/);
			} finally {
				cleanup();
			}
		});

		test("a normal write succeeds at 0644, atomically replacing any prior content", async () => {
			dir = mkdtempSync(join(tmpdir(), "ap-write-no-follow-"));
			try {
				const target = join(dir, "hooks.json");
				writeFileSync(target, "old\n", { mode: 0o600 });

				const block = await site.block();
				const result = await runWriteNoFollow(block, target, '{"hooks":{}}\n');
				expect(result.code).toBe(0);
				expect(readFileSync(target, "utf-8")).toBe('{"hooks":{}}\n');
				expect(statSync(target).mode & 0o777).toBe(0o644);
			} finally {
				cleanup();
			}
		});
	});
}
