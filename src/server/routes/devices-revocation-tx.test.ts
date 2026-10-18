/**
 * Revoking a phone and changing or deactivating its key commit together or not at
 * all. For each writer that deactivates a key, and each path that changes a key's
 * owner, a failure forced AFTER the device hook has run must leave the key as it
 * was, the phone live with its token, and surface the error.
 *
 * On SQLite a statement that ignored the transaction handle would still roll back
 * with it (one connection), so these runs alone can't see a dropped `tx` there;
 * the source scan at the end pins it, and on Postgres the rollback assertions do.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { asKey, deviceBody } from "../test-utils/device-fixtures.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	apiKeys,
	controlActions,
	mobileDeviceActivities,
	mobileDevices,
	projects,
	sessions,
	supervisors,
	users,
} = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const keyLists = await import("../services/service-key-lists.js");
const supervisorAuth = await import("../auth/supervisor-auth.js");
const { applyApiKeyPatch, reassignApiKeyOwner, revokeApiKey } = await import(
	"../services/service-keys.js"
);
const { disableUser } = await import("../services/user-management.js");
const { getMode, setMode } = await import("../services/instance-mode.js");
const { readSendToken } = await import("../services/mobile-devices-service.js");
const { claimNextControlAction, queueCleanupWorkArea, updateControlAction } = await import(
	"../services/control-actions.js"
);

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await getDb().delete(mobileDeviceActivities);
	await getDb().delete(mobileDevices);
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const boom = () => new Error("forced failure after the device hook");

async function phoneOn(key: string): Promise<string> {
	const res = await app.request(
		"/api/v1/devices",
		jsonRequest("POST", await deviceBody(), asKey(key)),
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function expectUntouched(opts: {
	keyId: string;
	deviceId: string;
	ownerUserId: string | null;
}) {
	const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, opts.keyId));
	expect(key?.isActive).toBe(true);
	expect(key?.ownerUserId).toBe(opts.ownerUserId);
	const [device] = await getDb()
		.select()
		.from(mobileDevices)
		.where(eq(mobileDevices.id, opts.deviceId));
	expect(device?.revokedAt).toBeNull();
	expect(device?.revokedReason).toBeNull();
	expect(readSendToken(device as never)).not.toBeNull(); // the token was not wiped
}

describe("a key deactivation and its phones commit together", () => {
	test("revokeApiKey: a failure after the hook leaves the key active and the phone live", async () => {
		const owner = await seedLocalUser("tx-revoke");
		const key = await seedKey("tx-revoke-key", ["respond"], owner.id);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(keyLists, "delistAdminServiceKey").mockRejectedValue(boom());
		try {
			await expect(revokeApiKey(key.id)).rejects.toThrow("forced failure");
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: owner.id });
	});

	test("disabling a user: a failure after the keys are deactivated rolls the keys, the phones and the disable back", async () => {
		const owner = await seedLocalUser("tx-disable");
		const key = await seedKey("tx-disable-key", ["respond"], owner.id);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(supervisorAuth, "deactivateEnrollmentTokensCreatedByUser").mockRejectedValue(
			boom(),
		);
		try {
			await expect(disableUser(owner.id, {}, { userId: null, label: "system" })).rejects.toThrow(
				"forced failure",
			);
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: owner.id });
		const [user] = await getDb().select().from(users).where(eq(users.id, owner.id));
		expect(user?.disabledAt).toBeNull();
	});

	test("the mode switch revoking a key: a failure after the hook rolls back the key, the phone and the mode", async () => {
		const admin = await seedLocalUser("tx-mode-admin", "admin");
		const key = await seedKey("tx-mode-key", ["manage"], null);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(keyLists, "delistServiceKey").mockRejectedValue(boom());
		try {
			await expect(
				setMode(
					{ mode: "team", serviceKeyDecisions: [{ keyId: key.id, decision: "revoke" }] },
					{ userId: admin.id, label: "user", role: "admin" },
				),
			).rejects.toThrow("forced failure");
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: null });
		expect(await getMode()).toBe("solo");
	});
});

describe("a key's change of owner and its phones commit together", () => {
	test("PATCH /api-keys/:id (applyApiKeyPatch): a failure after the hook keeps the old owner and the live phone", async () => {
		const first = await seedLocalUser("tx-patch-1");
		const second = await seedLocalUser("tx-patch-2");
		const key = await seedKey("tx-patch-key", ["respond"], first.id);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(keyLists, "delistAdminServiceKey").mockRejectedValue(boom());
		try {
			await expect(applyApiKeyPatch(key.id, { ownerUserId: second.id }, true)).rejects.toThrow(
				"forced failure",
			);
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: first.id });
	});

	test("reassignApiKeyOwner: same", async () => {
		const first = await seedLocalUser("tx-reassign-1");
		const second = await seedLocalUser("tx-reassign-2");
		const key = await seedKey("tx-reassign-key", ["respond"], first.id);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(keyLists, "delistAdminServiceKey").mockRejectedValue(boom());
		try {
			await expect(reassignApiKeyOwner(key.id, second.id)).rejects.toThrow("forced failure");
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: first.id });
	});

	test("the mode switch assigning a key: a failure after the hook keeps the key ownerless and the phone live", async () => {
		const admin = await seedLocalUser("tx-assign-admin", "admin");
		const member = await seedLocalUser("tx-assign-member");
		const key = await seedKey("tx-assign-key", ["manage"], null);
		const deviceId = await phoneOn(key.key);
		const fail = spyOn(keyLists, "delistServiceKey").mockRejectedValue(boom());
		try {
			await expect(
				setMode(
					{
						mode: "team",
						serviceKeyDecisions: [{ keyId: key.id, decision: "assign", userId: member.id }],
					},
					{ userId: admin.id, label: "user", role: "admin" },
				),
			).rejects.toThrow("forced failure");
		} finally {
			fail.mockRestore();
		}
		await expectUntouched({ keyId: key.id, deviceId, ownerUserId: null });
		expect(await getMode()).toBe("solo");
	});
});

describe("device delete and its key commit together", () => {
	test("DELETE /devices/:id of a paired phone: a failure after the key's hook leaves the phone live and the key active", async () => {
		const { pairedKey } = await import("../test-utils/device-fixtures.js");
		const owner = await seedLocalUser("tx-delete");
		const paired = await pairedKey(owner.id);
		const deviceId = await phoneOn(paired.key);
		const fail = spyOn(keyLists, "delistAdminServiceKey").mockRejectedValue(boom());
		let status = 0;
		try {
			const res = await app.request(
				`/api/v1/devices/${deviceId}`,
				jsonRequest("DELETE", {}, asKey(paired.key)),
			);
			status = res.status;
		} finally {
			fail.mockRestore();
		}
		expect(status).toBe(500);
		await expectUntouched({ keyId: paired.keyId, deviceId, ownerUserId: owner.id });
	});
});

describe("every call site hands the hook its transaction", () => {
	// On SQLite the behaviour tests above can't tell a dropped `tx` (one connection
	// rolls back everything), so the sources are held to it directly; on Postgres
	// the rollback assertions fail if the hook runs on the pool instead.
	const sites: Array<[string, RegExp]> = [
		["src/server/services/service-keys.ts", /onKeysDeactivated\(\[keyId\], tx\)/],
		["src/server/auth/api-key.ts", /onKeysDeactivated\(ids, tx\)/],
		["src/server/services/instance-mode.ts", /onKeysDeactivated\(\[decision\.keyId\], tx\)/],
		[
			"src/server/services/instance-mode.ts",
			/onKeyOwnerChanged\(decision\.keyId, null, decision\.userId \?\? null, tx\)/,
		],
		[
			"src/server/services/service-keys.ts",
			/onKeyOwnerChanged\(keyId, existing\.ownerUserId, ownerUserId, tx\)/,
		],
		[
			"src/server/services/service-keys.ts",
			/onKeyOwnerChanged\(keyId, existing\.ownerUserId, patch\.ownerUserId, tx\)/,
		],
	];
	for (const [file, pattern] of sites) {
		test(`${file}: ${pattern.source}`, async () => {
			const source = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
			expect(source).toMatch(pattern);
		});
	}

	test("no call to either hook leaves out the handle, anywhere in the server", async () => {
		const root = new URL("../", import.meta.url).pathname;
		const offenders: string[] = [];
		let scanned = 0;
		for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
			if (relative.endsWith(".test.ts") || relative.endsWith("mobile-devices-service.ts")) continue;
			const source = await readFile(`${root}${relative}`, "utf8");
			scanned++;
			const file = relative;
			for (const match of source.matchAll(/onKey(?:sDeactivated|OwnerChanged)\(([^)]*)\)/g)) {
				if (!/\btx\b/.test(match[1] ?? "")) offenders.push(`${file}: ${match[0]}`);
			}
		}
		expect(scanned).toBeGreaterThan(100);
		expect(offenders).toEqual([]);
	});
});

describe("cleaning up a work area takes a phone's live activities with the sessions", () => {
	test("finalizeCleanupWorkArea (reached by a succeeded cleanup_workarea action) cascades to mobile_device_activities", async () => {
		const now = new Date().toISOString();
		const supervisorId = `sup-${crypto.randomUUID()}`;
		const projectId = crypto.randomUUID();
		const sessionId = `act-ctl-${crypto.randomUUID()}`;
		await getDb()
			.insert(supervisors)
			.values({
				id: supervisorId,
				hostName: "test-host",
				platform: "darwin",
				arch: "arm64",
				version: "0.1.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless"],
					os: "macos",
					terminalSupport: [],
					features: ["can_cleanup_workarea"],
				},
				trustedRoots: ["/tmp"],
				status: "connected",
				capabilitySchemaVersion: 2,
				configSchemaVersion: 1,
				lastHeartbeatAt: now,
				heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				enrollmentState: "active",
				createdAt: now,
				updatedAt: now,
			});
		await getDb()
			.insert(projects)
			.values({
				id: projectId,
				name: `proj-${projectId.slice(0, 8)}`,
				cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
				tags: ["scratch"],
				isFavorite: false,
				createdAt: now,
				updatedAt: now,
			});
		await getDb().insert(sessions).values({ sessionId, agentType: "claude_code", projectId });
		const owner = await seedLocalUser("cascade-owner");
		const key = await seedKey("cascade-key", ["respond"], owner.id);
		const deviceId = await phoneOn(key.key);
		await getDb()
			.insert(mobileDeviceActivities)
			.values({ deviceId, sessionId, slot: "s", generation: 1, createdAt: now });
		const count = async () => (await getDb().select().from(mobileDeviceActivities)).length;
		expect(await count(), "positive control").toBe(1);

		const queued = await queueCleanupWorkArea(
			{ projectId, cwd: `/tmp/scratch-${projectId.slice(0, 8)}`, targetSupervisorId: supervisorId },
			{ userId: null, label: "user" },
		);
		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed?.id).toBe(queued.id);
		try {
			const updated = await updateControlAction({
				actionId: queued.id,
				supervisorId,
				status: "succeeded",
			});
			expect(updated?.status).toBe("succeeded");
			expect(
				await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId)),
			).toHaveLength(0);
			expect(await count()).toBe(0);
			// the phone itself is untouched
			expect(
				await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, deviceId)),
			).toHaveLength(1);
		} finally {
			await getDb().delete(controlActions).where(eq(controlActions.id, queued.id));
			await getDb().delete(supervisors).where(eq(supervisors.id, supervisorId));
		}
	});
});
