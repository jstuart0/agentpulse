/**
 * withAdminLock: the generic cross-dialect lock primitive, plus the
 * concrete last-admin-protected operations (role change, disable) that
 * actually need it. The properties here are made deterministic with latches
 * (a held lock, a counted retry) rather than timing windows or luck.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import "./__test_db.js";
import { describeSqliteOnly, isPostgresTest } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb, getSqlite } = await import("./client.js");
const { users } = await import("../db/schema/index.js");
const { withAdminLock, PG_ADVISORY_LOCK_ID } = await import("./admin-lock.js");
const { createUser } = await import("../services/local-auth-service.js");
const { seedOwnedResources, snapshotOwnedResources, UNTOUCHED_OWNED_RESOURCES } = await import(
	"../test-utils/owned-resources.js"
);
const { setUserRole, disableUser, LastAdminError, _setDisableUserStepHookForTest } = await import(
	"../services/user-management.js"
);

beforeAll(async () => {
	await initializeDatabase();
});

afterEach(async () => {
	_setDisableUserStepHookForTest(null);
	await resetIdentityState();
});

function uniqueUsername(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

const PASSWORD = "a-very-long-password-123";

/** For bodies that hold the lock open on purpose, which the SQLite yield guard otherwise refuses. */
const YIELDS = { sqliteAllowYield: true };

/** A latch: `held` stays pending until `release()` is called. */
function latch() {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
}

/** "settled" if the promise finishes within the grace period, else "waiting". Only used to prove something is blocked, never to prove something is fast. */
async function settledOrWaiting(promise: Promise<unknown>, graceMs = 100): Promise<string> {
	return Promise.race([
		promise.then(
			() => "settled",
			() => "settled",
		),
		Bun.sleep(graceMs).then(() => "waiting"),
	]);
}

