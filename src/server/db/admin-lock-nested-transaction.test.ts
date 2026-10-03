/**
 * A body running under the admin lock must issue its statements on the `tx` it
 * was given. Calling the general transaction helper from inside it would wait
 * on the lock's own mutex forever on SQLite (and take a second connection on
 * Postgres), so the helper throws at once with a message that says why. A
 * transaction started from anywhere else is unaffected.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import "./__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase } = await import("./client.js");
const { withAdminLock } = await import("./admin-lock.js");
const { withTransaction } = await import("./with-transaction.js");

beforeAll(async () => {
	await initializeDatabase();
});
afterEach(resetIdentityState);

const HUNG = Symbol("hung");
/** The promise's outcome, or HUNG when it is still pending after the grace period. */
async function outcomeWithin(promise: Promise<unknown>, graceMs = 1500): Promise<unknown> {
	return Promise.race([
		promise.then(
			(value) => ({ value }),
			(error) => ({ error }),
		),
		new Promise((resolve) => setTimeout(() => resolve(HUNG), graceMs)),
	]);
}

describe("the transaction helper inside an admin-locked body", () => {
	test("throws immediately, naming the cause, instead of waiting on the lock", async () => {
		const outcome = (await outcomeWithin(
			withAdminLock(async () => {
				await withTransaction(async () => "never");
				return "completed";
			}),
		)) as { error?: Error } | typeof HUNG;

		expect(outcome).not.toBe(HUNG);
		const error = (outcome as { error?: Error }).error;
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toMatch(/admin lock/i);
	});

	test("the lock is released afterwards, and a later locked body and transaction both run", async () => {
		await outcomeWithin(
			withAdminLock(async () => {
				await withTransaction(async () => "never");
			}),
		);
		expect(await outcomeWithin(withAdminLock(async () => "second"))).toEqual({ value: "second" });
		expect(await outcomeWithin(withTransaction(async () => "plain"))).toEqual({ value: "plain" });
	});

	test("a transaction started from outside the body while it runs is not refused", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const locked = withAdminLock(async () => {
			entered();
			await gate;
			return "locked";
		});
		await inside;

		const outside = withTransaction(async () => "outside");
		release();

		expect(await outcomeWithin(locked)).toEqual({ value: "locked" });
		expect(await outcomeWithin(outside)).toEqual({ value: "outside" });
	});
});
