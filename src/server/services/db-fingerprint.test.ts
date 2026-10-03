import { beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { eq } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema/index.js");
const { getDbFingerprint } = await import("./db-fingerprint.js");

beforeAll(() => {
	return initializeDatabase();
});

describe("getDbFingerprint", () => {
	test("returns 12 lowercase hex characters", async () => {
		const fingerprint = await getDbFingerprint();
		expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
	});

	test("is deterministic for the same installation_id", async () => {
		const first = await getDbFingerprint();
		const second = await getDbFingerprint();
		expect(first).toBe(second);
	});

	test("matches an independently computed sha256('agentpulse-db-fingerprint:' + installation_id), first 12 hex chars", async () => {
		// The installation_id row is created on first use; do not rely on an
		// earlier test having done that.
		await getDbFingerprint();
		const [row] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, "installation_id"))
			.limit(1);
		const installationId = row?.value as string;
		expect(installationId).toBeTruthy();

		const data = new TextEncoder().encode(`agentpulse-db-fingerprint:${installationId}`);
		const hash = await crypto.subtle.digest("SHA-256", data);
		const expected = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 12);

		expect(await getDbFingerprint()).toBe(expected);
	});

	test("differs from a different installation_id (simulated second database)", async () => {
		const before = await getDbFingerprint();

		await getDb().delete(settings).where(eq(settings.key, "installation_id")).execute();
		await getDb()
			.insert(settings)
			.values({
				key: "installation_id",
				value: "a-completely-different-uuid",
				updatedAt: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: "a-completely-different-uuid", updatedAt: new Date().toISOString() },
			});

		const after = await getDbFingerprint();
		expect(after).not.toBe(before);
	});

	test("never leaks the raw installation_id (fingerprint is not a substring of it and vice versa)", async () => {
		const fingerprint = await getDbFingerprint();
		const [row] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, "installation_id"))
			.limit(1);
		const installationId = (row?.value as string) ?? "";
		expect(installationId).toBeTruthy();

		expect(installationId).not.toContain(fingerprint);
		expect(fingerprint).not.toContain(installationId);
	});
});
