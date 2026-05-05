// P8 — S-M4: verify config.localAdminPassword is cleared after bootstrap.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { users } = await import("../db/schema/index.js");
const { ensureBootstrapAdmin } = await import("../services/local-auth-bootstrap.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(users).execute();
	// Reset password so each test starts fresh.
	config.localAdminPassword = process.env.AGENTPULSE_LOCAL_ADMIN_PASSWORD || "testpass";
	config.localAdminUsername = process.env.AGENTPULSE_LOCAL_ADMIN_USERNAME || "testadmin";
});

afterAll(() => {
	// Restore from env for other tests.
	config.localAdminPassword = process.env.AGENTPULSE_LOCAL_ADMIN_PASSWORD || "";
	config.localAdminUsername = process.env.AGENTPULSE_LOCAL_ADMIN_USERNAME || "";
});

describe("S-M4 — localAdminPassword cleared post-bootstrap", () => {
	test("password is cleared after creating a new admin", async () => {
		config.localAdminUsername = `admin-${crypto.randomUUID().slice(0, 8)}`;
		config.localAdminPassword = "secret-pass-123";

		await ensureBootstrapAdmin();

		expect(config.localAdminPassword).toBe("");
	});

	test("password is cleared after re-syncing an existing admin", async () => {
		const username = `admin-resync-${crypto.randomUUID().slice(0, 8)}`;
		config.localAdminUsername = username;
		config.localAdminPassword = "initial-pass";

		// First call: creates the user.
		await ensureBootstrapAdmin();
		// Restore password (simulating a restart with the env var still set).
		config.localAdminPassword = "rotated-pass";

		// Second call: re-syncs (user already exists).
		await ensureBootstrapAdmin();

		expect(config.localAdminPassword).toBe("");
	});

	test("no-op when username or password is empty — password stays as-is", async () => {
		config.localAdminUsername = "";
		config.localAdminPassword = "whatever";

		await ensureBootstrapAdmin();

		// Should not have been touched — early return before use.
		expect(config.localAdminPassword).toBe("whatever");
	});
});
