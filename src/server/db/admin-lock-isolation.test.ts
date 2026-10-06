/**
 * On SQLite the admin lock is an open BEGIN IMMEDIATE on the one shared
 * connection, so any statement another request issues while a locked body is
 * suspended lands inside the lock's transaction and is rolled back with it when
 * the body throws. Hook writes are such statements: the hook was already
 * answered, so the rows are simply gone. The lock therefore has to guarantee
 * that nothing else can run inside a locked body.
 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("./client.js");
const { sessions, users } = await import("../db/schema/index.js");
const { withAdminLock } = await import("./admin-lock.js");
const { createUser } = await import("../services/local-auth-service.js");
const { setUserRole, LastAdminError } = await import("../services/user-management.js");
const { enrollSupervisor } = await import("../services/supervisor-registry.js");

beforeAll(async () => {
	await initializeDatabase();
});

afterEach(async () => {
	await getDb().delete(sessions);
	await resetIdentityState();
});

const PASSWORD = "a-very-long-password-123";

/** A directly inserted admin: the sweep below runs many iterations and a password hash per one is slow. */
async function insertAdmin(label: string): Promise<{ id: string }> {
	const [row] = await getDb()
		.insert(users)
		.values({
			username: `${label}-${crypto.randomUUID().slice(0, 6)}`,
			passwordHash: "!",
			role: "admin",
			authSource: "local",
		})
		.returning({ id: users.id });
	return row;
}

async function hookWrite(sessionId: string): Promise<void> {
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" });
}

describeSqliteOnly("admin lock isolation on SQLite", () => {
	test("a body that waits on a timer is refused loudly", async () => {
		await expect(
			withAdminLock(async () => {
				// Long enough that the lock's setImmediate sentinel always fires first. A 0 ms
				// timer is floored to 1 ms, and on Linux that timer could come due before
				// the sentinel's loop iteration was checked, so the yield went unreported
				// and this test failed about 0.2-1.5% of the time (none missed at 10 or 25 ms).
				await new Promise((resolve) => setTimeout(resolve, 25));
			}),
		).rejects.toThrow(/yielded to the event loop/);
	});

	test("a body that only awaits database calls is not refused", async () => {
		await expect(
			withAdminLock(async (tx) => {
				await tx.select().from(sessions).limit(1);
				return "done";
			}),
		).resolves.toBe("done");
	});

	test("enrolling a host for a user does no outside work inside the lock", async () => {
		const owner = await createUser({
			username: `enroll-${crypto.randomUUID().slice(0, 8)}`,
			password: PASSWORD,
			role: "user",
		});
		const enrolled = await enrollSupervisor(
			{
				hostName: "isolation-host",
				platform: "linux",
				arch: "x64",
				version: "0.0.0",
				// biome-ignore lint/suspicious/noExplicitAny: capabilities shape is irrelevant here
				capabilities: {} as any,
				trustedRoots: [],
			},
			owner.id,
		);
		expect(enrolled.supervisorCredential.startsWith("aps_")).toBe(true);
	});

	test("a hook write in flight when a refused admin action starts survives the refusal", async () => {
		const lost: number[] = [];
		// The foreign write is started `k` microtask turns apart from the lock, for
		// every k across the whole window the locked body occupies.
		for (let k = 0; k <= 80; k++) {
			await resetIdentityState();
			const admin = await insertAdmin(`only-admin-${k}`);
			const sessionId = `hook-${k}`;

			const refused = setUserRole(admin.id, "user", { userId: admin.id, label: "user" }).then(
				() => null,
				(err) => err,
			);
			const hook = (async () => {
				for (let i = 0; i < k; i++) await Promise.resolve();
				await hookWrite(sessionId);
			})();
			const [error] = await Promise.all([refused, hook]);

			expect(error).toBeInstanceOf(LastAdminError);
			const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
			if (rows.length !== 1) lost.push(k);
		}
		expect(lost).toEqual([]);
	});

	test("a hook write queued on the event loop while the lock waits for it lands outside the lock", async () => {
		const admin = await insertAdmin("loop-admin");
		const refused = setUserRole(admin.id, "user", { userId: admin.id, label: "user" }).then(
			() => null,
			(err) => err,
		);
		const hook = new Promise<void>((resolve, reject) =>
			setImmediate(() => hookWrite("hook-loop").then(resolve, reject)),
		);
		const [error] = await Promise.all([refused, hook]);

		expect(error).toBeInstanceOf(LastAdminError);
		const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, "hook-loop"));
		expect(rows.length).toBe(1);
	});
});
