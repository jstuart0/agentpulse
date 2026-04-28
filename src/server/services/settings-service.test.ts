import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import type { ProtectedSettingError as ProtectedSettingErrorType } from "./settings-service.js";

const { eq } = await import("drizzle-orm");
const { db, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { ProtectedSettingError, isProtectedSettingKey, upsertSetting } = await import(
	"./settings-service.js"
);

beforeAll(() => {
	initializeDatabase();
});

afterEach(async () => {
	await db.delete(settings).execute();
});

async function readSetting(key: string) {
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
	return row;
}

describe("upsertSetting", () => {
	test("writes a non-protected key and is idempotent", async () => {
		await upsertSetting("ui.theme", "dark");
		let row = await readSetting("ui.theme");
		expect(row?.value).toBe("dark");

		// Calling again with a new value should update, not insert a duplicate.
		await upsertSetting("ui.theme", "light");
		row = await readSetting("ui.theme");
		expect(row?.value).toBe("light");

		const allThemeRows = await db.select().from(settings).where(eq(settings.key, "ui.theme"));
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

	test("allowProtected: true bypasses the denylist", async () => {
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
	});

	test("isProtectedSettingKey classifies correctly", () => {
		expect(isProtectedSettingKey("ai.enabled")).toBe(true);
		expect(isProtectedSettingKey("ai.killSwitch")).toBe(true);
		expect(isProtectedSettingKey("ai.classifierEnabled")).toBe(true);
		expect(isProtectedSettingKey("vectorSearch.model")).toBe(true);
		expect(isProtectedSettingKey("telegram:credentials")).toBe(true);
		expect(isProtectedSettingKey("ui.theme")).toBe(false);
		expect(isProtectedSettingKey("sessionIdleTimeoutMinutes")).toBe(false);
		expect(isProtectedSettingKey("eventsRetentionDays")).toBe(false);
		// Lookalike keys must not get accidentally protected.
		expect(isProtectedSettingKey("aiAssistant")).toBe(false);
		expect(isProtectedSettingKey("vectorSearchUI")).toBe(false);
	});
});
