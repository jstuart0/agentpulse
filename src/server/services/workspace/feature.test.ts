import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { settings } = await import("../../db/schema.js");
const {
	DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS,
	DEFAULT_GIT_CLONE_ALLOW_SSH_URLS,
	DEFAULT_GIT_CLONE_DEFAULT_DEPTH,
	DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
	DEFAULT_WORKSPACE_GIT_INIT,
	DEFAULT_WORKSPACE_ROOT,
	DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
	GIT_CLONE_ALLOW_LOCAL_URLS_KEY,
	GIT_CLONE_ALLOW_SSH_URLS_KEY,
	GIT_CLONE_DEFAULT_DEPTH_KEY,
	GIT_CLONE_TIMEOUT_SECONDS_KEY,
	WORKSPACE_DEFAULT_ROOT_KEY,
	WORKSPACE_GIT_INIT_KEY,
	WORKSPACE_TEMPLATE_CLAUDE_MD_KEY,
	WorkspaceValidationError,
	getWorkspaceSettings,
	setWorkspaceSettings,
	validateWorkspaceRoot,
} = await import("./feature.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(settings).execute();
});

describe("validateWorkspaceRoot", () => {
	test("accepts an absolute path", () => {
		expect(validateWorkspaceRoot("/home/jay/work").ok).toBe(true);
	});

	test("accepts a tilde-rooted path", () => {
		expect(validateWorkspaceRoot("~/agentpulse-work").ok).toBe(true);
	});

	test("rejects a relative path", () => {
		const r = validateWorkspaceRoot("relative/path");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/start with/);
	});

	test("rejects an empty string", () => {
		expect(validateWorkspaceRoot("").ok).toBe(false);
	});

	test("rejects whitespace-only", () => {
		expect(validateWorkspaceRoot("   ").ok).toBe(false);
	});

	test("rejects bare ~ without slash", () => {
		expect(validateWorkspaceRoot("~").ok).toBe(false);
	});

	test("rejects non-string input", () => {
		expect(validateWorkspaceRoot(42).ok).toBe(false);
		expect(validateWorkspaceRoot(null).ok).toBe(false);
		expect(validateWorkspaceRoot(undefined).ok).toBe(false);
	});
});

describe("getWorkspaceSettings", () => {
	test("returns defaults when nothing is stored", async () => {
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.defaultRoot).toBe(DEFAULT_WORKSPACE_ROOT);
		expect(ws.workspace.templateClaudeMd).toBe(DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD);
		expect(ws.workspace.gitInit).toBe(DEFAULT_WORKSPACE_GIT_INIT);
		expect(ws.gitClone.allowSshUrls).toBe(DEFAULT_GIT_CLONE_ALLOW_SSH_URLS);
		expect(ws.gitClone.allowLocalUrls).toBe(DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS);
		expect(ws.gitClone.defaultDepth).toBe(DEFAULT_GIT_CLONE_DEFAULT_DEPTH);
		expect(ws.gitClone.timeoutSeconds).toBe(DEFAULT_GIT_CLONE_TIMEOUT_SECONDS);
	});

	test("git-clone defaults match the documented values", async () => {
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.allowSshUrls).toBe(false);
		expect(ws.gitClone.allowLocalUrls).toBe(false);
		expect(ws.gitClone.defaultDepth).toBe(null);
		expect(ws.gitClone.timeoutSeconds).toBe(300);
	});

	test("reflects values written via setWorkspaceSettings", async () => {
		await setWorkspaceSettings({
			defaultRoot: "/tmp/wk",
			templateClaudeMd: "hello {{taskSlug}}",
			gitInit: true,
			gitClone: {
				allowSshUrls: true,
				allowLocalUrls: true,
				defaultDepth: 5,
				timeoutSeconds: 600,
			},
		});
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.defaultRoot).toBe("/tmp/wk");
		expect(ws.workspace.templateClaudeMd).toBe("hello {{taskSlug}}");
		expect(ws.workspace.gitInit).toBe(true);
		expect(ws.gitClone.allowSshUrls).toBe(true);
		expect(ws.gitClone.allowLocalUrls).toBe(true);
		expect(ws.gitClone.defaultDepth).toBe(5);
		expect(ws.gitClone.timeoutSeconds).toBe(600);
	});

	test("falls back to default for any individual unset field", async () => {
		await setWorkspaceSettings({ gitInit: true });
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.defaultRoot).toBe(DEFAULT_WORKSPACE_ROOT);
		expect(ws.workspace.templateClaudeMd).toBe(DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD);
		expect(ws.workspace.gitInit).toBe(true);
		expect(ws.gitClone.allowSshUrls).toBe(DEFAULT_GIT_CLONE_ALLOW_SSH_URLS);
		expect(ws.gitClone.timeoutSeconds).toBe(DEFAULT_GIT_CLONE_TIMEOUT_SECONDS);
	});
});

