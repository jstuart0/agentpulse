import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema/index.js");
const { LABS_REGISTRY, LABS_SETTINGS_KEY, defaultLabsFlags, getLabsFlags, setLabsFlag } =
	await import("./labs-service.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(settings).execute();
});

// Nothing resets `settings` after the LAST test in this file — the
// beforeEach above only protects tests within this file from each other.
afterAll(async () => {
	await getDb().delete(settings).execute();
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
		await getDb()
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

	test("TC-5.59 the sessionSummary flag is registered by this key and label with the exact description, off by default", () => {
		const entry = LABS_REGISTRY.find((def) => def.key === "sessionSummary");
		expect(entry).toBeDefined();
		expect(entry?.key).toBe("sessionSummary");
		expect(entry?.label).toBe("Session summary");
		expect(entry?.description).toBe(
			"Summary tab on each session: what it set out to do, what changed, what was checked, what's left. Nothing is sent to your AI provider until you ask for a summary.",
		);
		expect(entry?.defaultEnabled).toBe(false);
		expect(defaultLabsFlags().sessionSummary).toBe(false);
	});
});
