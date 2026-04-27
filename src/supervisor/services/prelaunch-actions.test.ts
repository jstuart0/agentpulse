import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PrelaunchAction } from "../../shared/types.js";
import { PrelaunchError, executePrelaunchActions } from "./prelaunch-actions.js";

async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

let workDir: string;
let trustedRoot: string;

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "ap-prelaunch-"));
	trustedRoot = join(workDir, "trusted");
	await mkdir(trustedRoot, { recursive: true });
});

afterEach(async () => {
	if (workDir) {
		await rm(workDir, { recursive: true, force: true });
	}
});

function scaffoldAction(
	path: string,
	overrides: Partial<Extract<PrelaunchAction, { kind: "scaffold_workarea" }>> = {},
): PrelaunchAction {
	return {
		kind: "scaffold_workarea",
		path,
		...overrides,
	};
}

describe("executePrelaunchActions: scaffold_workarea path checks", () => {
	test("creates a fresh directory inside trusted roots", async () => {
		const target = join(trustedRoot, "fresh");
		await executePrelaunchActions([scaffoldAction(target)], {
			trustedRoots: [trustedRoot],
		});
		const info = await stat(target);
		expect(info.isDirectory()).toBe(true);
	});

	test("treats existing empty directory as idempotent success", async () => {
		const target = join(trustedRoot, "empty");
		await mkdir(target, { recursive: true });
		await executePrelaunchActions([scaffoldAction(target)], {
			trustedRoots: [trustedRoot],
		});
		const entries = await readdir(target);
		expect(entries).toEqual([]);
	});

	test("rejects existing non-empty directory with path_not_empty", async () => {
		const target = join(trustedRoot, "occupied");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "file.txt"), "hi");
		try {
			await executePrelaunchActions([scaffoldAction(target)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_not_empty");
		}
	});

	test("rejects path containing '..' with path_traversal_rejected", async () => {
		const target = `${trustedRoot}/foo/../escape`;
		try {
			await executePrelaunchActions([scaffoldAction(target)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_traversal_rejected");
		}
	});

	test("rejects relative path with path_not_absolute", async () => {
		try {
			await executePrelaunchActions([scaffoldAction("relative/path")], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_not_absolute");
		}
	});

	test("rejects path outside trusted roots", async () => {
		const stranger = join(workDir, "stranger", "place");
		try {
			await executePrelaunchActions([scaffoldAction(stranger)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_outside_trusted_roots");
		}
	});

	test("rejects when an ancestor symlink escapes trusted roots", async () => {
		const escapeTarget = join(workDir, "outside-root");
		await mkdir(escapeTarget, { recursive: true });
		const linkedAncestor = join(trustedRoot, "linked");
		await symlink(escapeTarget, linkedAncestor);
		const target = join(linkedAncestor, "child");
		try {
			await executePrelaunchActions([scaffoldAction(target)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("symlink_rejected");
		}
	});

	test("allows ancestor symlink whose realpath stays under trusted root", async () => {
		const real = join(trustedRoot, "real");
		await mkdir(real, { recursive: true });
		const aliased = join(trustedRoot, "alias");
		await symlink(real, aliased);
		const target = join(aliased, "child");
		await executePrelaunchActions([scaffoldAction(target)], {
			trustedRoots: [trustedRoot],
		});
		const info = await stat(target);
		expect(info.isDirectory()).toBe(true);
	});
});

describe("executePrelaunchActions: gitInit", () => {
	test("creates .git when gitInit=true on a fresh dir", async () => {
		const target = join(trustedRoot, "with-git");
		await executePrelaunchActions([scaffoldAction(target, { gitInit: true })], {
			trustedRoots: [trustedRoot],
		});
		const dotGit = await stat(join(target, ".git"));
		expect(dotGit.isDirectory()).toBe(true);
	});

	test("skips git init when .git already exists (idempotent)", async () => {
		const target = join(trustedRoot, "preinitialised");
		await mkdir(join(target, ".git"), { recursive: true });
		const sentinel = join(target, ".git", "marker");
		await writeFile(sentinel, "preexisting");

		// Subset-match idempotency: dir contains only .git, which is one of
		// the artifacts this action would create, so mkdir treats it as empty.
		// The git-init step must then no-op rather than re-init.
		await executePrelaunchActions([scaffoldAction(target, { gitInit: true })], {
			trustedRoots: [trustedRoot],
		});
		const marker = await readFile(sentinel, "utf8");
		expect(marker).toBe("preexisting");
	});

	test("re-running scaffold with gitInit on the same dir does not re-init", async () => {
		const target = join(trustedRoot, "rerun");
		await executePrelaunchActions([scaffoldAction(target, { gitInit: true })], {
			trustedRoots: [trustedRoot],
		});
		const headBefore = await readFile(join(target, ".git", "HEAD"), "utf8");
		await executePrelaunchActions([scaffoldAction(target, { gitInit: true })], {
			trustedRoots: [trustedRoot],
		});
		const headAfter = await readFile(join(target, ".git", "HEAD"), "utf8");
		expect(headAfter).toBe(headBefore);
	});
});

describe("executePrelaunchActions: seedClaudeMd", () => {
	test("writes CLAUDE.md to a fresh path with verified SHA", async () => {
		const target = join(trustedRoot, "seeded");
		const content = "# scratch\n\nhello";
		const sha = await sha256Hex(content);
		await executePrelaunchActions(
			[
				scaffoldAction(target, {
					seedClaudeMd: { content, path: "CLAUDE.md", sha256: sha },
				}),
			],
			{ trustedRoots: [trustedRoot] },
		);
		const written = await readFile(join(target, "CLAUDE.md"), "utf8");
		expect(written).toBe(content);
	});

	test("rejects when supplied SHA does not match content", async () => {
		const target = join(trustedRoot, "bad-sha");
		try {
			await executePrelaunchActions(
				[
					scaffoldAction(target, {
						seedClaudeMd: { content: "hello", path: "CLAUDE.md", sha256: "deadbeef" },
					}),
				],
				{ trustedRoots: [trustedRoot] },
			);
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("claude_md_sha_mismatch");
		}
	});

	test("skips rewrite when an existing CLAUDE.md has the same SHA", async () => {
		const target = join(trustedRoot, "same-sha");
		const content = "same-content";
		const sha = await sha256Hex(content);
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "CLAUDE.md"), content);
		const before = (await stat(join(target, "CLAUDE.md"))).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 25));

		await executePrelaunchActions(
			[
				scaffoldAction(target, {
					seedClaudeMd: { content, path: "CLAUDE.md", sha256: sha },
				}),
			],
			{ trustedRoots: [trustedRoot] },
		);
		const after = (await stat(join(target, "CLAUDE.md"))).mtimeMs;
		expect(after).toBe(before);
		const onDisk = await readFile(join(target, "CLAUDE.md"), "utf8");
		expect(onDisk).toBe(content);
	});

	test("does not clobber existing CLAUDE.md when SHAs differ (warns instead)", async () => {
		const target = join(trustedRoot, "no-clobber");
		await mkdir(target, { recursive: true });
		const userContent = "user-edited content";
		await writeFile(join(target, "CLAUDE.md"), userContent);

		const seedContent = "supervisor template";
		const seedSha = await sha256Hex(seedContent);
		const warnings: string[] = [];

		await executePrelaunchActions(
			[
				scaffoldAction(target, {
					seedClaudeMd: { content: seedContent, path: "CLAUDE.md", sha256: seedSha },
				}),
			],
			{ trustedRoots: [trustedRoot], logWarning: (msg) => warnings.push(msg) },
		);

		const stillThere = await readFile(join(target, "CLAUDE.md"), "utf8");
		expect(stillThere).toBe(userContent);
		expect(warnings.some((w) => w.includes("CLAUDE.md") && w.includes("differs"))).toBe(true);
	});
});

describe("executePrelaunchActions: empty / null inputs", () => {
	test("no-ops on empty actions array", async () => {
		await executePrelaunchActions([], { trustedRoots: [trustedRoot] });
	});

	test("trusted root may itself be a path with trailing separator", async () => {
		const target = join(trustedRoot, "trailing-sep");
		await executePrelaunchActions([scaffoldAction(target)], {
			trustedRoots: [`${trustedRoot}${sep}`],
		});
		const info = await stat(target);
		expect(info.isDirectory()).toBe(true);
	});
});
