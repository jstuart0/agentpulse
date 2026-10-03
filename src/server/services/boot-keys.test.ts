/**
 * Boot, for API keys: on a fresh install the default key is minted first and
 * the unlisted-admin-service-key warning runs after it. In env-locked team
 * mode the default key is minted ingest-only (nobody is locked out: a human
 * admin source is required to boot), so a fresh team install never starts with
 * an ownerless manage key that acts as a member and warns nobody.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { clearInstanceSettings } from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys } = await import("../db/schema/index.js");
const apiKeyModule = await import("../auth/api-key.js");
const instanceMode = await import("./instance-mode.js");
const { ensureDefaultKeyThenWarn } = await import("./boot-keys.js");

const originalMode = process.env.AGENTPULSE_MODE;

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	if (originalMode === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an absent env var
		delete process.env.AGENTPULSE_MODE;
	} else {
		process.env.AGENTPULSE_MODE = originalMode;
	}
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

async function defaultKeyScopes(): Promise<string[]> {
	const rows = await getDb().select().from(apiKeys);
	expect(rows.length).toBe(1);
	return apiKeyModule.parseScopes(rows[0]?.scopes);
}

describe("the default key on a fresh install", () => {
	test("solo: ingest and manage, as before", async () => {
		await ensureDefaultKeyThenWarn();
		expect(await defaultKeyScopes()).toEqual(["ingest", "manage"]);
	});

	test("team (set by the environment): ingest only", async () => {
		process.env.AGENTPULSE_MODE = "team";
		await ensureDefaultKeyThenWarn();
		expect(await defaultKeyScopes()).toEqual(["ingest"]);
	});

	test("team (stored by an admin): ingest only", async () => {
		const { setStoredMode } = await import("../test-utils/team-fixtures.js");
		await setStoredMode("team");
		await ensureDefaultKeyThenWarn();
		expect(await defaultKeyScopes()).toEqual(["ingest"]);
	});
});

describe("the order at boot", () => {
	test("the default key is created before the warning looks for unlisted admin service keys", async () => {
		const order: string[] = [];
		const ensure = spyOn(apiKeyModule, "ensureDefaultApiKey").mockImplementation(async () => {
			order.push("default-key");
			return null;
		});
		const warn = spyOn(instanceMode, "warnAboutUnlistedAdminServiceKeysAtBoot").mockImplementation(
			async () => {
				order.push("warning");
			},
		);
		try {
			await ensureDefaultKeyThenWarn();
		} finally {
			ensure.mockRestore();
			warn.mockRestore();
		}
		expect(order).toEqual(["default-key", "warning"]);
	});
});

describe("src/server/index.ts boots through the ordered helper", () => {
	// Loading index.ts starts a server, so the order is pinned by reading its
	// source: it must reach the warning only through ensureDefaultKeyThenWarn,
	// never by calling the warning (or the default-key minting) itself.
	test("index.ts calls ensureDefaultKeyThenWarn and neither of the two steps directly", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
		expect(source).toMatch(/await ensureDefaultKeyThenWarn\(\)/);
		expect(source).not.toMatch(/warnAboutUnlistedAdminServiceKeysAtBoot/);
		expect(source).not.toMatch(/ensureDefaultApiKey/);
	});
});
