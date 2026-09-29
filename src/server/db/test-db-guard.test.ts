/**
 * tessa F119: the shared test-DB helper refuses a SQLITE_PATH outside the
 * OS temp dir, so a developer's exported SQLITE_PATH can never be used (and
 * wiped) by the test suite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "__test_db.ts");

async function importHelperWith(sqlitePath: string) {
	const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(HELPER)})`], {
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: tmpdir(),
			SQLITE_PATH: sqlitePath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { code: proc.exitCode, stderr };
}

describe("__test_db.ts SQLITE_PATH guard (F119)", () => {
	test("a path outside the temp dir fails fast and names the variable", async () => {
		const { code, stderr } = await importHelperWith("/srv/agentpulse/data/agentpulse.db");
		expect(code).not.toBe(0);
		expect(stderr).toContain("SQLITE_PATH");
	});

	test("a path under the temp dir is accepted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ap-guard-"));
		const { code, stderr } = await importHelperWith(join(dir, "t.db"));
		expect([code, stderr]).toEqual([0, ""]);
	});
});
