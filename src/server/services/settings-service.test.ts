import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import type { ProtectedSettingError as ProtectedSettingErrorType } from "./settings-service.js";

const { eq } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { ProtectedSettingError, upsertSetting } = await import("./settings-service.js");

beforeAll(() => {
	initializeDatabase();
});

afterEach(async () => {
	await getDb().delete(settings).execute();
});

async function readSetting(key: string) {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
	return row;
}

describe("upsertSetting", () => {
	test("writes a user-settable key and is idempotent", async () => {
		await upsertSetting("theme", "dark");
		let row = await readSetting("theme");
		expect(row?.value).toBe("dark");

		// Calling again with a new value should update, not insert a duplicate.
		await upsertSetting("theme", "light");
		row = await readSetting("theme");
		expect(row?.value).toBe("light");

		const allThemeRows = await getDb().select().from(settings).where(eq(settings.key, "theme"));
		expect(allThemeRows.length).toBe(1);
	});

	test("throws ProtectedSettingError for ai.* keys without allowProtected", async () => {
		let caught: unknown;
		try {
			await upsertSetting("ai.enabled", true);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProtectedSettingError);
		expect((caught as ProtectedSettingErrorType).key).toBe("ai.enabled");
		const row = await readSetting("ai.enabled");
		expect(row).toBeUndefined();
	});

	test("throws ProtectedSettingError for vectorSearch.* keys", async () => {
		let caught: unknown;
		try {
			await upsertSetting("vectorSearch.enabled", true);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProtectedSettingError);
		expect((caught as ProtectedSettingErrorType).key).toBe("vectorSearch.enabled");
	});

	test("throws ProtectedSettingError for telegram:credentials", async () => {
		let caught: unknown;
		try {
			await upsertSetting("telegram:credentials", { token: "x", chatId: "y" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProtectedSettingError);
		expect((caught as ProtectedSettingErrorType).key).toBe("telegram:credentials");
	});

	test("throws ProtectedSettingError for workspace.* keys without allowProtected", async () => {
		let caught: unknown;
		try {
			await upsertSetting("workspace.defaultRoot", "~/foo");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProtectedSettingError);
		expect((caught as ProtectedSettingErrorType).key).toBe("workspace.defaultRoot");
	});

	test("throws ProtectedSettingError for auth.firstRunCompleted without allowProtected", async () => {
		let caught: unknown;
		try {
			await upsertSetting("auth.firstRunCompleted", "true");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProtectedSettingError);
		expect((caught as ProtectedSettingErrorType).key).toBe("auth.firstRunCompleted");
	});

	test("allowProtected: true bypasses the allowlist", async () => {
		await upsertSetting("ai.enabled", true, { allowProtected: true });
		const row = await readSetting("ai.enabled");
		expect(row?.value).toBe(true);

		await upsertSetting("vectorSearch.enabled", true, { allowProtected: true });
		const vsRow = await readSetting("vectorSearch.enabled");
		expect(vsRow?.value).toBe(true);

		await upsertSetting(
			"telegram:credentials",
			{ token: "secret", chatId: "1" },
			{ allowProtected: true },
		);
		const tgRow = await readSetting("telegram:credentials");
		expect(tgRow?.value).toEqual({ token: "secret", chatId: "1" });

		await upsertSetting("auth.firstRunCompleted", "true", { allowProtected: true });
		const authRow = await readSetting("auth.firstRunCompleted");
		expect(authRow?.value).toBe("true");

		await upsertSetting("workspace.defaultRoot", "~/foo", { allowProtected: true });
		const wsRow = await readSetting("workspace.defaultRoot");
		expect(wsRow?.value).toBe("~/foo");
	});

	test("allowlist classifies correctly — user-settable keys accepted without allowProtected", async () => {
		// These are the keys the SettingsPage UI writes. They must pass without allowProtected.
		for (const key of [
			"theme",
			"sessionIdleTimeoutMinutes",
			"sessionEndTimeoutMinutes",
			"eventsRetentionDays",
		]) {
			await expect(upsertSetting(key, "test")).resolves.toBeUndefined();
		}
	});

	test("allowlist classifies correctly — internal-only keys rejected without allowProtected", async () => {
		const internalKeys = [
			"ai.enabled",
			"ai.killSwitch",
			"ai.classifierEnabled",
			"vectorSearch.model",
			"telegram:credentials",
			"workspace.defaultRoot",
			"auth.firstRunCompleted",
			"installation_id",
		];
		for (const key of internalKeys) {
			let caught: unknown;
			try {
				await upsertSetting(key, "x");
			} catch (err) {
				caught = err;
			}
			expect(caught, `expected ${key} to be rejected`).toBeInstanceOf(ProtectedSettingError);
		}
	});
});
