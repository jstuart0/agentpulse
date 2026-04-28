import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PrelaunchAction } from "../../shared/types.js";
import {
	PrelaunchError,
	classifyCloneStderr,
	executePrelaunchActions,
} from "./prelaunch-actions.js";

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

function cloneAction(
	url: string,
	intoPath: string,
	overrides: Partial<Extract<PrelaunchAction, { kind: "clone_repo" }>> = {},
): PrelaunchAction {
	return {
		kind: "clone_repo",
		url,
		intoPath,
		...overrides,
	};
}

async function spawnGit(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function makeOriginRepo(
	root: string,
	options: {
		extraBranch?: string;
		commits?: number;
	} = {},
): Promise<{ path: string; url: string }> {
	const repoPath = join(root, "origin.git-src");
	await mkdir(repoPath, { recursive: true });
	const env = {
		GIT_AUTHOR_NAME: "ap-test",
		GIT_AUTHOR_EMAIL: "ap-test@example.com",
		GIT_COMMITTER_NAME: "ap-test",
		GIT_COMMITTER_EMAIL: "ap-test@example.com",
	};
	await spawnGit(["init", "--initial-branch=main", "--quiet"], repoPath);
	await writeFile(join(repoPath, "README.md"), "hello\n");
	await spawnGit(["add", "."], repoPath, env);
	await spawnGit(["commit", "-m", "initial", "--quiet"], repoPath, env);
	const totalCommits = options.commits ?? 1;
	for (let i = 1; i < totalCommits; i++) {
		await writeFile(join(repoPath, `f${i}.txt`), `${i}\n`);
		await spawnGit(["add", "."], repoPath, env);
		await spawnGit(["commit", "-m", `c${i}`, "--quiet"], repoPath, env);
	}
	if (options.extraBranch) {
		await spawnGit(["checkout", "-b", options.extraBranch, "--quiet"], repoPath, env);
		await writeFile(join(repoPath, "branch-only.txt"), "branch\n");
		await spawnGit(["add", "."], repoPath, env);
		await spawnGit(["commit", "-m", "branch commit", "--quiet"], repoPath, env);
		await spawnGit(["checkout", "main", "--quiet"], repoPath, env);
	}
	return { path: repoPath, url: `file://${repoPath}` };
}

describe("executePrelaunchActions: clone_repo URL + path validation", () => {
	test("rejects HTTPS URL with embedded credentials", async () => {
		try {
			await executePrelaunchActions(
				[cloneAction("https://user:secret@example.com/x.git", join(trustedRoot, "creds"))],
				{ trustedRoots: [trustedRoot] },
			);
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_credentials_in_url");
			// Defense in depth: error must not echo the URL (would leak secret).
			expect((err as PrelaunchError).message).not.toContain("secret");
		}
	});

	test("rejects SSH-form URL with clone_scheme_disallowed", async () => {
		try {
			await executePrelaunchActions(
				[cloneAction("git@github.com:org/repo.git", join(trustedRoot, "ssh"))],
				{ trustedRoots: [trustedRoot] },
			);
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_scheme_disallowed");
		}
	});

	test("rejects empty / unparseable URL with clone_url_invalid", async () => {
		try {
			await executePrelaunchActions([cloneAction("", join(trustedRoot, "empty-url"))], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_url_invalid");
		}
	});

	test("rejects '..' segments in intoPath with path_traversal_rejected", async () => {
		const origin = await makeOriginRepo(workDir);
		try {
			await executePrelaunchActions([cloneAction(origin.url, `${trustedRoot}/foo/../escape`)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_traversal_rejected");
		}
	});

	test("rejects intoPath outside trusted roots", async () => {
		const origin = await makeOriginRepo(workDir);
		const stranger = join(workDir, "stranger", "place");
		try {
			await executePrelaunchActions([cloneAction(origin.url, stranger)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_outside_trusted_roots");
		}
	});

	test("rejects relative intoPath with path_not_absolute", async () => {
		const origin = await makeOriginRepo(workDir);
		try {
			await executePrelaunchActions([cloneAction(origin.url, "relative/path")], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("path_not_absolute");
		}
	});
});

describe("executePrelaunchActions: clone_repo execution", () => {
	test("clones a fresh repo into a fresh path under trustedRoots", async () => {
		const origin = await makeOriginRepo(workDir);
		const target = join(trustedRoot, "fresh-clone");
		await executePrelaunchActions([cloneAction(origin.url, target)], {
			trustedRoots: [trustedRoot],
		});
		const dotGit = await stat(join(target, ".git"));
		expect(dotGit.isDirectory()).toBe(true);
		const readme = await readFile(join(target, "README.md"), "utf8");
		expect(readme).toBe("hello\n");
	});

	test("respects --branch and --depth options", async () => {
		const origin = await makeOriginRepo(workDir, { extraBranch: "feature-x", commits: 3 });
		const target = join(trustedRoot, "shallow-branch");
		await executePrelaunchActions(
			[cloneAction(origin.url, target, { branch: "feature-x", depth: 1 })],
			{ trustedRoots: [trustedRoot] },
		);
		const head = await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], target);
		expect(head.stdout.trim()).toBe("feature-x");
		const count = await spawnGit(["rev-list", "--count", "HEAD"], target);
		expect(count.stdout.trim()).toBe("1");
	});

	test("idempotent re-clone when path exists with the same origin", async () => {
		const origin = await makeOriginRepo(workDir);
		const target = join(trustedRoot, "idempotent");
		await executePrelaunchActions([cloneAction(origin.url, target)], {
			trustedRoots: [trustedRoot],
		});
		// Drop a sentinel inside the worktree; if the second call were to actually
		// re-clone, it would have to remove this file (which it shouldn't).
		await writeFile(join(target, "sentinel.txt"), "kept");
		await executePrelaunchActions([cloneAction(origin.url, target)], {
			trustedRoots: [trustedRoot],
		});
		const sentinel = await readFile(join(target, "sentinel.txt"), "utf8");
		expect(sentinel).toBe("kept");
	});

	test("throws clone_target_exists when path has a different origin", async () => {
		const origin1 = await makeOriginRepo(workDir);
		const origin2Path = join(workDir, "origin2.git-src");
		await mkdir(origin2Path, { recursive: true });
		const env = {
			GIT_AUTHOR_NAME: "ap-test",
			GIT_AUTHOR_EMAIL: "ap-test@example.com",
			GIT_COMMITTER_NAME: "ap-test",
			GIT_COMMITTER_EMAIL: "ap-test@example.com",
		};
		await spawnGit(["init", "--initial-branch=main", "--quiet"], origin2Path);
		await writeFile(join(origin2Path, "README.md"), "alt\n");
		await spawnGit(["add", "."], origin2Path, env);
		await spawnGit(["commit", "-m", "initial", "--quiet"], origin2Path, env);
		const target = join(trustedRoot, "diff-origin");
		await executePrelaunchActions([cloneAction(`file://${origin2Path}`, target)], {
			trustedRoots: [trustedRoot],
		});
		try {
			await executePrelaunchActions([cloneAction(origin1.url, target)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_target_exists");
		}
	});

	test("throws clone_target_exists when path is non-empty and lacks .git/", async () => {
		const origin = await makeOriginRepo(workDir);
		const target = join(trustedRoot, "occupied");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "stray.txt"), "hi");
		try {
			await executePrelaunchActions([cloneAction(origin.url, target)], {
				trustedRoots: [trustedRoot],
			});
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_target_exists");
		}
	});

	test("removes the target directory when clone fails AND we created it", async () => {
		const origin = await makeOriginRepo(workDir);
		const target = join(trustedRoot, "would-be-created");
		try {
			await executePrelaunchActions(
				[cloneAction(origin.url, target, { branch: "no-such-branch" })],
				{ trustedRoots: [trustedRoot] },
			);
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_failed");
		}
		let exists = true;
		try {
			await stat(target);
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);
	});

	test("preserves a pre-existing empty dir on clone failure", async () => {
		const origin = await makeOriginRepo(workDir);
		const target = join(trustedRoot, "preexisting-empty");
		await mkdir(target, { recursive: true });
		try {
			await executePrelaunchActions(
				[cloneAction(origin.url, target, { branch: "no-such-branch" })],
				{ trustedRoots: [trustedRoot] },
			);
			throw new Error("expected PrelaunchError");
		} catch (err) {
			expect(err).toBeInstanceOf(PrelaunchError);
			expect((err as PrelaunchError).code).toBe("clone_failed");
		}
		// Directory we did NOT create must still exist.
		const info = await stat(target);
		expect(info.isDirectory()).toBe(true);
	});
});

describe("classifyCloneStderr", () => {
	test("classifies authentication failure", () => {
		expect(classifyCloneStderr("fatal: Authentication failed for 'https://...'").code).toBe(
			"clone_failed",
		);
		expect(classifyCloneStderr("fatal: Authentication failed").hint).toContain("authentication");
	});

	test("classifies repository-not-found", () => {
		expect(classifyCloneStderr("remote: Repository not found.").hint).toContain("not found");
	});

	test("classifies DNS / network failure", () => {
		expect(classifyCloneStderr("fatal: Could not resolve host: example.invalid").hint).toContain(
			"DNS",
		);
	});

	test("classifies disk-full", () => {
		const out = classifyCloneStderr("error: file write error: No space left on device");
		expect(out.code).toBe("disk_full");
	});

	test("falls back to generic clone_failed on unrecognised stderr", () => {
		expect(classifyCloneStderr("something unexpected").code).toBe("clone_failed");
	});
});

// NOTE: A real clone_timeout test against `git clone` would require either a
// fake remote that hangs (delicate, racey, OS-dependent) or extensive Bun.spawn
// mocking. We rely on the timeout AbortController integration in
// executeCloneRepo + the classifyCloneStderr unit tests above, plus the
// happy-path tests above which exercise the timeout-armed code path.

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