describe("setWorkspaceSettings", () => {
	test("rejects relative defaultRoot", async () => {
		await expect(setWorkspaceSettings({ defaultRoot: "relative/path" })).rejects.toBeInstanceOf(
			WorkspaceValidationError,
		);
	});

	test("trims whitespace around defaultRoot before persisting", async () => {
		await setWorkspaceSettings({ defaultRoot: "  /tmp/wk  " });
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.defaultRoot).toBe("/tmp/wk");
	});

	test("upserts only the provided keys", async () => {
		await setWorkspaceSettings({ defaultRoot: "/a" });
		await setWorkspaceSettings({ gitInit: true });
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.defaultRoot).toBe("/a");
		expect(ws.workspace.gitInit).toBe(true);
	});

	test("persists template literally — no token substitution at this layer", async () => {
		const raw = "Workspace for {{taskSummary}} ({{taskSlug}})";
		await setWorkspaceSettings({ templateClaudeMd: raw });
		const ws = await getWorkspaceSettings();
		expect(ws.workspace.templateClaudeMd).toBe(raw);
	});

	test("partial gitClone updates leave the other clone fields alone", async () => {
		await setWorkspaceSettings({
			gitClone: {
				allowSshUrls: true,
				timeoutSeconds: 900,
			},
		});
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.allowSshUrls).toBe(true);
		expect(ws.gitClone.allowLocalUrls).toBe(DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS);
		expect(ws.gitClone.defaultDepth).toBe(DEFAULT_GIT_CLONE_DEFAULT_DEPTH);
		expect(ws.gitClone.timeoutSeconds).toBe(900);
	});

	test("round-trips a partial gitClone.allowSshUrls toggle", async () => {
		await setWorkspaceSettings({ gitClone: { allowSshUrls: true } });
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.allowSshUrls).toBe(true);
		expect(ws.gitClone.allowLocalUrls).toBe(false);
	});

	test("rejects negative defaultDepth", async () => {
		await expect(setWorkspaceSettings({ gitClone: { defaultDepth: -1 } })).rejects.toBeInstanceOf(
			WorkspaceValidationError,
		);
	});

	test("rejects zero defaultDepth", async () => {
		await expect(setWorkspaceSettings({ gitClone: { defaultDepth: 0 } })).rejects.toBeInstanceOf(
			WorkspaceValidationError,
		);
	});

	test("rejects non-integer defaultDepth", async () => {
		await expect(setWorkspaceSettings({ gitClone: { defaultDepth: 1.5 } })).rejects.toBeInstanceOf(
			WorkspaceValidationError,
		);
	});

	test("accepts null defaultDepth (full clone)", async () => {
		await setWorkspaceSettings({ gitClone: { defaultDepth: 5 } });
		await setWorkspaceSettings({ gitClone: { defaultDepth: null } });
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.defaultDepth).toBe(null);
	});

	test("accepts a positive integer defaultDepth", async () => {
		await setWorkspaceSettings({ gitClone: { defaultDepth: 5 } });
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.defaultDepth).toBe(5);
	});

	test("rejects timeoutSeconds below the lower bound (10)", async () => {
		await expect(setWorkspaceSettings({ gitClone: { timeoutSeconds: 10 } })).rejects.toBeInstanceOf(
			WorkspaceValidationError,
		);
	});

	test("rejects timeoutSeconds above the upper bound (5000)", async () => {
		await expect(
			setWorkspaceSettings({ gitClone: { timeoutSeconds: 5000 } }),
		).rejects.toBeInstanceOf(WorkspaceValidationError);
	});

	test("accepts the default timeoutSeconds (300)", async () => {
		await setWorkspaceSettings({ gitClone: { timeoutSeconds: 300 } });
		const ws = await getWorkspaceSettings();
		expect(ws.gitClone.timeoutSeconds).toBe(300);
	});

	test("rejects non-boolean allowSshUrls", async () => {
		await expect(
			// @ts-expect-error — testing runtime validation
			setWorkspaceSettings({ gitClone: { allowSshUrls: "true" } }),
		).rejects.toBeInstanceOf(WorkspaceValidationError);
	});

	test("rejects non-boolean allowLocalUrls", async () => {
		await expect(
			// @ts-expect-error — testing runtime validation
			setWorkspaceSettings({ gitClone: { allowLocalUrls: 1 } }),
		).rejects.toBeInstanceOf(WorkspaceValidationError);
	});
});

describe("settings keys are namespaced under workspace.* and git_clone.*", () => {
	test("workspace keys match the expected names", () => {
		expect(WORKSPACE_DEFAULT_ROOT_KEY).toBe("workspace.default_root");
		expect(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY).toBe("workspace.template_claude_md");
		expect(WORKSPACE_GIT_INIT_KEY).toBe("workspace.git_init");
	});

	test("git_clone keys match the expected names", () => {
		expect(GIT_CLONE_ALLOW_SSH_URLS_KEY).toBe("git_clone.allow_ssh_urls");
		expect(GIT_CLONE_ALLOW_LOCAL_URLS_KEY).toBe("git_clone.allow_local_urls");
		expect(GIT_CLONE_DEFAULT_DEPTH_KEY).toBe("git_clone.default_depth");
		expect(GIT_CLONE_TIMEOUT_SECONDS_KEY).toBe("git_clone.timeout_seconds");
	});
});