describe("withAdminLock — generic mechanics", () => {
	test("two concurrent critical sections never interleave: the counter never sees a torn read", async () => {
		let counter = 0;
		const observedDuringSecond: number[] = [];

		async function criticalSection(): Promise<void> {
			await withAdminLock(async () => {
				const before = counter;
				// Yield the event loop — if the lock weren't exclusive, the other
				// call's increment could land here.
				await new Promise((r) => setTimeout(r, 5));
				counter = before + 1;
				observedDuringSecond.push(counter);
			}, YIELDS);
		}

		await Promise.all([criticalSection(), criticalSection()]);
		expect(counter).toBe(2);
		// Each call must have observed a strictly increasing counter — a torn
		// interleave would show [1, 1] (both read 0) instead of [1, 2].
		expect(observedDuringSecond.sort()).toEqual([1, 2]);
	});

	test("a throw inside the callback rolls back the callback's write and still propagates", async () => {
		const username = uniqueUsername("rollback-probe");
		await expect(
			withAdminLock(async (tx) => {
				await tx.insert(users).values({
					username,
					passwordHash: "!",
					role: "user",
					authSource: "local",
				});
				// Visible inside the transaction — so the absence afterwards is the rollback, not a failed insert.
				const inside = await tx.select().from(users).where(eq(users.username, username));
				expect(inside.length).toBe(1);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const rows = await getDb().select().from(users).where(eq(users.username, username));
		expect(rows.length).toBe(0);
	});

	test("the callback's writes are visible once the lock resolves", async () => {
		const username = uniqueUsername("commit-probe");
		await withAdminLock(async (tx) => {
			await tx.insert(users).values({
				username,
				passwordHash: "!",
				role: "user",
				authSource: "local",
			});
		});
		const [row] = await getDb().select().from(users).where(eq(users.username, username)).limit(1);
		expect(row).toBeTruthy();
	});

	test("a caller that arrives while the lock is held waits for it and then runs", async () => {
		const gate = latch();
		const order: string[] = [];
		const first = withAdminLock(async () => {
			order.push("first-start");
			await gate.held;
			order.push("first-end");
		}, YIELDS);
		await Bun.sleep(10);
		const second = withAdminLock(async () => {
			order.push("second");
		});

		expect(await settledOrWaiting(second)).toBe("waiting");
		gate.release();
		await Promise.all([first, second]);

		expect(order).toEqual(["first-start", "first-end", "second"]);
	});
});

describe.skipIf(!isPostgresTest)("withAdminLock — Postgres advisory lock", () => {
	// Another connection's view of the advisory locks currently held with the admin lock's key.
	async function advisoryLocksHeld(): Promise<number> {
		// biome-ignore lint/suspicious/noExplicitAny: Postgres-only entry point
		const rows = (await (getDb() as any).execute(
			sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND objid::bigint = ${PG_ADVISORY_LOCK_ID}`,
		)) as Array<{ n: number }>;
		return Number(rows[0]?.n);
	}

	test("holds the advisory lock while the body runs and releases it afterwards", async () => {
		let heldInside = -1;
		await withAdminLock(async () => {
			heldInside = await advisoryLocksHeld();
		});

		expect(heldInside).toBe(1);
		expect(await advisoryLocksHeld()).toBe(0);
	});

	test("releases the advisory lock when the body throws", async () => {
		await expect(
			withAdminLock(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(await advisoryLocksHeld()).toBe(0);
	});
});

describeSqliteOnly("withAdminLock — SQLite mutex and BEGIN IMMEDIATE retry", () => {
	/** Counts BEGIN IMMEDIATE attempts on the shared connection; `onAttempt` may act on the Nth one. Always restored. */
	async function withBeginSpy<T>(
		onAttempt: (attempt: number) => void,
		run: () => Promise<T>,
	): Promise<{ result: T; attempts: number }> {
		const sqlite = getSqlite();
		const originalExec = sqlite.exec.bind(sqlite);
		let attempts = 0;
		// biome-ignore lint/suspicious/noExplicitAny: test spy on a native binding
		(sqlite as any).exec = (...args: unknown[]) => {
			if (args[0] === "BEGIN IMMEDIATE") {
				attempts++;
				onAttempt(attempts);
			}
			return originalExec(...(args as [string]));
		};
		try {
			return { result: await run(), attempts };
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore the native binding
			(sqlite as any).exec = originalExec;
		}
	}

	test("four concurrent callers queue on the process mutex: exactly four BEGIN IMMEDIATE, none retried", async () => {
		const { attempts } = await withBeginSpy(
			() => {},
			async () => {
				await Promise.all(
					[1, 2, 3, 4].map((n) =>
						withAdminLock(async () => {
							await Bun.sleep(5 * n);
						}, YIELDS),
					),
				);
			},
		);

		// Without the mutex the later callers would hit "cannot start a
		// transaction within a transaction" and retry, so attempts would exceed 4.
		expect(attempts).toBe(4);
	});

	test("four concurrent callers run one at a time and in arrival order", async () => {
		const order: string[] = [];
		await Promise.all(
			[1, 2, 3, 4].map((n) =>
				withAdminLock(async () => {
					order.push(`start-${n}`);
					await Bun.sleep(5);
					order.push(`end-${n}`);
				}, YIELDS),
			),
		);

		expect(order).toEqual([
			"start-1",
			"end-1",
			"start-2",
			"end-2",
			"start-3",
			"end-3",
			"start-4",
			"end-4",
		]);
	});

	test("an unrelated open transaction makes the lock retry (past the old three attempts) and then succeed", async () => {
		const sqlite = getSqlite();
		sqlite.exec("BEGIN IMMEDIATE");
		let outsiderCommitted = false;
		const RELEASE_ON_ATTEMPT = 6;
		try {
			const { result, attempts } = await withBeginSpy(
				(attempt) => {
					// Deterministic: the outsider finishes exactly when the lock makes its sixth try.
					if (attempt === RELEASE_ON_ATTEMPT && !outsiderCommitted) {
						outsiderCommitted = true;
						sqlite.exec("COMMIT");
					}
				},
				() => withAdminLock(async () => "done").catch((err: Error) => `rejected: ${err.message}`),
			);

			expect(result).toBe("done");
			expect(attempts).toBe(RELEASE_ON_ATTEMPT);
		} finally {
			if (!outsiderCommitted) sqlite.exec("COMMIT");
		}
	});

	test("a transaction that never ends surfaces the error once the retry budget is spent", async () => {
		const sqlite = getSqlite();
		sqlite.exec("BEGIN IMMEDIATE");
		try {
			const { attempts } = await withBeginSpy(
				() => {},
				async () => {
					await expect(
						withAdminLock(async () => "unreachable", { sqliteRetryBudgetMs: 40 }),
					).rejects.toThrow(/within a transaction/);
				},
			);
			expect(attempts).toBeGreaterThan(1);
		} finally {
			sqlite.exec("COMMIT");
		}
	});
});

describe("withAdminLock protects the last admin", () => {
	async function twoAdmins(label: string) {
		const a = await createUser({
			username: uniqueUsername(`${label}-a`),
			password: PASSWORD,
			role: "admin",
		});
		const b = await createUser({
			username: uniqueUsername(`${label}-b`),
			password: PASSWORD,
			role: "admin",
		});
		return [a, b] as const;
	}

	test("two concurrent demotions of the last two admins leave exactly one admin", async () => {
		const [a, b] = await twoAdmins("demote");

		const results = await Promise.allSettled([
			setUserRole(a.id, "user", { userId: a.id, label: "user" }),
			setUserRole(b.id, "user", { userId: b.id, label: "user" }),
		]);

		expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
		expect(
			results.filter(
				(r) => r.status === "rejected" && (r.reason as Error) instanceof LastAdminError,
			).length,
		).toBe(1);
		const remainingAdmins = await getDb()
			.select({ id: users.id })
			.from(users)
			.where(eq(users.role, "admin"));
		expect(remainingAdmins.length).toBe(1);
	});

	test("two concurrent disables of the last two admins: one succeeds, one gets last_admin", async () => {
		const [a, b] = await twoAdmins("disable");

		const results = await Promise.allSettled([
			disableUser(a.id, {}, { userId: a.id, label: "user" }),
			disableUser(b.id, {}, { userId: b.id, label: "user" }),
		]);

		expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
		expect(
			results.filter(
				(r) => r.status === "rejected" && (r.reason as Error) instanceof LastAdminError,
			).length,
		).toBe(1);
		const rows = await getDb().select().from(users);
		expect(rows.filter((r) => r.disabledAt !== null).length).toBe(1);
	});

	// The two tests above can pass by luck on an engine where the race is
	// narrow. These can't: they hold the admin lock themselves and show the
	// operation is parked behind it, so an operation that skipped the lock
	// would settle immediately and fail here.
	test("a demotion waits behind a held admin lock", async () => {
		const [a] = await twoAdmins("held-demote");
		const gate = latch();
		const holder = withAdminLock(async () => gate.held, YIELDS);
		await Bun.sleep(10);

		const demotion = setUserRole(a.id, "user", { userId: a.id, label: "user" });
		const state = await settledOrWaiting(demotion);
		gate.release();
		await holder;
		await demotion;

		expect(state).toBe("waiting");
	});

	test("a disable waits behind a held admin lock", async () => {
		const [a] = await twoAdmins("held-disable");
		const gate = latch();
		const holder = withAdminLock(async () => gate.held, YIELDS);
		await Bun.sleep(10);

		const disabling = disableUser(a.id, {}, { userId: a.id, label: "user" });
		const state = await settledOrWaiting(disabling);
		gate.release();
		await holder;
		await disabling;

		expect(state).toBe("waiting");
	});
});

describe("disableUser is one unit: a failure part-way leaves nothing changed", () => {
	const UNCHANGED = UNTOUCHED_OWNED_RESOURCES;

	for (const failAfter of ["credentials-deactivated", "hosts-revoked"] as const) {
		test(`a failure after "${failAfter}" rolls back the disable, the session, key, token, host and credential together`, async () => {
			const admin = await createUser({
				username: uniqueUsername("unit-admin"),
				password: PASSWORD,
				role: "admin",
			});
			const target = await createUser({
				username: uniqueUsername("unit-target"),
				password: PASSWORD,
				role: "user",
			});
			const seed = await seedOwnedResources(target.id);
			expect(await snapshotOwnedResources(seed)).toEqual(UNCHANGED(target.id));

			_setDisableUserStepHookForTest(async (step) => {
				if (step === failAfter) throw new Error(`injected failure after ${failAfter}`);
			});
			await expect(disableUser(target.id, {}, { userId: admin.id, label: "user" })).rejects.toThrow(
				`injected failure after ${failAfter}`,
			);

			// Everything the disable touched before the failure is back as it was.
			expect(await snapshotOwnedResources(seed)).toEqual(UNCHANGED(target.id));

			// Positive control: without the failure the same disable changes every one
			// of those fields, so the assertions above are capable of failing.
			_setDisableUserStepHookForTest(null);
			await disableUser(target.id, {}, { userId: admin.id, label: "user" });
			const after = await snapshotOwnedResources(seed);
			expect(after.disabledAt).not.toBeNull();
			expect(after.loginSessions).toBe(0);
			expect(after.keyActive).toBe(false);
			expect(after.tokenActive).toBe(false);
			expect(after.tokenRevokedAt).not.toBeNull();
			expect(after.hostState).toBe("revoked");
			expect(after.credentialActive).toBe(false);
			expect(after.sessionRowOwner).toBe(target.id);
		});
	}

	// On Postgres the injected-failure cases above prove every helper ran on the
	// transaction handle: a helper that opened its own connection would have
	// committed its write before the failure and the snapshot would differ. On
	// SQLite they cannot prove that — the lock hands out the one shared
	// connection (`tx` is the same object as getDb()), so a helper that ignored
	// `tx` would still write inside the open BEGIN IMMEDIATE and be rolled back
	// with it. This source-level check is what notices it on both dialects.
	test("every call to a transaction-aware helper inside disableUser passes the transaction", async () => {
		const source = await readFile(
			new URL("../services/user-management.ts", import.meta.url),
			"utf8",
		);
		const helpers = [
			"revokeAllSessionsForUser",
			"deactivateApiKeysOwnedByUser",
			"deactivateEnrollmentTokensCreatedByUser",
			"listSupervisorIdsOwnedByUser",
			"revokeSupervisor",
			"revokeSupervisorCredential",
		];
		const calls = source
			.split("\n")
			.filter(
				(line) =>
					/\bawait\b/.test(line) && helpers.some((name) => new RegExp(`\\b${name}\\(`).test(line)),
			);

		expect(calls.length).toBeGreaterThanOrEqual(helpers.length);
		for (const line of calls) expect(line).toMatch(/\btx\b/);
	});
});
