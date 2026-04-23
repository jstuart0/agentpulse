import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { db, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { LABS_REGISTRY, LABS_SETTINGS_KEY, defaultLabsFlags, getLabsFlags, setLabsFlag } =
	await import("./labs-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(settings).execute();
});

describe("labs-service", () => {
	test("default flags include every entry in the registry", () => {
		const defaults = defaultLabsFlags();
		for (const def of LABS_REGISTRY) {
			expect(defaults[def.key]).toBe(def.defaultEnabled);
		}
	});

	test("getLabsFlags returns defaults when no settings row exists", async () => {
		const flags = await getLabsFlags();
		expect(flags).toEqual(defaultLabsFlags());
	});

	test("setLabsFlag persists and merges with defaults", async () => {
		const after = await setLabsFlag("inbox", false);
		expect(after.inbox).toBe(false);
		// Other flags keep their defaults.
		expect(after.digest).toBe(defaultLabsFlags().digest);
		const reloaded = await getLabsFlags();
		expect(reloaded.inbox).toBe(false);
	});

	test("stored partial flags merge with defaults for newly-added features", async () => {
		const now = new Date().toISOString();
		// Legacy stored config that only knows about "inbox".
		await db
			.insert(settings)
			.values({ key: LABS_SETTINGS_KEY, value: { inbox: false }, updatedAt: now })
			.execute();
		const flags = await getLabsFlags();
		expect(flags.inbox).toBe(false);
		// Any other registry entry should fall back to its default.
		for (const def of LABS_REGISTRY) {
			if (def.key === "inbox") continue;
			expect(flags[def.key]).toBe(def.defaultEnabled);
		}
	});
});
