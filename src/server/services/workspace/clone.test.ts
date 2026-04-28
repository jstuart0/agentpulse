import { describe, expect, test } from "bun:test";
import { type CloneRepoInput, cloneRepo, validateCloneUrlPolicy } from "./clone.js";
import type { GitCloneSettings, WorkspaceSettings } from "./feature.js";
import { WorkspaceCollisionExhaustedError, WorkspacePathValidationError } from "./scaffold.js";

const baseWorkspace: WorkspaceSettings = {
	defaultRoot: "~/agentpulse-work",
	templateClaudeMd: "# {{taskSlug}}\n\n{{taskSummary}}",
	gitInit: false,
};

const strictGitClone: GitCloneSettings = {
	allowSshUrls: false,
	allowLocalUrls: false,
	defaultDepth: null,
	timeoutSeconds: 300,
};

const permissiveGitClone: GitCloneSettings = {
	allowSshUrls: true,
	allowLocalUrls: true,
	defaultDepth: null,
	timeoutSeconds: 300,
};

function makeInput(overrides: Partial<CloneRepoInput> = {}): CloneRepoInput {
	return {
		url: "https://github.com/foo/bar.git",
		workspaceSettings: { ...baseWorkspace, gitClone: strictGitClone },
		...overrides,
	};
}

describe("validateCloneUrlPolicy", () => {
	test("accepts plain https URL", () => {
		expect(() =>
			validateCloneUrlPolicy("https://github.com/foo/bar.git", strictGitClone),
		).not.toThrow();
	});

	test("accepts http URL (delegate to settings if needed)", () => {
		expect(() =>
			validateCloneUrlPolicy("http://example.com/foo/bar.git", strictGitClone),
		).not.toThrow();
	});

	test("rejects empty / non-string URL", () => {
		expect(() => validateCloneUrlPolicy("", strictGitClone)).toThrow(WorkspacePathValidationError);
		expect(() => validateCloneUrlPolicy("   ", strictGitClone)).toThrow(
			WorkspacePathValidationError,
		);
		expect(() => validateCloneUrlPolicy(undefined, strictGitClone)).toThrow(
			WorkspacePathValidationError,
		);
	});

	test("rejects unparseable URL with clone_url_invalid", () => {
		try {
			validateCloneUrlPolicy("not a url at all", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspacePathValidationError);
			expect((err as WorkspacePathValidationError).code).toBe("clone_url_invalid");
		}
	});

	test("blocks SCP-style git@host:path when allowSshUrls=false", () => {
		try {
			validateCloneUrlPolicy("git@github.com:foo/bar.git", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspacePathValidationError);
			expect((err as WorkspacePathValidationError).code).toBe("clone_scheme_disallowed");
		}
	});

	test("permits SCP-style git@host:path when allowSshUrls=true", () => {
		expect(() =>
			validateCloneUrlPolicy("git@github.com:foo/bar.git", permissiveGitClone),
		).not.toThrow();
	});

	test("blocks ssh:// URLs when allowSshUrls=false", () => {
		try {
			validateCloneUrlPolicy("ssh://git@github.com/foo/bar.git", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect((err as WorkspacePathValidationError).code).toBe("clone_scheme_disallowed");
		}
	});

	test("blocks file:// URLs when allowLocalUrls=false", () => {
		try {
			validateCloneUrlPolicy("file:///tmp/foo", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect((err as WorkspacePathValidationError).code).toBe("clone_scheme_disallowed");
		}
	});

	test("permits file:// URLs when allowLocalUrls=true", () => {
		expect(() => validateCloneUrlPolicy("file:///tmp/foo", permissiveGitClone)).not.toThrow();
	});

	test("rejects URL with embedded credentials and does not echo URL in message", () => {
		try {
			validateCloneUrlPolicy("https://user:secrettoken@github.com/foo/bar", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorkspacePathValidationError);
			expect((err as WorkspacePathValidationError).code).toBe("clone_credentials_in_url");
			const msg = (err as Error).message;
			expect(msg).not.toContain("secrettoken");
			expect(msg).not.toContain("user:");
			expect(msg).not.toContain("github.com/foo/bar");
		}
	});

	test("rejects unknown scheme as clone_scheme_disallowed", () => {
		try {
			validateCloneUrlPolicy("rsync://example.com/foo", strictGitClone);
			throw new Error("expected to throw");
		} catch (err) {
			expect((err as WorkspacePathValidationError).code).toBe("clone_scheme_disallowed");
		}
	});
});

describe("cloneRepo: slug derivation", () => {
	test("derives slug from URL basename when no taskSlug provided", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/foo/bar.git" }));
		expect(result.resolvedPath).toBe("~/agentpulse-work/bar");
	});

	test("strips trailing .git from URL basename", async () => {
		const result = await cloneRepo(
			makeInput({ url: "https://github.com/example/something-cool.git" }),
		);
		expect(result.resolvedPath).toBe("~/agentpulse-work/something-cool");
	});

	test("prefixes org when basename is very short (1 char)", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/foo/x" }));
		expect(result.resolvedPath).toBe("~/agentpulse-work/foo-x");
	});

	test("prefixes org when basename is 2 chars", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/myorg/ai" }));
		expect(result.resolvedPath).toBe("~/agentpulse-work/myorg-ai");
	});

	test("does NOT prefix when basename is 3+ chars", async () => {
		// `bar` (3 chars) is the canonical example from the plan's slug-derivation
		// test cases — kept as-is, not org-prefixed (plan §12.6 example output).
		const result = await cloneRepo(makeInput({ url: "https://github.com/foo/bar.git" }));
		expect(result.resolvedPath).toBe("~/agentpulse-work/bar");
	});

	test("does NOT prefix when basename is longer than the short threshold", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/foo/longer-repo-name" }));
		expect(result.resolvedPath).toBe("~/agentpulse-work/longer-repo-name");
	});

	test("explicit taskSlug overrides URL-derived slug", async () => {
		const result = await cloneRepo(
			makeInput({
				url: "https://github.com/foo/bar.git",
				taskSlug: "auth-refactor",
			}),
		);
		expect(result.resolvedPath).toBe("~/agentpulse-work/auth-refactor");
	});
});

