/**
 * disableUser holds the admin lock's transaction for its whole body, so every
 * statement in it must run on that transaction — one issued on the pool
 * instead needs a second connection, and with a pool of one it waits forever
 * for the connection the lock is holding.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import "../db/__test_db.js";
import { isPostgresTest } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { supervisors } = await import("../db/schema/index.js");
const { createUser } = await import("./local-auth-service.js");
const { disableUser } = await import("./user-management.js");

const FIXTURE_PATH = new URL("./disable-user-pool-one.fixture.ts", import.meta.url).pathname;
const POOL_ONE_DEADLINE_MS = 6000;

beforeAll(async () => {
	await initializeDatabase();
});

describe("disableUser on Postgres", () => {
	test.skipIf(!isPostgresTest)(
		"issues no statement on the connection pool while the lock holds its transaction",
		async () => {
			await resetIdentityState();
			const admin = await createUser({
				username: `pool-spy-admin-${crypto.randomUUID().slice(0, 8)}`,
				password: "a-very-long-password-123",
				role: "admin",
			});
			const target = await createUser({
				username: `pool-spy-target-${crypto.randomUUID().slice(0, 8)}`,
				password: "a-very-long-password-123",
				role: "user",
			});
			await getDb().insert(supervisors).values({
				hostName: "pool-spy-host",
				platform: "linux",
				arch: "x64",
				version: "0.0.0",
				ownerUserId: target.id,
			});

			const db = getDb();
			const spies = [
				spyOn(db, "select"),
				spyOn(db, "insert"),
				spyOn(db, "update"),
				spyOn(db, "delete"),
			];
			let poolStatements = 0;
			try {
				await disableUser(target.id, {}, { userId: admin.id, label: "user" });
				poolStatements = spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}

			expect(poolStatements).toBe(0);
		},
	);

	test.skipIf(!isPostgresTest)(
		"completes with the connection pool capped at one",
		async () => {
			const child = Bun.spawn([process.execPath, "run", FIXTURE_PATH], {
				env: { ...process.env, AGENTPULSE_PG_POOL_MAX: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const finished = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(POOL_ONE_DEADLINE_MS).then(() => false),
			]);
			if (!finished) child.kill();

			expect(finished).toBe(true);
			const stdout = await new Response(child.stdout).text();
			const resultLine = stdout.split("\n").find((line) => line.startsWith("RESULT "));
			expect(JSON.parse(resultLine?.slice("RESULT ".length) ?? "{}")).toEqual({
				enrollmentState: "revoked",
			});
		},
		POOL_ONE_DEADLINE_MS + 7000,
	);
});
