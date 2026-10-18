/**
 * The edges of registering a phone: the token at rest, who can claim, move or
 * re-register one, the caps and rate limits, the field rules (including the C1
 * DevicePrefs contract), and that no response or log ever carries a push credential.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { asKey, deviceBody, p256PublicKey, pairedKey } from "../test-utils/device-fixtures.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const dbClient = await import("../db/client.js");
const { apiKeys, mobileDevices, pairingCodes } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const service = await import("../services/mobile-devices-service.js");
const {
	DEVICE_REGISTRATIONS_PER_HOUR,
	DEVICE_TEST_PUSHES_PER_MINUTE,
	MAX_DEVICES_PER_KEY,
	MAX_DEVICES_PER_USER,
	USER_TEST_PUSHES_PER_MINUTE,
	readSendToken,
} = service;
const { _resetPairingLimiterForTest } = await import("../services/pairing-service.js");
const { config } = await import("../config.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	service._setDeviceLimitClockForTest(null);
	service._resetDeviceLimitsForTest();
	await getDb().delete(mobileDevices);
	await getDb().delete(pairingCodes);
	await resetIdentityState();
	await clearInstanceSettings();
	_resetPairingLimiterForTest();
}
beforeEach(reset);
afterEach(reset);

type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
const call = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

async function person(label: string, role: "user" | "admin" = "user") {
	const user = await seedLocalUser(label, role);
	return user;
}
async function keyFor(userId: string | null, label: string, scopes = ["respond"]) {
	const key = await seedKey(label, scopes, userId);
	return { ...key, headers: asKey(key.key) };
}
const rows = () => getDb().select().from(mobileDevices);

describe("the send token at rest", () => {
	test("stored encrypted: not the plaintext, readable only through readSendToken, never in a response", async () => {
		const owner = await person("tok-owner");
		const key = await keyFor(owner.id, "tok-key");
		const body = await deviceBody();
		const res = await call("POST", "/devices", key.headers, body);
		const created = await json(res);

		const [row] = await rows();
		expect(row?.sendToken).not.toBe(body.sendToken);
		expect(row?.sendToken).not.toContain(body.sendToken as string);
		expect(row?.sendToken.length).toBeGreaterThan(40);
		expect(readSendToken(row as never)).toBe(body.sendToken as string);
		expect(JSON.stringify(created)).not.toContain(body.sendToken as string);
		expect(JSON.stringify(created)).not.toContain(row?.sendToken as string);
	});

	test("two registrations of the same token store different ciphertext", async () => {
		const owner = await person("tok-salt");
		const key = await keyFor(owner.id, "tok-salt-key");
		const a = await deviceBody({ sendToken: "same-token-value" });
		const b = await deviceBody({ sendToken: "same-token-value" });
		await call("POST", "/devices", key.headers, a);
		await call("POST", "/devices", key.headers, b);
		const stored = (await rows()).map((r) => r.sendToken);
		expect(new Set(stored).size).toBe(2);
	});

	test("revoking wipes it: by device delete, by key deactivation, by owner change", async () => {
		const owner = await person("tok-wipe");
		const admin = await person("tok-wipe-admin", "admin");
		const adminHeaders = await cookieHeadersFor(admin.id);
		const a = await keyFor(owner.id, "tok-wipe-a");
		const b = await keyFor(owner.id, "tok-wipe-b");
		const c = await keyFor(owner.id, "tok-wipe-c");
		const da = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		await call("POST", "/devices", b.headers, await deviceBody());
		await call("POST", "/devices", c.headers, await deviceBody());

		await call("DELETE", `/devices/${da.id}`, a.headers);
		await call("DELETE", `/api-keys/${b.id}`, adminHeaders);
		await call("PATCH", `/api-keys/${c.id}`, adminHeaders, { ownerUserId: null });

		for (const row of await rows()) {
			expect({ reason: row.revokedReason, token: row.sendToken }).toEqual({
				reason: row.revokedReason,
				token: "",
			});
			expect(readSendToken(row as never)).toBeNull();
		}
		expect((await rows()).map((r) => r.revokedReason).sort()).toEqual([
			"deleted",
			"key_deactivated",
			"owner_changed",
		]);
	});

	test("a token that can't be decrypted (the secrets key changed) reads as null and says so without leaking it", async () => {
		const owner = await person("tok-unreadable");
		const key = await keyFor(owner.id, "tok-unreadable-key");
		await call("POST", "/devices", key.headers, await deviceBody());
		const [row] = await rows();
		const lines: string[] = [];
		const err = spyOn(console, "error").mockImplementation((...a) => void lines.push(a.join(" ")));
		try {
			expect(
				readSendToken({
					...(row as object),
					sendToken: "bm90IGEgcmVhbCBjaXBoZXJ0ZXh0IGF0IGFsbCBub3Q=",
				} as never),
			).toBeNull();
		} finally {
			err.mockRestore();
		}
		expect(lines.join("\n")).toContain("device_send_token_unreadable");
	});

	test("with no secrets key a phone can't register: 503 secrets_key_missing, nothing stored", async () => {
		const owner = await person("tok-nokey");
		const key = await keyFor(owner.id, "tok-nokey-key");
		const original = config.secretsKey;
		(config as Record<string, unknown>).secretsKey = "";
		try {
			const res = await call("POST", "/devices", key.headers, await deviceBody());
			expect(res.status).toBe(503);
			expect(await json(res)).toEqual({ error: "secrets_key_missing" });
		} finally {
			(config as Record<string, unknown>).secretsKey = original;
		}
		expect((await rows()).length).toBe(0);
	});

	test("no response or log line on any path carries the token: values compared, not key names", async () => {
		const lines: string[] = [];
		const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		const log = spyOn(console, "log").mockImplementation(capture);
		const err = spyOn(console, "error").mockImplementation(capture);
		const warn = spyOn(console, "warn").mockImplementation(capture);
		const seen: string[] = [];
		try {
			const owner = await person("tok-leak");
			const other = await person("tok-leak-other");
			const key = await keyFor(owner.id, "tok-leak-key");
			const otherKey = await keyFor(other.id, "tok-leak-other-key");
			const body = await deviceBody();
			const token = body.sendToken as string;
			const keep = async (res: Response) => void seen.push(await res.text());

			await keep(await call("POST", "/devices", key.headers, body)); // create
			await keep(await call("POST", "/devices", key.headers, { ...body, deviceName: "again" })); // update
			await keep(await call("POST", "/devices", otherKey.headers, body)); // 409
			await keep(await call("POST", "/devices", key.headers, { ...body, publicKey: "bad" })); // 400
			const list = await call("GET", "/devices", key.headers);
			await keep(list);
			const id = (JSON.parse(seen[seen.length - 1] as string) as Json).devices[0].id as string;
			await keep(await call("PATCH", `/devices/${id}`, key.headers, { deviceName: "patched" }));
			await keep(await call("POST", `/devices/${id}/test`, key.headers));
			await keep(await call("DELETE", `/devices/${id}`, key.headers));
			await keep(await call("POST", "/devices", key.headers, body)); // 409 device_removed

			for (const text of [...seen, ...lines]) {
				expect(text).not.toContain(token);
			}
			const [stored] = await rows();
			expect(stored?.sendToken).toBe("");
		} finally {
			log.mockRestore();
			err.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("who can claim, move or re-register a phone", () => {
	test("owned -> ownerless is refused, and ownerless -> owned too (live rows)", async () => {
		const owner = await person("cm-owner");
		const owned = await keyFor(owner.id, "cm-owned");
		const loose = await keyFor(null, "cm-loose");
		const ownedBody = await deviceBody();
		const looseBody = await deviceBody();
		await call("POST", "/devices", owned.headers, ownedBody);
		await call("POST", "/devices", loose.headers, looseBody);

		expect((await call("POST", "/devices", loose.headers, ownedBody)).status).toBe(409);
		expect((await call("POST", "/devices", owned.headers, looseBody)).status).toBe(409);
		const stored = await rows();
		expect(stored.map((r) => r.userId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
			[null, owner.id].sort((a, b) => String(a).localeCompare(String(b))),
		);
	});

	test("the same relay id on a different platform is a separate phone", async () => {
		const owner = await person("cm-platform");
		const key = await keyFor(owner.id, "cm-platform-key");
		const body = await deviceBody({ relayDeviceId: "shared-relay-id" });
		expect((await call("POST", "/devices", key.headers, body)).status).toBe(201);
		expect(
			(await call("POST", "/devices", key.headers, { ...body, platform: "android" })).status,
		).toBe(201);
		const stored = await rows();
		expect(stored.map((r) => r.platform).sort()).toEqual(["android", "ios"]);
		expect(new Set(stored.map((r) => r.id)).size).toBe(2);
	});

	test("a paired phone can't be re-registered by a second, non-manage key of the same person: 409 device_key_mismatch; a manage key can", async () => {
		const owner = await person("cm-mismatch");
		const paired = await pairedKey(owner.id);
		const second = await keyFor(owner.id, "cm-mismatch-second");
		const manage = await keyFor(owner.id, "cm-mismatch-manage", ["manage"]);
		const body = await deviceBody();
		expect((await call("POST", "/devices", asKey(paired.key), body)).status).toBe(201);

		const refused = await call("POST", "/devices", second.headers, body);
		expect(refused.status).toBe(409);
		expect(await json(refused)).toEqual({ error: "device_key_mismatch" });
		expect((await rows())[0]?.apiKeyId).toBe(paired.keyId);

		const moved = await call("POST", "/devices", manage.headers, body);
		expect(moved.status).toBe(200);
		expect((await rows())[0]?.apiKeyId).toBe(manage.id);
	});

	test("across the paired/pasted boundary, both ways: `paired` follows the current key", async () => {
		const owner = await person("cm-boundary");
		const paired = await pairedKey(owner.id);
		const pasted = await keyFor(owner.id, "cm-boundary-pasted");
		const pastedManage = await keyFor(owner.id, "cm-boundary-manage", ["manage"]);
		const body = await deviceBody();

		// pasted first: registered as not paired
		expect((await json(await call("POST", "/devices", pasted.headers, body))).paired).toBe(false);
		// the paired key takes it over: the existing key is pasted, so that is allowed, and it is now paired
		const toPaired = await call("POST", "/devices", asKey(paired.key), body);
		expect(toPaired.status).toBe(200);
		expect((await json(toPaired)).paired).toBe(true);
		expect((await json(await call("GET", "/devices", asKey(paired.key)))).devices[0].paired).toBe(
			true,
		);
		// back to a pasted respond key: refused, it is paired now
		expect((await call("POST", "/devices", pasted.headers, body)).status).toBe(409);
		// back to a pasted manage key: allowed, and no longer paired
		const back = await call("POST", "/devices", pastedManage.headers, body);
		expect(back.status).toBe(200);
		expect((await json(back)).paired).toBe(false);
	});

	test("a paired key that is later deactivated leaves a revoked phone anyone may claim", async () => {
		const owner = await person("cm-claim-owner");
		const other = await person("cm-claim-other");
		const admin = await person("cm-claim-admin", "admin");
		const a = await keyFor(owner.id, "cm-claim-a");
		const b = await keyFor(other.id, "cm-claim-b");
		const body = await deviceBody({ deviceName: "Original", prefs: { digestHour: 9 } });
		await call("POST", "/devices", a.headers, body);
		await call("DELETE", `/api-keys/${a.id}`, await cookieHeadersFor(admin.id));
		expect((await rows())[0]?.revokedReason).toBe("key_deactivated");

		const mine = await deviceBody({
			relayDeviceId: body.relayDeviceId,
			deviceName: undefined,
			prefs: undefined,
		});
		const res = await call("POST", "/devices", b.headers, mine);

		expect(res.status).toBe(200);
		const [row] = await rows();
		expect(row?.userId).toBe(other.id);
		expect(row?.apiKeyId).toBe(b.id);
		expect(row?.revokedAt).toBeNull();
		expect(row?.deviceName).toBeNull(); // nothing of the old registration is inherited
		expect(row?.prefsJson).toBeNull();
		expect(readSendToken(row as never)).toBe(mine.sendToken as string);
		expect((await json(await call("GET", "/devices", b.headers))).devices).toHaveLength(1);
	});

	test("a phone removed by hand by one person can be claimed by another", async () => {
		const owner = await person("cm-removed-owner");
		const other = await person("cm-removed-other");
		const a = await keyFor(owner.id, "cm-removed-a");
		const b = await keyFor(other.id, "cm-removed-b");
		const body = await deviceBody();
		const created = await json(await call("POST", "/devices", a.headers, body));
		await call("DELETE", `/devices/${created.id}`, a.headers);
		expect((await call("POST", "/devices", b.headers, body)).status).toBe(200);
		expect((await rows())[0]?.userId).toBe(other.id);
	});

	test("a registration that loses a race to a change of owner is a retryable 409 and writes nothing", async () => {
		const owner = await person("cm-race-owner");
		const thief = await person("cm-race-thief");
		const key = await keyFor(owner.id, "cm-race-key");
		const body = await deviceBody();
		await call("POST", "/devices", key.headers, body);

		const realGetDb = dbClient.getDb;
		let armed = true;
		const spy = spyOn(dbClient, "getDb").mockImplementation(() => {
			const db = realGetDb();
			return new Proxy(db, {
				get(target, prop, receiver) {
					if (prop !== "update") return Reflect.get(target, prop, receiver);
					return (table: unknown) => {
						const builder = (target.update as (t: unknown) => any)(table);
						if (table !== mobileDevices || !armed) return builder;
						armed = false;
						return new Proxy(builder, {
							get(b, p) {
								if (p !== "set") return (b as any)[p].bind(b);
								return (values: unknown) => {
									const chain = b.set(values);
									return new Proxy(chain, {
										get(c, q) {
											if (q !== "where") return (c as any)[q].bind(c);
											return (cond: unknown) => {
												const done = c.where(cond);
												return new Proxy(done, {
													get(d, r) {
														if (r !== "returning") return (d as any)[r]?.bind?.(d);
														return async (...args: unknown[]) => {
															// the owner changes between our read and our write
															await realGetDb().update(mobileDevices).set({ userId: thief.id });
															return d.returning(...args);
														};
													},
												});
											};
										},
									});
								};
							},
						});
					};
				},
			});
		});
		try {
			const res = await call("POST", "/devices", key.headers, { ...body, deviceName: "Raced" });
			expect(res.status).toBe(409);
			expect(await json(res)).toEqual({ error: "device_conflict" });
		} finally {
			spy.mockRestore();
		}
		const [row] = await rows();
		expect(row?.userId).toBe(thief.id);
		expect(row?.deviceName).toBe("Test Phone"); // our update did not land
	});
});

describe("caps and rate limits", () => {
	test("a key holds at most 10 live phones; the 11th is a 409 device_limit and revoked ones don't count", async () => {
		const owner = await person("cap-key");
		const key = await keyFor(owner.id, "cap-key-key");
		const ids: string[] = [];
		for (let i = 0; i < MAX_DEVICES_PER_KEY; i++) {
			service._resetDeviceLimitsForTest(); // the hourly limit is its own test
			ids.push((await json(await call("POST", "/devices", key.headers, await deviceBody()))).id);
		}
		service._resetDeviceLimitsForTest();
		const over = await call("POST", "/devices", key.headers, await deviceBody());
		expect(over.status).toBe(409);
		expect(await json(over)).toEqual({ error: "device_limit", scope: "key" });

		await call("DELETE", `/devices/${ids[0]}`, key.headers);
		service._resetDeviceLimitsForTest();
		expect((await call("POST", "/devices", key.headers, await deviceBody())).status).toBe(201);
	});

	test("a person holds at most 20 across their keys", async () => {
		const owner = await person("cap-user");
		const keys = [
			await keyFor(owner.id, "cap-user-1"),
			await keyFor(owner.id, "cap-user-2"),
			await keyFor(owner.id, "cap-user-3"),
		];
		for (const key of keys.slice(0, 2)) {
			for (let i = 0; i < MAX_DEVICES_PER_KEY; i++) {
				service._resetDeviceLimitsForTest();
				expect((await call("POST", "/devices", key.headers, await deviceBody())).status).toBe(201);
			}
		}
		service._resetDeviceLimitsForTest();
		expect(MAX_DEVICES_PER_USER).toBe(20);
		const over = await call(
			"POST",
			"/devices",
			(keys[2] as { headers: Headers }).headers,
			await deviceBody(),
		);
		expect(over.status).toBe(409);
		expect(await json(over)).toEqual({ error: "device_limit", scope: "user" });
	});

	test("an update of an existing phone isn't blocked by the caps", async () => {
		const owner = await person("cap-update");
		const key = await keyFor(owner.id, "cap-update-key");
		const first = await deviceBody();
		await call("POST", "/devices", key.headers, first);
		for (let i = 1; i < MAX_DEVICES_PER_KEY; i++) {
			service._resetDeviceLimitsForTest();
			await call("POST", "/devices", key.headers, await deviceBody());
		}
		service._resetDeviceLimitsForTest();
		expect((await call("POST", "/devices", key.headers, first)).status).toBe(200);
	});

	test("registration is limited to 10 an hour per key, updates included, and the window releases", async () => {
		const owner = await person("rate-reg");
		const key = await keyFor(owner.id, "rate-reg-key");
		let now = 1_000_000;
		service._setDeviceLimitClockForTest(() => now);
		const body = await deviceBody();
		const statuses: number[] = [];
		for (let i = 0; i < DEVICE_REGISTRATIONS_PER_HOUR + 1; i++) {
			statuses.push((await call("POST", "/devices", key.headers, body)).status);
		}
		expect(statuses).toEqual([201, ...Array(DEVICE_REGISTRATIONS_PER_HOUR - 1).fill(200), 429]);
		const refused = await call("POST", "/devices", key.headers, body);
		expect(refused.headers.get("Retry-After")).toBe("3600");

		now += 3_599_000;
		expect((await call("POST", "/devices", key.headers, body)).status).toBe(429);
		now += 2_000;
		expect((await call("POST", "/devices", key.headers, body)).status).toBe(200);
	});

	test("the limit is per key: another key registers freely", async () => {
		const owner = await person("rate-per-key");
		const a = await keyFor(owner.id, "rate-a");
		const b = await keyFor(owner.id, "rate-b");
		const body = await deviceBody();
		for (let i = 0; i < DEVICE_REGISTRATIONS_PER_HOUR; i++)
			await call("POST", "/devices", a.headers, body);
		expect((await call("POST", "/devices", a.headers, body)).status).toBe(429);
		expect((await call("POST", "/devices", b.headers, await deviceBody())).status).toBe(201);
	});
});

describe("POST /devices/:id/test budgets", () => {
	async function phones(count: number) {
		const owner = await person(`test-${crypto.randomUUID().slice(0, 6)}`);
		const key = await keyFor(owner.id, `test-key-${crypto.randomUUID().slice(0, 6)}`);
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			service._resetDeviceLimitsForTest();
			ids.push((await json(await call("POST", "/devices", key.headers, await deviceBody()))).id);
		}
		service._resetDeviceLimitsForTest();
		return { owner, key, ids };
	}

	test("the window releases: 59 s later still limited, 61 s later served again", async () => {
		const { key, ids } = await phones(1);
		let now = 5_000_000;
		service._setDeviceLimitClockForTest(() => now);
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE; i++) {
			expect((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status).toBe(503);
		}
		expect((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status).toBe(429);
		now += 59_000;
		expect((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status).toBe(429);
		now += 2_000;
		expect((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status).toBe(503);
	});

	test("the person has a budget of their own across phones: 10 a minute", async () => {
		const { key, ids } = await phones(3);
		let served = 0;
		for (let round = 0; round < DEVICE_TEST_PUSHES_PER_MINUTE; round++) {
			for (const id of ids) {
				if ((await call("POST", `/devices/${id}/test`, key.headers)).status === 503) served++;
			}
		}
		expect(served).toBe(USER_TEST_PUSHES_PER_MINUTE);
		expect((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status).toBe(429);
	});

	test("a request that is refused spends nothing: someone else's phone, a revoked phone, an unknown id", async () => {
		await setStoredMode("team");
		const { key, ids } = await phones(2);
		const stranger = await person("test-stranger");
		const strangerKey = await keyFor(stranger.id, "test-stranger-key");
		await call("DELETE", `/devices/${ids[1]}`, key.headers);

		for (let i = 0; i < 30; i++) {
			expect((await call("POST", `/devices/${ids[0]}/test`, strangerKey.headers)).status).toBe(404);
			expect((await call("POST", `/devices/${ids[1]}/test`, key.headers)).status).toBe(404);
			expect((await call("POST", "/devices/no-such-id/test", key.headers)).status).toBe(404);
		}

		// the owner still has the full budget on the live phone
		const statuses: number[] = [];
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE + 1; i++) {
			statuses.push((await call("POST", `/devices/${ids[0]}/test`, key.headers)).status);
		}
		expect(statuses).toEqual([503, 503, 503, 503, 503, 429]);
	});

	test("a refusal for the person's budget leaves the phone's budget alone", async () => {
		const { key, ids } = await phones(3);
		// spend the person's 10 on two phones, 5 each
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE; i++) {
			await call("POST", `/devices/${ids[0]}/test`, key.headers);
			await call("POST", `/devices/${ids[1]}/test`, key.headers);
		}
		// the third phone is refused for the person's limit, and must not have spent its own
		for (let i = 0; i < 4; i++) {
			expect((await call("POST", `/devices/${ids[2]}/test`, key.headers)).status).toBe(429);
		}
		// the refused attempts spent nothing of the third phone's own five
		let spent = 0;
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE + 1; i++) {
			if (service.tryConsumeDeviceTest(ids[2] as string, `another-person-${i}`)) spent++;
		}
		expect(spent).toBe(DEVICE_TEST_PUSHES_PER_MINUTE);
	});
});

describe("scope and the respond key's reach", () => {
	test("observe and ingest keys are refused on PATCH, DELETE and test as well as on register", async () => {
		const owner = await person("scope-refused");
		const key = await keyFor(owner.id, "scope-refused-key");
		const device = await json(await call("POST", "/devices", key.headers, await deviceBody()));
		for (const scope of ["observe", "ingest"]) {
			const other = await keyFor(owner.id, `scope-${scope}`, [scope]);
			for (const [method, path, body] of [
				["PATCH", `/devices/${device.id}`, { deviceName: "x" }],
				["DELETE", `/devices/${device.id}`, {}],
				["POST", `/devices/${device.id}/test`, {}],
				["GET", "/devices", {}],
			] as const) {
				const res = await call(method, path, other.headers, body);
				expect({ scope, method, status: res.status }).toEqual({ scope, method, status: 403 });
			}
		}
		expect((await rows())[0]?.revokedAt).toBeNull();
	});

	test("team mode: a respond key deletes only its own key's phone, even the same person's other phone", async () => {
		await setStoredMode("team");
		const owner = await person("scope-team");
		const a = await keyFor(owner.id, "scope-team-a");
		const b = await keyFor(owner.id, "scope-team-b");
		const phoneA = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const phoneB = await json(await call("POST", "/devices", b.headers, await deviceBody()));

		const refused = await call("DELETE", `/devices/${phoneB.id}`, a.headers);
		expect(refused.status).toBe(403);
		expect(await json(refused)).toEqual({ error: "own_device_only" });
		expect((await rows()).every((r) => r.revokedAt === null)).toBe(true);

		expect((await call("DELETE", `/devices/${phoneA.id}`, a.headers)).status).toBe(200);
		// a signed-in person may remove either
		expect(
			(await call("DELETE", `/devices/${phoneB.id}`, await cookieHeadersFor(owner.id))).status,
		).toBe(200);
	});

	test("a respond key doesn't revoke another key's access: deleting another key's paired phone needs manage", async () => {
		const owner = await person("scope-paired-other");
		const paired = await pairedKey(owner.id);
		const respond = await keyFor(owner.id, "scope-paired-other-respond");
		const manage = await keyFor(owner.id, "scope-paired-other-manage", ["manage"]);
		const phone = await json(await call("POST", "/devices", asKey(paired.key), await deviceBody()));

		expect((await call("DELETE", `/devices/${phone.id}`, respond.headers)).status).toBe(403);
		const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, paired.keyId));
		expect(key?.isActive).toBe(true);

		const res = await call("DELETE", `/devices/${phone.id}`, manage.headers);
		expect(await json(res)).toEqual({ ok: true, keyRevoked: true });
	});

	test("DELETE is idempotent and finishes the job: a revoked phone whose paired key is somehow still active gets the key revoked", async () => {
		const owner = await person("scope-idem");
		const paired = await pairedKey(owner.id);
		const phone = await json(await call("POST", "/devices", asKey(paired.key), await deviceBody()));
		// the phone was revoked on its own (as a half-finished delete would leave it)
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date().toISOString(), revokedReason: "deleted", sendToken: "" })
			.where(eq(mobileDevices.id, phone.id));

		const res = await call("DELETE", `/devices/${phone.id}`, await cookieHeadersFor(owner.id));

		expect(await json(res)).toEqual({ ok: true, keyRevoked: true });
		const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, paired.keyId));
		expect(key?.isActive).toBe(false);
		const again = await call("DELETE", `/devices/${phone.id}`, await cookieHeadersFor(owner.id));
		expect(await json(again)).toEqual({ ok: true, keyRevoked: false });
	});

	test("a paired-key delete records the reason `deleted`, not key_deactivated", async () => {
		const owner = await person("scope-reason");
		const paired = await pairedKey(owner.id);
		const phone = await json(await call("POST", "/devices", asKey(paired.key), await deviceBody()));
		await call("DELETE", `/devices/${phone.id}`, asKey(paired.key));
		expect((await rows())[0]?.revokedReason).toBe("deleted");
	});
});

describe("who sees which phones", () => {
	test("solo: a respond key sees its own key's phones; a manage key or a person sees all", async () => {
		const owner = await person("vis-solo");
		const other = await person("vis-solo-other");
		const respond = await keyFor(owner.id, "vis-solo-respond");
		const otherRespond = await keyFor(other.id, "vis-solo-other-respond");
		const manage = await keyFor(owner.id, "vis-solo-manage", ["manage"]);
		await call("POST", "/devices", respond.headers, await deviceBody({ deviceName: "mine" }));
		await call(
			"POST",
			"/devices",
			otherRespond.headers,
			await deviceBody({ deviceName: "theirs" }),
		);

		const names = async (h: Headers) =>
			(await json(await call("GET", "/devices", h))).devices.map((d: Json) => d.deviceName).sort();
		expect(await names(respond.headers)).toEqual(["mine"]);
		expect(await names(manage.headers)).toEqual(["mine", "theirs"]);
		expect(await names(await cookieHeadersFor(owner.id))).toEqual(["mine", "theirs"]);
	});

	test("what the list shows is what can be managed: every listed phone can be patched by that caller", async () => {
		const owner = await person("vis-agree");
		const other = await person("vis-agree-other");
		const respond = await keyFor(owner.id, "vis-agree-respond");
		const otherRespond = await keyFor(other.id, "vis-agree-other-respond");
		const manage = await keyFor(owner.id, "vis-agree-manage", ["manage"]);
		await call("POST", "/devices", respond.headers, await deviceBody());
		await call("POST", "/devices", otherRespond.headers, await deviceBody());
		for (const headers of [respond.headers, manage.headers, await cookieHeadersFor(owner.id)]) {
			for (const device of (await json(await call("GET", "/devices", headers))).devices) {
				const res = await call("PATCH", `/devices/${device.id}`, headers, { deviceName: "n" });
				expect(res.status).toBe(200);
			}
		}
	});

	test("switching solo to team: a manage key then sees only its person's phones; back to solo it sees all again", async () => {
		const owner = await person("vis-switch");
		const other = await person("vis-switch-other");
		const manage = await keyFor(owner.id, "vis-switch-manage", ["manage"]);
		const otherKey = await keyFor(other.id, "vis-switch-other-key");
		await call("POST", "/devices", manage.headers, await deviceBody({ deviceName: "mine" }));
		await call("POST", "/devices", otherKey.headers, await deviceBody({ deviceName: "theirs" }));
		const count = async () =>
			(await json(await call("GET", "/devices", manage.headers))).devices.length;

		expect(await count()).toBe(2);
		await setStoredMode("team");
		expect(await count()).toBe(1);
		await setStoredMode("solo");
		expect(await count()).toBe(2);
	});

	test("team: an admin manages a phone registered with an ownerless key", async () => {
		await setStoredMode("team");
		const admin = await person("vis-admin", "admin");
		const loose = await keyFor(null, "vis-admin-loose");
		const phone = await json(await call("POST", "/devices", loose.headers, await deviceBody()));
		const adminHeaders = await cookieHeadersFor(admin.id);
		expect(
			(await call("PATCH", `/devices/${phone.id}`, adminHeaders, { deviceName: "by admin" }))
				.status,
		).toBe(200);
		expect((await call("DELETE", `/devices/${phone.id}`, adminHeaders)).status).toBe(200);
	});
});

describe("field rules", () => {
	async function status(over: Record<string, unknown>) {
		const owner = await person(`field-${crypto.randomUUID().slice(0, 6)}`);
		const key = await keyFor(owner.id, `field-key-${crypto.randomUUID().slice(0, 6)}`);
		const res = await call("POST", "/devices", key.headers, await deviceBody(over));
		return { status: res.status, field: (await json(res)).field as string | undefined };
	}

	test("platform is an allowlist: ios and android only", async () => {
		expect((await status({ platform: "ios" })).status).toBe(201);
		expect((await status({ platform: "android" })).status).toBe(201);
		for (const platform of ["windows", "iOS", "ios ", "macos", "", 5]) {
			expect(await status({ platform })).toEqual({ status: 400, field: "platform" });
		}
	});

	test("environment accepts the contract's three values", async () => {
		for (const environment of ["sandbox", "production", "development"]) {
			expect((await status({ environment })).status).toBe(201);
		}
		expect((await status({ environment: "staging" })).field).toBe("environment");
	});

	const unprintable = [
		"has space",
		"tab\there",
		"new\nline",
		"café",
		"\u0000nul",
		"emoji\u{1F600}",
		"del\u007f",
	];

	test("sendToken is printable ASCII with no spaces", async () => {
		for (const value of unprintable) {
			expect(await status({ sendToken: value })).toEqual({ status: 400, field: "sendToken" });
		}
		expect((await status({ sendToken: "ok-._~+/=:ABC123" })).status).toBe(201);
	});

	test("kid, relayDeviceId and clientServerRef fit the sealed payload's ids: 1 to 64 of A-Z a-z 0-9 . _ : -", async () => {
		// A phone whose ids don't fit could be registered but never pushed to, so registration refuses it.
		for (const field of ["kid", "relayDeviceId", "clientServerRef"]) {
			for (const value of [...unprintable, "a|b", "a/b", "tilde~", "x".repeat(65)]) {
				expect(await status({ [field]: value })).toEqual({ status: 400, field });
			}
			expect((await status({ [field]: "ok-._:ABC123" })).status).toBe(201);
			expect((await status({ [field]: "x".repeat(64) })).status).toBe(201);
		}
	}, 60_000);
	test("prefs follow the DevicePrefs contract", async () => {
		const good: unknown[] = [
			{},
			{ showContent: false, includeAgentText: true },
			{ quietHours: { enabled: true, start: "22:00", end: "07:30" } },
			{ categories: { NEEDS_YOU_TURN: true, SESSION_FAILED: false } },
			{ timezone: "Europe/Berlin", digestHour: 0 },
			{ digestHour: 23, lastDigestDate: "2026-10-17" },
			{ somethingNew: { nested: [1, 2] } }, // additionalProperties stays open
		];
		for (const prefs of good)
			expect({ prefs, ...(await status({ prefs })) }).toMatchObject({ status: 201 });
		const bad: unknown[] = [
			{ showContent: "yes" },
			{ includeAgentText: 1 },
			{ quietHours: true },
			{ quietHours: { enabled: true } },
			{ quietHours: { enabled: true, start: "25:00", end: "07:00" } },
			{ quietHours: { enabled: true, start: "22:00", end: "7:00" } },
			{ quietHours: { enabled: "on", start: "22:00", end: "07:00" } },
			{ categories: [] },
			{ categories: { NEEDS_YOU_TURN: "yes" } },
			{ categories: { "not a category": true } },
			{ categories: { lowercase: true } },
			{ timezone: "Mars/Olympus" },
			{ timezone: 5 },
			{ digestHour: 24 },
			{ digestHour: -1 },
			{ digestHour: 7.5 },
			{ digestHour: "7" },
			{ lastDigestDate: "17-10-2026" },
			{ lastDigestDate: 20261017 },
		];
		for (const prefs of bad) {
			expect({ prefs, ...(await status({ prefs })) }).toMatchObject({
				status: 400,
				field: "prefs",
			});
		}
	});

	test("too many categories are refused", async () => {
		const categories = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`CAT_${i}`, true]));
		expect((await status({ prefs: { categories } })).field).toBe("prefs");
	});

	test("PATCH applies the same prefs rules", async () => {
		const owner = await person("field-patch");
		const key = await keyFor(owner.id, "field-patch-key");
		const device = await json(await call("POST", "/devices", key.headers, await deviceBody()));
		const bad = await call("PATCH", `/devices/${device.id}`, key.headers, {
			prefs: { digestHour: 99 },
		});
		expect(bad.status).toBe(400);
		expect((await json(bad)).field).toBe("prefs");
		const good = await call("PATCH", `/devices/${device.id}`, key.headers, {
			prefs: { digestHour: 8 },
		});
		expect(good.status).toBe(200);
	});
});

describe("the public key", () => {
	const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
	const be32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
	const point = (prefix: number, x: Buffer, y: Buffer) =>
		Buffer.concat([Buffer.from([prefix]), x, y]).toString("base64url");

	async function field(publicKey: string) {
		const owner = await person(`pk-${crypto.randomUUID().slice(0, 6)}`);
		const key = await keyFor(owner.id, `pk-key-${crypto.randomUUID().slice(0, 6)}`);
		const res = await call("POST", "/devices", key.headers, await deviceBody({ publicKey }));
		return { status: res.status, field: (await json(res)).field as string | undefined };
	}

	test("a real point is accepted", async () => {
		expect((await field(await p256PublicKey())).status).toBe(201);
	});

	test("65 bytes with any prefix but 0x04 are refused (0x00, 0x02, 0x03, 0x06, 0x07)", async () => {
		const real = Buffer.from(await p256PublicKey(), "base64url");
		for (const prefix of [0x00, 0x02, 0x03, 0x06, 0x07]) {
			const body = Buffer.from(real);
			body[0] = prefix;
			expect({ prefix, ...(await field(body.toString("base64url"))) }).toEqual({
				prefix,
				status: 400,
				field: "publicKey",
			});
		}
	});

	test("0x04 with an all-zero body, with (0,0), and with coordinates at or above the field prime are refused", async () => {
		const zero = Buffer.alloc(32);
		const real = Buffer.from(await p256PublicKey(), "base64url");
		const x = real.subarray(1, 33);
		const y = real.subarray(33, 65);
		const cases: Record<string, string> = {
			"all zero": point(0x04, zero, zero),
			"(0,0)": point(0x04, zero, zero),
			"x = p": point(0x04, be32(P), y),
			"x = p + 1": point(0x04, be32(P + 1n), y),
			"y = p": point(0x04, x, be32(P)),
			"y = 2^256 - 1": point(0x04, x, be32((1n << 256n) - 1n)),
			"x and y = p": point(0x04, be32(P), be32(P)),
			"x = 1, y = 1 (off the curve)": point(0x04, be32(1n), be32(1n)),
		};
		for (const [name, publicKey] of Object.entries(cases)) {
			expect({ name, ...(await field(publicKey)) }).toEqual({
				name,
				status: 400,
				field: "publicKey",
			});
		}
	});
});
