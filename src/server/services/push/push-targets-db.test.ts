/**
 * The targeting policy against the real tables: who is eligible (a live device,
 * an active key that is still its owner's, an owner who is not disabled) and
 * who an event reaches in team mode. Every eligibility break is made directly
 * on the row, not through the revocation writers, so these prove the check
 * itself rather than the cleanup that usually goes with it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../../db/__test_db.js";
import { asKey, deviceBody } from "../../test-utils/device-fixtures.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
	setUserRoleDirectly,
} from "../../test-utils/team-fixtures.js";
import type { PushEvent } from "./types.js";

const { config } = await import("../../config.js");
const { initializeDatabase, getDb } = await import("../../db/client.js");
const { apiKeys, launchRequests, mobileDeviceActivities, mobileDevices, sessions } = await import(
	"../../db/schema/index.js"
);
const { app } = await import("../../app.js");
const { getMode } = await import("../instance-mode.js");
const { _resetDeviceLimitsForTest, revokeDeviceRow } = await import("../mobile-devices-service.js");
const { DbPushDeviceSource, DbPushSubjects, getEligibleDevice } = await import(
	"./device-source.js"
);
const { PolicyPushTargets } = await import("./push-targets.js");
const { observeWsRevalidation } = await import("../../ws/revalidation.js");
const { revokeApiKey } = await import("../service-keys.js");
const { disableUser, setUserRole } = await import("../user-management.js");

const originalSecretsKey = config.secretsKey;
const targets = () =>
	new PolicyPushTargets(new DbPushDeviceSource(), getMode, new DbPushSubjects());

beforeAll(async () => {
	await initializeDatabase();
	config.secretsKey = "targets-db-test-secrets-key";
});
afterAll(() => {
	config.secretsKey = originalSecretsKey;
});

interface Person {
	userId: string;
	keyId: string;
	key: string;
	deviceId: string;
}

async function person(name: string, role: "user" | "admin" = "user"): Promise<Person> {
	const user = await seedLocalUser(name, role);
	const key = await seedKey(`${name}-respond`, ["respond"], user.id);
	const res = await app.request(
		"/api/v1/devices",
		jsonRequest("POST", await deviceBody(), asKey(key.key)),
	);
	expect(res.status).toBe(201);
	const dto = (await res.json()) as { id: string };
	return { userId: user.id, keyId: key.id, key: key.key, deviceId: dto.id };
}

async function mkSession(sessionId: string, ownerUserId: string | null) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			metadata: {},
			ownerUserId,
		})
		.execute();
}

const idsFor = async (event: PushEvent) => (await targets().resolve(event)).map((d) => d.id).sort();
const stuck = (sessionId: string): PushEvent => ({ type: "stuck", sessionId });

let alice: Person;
let bob: Person;
let root: Person;

beforeEach(async () => {
	await getDb().delete(mobileDeviceActivities);
	await getDb().delete(mobileDevices);
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await resetIdentityState();
	await clearInstanceSettings();
	_resetDeviceLimitsForTest();
	await setStoredMode("team");
	alice = await person("tg-alice");
	bob = await person("tg-bob");
	root = await person("tg-root", "admin");
	await mkSession("s-alice", alice.userId);
	await mkSession("s-open", null);
});

describe("team targeting from the real tables", () => {
	test("a session's event reaches its owner's devices only", async () => {
		expect(await idsFor(stuck("s-alice"))).toEqual([alice.deviceId]);
	});

	test("an unowned session reaches the admins' devices", async () => {
		expect(await idsFor(stuck("s-open"))).toEqual([root.deviceId]);
	});

	test("a handed-over session follows its new owner at the next event", async () => {
		await getDb()
			.update(sessions)
			.set({ ownerUserId: bob.userId })
			.where(eq(sessions.sessionId, "s-alice"));
		expect(await idsFor(stuck("s-alice"))).toEqual([bob.deviceId]);
	});

	test("an action request reaches the admins' devices", async () => {
		expect(
			await idsFor({ type: "action_request_opened", actionRequestId: "a", actionKind: "k" }),
		).toEqual([root.deviceId]);
	});

	test("a launch reaches whoever requested it; unrecorded, the admins; unknown, nobody", async () => {
		const launch = (requestedByUserId: string | null) =>
			getDb()
				.insert(launchRequests)
				.values({
					id: crypto.randomUUID(),
					launchCorrelationId: crypto.randomUUID(),
					agentType: "claude_code",
					cwd: "/tmp/x",
					status: "running",
					requestedByUserId,
				})
				.returning({ id: launchRequests.id })
				.then((rows) => (rows[0] as { id: string }).id);
		const mine = await launch(bob.userId);
		const unattributed = await launch(null);
		expect(await idsFor({ type: "launch_status", launchId: mine })).toEqual([bob.deviceId]);
		expect(await idsFor({ type: "launch_status", launchId: unattributed })).toEqual([
			root.deviceId,
		]);
		expect(await idsFor({ type: "launch_status", launchId: "no-such-launch" })).toEqual([]);
	});

	test("a user promoted to admin is an admin target from then on", async () => {
		await setUserRoleDirectly(bob.userId, "admin");
		expect(await idsFor(stuck("s-open"))).toEqual([bob.deviceId, root.deviceId].sort());
	});
});

describe("eligibility, in both modes", () => {
	const everyone = () => [alice.deviceId, bob.deviceId, root.deviceId].sort();

	test("the baseline: every device is eligible and solo mode reaches all of them", async () => {
		await setStoredMode("solo");
		expect(await idsFor(stuck("s-alice"))).toEqual(everyone());
		expect(await getEligibleDevice(alice.deviceId)).not.toBeNull();
	});

	test("a deactivated key makes its device ineligible although the device row is untouched", async () => {
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, alice.keyId));
		expect(await idsFor(stuck("s-alice"))).toEqual([]);
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
		await setStoredMode("solo");
		expect(await idsFor(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("a disabled owner makes their devices ineligible", async () => {
		await disableUserDirectly(alice.userId);
		expect(await idsFor(stuck("s-alice"))).toEqual([]);
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
		await setStoredMode("solo");
		expect(await idsFor(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("a revoked device is no target", async () => {
		await revokeDeviceRow(alice.deviceId, "deleted");
		expect(await idsFor(stuck("s-alice"))).toEqual([]);
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
		await setStoredMode("solo");
		expect(await idsFor(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("a device marked revoked is ineligible even if its token were somehow still there", async () => {
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date().toISOString(), revokedReason: "deleted" })
			.where(eq(mobileDevices.id, alice.deviceId));
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
		expect(await idsFor(stuck("s-alice"))).toEqual([]);
	});

	test("a key that changed owner leaves the device it registered ineligible", async () => {
		await getDb()
			.update(apiKeys)
			.set({ ownerUserId: bob.userId })
			.where(eq(apiKeys.id, alice.keyId));
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
		expect(await idsFor(stuck("s-alice"))).toEqual([]);
	});

	test("a deleted key makes its device ineligible", async () => {
		await getDb().delete(apiKeys).where(eq(apiKeys.id, alice.keyId));
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
	});

	test("a device whose user row is gone is ineligible", async () => {
		const { users } = await import("../../db/schema/index.js");
		await getDb().delete(users).where(eq(users.id, alice.userId));
		expect(await getEligibleDevice(alice.deviceId)).toBeNull();
	});

	test("an ownerless key's device is eligible in solo mode and reaches no session in team mode", async () => {
		const key = await seedKey("service-respond", ["respond"], null);
		const res = await app.request(
			"/api/v1/devices",
			jsonRequest("POST", await deviceBody(), asKey(key.key)),
		);
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		expect(await getEligibleDevice(id)).not.toBeNull();
		expect(await idsFor(stuck("s-alice"))).not.toContain(id);
		expect(await idsFor(stuck("s-open"))).not.toContain(id);
		await setStoredMode("solo");
		expect(await idsFor(stuck("s-alice"))).toContain(id);
	});
});

describe("the cached device list follows every change that makes a device ineligible", () => {
	// The wiring startPush installs: a long cache, dropped whenever a revalidation is requested.
	let cached: InstanceType<typeof PolicyPushTargets>;
	let unobserve: () => void;
	const cachedIds = async (event: PushEvent) =>
		(await cached.resolve(event)).map((d) => d.id).sort();

	beforeEach(async () => {
		await setStoredMode("solo");
		cached = new PolicyPushTargets(new DbPushDeviceSource(), getMode, new DbPushSubjects(), {
			ms: 600_000,
			now: Date.now,
		});
		unobserve = observeWsRevalidation(async () => cached.invalidate());
		expect(await cachedIds(stuck("s-alice"))).toEqual(
			[alice.deviceId, bob.deviceId, root.deviceId].sort(),
		); // warms the cache
	});
	afterEach(() => unobserve());

	test("control: without the invalidation a revoked device is still chosen, which is what the cache costs", async () => {
		unobserve();
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, alice.keyId));
		expect(await cachedIds(stuck("s-alice"))).toContain(alice.deviceId);
		unobserve = observeWsRevalidation(async () => cached.invalidate());
	});

	test("revoking a device: the very next dispatch skips it", async () => {
		await revokeDeviceRow(alice.deviceId, "deleted");
		expect(await cachedIds(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("deleting a device through the route (an unpaired key: no key revocation): the next dispatch skips it", async () => {
		const res = await app.request(`/api/v1/devices/${alice.deviceId}`, {
			method: "DELETE",
			headers: asKey(alice.key),
		});
		expect(res.status).toBe(200);
		expect(await cachedIds(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("revoking a key: the next dispatch skips its device", async () => {
		expect(await revokeApiKey(alice.keyId)).toBe(true);
		expect(await cachedIds(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("disabling a user: the next dispatch skips their devices", async () => {
		await disableUser(alice.userId, {}, { userId: root.userId, label: "user" } as never);
		expect(await cachedIds(stuck("s-alice"))).toEqual([bob.deviceId, root.deviceId].sort());
	});

	test("changing a role: team targeting sees the new role at the next dispatch", async () => {
		await setStoredMode("team");
		cached.invalidate();
		expect(await cachedIds(stuck("s-open"))).toEqual([root.deviceId]);
		await setUserRole(bob.userId, "admin", { userId: root.userId, label: "user" } as never);
		expect(await cachedIds(stuck("s-open"))).toEqual([bob.deviceId, root.deviceId].sort());
	});
});
