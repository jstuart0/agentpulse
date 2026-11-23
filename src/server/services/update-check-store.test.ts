import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { eq } from "drizzle-orm";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { settings } = await import("../db/schema/index.js");
const { settingsUpdateStore, UPDATE_STATE_SETTING } = await import("./update-check.js");
const { upsertSetting } = await import("./settings-service.js");

beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(async () => {
	await getDb().delete(settings).where(eq(settings.key, UPDATE_STATE_SETTING));
});

async function loadWith(lastResult: unknown) {
	await upsertSetting(
		UPDATE_STATE_SETTING,
		{ lastCheckedAt: "2026-11-19T12:00:00.000Z", lastResult, last: null, revoked: [] },
		{ allowProtected: true },
	);
	return (await settingsUpdateStore().load()).state.lastResult;
}

describe("the stored lastResult is an allowlist", () => {
	test("ok, unreachable, not_published and every verifier code survive", async () => {
		for (const code of [
			"ok",
			"unreachable",
			"not_published",
			"too_large",
			"bad_envelope",
			"unknown_key",
			"revoked_key",
			"bad_signature",
			"replayed",
			"older",
			"future",
			"bad_payload",
		]) {
			expect(await loadWith(code)).toBe(code as never);
		}
	});

	test("anything else is dropped to null", async () => {
		for (const bad of ["evil", "<script>", "", "OK", 3, {}, [], null, "__proto__"]) {
			expect(await loadWith(bad)).toBeNull();
		}
	});
});
