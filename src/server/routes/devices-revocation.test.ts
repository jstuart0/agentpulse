/**
 * What revokes a phone. Every writer that deactivates an API key revokes that
 * key's devices in the same transaction (one test per writer); deleting a phone
 * revokes its key only when a pairing code produced it; and none of this
 * depends on the pairing row surviving a retention pass while the key lives.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import "../db/__test_db.js";
import { asKey, deviceBody, pairedKey } from "../test-utils/device-fixtures.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { apiKeys, mobileDeviceActivities, mobileDevices, pairingCodes, sessions } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { reassignApiKeyOwner, revokeApiKey } = await import("../services/service-keys.js");
const { disableUser } = await import("../services/user-management.js");
const { setMode } = await import("../services/instance-mode.js");
const { deleteRevokedDevices, readSendToken, REVOKED_DEVICE_RETENTION_MS } = await import(
	"../services/mobile-devices-service.js"
);
const { runRetentionPass } = await import("../services/retention-service.js");
const { _resetPairingLimiterForTest } = await import("../services/pairing-service.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await getDb().delete(mobileDeviceActivities);
	await getDb().delete(mobileDevices);
	await getDb().delete(pairingCodes);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearInstanceSettings();
	_resetPairingLimiterForTest();
}
beforeEach(reset);
afterEach(reset);

const call = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

async function phoneOn(keyHeaders: Headers) {
	const res = await call("POST", "/devices", keyHeaders, await deviceBody());
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function deviceRow(id: string) {
	const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, id));
	return row;
}

async function keyRow(id: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id));
	return row;
}

describe("every writer that deactivates a key revokes its phones", () => {
	test("DELETE /api-keys/:id: the key's phones are revoked, another key's are not", async () => {
		const owner = await seedLocalUser("rev-route");
		const admin = await seedLocalUser("rev-route-admin", "admin");
		const doomed = await seedKey("rev-route-doomed", ["respond"], owner.id);
		const kept = await seedKey("rev-route-kept", ["respond"], owner.id);
		const doomedPhone = await phoneOn(asKey(doomed.key));
		const keptPhone = await phoneOn(asKey(kept.key));

		const res = await call("DELETE", `/api-keys/${doomed.id}`, await cookieHeadersFor(admin.id));
		expect(res.status).toBe(200);

		const revoked = await deviceRow(doomedPhone);
		expect(revoked?.revokedAt).not.toBeNull();
		expect(revoked?.revokedReason).toBe("key_deactivated");
		expect((await deviceRow(keptPhone))?.revokedAt).toBeNull();
	});

	test("the service behind it (revokeApiKey) does the same", async () => {
		const owner = await seedLocalUser("rev-service");
		const key = await seedKey("rev-service-key", ["respond"], owner.id);
		const phone = await phoneOn(asKey(key.key));
		expect(await revokeApiKey(key.id)).toBe(true);
		expect((await deviceRow(phone))?.revokedReason).toBe("key_deactivated");
	});

	test("disabling the owner: every phone on every key they own is revoked, other people's are not", async () => {
		const owner = await seedLocalUser("rev-disable");
		const bystander = await seedLocalUser("rev-bystander");
		const k1 = await seedKey("rev-disable-1", ["respond"], owner.id);
		const k2 = await seedKey("rev-disable-2", ["manage"], owner.id);
		const other = await seedKey("rev-bystander-key", ["respond"], bystander.id);
		const p1 = await phoneOn(asKey(k1.key));
		const p2 = await phoneOn(asKey(k2.key));
		const p3 = await phoneOn(asKey(other.key));

		await disableUser(owner.id, {}, { userId: null, label: "system" });

		expect((await deviceRow(p1))?.revokedReason).toBe("key_deactivated");
		expect((await deviceRow(p2))?.revokedReason).toBe("key_deactivated");
		expect((await deviceRow(p3))?.revokedAt).toBeNull();
	});

	test("the mode switch revoking an ownerless key: its phones are revoked; a kept key's are not", async () => {
		const admin = await seedLocalUser("rev-mode-admin", "admin");
		const revoked = await seedKey("rev-mode-revoked", ["manage"], null);
		const kept = await seedKey("rev-mode-kept", ["manage"], null);
		const revokedPhone = await phoneOn(asKey(revoked.key));
		const keptPhone = await phoneOn(asKey(kept.key));

		await setMode(
			{
				mode: "team",
				serviceKeyDecisions: [
					{ keyId: revoked.id, decision: "revoke" },
					{ keyId: kept.id, decision: "keep" },
				],
			},
			{ userId: admin.id, label: "user", role: "admin" },
		);

		expect((await keyRow(revoked.id))?.isActive).toBe(false);
		expect((await deviceRow(revokedPhone))?.revokedReason).toBe("key_deactivated");
		expect((await keyRow(kept.id))?.isActive).toBe(true);
		expect((await deviceRow(keptPhone))?.revokedAt).toBeNull();
	});

	test("a phone already revoked keeps its first reason and time", async () => {
		const owner = await seedLocalUser("rev-twice");
		const key = await seedKey("rev-twice-key", ["respond"], owner.id);
		const headers = asKey(key.key);
		const phone = await phoneOn(headers);
		await call("DELETE", `/devices/${phone}`, headers);
		const first = await deviceRow(phone);

		await revokeApiKey(key.id);

		const after = await deviceRow(phone);
		expect(after?.revokedAt).toBe(first?.revokedAt as string);
		expect(after?.revokedReason).toBe("deleted");
	});

	test("handing a key to another person revokes its phones (owner_changed, token wiped); they register again under the new owner", async () => {
		const first = await seedLocalUser("rev-handover-1");
		const second = await seedLocalUser("rev-handover-2");
		const admin = await seedLocalUser("rev-handover-admin", "admin");
		const key = await seedKey("rev-handover-key", ["respond"], first.id);
		const other = await seedKey("rev-handover-other", ["respond"], first.id);
		const phone = await phoneOn(asKey(key.key));
		const otherPhone = await phoneOn(asKey(other.key));

		const res = await call("PATCH", `/api-keys/${key.id}`, await cookieHeadersFor(admin.id), {
			ownerUserId: second.id,
		});
		expect(res.status).toBe(200);

		const row = await deviceRow(phone);
		expect(row?.revokedReason).toBe("owner_changed");
		expect(row?.revokedAt).not.toBeNull();
		expect(row?.sendToken).toBe("");
		expect(readSendToken(row as never)).toBeNull();
		// another key's phone is untouched, even the same person's
		expect((await deviceRow(otherPhone))?.revokedAt).toBeNull();

		// explicit re-registration under the new owner reinstates it, owned by them
		const body = await deviceBody({ relayDeviceId: row?.relayDeviceId });
		const again = await call("POST", "/devices", asKey(key.key), body);
		expect(again.status).toBe(200);
		const reset = await deviceRow(phone);
		expect(reset?.userId).toBe(second.id);
		expect(reset?.revokedAt).toBeNull();
		expect(readSendToken(reset as never)).toBe(body.sendToken as string);
	});

	test("handing a key to nobody (making it ownerless) revokes its phones too; the same owner again changes nothing", async () => {
		const owner = await seedLocalUser("rev-handover-null");
		const admin = await seedLocalUser("rev-handover-null-admin", "admin");
		const key = await seedKey("rev-handover-null-key", ["respond"], owner.id);
		const phone = await phoneOn(asKey(key.key));
		const adminHeaders = await cookieHeadersFor(admin.id);

		await call("PATCH", `/api-keys/${key.id}`, adminHeaders, { ownerUserId: owner.id }); // no change
		expect((await deviceRow(phone))?.revokedAt).toBeNull();

		await call("PATCH", `/api-keys/${key.id}`, adminHeaders, { ownerUserId: null });
		expect((await deviceRow(phone))?.revokedReason).toBe("owner_changed");
	});

	test("reassignApiKeyOwner (the service form) revokes the same way", async () => {
		const first = await seedLocalUser("rev-reassign-1");
		const second = await seedLocalUser("rev-reassign-2");
		const key = await seedKey("rev-reassign-key", ["respond"], first.id);
		const phone = await phoneOn(asKey(key.key));
		expect(await reassignApiKeyOwner(key.id, second.id)).toBe(true);
		expect((await deviceRow(phone))?.revokedReason).toBe("owner_changed");
	});

	test("the mode switch assigning an ownerless key to someone revokes its phones", async () => {
		const admin = await seedLocalUser("rev-assign-admin", "admin");
		const member = await seedLocalUser("rev-assign-member");
		const key = await seedKey("rev-assign-key", ["manage"], null);
		const phone = await phoneOn(asKey(key.key));

		await setMode(
			{
				mode: "team",
				serviceKeyDecisions: [{ keyId: key.id, decision: "assign", userId: member.id }],
			},
			{ userId: admin.id, label: "user", role: "admin" },
		);

		expect((await keyRow(key.id))?.ownerUserId).toBe(member.id);
		expect((await deviceRow(phone))?.revokedReason).toBe("owner_changed");
	});
});

describe("deleting a phone vs the key behind it", () => {
	test("paired key: revoked with the phone; pasted key: left alone", async () => {
		const owner = await seedLocalUser("rev-pair-vs-paste");
		const paired = await pairedKey(owner.id);
		const pasted = await seedKey("rev-pasted", ["respond"], owner.id);
		const pairedPhone = await phoneOn(asKey(paired.key));
		const pastedPhone = await phoneOn(asKey(pasted.key));

		const a = await (await call("DELETE", `/devices/${pairedPhone}`, asKey(paired.key))).json();
		const b = await (await call("DELETE", `/devices/${pastedPhone}`, asKey(pasted.key))).json();

		expect(a).toEqual({ ok: true, keyRevoked: true });
		expect(b).toEqual({ ok: true, keyRevoked: false });
		expect((await keyRow(paired.keyId))?.isActive).toBe(false);
		expect((await keyRow(pasted.id))?.isActive).toBe(true);
	});

	test("a key a pairing code produced, and one it did not, on the same account", async () => {
		const owner = await seedLocalUser("rev-same-account");
		const paired = await pairedKey(owner.id);
		const pairedPhone = await phoneOn(asKey(paired.key));
		const other = await seedKey("rev-same-account-pasted", ["respond"], owner.id);
		const otherPhone = await phoneOn(asKey(other.key));
		// both are the owner's; only the paired one is revoked when the owner deletes the phones from the dashboard
		const dash = await cookieHeadersFor(owner.id);
		expect((await (await call("DELETE", `/devices/${otherPhone}`, dash)).json()) as object).toEqual(
			{ ok: true, keyRevoked: false },
		);
		expect(
			(await (await call("DELETE", `/devices/${pairedPhone}`, dash)).json()) as object,
		).toEqual({ ok: true, keyRevoked: true });
	});

	test("after a retention pass: the pairing row is still there while its key lives, so deleting the phone still revokes the key", async () => {
		const owner = await seedLocalUser("rev-after-retention");
		const paired = await pairedKey(owner.id);
		const phone = await phoneOn(asKey(paired.key));

		await runRetentionPass(new Date(Date.now() + 400 * 24 * 3_600_000));
		expect((await getDb().select().from(pairingCodes)).length).toBe(1);

		const res = await call("DELETE", `/devices/${phone}`, asKey(paired.key));
		expect(await res.json()).toEqual({ ok: true, keyRevoked: true });
		expect((await keyRow(paired.keyId))?.isActive).toBe(false);
	});

	test("a pasted key stays unrevokable by device delete even after retention has run", async () => {
		const owner = await seedLocalUser("rev-pasted-retention");
		const pasted = await seedKey("rev-pasted-retention-key", ["respond"], owner.id);
		const phone = await phoneOn(asKey(pasted.key));
		await runRetentionPass(new Date(Date.now() + 400 * 24 * 3_600_000));
		const res = await call("DELETE", `/devices/${phone}`, asKey(pasted.key));
		expect(await res.json()).toEqual({ ok: true, keyRevoked: false });
		expect((await keyRow(pasted.id))?.isActive).toBe(true);
	});
});

describe("retention", () => {
	async function revokedPhone(daysAgo: number) {
		const owner = await seedLocalUser(`ret-${daysAgo}-${crypto.randomUUID().slice(0, 4)}`);
		const key = await seedKey(`ret-key-${daysAgo}`, ["respond"], owner.id);
		const id = await phoneOn(asKey(key.key));
		const at = new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString();
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: at, revokedReason: "deleted" })
			.where(eq(mobileDevices.id, id));
		return { id, owner, key };
	}

	test("a phone is purged 30 days after it was revoked, not before; live phones are never purged", async () => {
		const young = await revokedPhone(29);
		const old = await revokedPhone(31);
		const owner = await seedLocalUser("ret-live");
		const liveKey = await seedKey("ret-live-key", ["respond"], owner.id);
		const live = await phoneOn(asKey(liveKey.key));

		expect(await deleteRevokedDevices()).toBe(1);

		expect(await deviceRow(old.id)).toBeUndefined();
		expect(await deviceRow(young.id)).toBeDefined();
		expect(await deviceRow(live)).toBeDefined();
	});

	test("the boundary is exact: at 30 days kept, a millisecond later purged", async () => {
		const owner = await seedLocalUser("ret-boundary");
		const key = await seedKey("ret-boundary-key", ["respond"], owner.id);
		const id = await phoneOn(asKey(key.key));
		const revokedAt = new Date("2026-09-01T00:00:00.000Z");
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: revokedAt.toISOString() })
			.where(eq(mobileDevices.id, id));
		expect(
			await deleteRevokedDevices(new Date(revokedAt.getTime() + REVOKED_DEVICE_RETENTION_MS)),
		).toBe(0);
		expect(
			await deleteRevokedDevices(new Date(revokedAt.getTime() + REVOKED_DEVICE_RETENTION_MS + 1)),
		).toBe(1);
	});

	test("the retention pass does it, even with event retention off", async () => {
		const old = await revokedPhone(40);
		const result = await runRetentionPass();
		expect(result.disabled).toBe(true);
		expect(await deviceRow(old.id)).toBeUndefined();
	});

	test("first registration after a retention pass: the purged phone registers as a new row", async () => {
		const owner = await seedLocalUser("ret-reregister");
		const key = await seedKey("ret-reregister-key", ["respond"], owner.id);
		const headers = asKey(key.key);
		const body = await deviceBody();
		const first = (await (await call("POST", "/devices", headers, body)).json()) as { id: string };
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date(Date.now() - 45 * 24 * 3_600_000).toISOString() })
			.where(eq(mobileDevices.id, first.id));
		await runRetentionPass();
		expect(await deviceRow(first.id)).toBeUndefined();

		const res = await call("POST", "/devices", headers, body);

		expect(res.status).toBe(201);
		expect(((await res.json()) as { id: string }).id).not.toBe(first.id);
	});

	test("a purge that fails does not stop the pairing purge or the event retention pass after it", async () => {
		await upsertSetting("eventsRetentionDays", 1, { allowProtected: true });
		const rename = (from: string, to: string) =>
			config.dialect === "postgres"
				? // biome-ignore lint/suspicious/noExplicitAny: dialect-specific raw statement
					(getDb() as any).execute(sql.raw(`ALTER TABLE ${from} RENAME TO ${to}`))
				: // biome-ignore lint/suspicious/noExplicitAny: dialect-specific raw statement
					(getDb() as any).run(sql.raw(`ALTER TABLE ${from} RENAME TO ${to}`));
		const quiet = spyOn(console, "error").mockImplementation(() => undefined);
		await getDb().insert(pairingCodes).values({
			codeHash: "purge-failure-isolation",
			access: "respond",
			createdAt: "2020-01-01T00:00:00.000Z",
			expiresAt: "2020-01-01T00:05:00.000Z",
		});
		await rename("mobile_devices", "mobile_devices_away");
		try {
			const result = await runRetentionPass();
			expect(result.disabled).toBe(false);
			expect(result.retentionDays).toBe(1);
			expect(
				quiet.mock.calls.some((call) => String(call[0]).includes("revoked device purge failed")),
			).toBe(true);
			// the pairing purge, which runs before it, did its work
			expect((await getDb().select().from(pairingCodes)).length).toBe(0);
		} finally {
			await rename("mobile_devices_away", "mobile_devices");
			quiet.mockRestore();
			const { settings } = await import("../db/schema/index.js");
			await getDb().delete(settings).where(eq(settings.key, "eventsRetentionDays"));
		}
	});

	test("a phone's live activities go with it, and with their session", async () => {
		const owner = await seedLocalUser("ret-cascade");
		const key = await seedKey("ret-cascade-key", ["respond"], owner.id);
		const phone = await phoneOn(asKey(key.key));
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "act-s1", agentType: "claude_code", status: "active" },
				{ sessionId: "act-s2", agentType: "claude_code", status: "active" },
			]);
		const now = new Date().toISOString();
		await getDb()
			.insert(mobileDeviceActivities)
			.values([
				{ deviceId: phone, sessionId: "act-s1", slot: "a", generation: 1, createdAt: now },
				{ deviceId: phone, sessionId: "act-s2", slot: "b", generation: 1, createdAt: now },
			]);
		const count = async () => (await getDb().select().from(mobileDeviceActivities)).length;
		expect(await count()).toBe(2);

		await getDb().delete(sessions).where(eq(sessions.sessionId, "act-s1"));
		expect(await count()).toBe(1);

		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date(Date.now() - 40 * 24 * 3_600_000).toISOString() })
			.where(eq(mobileDevices.id, phone));
		await deleteRevokedDevices();
		expect(await count()).toBe(0);
	});

	test("one activity per device and session", async () => {
		const owner = await seedLocalUser("ret-unique");
		const key = await seedKey("ret-unique-key", ["respond"], owner.id);
		const phone = await phoneOn(asKey(key.key));
		await getDb()
			.insert(sessions)
			.values({ sessionId: "uniq-s", agentType: "claude_code", status: "active" });
		const row = {
			deviceId: phone,
			sessionId: "uniq-s",
			slot: "a",
			createdAt: new Date().toISOString(),
		};
		await getDb().insert(mobileDeviceActivities).values(row);
		let failed = false;
		try {
			await getDb()
				.insert(mobileDeviceActivities)
				.values({ ...row, slot: "b" });
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});
});
