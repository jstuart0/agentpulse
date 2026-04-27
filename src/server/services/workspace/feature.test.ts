import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { settings } = await import("../../db/schema.js");
const {
	DEFAULT_WORKSPACE_GIT_INIT,
	DEFAULT_WORKSPACE_ROOT,
	DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
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
		expect(ws.defaultRoot).toBe(DEFAULT_WORKSPACE_ROOT);
		expect(ws.templateClaudeMd).toBe(DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD);
		expect(ws.gitInit).toBe(DEFAULT_WORKSPACE_GIT_INIT);
	});

	test("reflects values written via setWorkspaceSettings", async () => {
		await setWorkspaceSettings({
			defaultRoot: "/tmp/wk",
			templateClaudeMd: "hello {{taskSlug}}",
			gitInit: true,
		});
		const ws = await getWorkspaceSettings();
		expect(ws.defaultRoot).toBe("/tmp/wk");
		expect(ws.templateClaudeMd).toBe("hello {{taskSlug}}");
		expect(ws.gitInit).toBe(true);
	});

	test("falls back to default for any individual unset field", async () => {
		await setWorkspaceSettings({ gitInit: true });
		const ws = await getWorkspaceSettings();
		expect(ws.defaultRoot).toBe(DEFAULT_WORKSPACE_ROOT);
		expect(ws.templateClaudeMd).toBe(DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD);
		expect(ws.gitInit).toBe(true);
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
		expect(ws.defaultRoot).toBe("/tmp/wk");
	});

	test("upserts only the provided keys", async () => {
		await setWorkspaceSettings({ defaultRoot: "/a" });
		await setWorkspaceSettings({ gitInit: true });
		const ws = await getWorkspaceSettings();
		expect(ws.defaultRoot).toBe("/a");
		expect(ws.gitInit).toBe(true);
	});

	test("persists template literally — no token substitution at this layer", async () => {
		const raw = "Workspace for {{taskSummary}} ({{taskSlug}})";
		await setWorkspaceSettings({ templateClaudeMd: raw });
		const ws = await getWorkspaceSettings();
		expect(ws.templateClaudeMd).toBe(raw);
	});
});

describe("settings keys are namespaced under workspace.*", () => {
	test("keys match the expected names", () => {
		expect(WORKSPACE_DEFAULT_ROOT_KEY).toBe("workspace.default_root");
		expect(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY).toBe("workspace.template_claude_md");
		expect(WORKSPACE_GIT_INIT_KEY).toBe("workspace.git_init");
	});
});
