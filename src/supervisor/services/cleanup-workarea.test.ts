import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanupError, executeCleanupWorkArea } from "./cleanup-workarea.js";

let workDir: string;
let trustedRoot: string;

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "ap-cleanup-"));
	trustedRoot = join(workDir, "trusted");
	await mkdir(trustedRoot, { recursive: true });
});

afterEach(async () => {
	if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("executeCleanupWorkArea", () => {
	test("removes a real directory under trusted roots", async () => {
		const target = join(trustedRoot, "scratch");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "CLAUDE.md"), "hi");

		const result = await executeCleanupWorkArea({
			cwd: target,
			trustedRoots: [trustedRoot],
		});
		expect(result.removed).toBe(true);
		expect(result.resolvedPath).toBe(target);

		await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("idempotent on missing path (returns removed: false)", async () => {
		const target = join(trustedRoot, "never-existed");
		const result = await executeCleanupWorkArea({
			cwd: target,
			trustedRoots: [trustedRoot],
		});
		expect(result.removed).toBe(false);
	});

	test("rejects path outside trustedRoots", async () => {
		const sibling = join(workDir, "untrusted");
		await mkdir(sibling, { recursive: true });
		try {
			await executeCleanupWorkArea({
				cwd: sibling,
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("path_outside_trusted_roots");
		}
		// Untrusted dir must still exist.
		const info = await stat(sibling);
		expect(info.isDirectory()).toBe(true);
	});

	test("rejects path with `..` segments", async () => {
		const target = `${trustedRoot}/foo/../escape`;
		try {
			await executeCleanupWorkArea({
				cwd: target,
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("path_traversal_rejected");
		}
	});

	test("rejects relative path", async () => {
		try {
			await executeCleanupWorkArea({
				cwd: "relative/path",
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("path_not_absolute");
		}
	});

	test("rejects ancestor symlink that escapes trusted roots", async () => {
		const linkedAlias = join(workDir, "alias");
		const outside = join(workDir, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret"), "x");
		await symlink(outside, linkedAlias);

		try {
			await executeCleanupWorkArea({
				cwd: join(linkedAlias, "scratch"),
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("symlink_rejected");
		}
		// Outside must remain untouched.
		const outsideStill = await stat(outside);
		expect(outsideStill.isDirectory()).toBe(true);
	});

	test("rejects when cwd itself is a symlink", async () => {
		const target = join(trustedRoot, "linky");
		const realDir = join(trustedRoot, "real");
		await mkdir(realDir, { recursive: true });
		await symlink(realDir, target);

		try {
			await executeCleanupWorkArea({
				cwd: target,
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("symlink_rejected");
		}

		const realStill = await stat(realDir);
		expect(realStill.isDirectory()).toBe(true);
	});

	test("rejects when cwd is a regular file", async () => {
		const target = join(trustedRoot, "afile");
		await writeFile(target, "x");
		try {
			await executeCleanupWorkArea({
				cwd: target,
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected CleanupError");
		} catch (err) {
			expect(err).toBeInstanceOf(CleanupError);
			expect((err as CleanupError).code).toBe("not_a_directory");
		}
	});
});
