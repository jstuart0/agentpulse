import { beforeAll, describe, expect, test } from "bun:test";
import "../server/services/ai/__test_db.js";

const { eq } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../server/db/client.js");
const { settings } = await import("../server/db/schema/index.js");
const { getDbFingerprint } = await import("../server/services/db-fingerprint.js");
const { INSTALLATION_ID_KEY, fingerprintOf } = await import("./db-fingerprint.js");

beforeAll(() => initializeDatabase());

describe("fingerprintOf", () => {
	test("is 12 lowercase hex characters and deterministic", async () => {
		const out = await fingerprintOf("11111111-2222-3333-4444-555555555555");
		expect(out).toMatch(/^[0-9a-f]{12}$/);
		expect(await fingerprintOf("11111111-2222-3333-4444-555555555555")).toBe(out);
	});

	test("different installation ids give different fingerprints", async () => {
		expect(await fingerprintOf("a")).not.toBe(await fingerprintOf("b"));
	});

	test("equals getDbFingerprint() of a test database holding that installation id", async () => {
		const served = await getDbFingerprint();
		const [row] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, INSTALLATION_ID_KEY))
			.limit(1);
		expect(row?.value).toBeTruthy();
		expect(await fingerprintOf(row?.value as string)).toBe(served);
	});

	test("matches the salted sha256 the /health fingerprint has always used", async () => {
		const data = new TextEncoder().encode("agentpulse-db-fingerprint:fixed-id");
		const hash = Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
		expect(await fingerprintOf("fixed-id")).toBe(hash.slice(0, 12));
	});
});
