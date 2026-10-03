/**
 * A service key is a service key because it is on a list, so minting one is a
 * single transaction: the key row and its list entry exist together or not at
 * all. A failure after the key insert (or after the list entry) leaves neither.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "../db/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { clearInstanceSettings, seedLocalUser } from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb, getSqlite } = await import("../db/client.js");
const { apiKeys } = await import("../db/schema/index.js");
const { createApiKey } = await import("../auth/api-key.js");
const { getAdminServiceKeyIds, getServiceKeyIds, listAdminServiceKey } = await import(
	"./service-keys.js"
);

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

async function keysNamed(name: string) {
	return (await getDb().select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys)).filter(
		(row) => row.name === name,
	);
}

describe("minting a service key is atomic", () => {
	test("a failure after the key and its list entry are written leaves neither", async () => {
		const admin = await seedLocalUser("atomic-admin", "admin");
		const before = await getServiceKeyIds();
		await expect(
			createApiKey("atomic-plain", ["ingest"], admin.id, {
				service: true,
				withinTransaction: () => {
					throw new Error("injected failure");
				},
			}),
		).rejects.toThrow("injected failure");
		expect(await keysNamed("atomic-plain")).toEqual([]);
		expect(await getServiceKeyIds()).toEqual(before);
	});

	test("the same for a key kept as an admin service key", async () => {
		const admin = await seedLocalUser("atomic-admin2", "admin");
		const before = { plain: await getServiceKeyIds(), admin: await getAdminServiceKeyIds() };
		await expect(
			createApiKey("atomic-admin-service", ["manage"], admin.id, {
				service: true,
				withinTransaction: async (tx, keyId) => {
					await listAdminServiceKey(keyId, tx);
					throw new Error("injected failure");
				},
			}),
		).rejects.toThrow("injected failure");
		expect(await keysNamed("atomic-admin-service")).toEqual([]);
		expect({ plain: await getServiceKeyIds(), admin: await getAdminServiceKeyIds() }).toEqual(
			before,
		);
	});

	test("a successful mint has both the key and the list entry", async () => {
		const admin = await seedLocalUser("atomic-admin3", "admin");
		const { id } = await createApiKey("atomic-ok", ["ingest"], admin.id, { service: true });
		expect((await keysNamed("atomic-ok")).map((row) => row.id)).toEqual([id]);
		expect(await getServiceKeyIds()).toContain(id);
	});
});

// On SQLite one connection serves everything, so a write made outside the
// transaction is rolled back with it and the outcome alone cannot tell the two
// apart (only Postgres, with a connection per transaction, can). What SQLite
// can show is the order of the statements: the key insert and the list entry
// are both written after the lock's BEGIN and before its ROLLBACK or COMMIT.
describeSqliteOnly("the statements of a mint, in order (SQLite)", () => {
	/** Every statement the SQLite client runs or prepares while `run` executes, in order. */
	async function recordStatements(run: () => Promise<unknown>): Promise<string[]> {
		const seen: string[] = [];
		const db = getSqlite();
		const exec = db.exec.bind(db);
		const prepare = db.prepare.bind(db);
		const execSpy = spyOn(db, "exec").mockImplementation(((query: string) => {
			seen.push(query);
			return exec(query);
		}) as never);
		const prepareSpy = spyOn(db, "prepare").mockImplementation(((query: string) => {
			seen.push(query);
			return prepare(query);
		}) as never);
		try {
			await run().catch(() => undefined);
		} finally {
			execSpy.mockRestore();
			prepareSpy.mockRestore();
		}
		return seen;
	}

	const index = (seen: string[], predicate: (statement: string) => boolean) =>
		seen.findIndex(predicate);
	const isKeyInsert = (statement: string) => /insert into "api_keys"/i.test(statement);
	const isListWrite = (statement: string) =>
		/"settings"/i.test(statement) && /insert|update/i.test(statement);

	test("a failed mint writes the key and the list entry between BEGIN and ROLLBACK", async () => {
		const admin = await seedLocalUser("order-admin", "admin");
		const seen = await recordStatements(() =>
			createApiKey("order-failed", ["ingest"], admin.id, {
				service: true,
				withinTransaction: () => {
					throw new Error("injected failure");
				},
			}),
		);
		const begin = index(seen, (s) => /^BEGIN IMMEDIATE/i.test(s));
		const insert = index(seen, isKeyInsert);
		const list = index(seen, isListWrite);
		const rollback = index(seen, (s) => /^ROLLBACK/i.test(s));
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(insert).toBeGreaterThan(begin);
		expect(list).toBeGreaterThan(insert);
		expect(rollback).toBeGreaterThan(list);
		expect(seen.some((s) => /^COMMIT/i.test(s))).toBe(false);
	});

	test("a successful mint commits after both", async () => {
		const admin = await seedLocalUser("order-admin2", "admin");
		const seen = await recordStatements(() =>
			createApiKey("order-ok", ["ingest"], admin.id, { service: true }),
		);
		const begin = index(seen, (s) => /^BEGIN IMMEDIATE/i.test(s));
		const insert = index(seen, isKeyInsert);
		const list = index(seen, isListWrite);
		const commit = index(seen, (s) => /^COMMIT/i.test(s));
		expect(insert).toBeGreaterThan(begin);
		expect(list).toBeGreaterThan(insert);
		expect(commit).toBeGreaterThan(list);
	});
});
