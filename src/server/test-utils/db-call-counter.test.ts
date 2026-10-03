/**
 * countDbCalls is the instrument behind every statement-count pin, so it
 * gets its own checks: each statement is counted once, on the pool handle or
 * on a Postgres transaction handle (including raw `execute`, and statements
 * issued after the transaction callback's first await); SQLite, where the
 * transaction handle is the same object as the db, never double counts; and
 * nothing is counted or left spied once the block ends.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import "../db/__test_db.js";
import { isPostgresTest } from "./backend.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { settings } = await import("../db/schema/index.js");
const { withTransaction } = await import("../db/with-transaction.js");
const { countDbCalls } = await import("./db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});

const readOneSetting = (handle: ReturnType<typeof getDb>) =>
	handle.select().from(settings).limit(1);

describe("countDbCalls", () => {
	test("counts each statement issued on the db once", async () => {
		const calls = await countDbCalls(async () => {
			await readOneSetting(getDb());
			await readOneSetting(getDb());
			await getDb().select().from(settings).limit(1);
		});
		expect(calls).toBe(3);
	});

	test("counts statements issued inside a transaction once, on either dialect", async () => {
		const calls = await countDbCalls(async () => {
			await withTransaction(async (tx) => {
				await readOneSetting(tx);
				await readOneSetting(tx);
			});
		});
		expect(calls).toBe(2);
	});

	test("counts statements issued after the transaction callback's first await", async () => {
		const calls = await countDbCalls(async () => {
			await withTransaction(async (tx) => {
				await readOneSetting(tx);
				await Bun.sleep(5);
				await readOneSetting(tx);
				await Bun.sleep(5);
				await readOneSetting(tx);
			});
		});
		expect(calls).toBe(3);
	});

	test("a statement on the pool and one on the transaction are each counted once", async () => {
		const calls = await countDbCalls(async () => {
			await readOneSetting(getDb());
			await withTransaction(async (tx) => {
				await readOneSetting(tx);
			});
		});
		expect(calls).toBe(2);
	});

	test.skipIf(!isPostgresTest)("counts raw execute on a Postgres transaction handle", async () => {
		const calls = await countDbCalls(async () => {
			await withTransaction(async (tx) => {
				await tx.execute(sql`SELECT 1`);
				await Bun.sleep(5);
				await tx.execute(sql`SELECT 2`);
				await readOneSetting(tx);
			});
		});
		expect(calls).toBe(3);
	});

	test.skipIf(!isPostgresTest)("counts raw execute on the Postgres pool handle", async () => {
		const calls = await countDbCalls(async () => {
			// biome-ignore lint/suspicious/noExplicitAny: Postgres-only entry point
			await (getDb() as any).execute(sql`SELECT 1`);
		});
		expect(calls).toBe(1);
	});

	test("two measurements in a row don't leak into each other, and the spies are removed afterwards", async () => {
		const first = await countDbCalls(async () => {
			await readOneSetting(getDb());
		});
		const second = await countDbCalls(async () => {
			await readOneSetting(getDb());
			await readOneSetting(getDb());
		});
		expect(first).toBe(1);
		expect(second).toBe(2);

		const db = getDb();
		// biome-ignore lint/suspicious/noExplicitAny: bun's mock marker
		expect((db.select as any).mock).toBeUndefined();
		// biome-ignore lint/suspicious/noExplicitAny: bun's mock marker
		expect((db as any).transaction?.mock).toBeUndefined();
	});
});
