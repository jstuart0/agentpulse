// P8 — CH-M1: workspace/feature.ts uses upsertSetting with allowProtected:true.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../../services/ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { settings } = await import("../../db/schema.js");
const { ProtectedSettingError } = await import("../settings-service.js");
const {
	setWorkspaceSettings,
	WORKSPACE_DEFAULT_ROOT_KEY,
	WORKSPACE_TEMPLATE_CLAUDE_MD_KEY,
	WORKSPACE_GIT_INIT_KEY,
	GIT_CLONE_ALLOW_SSH_URLS_KEY,
	GIT_CLONE_TIMEOUT_SECONDS_KEY,
} = await import("./feature.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(settings).execute();
});

afterAll(async () => {
	await getDb().delete(settings).execute();
});

describe("CH-M1 — workspace settings use upsertSetting with allowProtected:true", () => {
	test("setWorkspaceSettings persists workspace.default_root", async () => {
		await setWorkspaceSettings({ defaultRoot: "/tmp/workspace" });
		const [found] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, WORKSPACE_DEFAULT_ROOT_KEY));
		expect(found?.value).toBe("/tmp/workspace");
	});

	test("workspace.* keys are NOT in the user-settable allowlist — upsertSetting without flag throws", async () => {
		// Proves the allowProtected:true flag is necessary.
		// Without the flag, upsertSetting throws ProtectedSettingError.
		const { upsertSetting } = await import("../settings-service.js");
		await expect(upsertSetting(WORKSPACE_DEFAULT_ROOT_KEY, "/tmp/x")).rejects.toBeInstanceOf(
			ProtectedSettingError,
		);
	});

	test("setWorkspaceSettings succeeds for all workspace keys", async () => {
		// If upsertSetting were called without allowProtected:true, this
		// would throw ProtectedSettingError. Verifying it completes without throwing.
		const result = await setWorkspaceSettings({
			defaultRoot: "~/work",
			templateClaudeMd: "hello",
			gitInit: true,
			gitClone: {
				allowSshUrls: false,
				allowLocalUrls: false,
				timeoutSeconds: 60,
			},
		});
		expect(result).not.toBeNull();

		const all = await getDb().select().from(settings);
		const keyMap = new Map(all.map((r) => [r.key, r.value]));
		expect(keyMap.get(WORKSPACE_DEFAULT_ROOT_KEY)).toBe("~/work");
		expect(keyMap.get(WORKSPACE_TEMPLATE_CLAUDE_MD_KEY)).toBe("hello");
		expect(keyMap.get(WORKSPACE_GIT_INIT_KEY)).toBe(true);
		expect(keyMap.get(GIT_CLONE_TIMEOUT_SECONDS_KEY)).toBe(60);
	});

	test("git_clone.* keys are also not in the user-settable allowlist", async () => {
		const { upsertSetting } = await import("../settings-service.js");
		await expect(upsertSetting(GIT_CLONE_ALLOW_SSH_URLS_KEY, true)).rejects.toBeInstanceOf(
			ProtectedSettingError,
		);
		await expect(upsertSetting(GIT_CLONE_TIMEOUT_SECONDS_KEY, 300)).rejects.toBeInstanceOf(
			ProtectedSettingError,
		);
	});
});
