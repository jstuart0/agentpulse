/**
 * A disabled user gains nothing new: their enrollment tokens die with the
 * account, a token whose creator is disabled can't enroll a host, and no key
 * or host can be created for a disabled owner — checked in the same
 * transaction as the insert, under the admin lock, so a disable racing a
 * mint can't slip a live credential past it.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { apiKeys, supervisors, supervisorEnrollmentTokens, users } = await import(
	"../db/schema/index.js"
);
const { withAdminLock } = await import("../db/admin-lock.js");
const { createUser } = await import("../services/local-auth-service.js");
const { disableUser } = await import("../services/user-management.js");
const { registerSupervisor } = await import("../services/supervisor-registry.js");
const { createApiKey } = await import("./api-key.js");
const { OwnerDisabledError } = await import("./owner-state.js");
const { createSupervisorEnrollmentToken, verifyEnrollmentToken, consumeEnrollmentToken } =
	await import("./supervisor-auth.js");

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
});

afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
});

function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

async function seedUser(label: string, role: "user" | "admin" = "user") {
	return createUser({
		username: uniqueName(label),
		password: "a-very-long-password-123",
		role,
	});
}

async function tokenRow(tokenId: string) {
	const [row] = await getDb()
		.select()
		.from(supervisorEnrollmentTokens)
		.where(eq(supervisorEnrollmentTokens.id, tokenId))
		.limit(1);
	return row;
}

const registrationBody = (hostName: string, enrollmentToken: string) => ({
	hostName,
	platform: "linux",
	arch: "x64",
	version: "1.0.0",
	enrollmentToken,
	capabilities: {
		version: 1,
		agentTypes: ["claude_code"],
		launchModes: ["headless"],
		os: "linux",
		terminalSupport: [],
		features: [],
	},
	trustedRoots: [],
});

describe("disabling a user deactivates the enrollment tokens they created", () => {
	test("their unused tokens go inactive and revoked; a used token and another user's token are untouched", async () => {
		const admin = await seedUser("tok-admin", "admin");
		const target = await seedUser("tok-target");
		const other = await seedUser("tok-other");
		const unused = await createSupervisorEnrollmentToken("t-unused", null, null, target.id);
		const used = await createSupervisorEnrollmentToken("t-used", null, null, target.id);
		await consumeEnrollmentToken(used.token);
		const othersToken = await createSupervisorEnrollmentToken("t-other", null, null, other.id);

		await disableUser(target.id, {}, { userId: admin.id, label: "user" });

		const unusedAfter = await tokenRow(unused.info.id);
		expect(unusedAfter?.isActive).toBe(false);
		expect(unusedAfter?.revokedAt).not.toBeNull();
		expect((await tokenRow(used.info.id))?.revokedAt).toBeNull();
		expect((await tokenRow(othersToken.info.id))?.isActive).toBe(true);
	});

	test("with revokeHosts false the tokens are still deactivated", async () => {
		const admin = await seedUser("tok-admin-nh", "admin");
		const target = await seedUser("tok-target-nh");
		const minted = await createSupervisorEnrollmentToken("t-nh", null, null, target.id);

		await disableUser(target.id, { revokeHosts: false }, { userId: admin.id, label: "user" });

		expect((await tokenRow(minted.info.id))?.isActive).toBe(false);
	});

	test("disable, then enrolling with a token minted before is refused and creates no host", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		const admin = await seedUser("enroll-admin", "admin");
		const target = await seedUser("enroll-target");
		const minted = await createSupervisorEnrollmentToken("t-enroll", null, null, target.id);
		await disableUser(target.id, {}, { userId: admin.id, label: "user" });
		const hostName = uniqueName("host-after-disable");

		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(registrationBody(hostName, minted.token)),
		});

		expect(res.status).toBe(401);
		const hosts = await getDb()
			.select()
			.from(supervisors)
			.where(eq(supervisors.hostName, hostName));
		expect(hosts.length).toBe(0);
	});
});

describe("a token whose creator is disabled can't be used, even if the token itself is still active", () => {
	test("verify and consume refuse it, and consume leaves it unused", async () => {
		const target = await seedUser("creator-disabled");
		const minted = await createSupervisorEnrollmentToken("t-creator", null, null, target.id);
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, target.id));

		expect(await verifyEnrollmentToken(minted.token)).toBeNull();
		expect(await consumeEnrollmentToken(minted.token)).toBeNull();
		expect((await tokenRow(minted.info.id))?.usedAt).toBeNull();
	});

	test("two simultaneous consumes of one token succeed exactly once", async () => {
		const target = await seedUser("double-consume");
		const minted = await createSupervisorEnrollmentToken("t-double", null, null, target.id);

		const results = await Promise.all([
			consumeEnrollmentToken(minted.token),
			consumeEnrollmentToken(minted.token),
		]);

		expect(results.filter((r) => r !== null).length).toBe(1);
	});
});

describe("no key or host is created for a disabled owner", () => {
	test("minting a key for a disabled owner is refused and writes no row", async () => {
		const target = await seedUser("mint-disabled");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, target.id));

		await expect(createApiKey(uniqueName("k"), ["ingest"], target.id)).rejects.toBeInstanceOf(
			OwnerDisabledError,
		);

		const rows = await getDb().select().from(apiKeys).where(eq(apiKeys.ownerUserId, target.id));
		expect(rows.length).toBe(0);
	});

	test("enrolling a host for a disabled owner is refused and writes no row", async () => {
		const target = await seedUser("host-disabled");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, target.id));
		const hostName = uniqueName("host-disabled-owner");

		await expect(
			registerSupervisor(
				{
					hostName,
					platform: "linux",
					arch: "x64",
					version: "1.0.0",
					capabilities: {} as never,
					trustedRoots: [],
				},
				target.id,
			),
		).rejects.toBeInstanceOf(OwnerDisabledError);

		const rows = await getDb()
			.select()
			.from(supervisors)
			.where(and(eq(supervisors.hostName, hostName)));
		expect(rows.length).toBe(0);
	});

	test("a mint that starts while a disable is uncommitted waits for it, then sees the user disabled", async () => {
		const target = await seedUser("mint-race");
		let disableIsPending!: () => void;
		const disablePending = new Promise<void>((resolve) => {
			disableIsPending = resolve;
		});
		let commitDisable!: () => void;
		const mayCommit = new Promise<void>((resolve) => {
			commitDisable = resolve;
		});
		const disabling = withAdminLock(
			async (tx) => {
				await tx
					.update(users)
					.set({ disabledAt: new Date().toISOString() })
					.where(eq(users.id, target.id));
				disableIsPending();
				await mayCommit;
			},
			{ sqliteAllowYield: true },
		);
		await disablePending;

		const minting = createApiKey(uniqueName("race-key"), ["ingest"], target.id);
		const outcome = await Promise.race([
			minting.then(
				() => "settled",
				() => "settled",
			),
			Bun.sleep(150).then(() => "waiting"),
		]);
		commitDisable();
		await disabling;

		expect(outcome).toBe("waiting");
		await expect(minting).rejects.toBeInstanceOf(OwnerDisabledError);
		const rows = await getDb().select().from(apiKeys).where(eq(apiKeys.ownerUserId, target.id));
		expect(rows.length).toBe(0);
	});
});