describe("cloneRepo: path resolution", () => {
	test("default root + slug composition", async () => {
		const result = await cloneRepo(
			makeInput({
				workspaceSettings: {
					...baseWorkspace,
					defaultRoot: "/tmp/work",
					gitClone: strictGitClone,
				},
			}),
		);
		expect(result.resolvedPath).toBe("/tmp/work/bar");
	});

	test("explicitPath overrides default-root composition", async () => {
		const result = await cloneRepo(makeInput({ explicitPath: "~/somewhere-else/my-clone" }));
		expect(result.resolvedPath).toBe("~/somewhere-else/my-clone");
	});

	test("explicitPath rejects relative paths", async () => {
		await expect(cloneRepo(makeInput({ explicitPath: "relative/path" }))).rejects.toBeInstanceOf(
			WorkspacePathValidationError,
		);
	});

	test("explicitPath rejects path traversal", async () => {
		await expect(
			cloneRepo(makeInput({ explicitPath: "/tmp/../etc/passwd" })),
		).rejects.toBeInstanceOf(WorkspacePathValidationError);
	});

	test("collision suffixing: -2 when base collides", async () => {
		const colliding = new Set(["~/agentpulse-work/longer-repo-name"]);
		const result = await cloneRepo(
			makeInput({
				url: "https://github.com/foo/longer-repo-name",
				collidingPaths: colliding,
			}),
		);
		expect(result.resolvedPath).toBe("~/agentpulse-work/longer-repo-name-2");
	});

	test("collision suffixing: -3 when base and -2 both collide", async () => {
		const colliding = new Set([
			"~/agentpulse-work/longer-repo-name",
			"~/agentpulse-work/longer-repo-name-2",
		]);
		const result = await cloneRepo(
			makeInput({
				url: "https://github.com/foo/longer-repo-name",
				collidingPaths: colliding,
			}),
		);
		expect(result.resolvedPath).toBe("~/agentpulse-work/longer-repo-name-3");
	});

	test("throws WorkspaceCollisionExhaustedError after 10 attempts", async () => {
		const colliding = new Set<string>(["~/agentpulse-work/longer-repo-name"]);
		for (let i = 2; i <= 10; i++) colliding.add(`~/agentpulse-work/longer-repo-name-${i}`);
		await expect(
			cloneRepo(
				makeInput({
					url: "https://github.com/foo/longer-repo-name",
					collidingPaths: colliding,
				}),
			),
		).rejects.toBeInstanceOf(WorkspaceCollisionExhaustedError);
	});
});

