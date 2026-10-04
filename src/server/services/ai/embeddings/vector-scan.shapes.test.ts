/**
 * Runs the stale-suffix / orphan / skip-marker / mixed-model scan assertions
 * against both SQLite install shapes. One process holds one shape, so each
 * shape gets its own child `bun test` over `scan-shape.fixture.test.ts`:
 * the Drizzle-migrated shape (a fresh database) and the legacy-init shape
 * (an existing install booted through `runLegacySqliteInit`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSqliteOnly } from "../../../test-utils/backend.js";

const FIXTURE = join(import.meta.dir, "scan-shape.fixture.test.ts");
const EXPECTED_TESTS = 7;
const REPO_ROOT = join(import.meta.dir, "../../../../..");

interface ShapeReport {
	shape: string;
	hasDrizzleMigrations: boolean;
	hasLegacyModelIndex: boolean;
	hasDeleteTrigger: boolean;
	hasScanIndex: boolean;
}

async function runShape(shape: "legacy" | "drizzle") {
	const dir = mkdtempSync(join(tmpdir(), `ap-scan-shape-${shape}-`));
	try {
		const child = Bun.spawn([process.execPath, "test", FIXTURE], {
			cwd: REPO_ROOT,
			env: {
				PATH: process.env.PATH ?? "",
				TMPDIR: tmpdir(),
				SQLITE_PATH: join(dir, "shape.db"),
				DATA_DIR: dir,
				AGENTPULSE_VECTOR_SEARCH: "true",
				AGENTPULSE_SCAN_SHAPE: shape,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = `${out}\n${err}`;
		const line = output.split("\n").find((l) => l.includes("SCAN_SHAPE_REPORT "));
		const report = line
			? (JSON.parse(line.slice(line.indexOf("SCAN_SHAPE_REPORT ") + 18)) as ShapeReport)
			: null;
		return { exitCode, output, report };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describeSqliteOnly("scan against both install shapes", () => {
	describe.each(["drizzle", "legacy"] as const)("%s shape", (shape) => {
		test("the scan holds its per-statement bounds and its plan", async () => {
			const { exitCode, output, report } = await runShape(shape);

			expect(report, output).not.toBeNull();
			expect(report?.shape).toBe(shape);
			expect(report?.hasDrizzleMigrations).toBe(shape === "drizzle");
			expect(report?.hasLegacyModelIndex).toBe(shape === "legacy");
			expect(report?.hasDeleteTrigger).toBe(shape === "legacy");
			expect(report?.hasScanIndex).toBe(true);
			expect(output).toContain(` ${EXPECTED_TESTS} pass`);
			expect(output).toContain(" 0 fail");
			expect(exitCode).toBe(0);
		}, 120_000);
	});
});
