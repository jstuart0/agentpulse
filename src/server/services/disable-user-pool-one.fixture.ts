/**
 * Child-process fixture for user-disable-pool.test.ts. Runs in its own
 * process because the Postgres pool size is fixed when the db client module
 * loads, and the test process has already loaded it with the default size.
 *
 * Seeds an admin, a target user who owns a host, runs disableUser with
 * AGENTPULSE_PG_POOL_MAX=1, and prints one "RESULT {json}" line describing the result.
 * With a pool of one, any statement issued on the pool while the admin lock
 * holds the only connection waits forever.
 */
import { eq } from "drizzle-orm";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { supervisors, users } = await import("../db/schema/index.js");
const { createUser } = await import("./local-auth-service.js");
const { disableUser } = await import("./user-management.js");

await initializeDatabase();

const suffix = crypto.randomUUID().slice(0, 8);
const admin = await createUser({
	username: `pool-admin-${suffix}`,
	password: "a-very-long-password-123",
	role: "admin",
});
const target = await createUser({
	username: `pool-target-${suffix}`,
	password: "a-very-long-password-123",
	role: "user",
});
const hostId = crypto.randomUUID();
await getDb().insert(supervisors).values({
	id: hostId,
	hostName: "pool-one-host",
	platform: "linux",
	arch: "x64",
	version: "0.0.0",
	ownerUserId: target.id,
});

await disableUser(target.id, {}, { userId: admin.id, label: "user" });

const [host] = await getDb().select().from(supervisors).where(eq(supervisors.id, hostId)).limit(1);
console.log(`RESULT ${JSON.stringify({ enrollmentState: host?.enrollmentState })}`);

await getDb().delete(supervisors).where(eq(supervisors.id, hostId));
await getDb().delete(users).where(eq(users.id, target.id));
await getDb().delete(users).where(eq(users.id, admin.id));
process.exit(0);