describe("cloneRepo: action shape", () => {
	test("returns exactly one clone_repo action", async () => {
		const result = await cloneRepo(makeInput());
		expect(result.prelaunchActions).toHaveLength(1);
		expect(result.prelaunchActions[0].kind).toBe("clone_repo");
	});

	test("intoPath matches resolvedPath", async () => {
		const result = await cloneRepo(makeInput());
		expect(result.prelaunchActions[0].intoPath).toBe(result.resolvedPath);
	});

	test("branch passed through when provided", async () => {
		const result = await cloneRepo(makeInput({ branch: "feature/x" }));
		expect(result.prelaunchActions[0].branch).toBe("feature/x");
	});

	test("branch absent when not provided", async () => {
		const result = await cloneRepo(makeInput());
		expect(result.prelaunchActions[0].branch).toBeUndefined();
	});

	test("depth from settings used when no branch is requested", async () => {
		const result = await cloneRepo(
			makeInput({
				workspaceSettings: {
					...baseWorkspace,
					gitClone: { ...strictGitClone, defaultDepth: 1 },
				},
			}),
		);
		expect(result.prelaunchActions[0].depth).toBe(1);
	});

	test("depth NOT applied when branch is requested (full history needed)", async () => {
		const result = await cloneRepo(
			makeInput({
				branch: "feature/x",
				workspaceSettings: {
					...baseWorkspace,
					gitClone: { ...strictGitClone, defaultDepth: 1 },
				},
			}),
		);
		expect(result.prelaunchActions[0].depth).toBeUndefined();
	});

	test("depth absent when defaultDepth is null", async () => {
		const result = await cloneRepo(makeInput());
		expect(result.prelaunchActions[0].depth).toBeUndefined();
	});

	test("timeoutSeconds always passed through from settings", async () => {
		const result = await cloneRepo(
			makeInput({
				workspaceSettings: {
					...baseWorkspace,
					gitClone: { ...strictGitClone, timeoutSeconds: 600 },
				},
			}),
		);
		expect(result.prelaunchActions[0].timeoutSeconds).toBe(600);
	});

	test("does not seed CLAUDE.md by default (clones bring their own)", async () => {
		const result = await cloneRepo(makeInput());
		expect(result.prelaunchActions[0].seedClaudeMd).toBeUndefined();
	});
});

describe("cloneRepo: URL canonicalization", () => {
	test("strips trailing slash from path", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/foo/bar/" }));
		expect(result.prelaunchActions[0].url).toBe("https://github.com/foo/bar");
	});

	test("lowercases host", async () => {
		const result = await cloneRepo(makeInput({ url: "https://GitHub.com/foo/Bar" }));
		expect(result.prelaunchActions[0].url).toBe("https://github.com/foo/Bar");
	});

	test("preserves path case (some hosts are path-sensitive)", async () => {
		const result = await cloneRepo(makeInput({ url: "https://github.com/Foo/Bar.git" }));
		expect(result.prelaunchActions[0].url).toBe("https://github.com/Foo/Bar.git");
	});

	test("leaves SCP-style URLs unchanged", async () => {
		const result = await cloneRepo(
			makeInput({
				url: "git@github.com:foo/bar.git",
				workspaceSettings: { ...baseWorkspace, gitClone: permissiveGitClone },
			}),
		);
		expect(result.prelaunchActions[0].url).toBe("git@github.com:foo/bar.git");
	});
});
