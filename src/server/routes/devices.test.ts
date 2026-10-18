/**
 * POST/GET/PATCH/DELETE /devices and /devices/:id/test: registering a phone,
 * who may see and change it, what the answers never carry, and what deleting
 * one does to its key.
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
const { apiKeys, mobileDevices, pairingCodes } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { _resetDeviceLimitsForTest, DEVICE_TEST_PUSHES_PER_MINUTE, readSendToken } = await import(
	"../services/mobile-devices-service.js"
);
const { _resetPairingLimiterForTest } = await import("../services/pairing-service.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await getDb().delete(mobileDevices);
	await getDb().delete(pairingCodes);
	await resetIdentityState();
	await clearInstanceSettings();
	_resetDeviceLimitsForTest();
	_resetPairingLimiterForTest();
}
beforeEach(reset);
afterEach(reset);

type DeviceJson = Record<string, any>;
const json = async (res: Response) => (await res.json()) as DeviceJson;
const call = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

async function alice() {
	const user = await seedLocalUser("dev-alice");
	const key = await seedKey("dev-alice-respond", ["respond"], user.id);
	return { user, key, headers: asKey(key.key) };
}

describe("registering a phone", () => {
	test("a respond key registers: 201, the phone's fields back, and no push credential", async () => {
		const a = await alice();
		const body = await deviceBody();
		const res = await call("POST", "/devices", a.headers, body);

		expect(res.status).toBe(201);
		const device = await json(res);
		expect(device).toMatchObject({
			platform: "ios",
			environment: "sandbox",
			relayDeviceId: body.relayDeviceId,
			kid: body.kid,
			deviceName: "Test Phone",
			appVersion: "1.0.0",
			osVersion: "26.3",
			prefs: { showContent: true, quietHours: { enabled: false, start: "22:00", end: "07:00" } },
			paired: false,
		});
		const text = JSON.stringify(device);
		expect(text).not.toContain(body.sendToken as string);
		expect(text).not.toContain(body.publicKey as string);
		expect(Object.keys(device)).not.toContain("sendToken");
		expect(Object.keys(device)).not.toContain("publicKey");
		expect(Object.keys(device)).not.toContain("apiKeyId");
	});

	test("api_key_id is the calling key and user_id its owner", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, device.id));
		expect(row?.apiKeyId).toBe(a.key.id);
		expect(row?.userId).toBe(a.user.id);
		expect(row?.revokedAt).toBeNull();
	});

	test("registering again is an update: 200, the same id, new values", async () => {
		const a = await alice();
		const body = await deviceBody();
		const first = await json(await call("POST", "/devices", a.headers, body));
		const second = await call("POST", "/devices", a.headers, {
			...body,
			deviceName: "Renamed",
			sendToken: "a-new-token",
			kid: "kid-rotated",
		});
		expect(second.status).toBe(200);
		const device = await json(second);
		expect(device.id).toBe(first.id);
		expect(device).toMatchObject({ deviceName: "Renamed", kid: "kid-rotated" });
		const [row] = await getDb().select().from(mobileDevices);
		expect(readSendToken(row as never)).toBe("a-new-token");
		expect((await getDb().select().from(mobileDevices)).length).toBe(1);
	});

	test("two registrations racing for the same phone make one row", async () => {
		const a = await alice();
		const body = await deviceBody();
		const results = await Promise.all([
			call("POST", "/devices", a.headers, body),
			call("POST", "/devices", a.headers, body),
			call("POST", "/devices", a.headers, body),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
		expect((await getDb().select().from(mobileDevices)).length).toBe(1);
	});

	test("another user registering the same phone is refused with 409 and the row is untouched", async () => {
		const a = await alice();
		const bob = await seedLocalUser("dev-bob");
		const bobKey = await seedKey("dev-bob-respond", ["respond"], bob.id);
		const body = await deviceBody();
		await call("POST", "/devices", a.headers, body);

		const res = await call("POST", "/devices", asKey(bobKey.key), {
			...body,
			deviceName: "Stolen",
		});

		expect(res.status).toBe(409);
		expect(await json(res)).toEqual({ error: "device_owned" });
		const [row] = await getDb().select().from(mobileDevices);
		expect(row?.userId).toBe(a.user.id);
		expect(row?.deviceName).toBe("Test Phone");
	});

	test("two different ownerless keys are not the same person: the second is refused", async () => {
		const k1 = await seedKey("dev-loose-1", ["respond"], null);
		const k2 = await seedKey("dev-loose-2", ["respond"], null);
		const body = await deviceBody();
		expect((await call("POST", "/devices", asKey(k1.key), body)).status).toBe(201);
		expect((await call("POST", "/devices", asKey(k2.key), body)).status).toBe(409);
		expect((await call("POST", "/devices", asKey(k1.key), body)).status).toBe(200);
	});

	test("a manage key may register; observe and ingest keys and no credential may not", async () => {
		const owner = await seedLocalUser("dev-scopes");
		const manage = await seedKey("dev-manage", ["manage"], owner.id);
		expect((await call("POST", "/devices", asKey(manage.key), await deviceBody())).status).toBe(
			201,
		);
		for (const scope of ["observe", "ingest"]) {
			const k = await seedKey(`dev-${scope}`, [scope], owner.id);
			const res = await call("POST", "/devices", asKey(k.key), await deviceBody());
			expect({ scope, status: res.status }).toEqual({ scope, status: 403 });
		}
		expect(
			(await app.request("/api/v1/devices", jsonRequest("POST", await deviceBody()))).status,
		).toBe(401);
	});

	test("a browser session has no key to bind a phone to: 400 key_required", async () => {
		const user = await seedLocalUser("dev-cookie");
		const res = await call("POST", "/devices", await cookieHeadersFor(user.id), await deviceBody());
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ error: "key_required" });
	});

	test("a foreign Origin is refused", async () => {
		const a = await alice();
		const headers = new Headers(a.headers);
		headers.set("Origin", "https://evil.example");
		expect((await call("POST", "/devices", headers, await deviceBody())).status).toBe(403);
	});

	test("the send token is never logged", async () => {
		const lines: string[] = [];
		const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		const log = spyOn(console, "log").mockImplementation(capture);
		const error = spyOn(console, "error").mockImplementation(capture);
		const warn = spyOn(console, "warn").mockImplementation(capture);
		try {
			const a = await alice();
			const body = await deviceBody();
			await call("POST", "/devices", a.headers, body);
			await call("POST", "/devices", a.headers, { ...body, publicKey: "garbage" });
			await call("GET", "/devices", a.headers);
			expect(lines.join("\n")).not.toContain(body.sendToken as string);
		} finally {
			log.mockRestore();
			error.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("validation", () => {
	async function firstBadField(over: Record<string, unknown>) {
		const a = await alice();
		const res = await call("POST", "/devices", a.headers, await deviceBody(over));
		return {
			status: res.status,
			body: await json(res),
			count: (await getDb().select().from(mobileDevices)).length,
		};
	}

	async function badPoints() {
		const good = await p256PublicKey();
		const raw = Buffer.from(good, "base64url");
		const offCurve = Buffer.from(raw);
		offCurve[40] = (offCurve[40] as number) ^ 1;
		const compressed = Buffer.from(raw.subarray(0, 33));
		compressed[0] = 2;
		const wrongPrefix = Buffer.from(raw);
		wrongPrefix[0] = 5;
		return {
			"a point off the curve": offCurve.toString("base64url"),
			"a compressed point": compressed.toString("base64url"),
			"an uncompressed point with the wrong prefix": wrongPrefix.toString("base64url"),
			"a short key": raw.subarray(0, 64).toString("base64url"),
			"a long key": Buffer.concat([raw, Buffer.from([0])]).toString("base64url"),
			"not base64url": `${good.slice(0, 80)}!!!`,
			"standard base64 with padding": raw.toString("base64"),
			"the empty string": "",
		};
	}

	test("the public key must be an uncompressed P-256 point on the curve: every other shape is refused and nothing is stored", async () => {
		for (const [name, publicKey] of Object.entries(await badPoints())) {
			const r = await firstBadField({ publicKey });
			expect({ name, status: r.status, field: r.body.field, count: r.count }).toEqual({
				name,
				status: 400,
				field: "publicKey",
				count: 0,
			});
		}
		for (const publicKey of [undefined, null, 5, {}, []]) {
			expect((await firstBadField({ publicKey })).body.field).toBe("publicKey");
		}
	});

	test("every required field is checked and named", async () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["platform", { platform: "iOS 26" }],
			["platform", { platform: undefined }],
			["environment", { environment: "staging" }],
			["environment", { environment: undefined }],
			["relayDeviceId", { relayDeviceId: "" }],
			["relayDeviceId", { relayDeviceId: "has space" }],
			["relayDeviceId", { relayDeviceId: "x".repeat(129) }],
			["sendToken", { sendToken: "" }],
			["sendToken", { sendToken: "t".repeat(513) }],
			["sendToken", { sendToken: 5 }],
			["kid", { kid: "k".repeat(65) }],
			["clientServerRef", { clientServerRef: "" }],
			["deviceName", { deviceName: "‮​" }],
			["deviceName", { deviceName: 5 }],
			["prefs", { prefs: [] }],
			["prefs", { prefs: "x" }],
			["prefs", { prefs: { blob: "x".repeat(5000) } }],
		];
		for (const [field, over] of cases) {
			const r = await firstBadField(over);
			expect({ field, over: Object.keys(over), got: r.body.field, status: r.status }).toEqual({
				field,
				over: Object.keys(over),
				got: field,
				status: 400,
			});
		}
	});

	test("hidden formatting is stripped from names and versions", async () => {
		const a = await alice();
		const res = await call(
			"POST",
			"/devices",
			a.headers,
			await deviceBody({ deviceName: "Ph‮one​", appVersion: "1.​0" }),
		);
		expect(await json(res)).toMatchObject({ deviceName: "Phone", appVersion: "1.0" });
	});

	test("a body that isn't JSON or is far too large is a 400, not a crash", async () => {
		const a = await alice();
		const notJson = await app.request("/api/v1/devices", {
			method: "POST",
			headers: a.headers,
			body: "not json",
		});
		expect(notJson.status).toBe(400);
		const big = await call("POST", "/devices", a.headers, {
			...(await deviceBody()),
			pad: "x".repeat(40_000),
		});
		expect(big.status).toBe(400);
	});

	test("optional fields may be omitted", async () => {
		const a = await alice();
		const body = await deviceBody();
		for (const key of ["deviceName", "appVersion", "osVersion", "prefs"]) delete body[key];
		const res = await call("POST", "/devices", a.headers, body);
		expect(res.status).toBe(201);
		expect(await json(res)).toMatchObject({
			deviceName: null,
			appVersion: null,
			osVersion: null,
			prefs: null,
		});
	});
});

describe("listing and owner isolation", () => {
	test("GET /devices is the caller's own live phones and nobody else's", async () => {
		await setStoredMode("team");
		const a = await alice();
		const bob = await seedLocalUser("dev-bob-list");
		const bobKey = await seedKey("dev-bob-list-key", ["respond"], bob.id);
		await call("POST", "/devices", a.headers, await deviceBody({ deviceName: "A1" }));
		await call("POST", "/devices", a.headers, await deviceBody({ deviceName: "A2" }));
		await call("POST", "/devices", asKey(bobKey.key), await deviceBody({ deviceName: "B1" }));

		const mine = await json(await call("GET", "/devices", a.headers));
		expect(mine.devices.map((d: DeviceJson) => d.deviceName)).toEqual(["A1", "A2"]);
		const theirs = await json(await call("GET", "/devices", asKey(bobKey.key)));
		expect(theirs.devices.map((d: DeviceJson) => d.deviceName)).toEqual(["B1"]);
		for (const device of mine.devices) {
			expect(Object.keys(device)).not.toContain("sendToken");
		}
	});

	test("a signed-in person sees the phones of their user, whichever key registered them", async () => {
		const a = await alice();
		await call("POST", "/devices", a.headers, await deviceBody());
		const res = await call("GET", "/devices", await cookieHeadersFor(a.user.id));
		expect((await json(res)).devices).toHaveLength(1);
	});

	test("an observe key can't list", async () => {
		const owner = await seedLocalUser("dev-observe");
		const k = await seedKey("dev-observe-key", ["observe"], owner.id);
		expect((await call("GET", "/devices", asKey(k.key))).status).toBe(403);
	});

	test("a revoked phone is no longer listed", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		await call("DELETE", `/devices/${device.id}`, a.headers);
		expect((await json(await call("GET", "/devices", a.headers))).devices).toEqual([]);
	});

	test("team mode: someone else's phone answers 404 to change, delete and test; an admin may change and delete it", async () => {
		await setStoredMode("team");
		const a = await alice();
		const bob = await seedLocalUser("dev-bob-team");
		const bobKey = await seedKey("dev-bob-team-key", ["respond"], bob.id);
		const admin = await seedLocalUser("dev-admin", "admin");
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const other = asKey(bobKey.key);

		expect(
			(await call("PATCH", `/devices/${device.id}`, other, { deviceName: "mine now" })).status,
		).toBe(404);
		expect((await call("POST", `/devices/${device.id}/test`, other)).status).toBe(404);
		expect((await call("DELETE", `/devices/${device.id}`, other)).status).toBe(404);
		expect((await call("PATCH", `/devices/${device.id}`, other, { deviceName: "x" })).status).toBe(
			404,
		);
		const [untouched] = await getDb().select().from(mobileDevices);
		expect(untouched?.deviceName).toBe("Test Phone");
		expect(untouched?.revokedAt).toBeNull();

		const adminHeaders = await cookieHeadersFor(admin.id);
		expect(
			(await call("PATCH", `/devices/${device.id}`, adminHeaders, { deviceName: "by admin" }))
				.status,
		).toBe(200);
		expect((await call("DELETE", `/devices/${device.id}`, adminHeaders)).status).toBe(200);
	});

	test("team mode: an ownerless key manages its own phone and no one else's", async () => {
		await setStoredMode("team");
		const k1 = await seedKey("dev-team-loose-1", ["respond"], null);
		const k2 = await seedKey("dev-team-loose-2", ["respond"], null);
		const device = await json(await call("POST", "/devices", asKey(k1.key), await deviceBody()));
		expect(
			(await call("PATCH", `/devices/${device.id}`, asKey(k1.key), { deviceName: "mine" })).status,
		).toBe(200);
		expect(
			(await call("PATCH", `/devices/${device.id}`, asKey(k2.key), { deviceName: "not mine" }))
				.status,
		).toBe(404);
	});

	test("solo mode: a manage key or a signed-in person manages any phone; a respond key only the phones of its own key", async () => {
		const a = await alice();
		const bob = await seedLocalUser("dev-bob-solo");
		const bobRespond = await seedKey("dev-bob-solo-respond", ["respond"], bob.id);
		const bobManage = await seedKey("dev-bob-solo-manage", ["manage"], bob.id);
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));

		const asRespond = asKey(bobRespond.key);
		expect(
			(await call("PATCH", `/devices/${device.id}`, asRespond, { deviceName: "no" })).status,
		).toBe(403);
		expect((await call("POST", `/devices/${device.id}/test`, asRespond)).status).toBe(403);
		expect((await call("DELETE", `/devices/${device.id}`, asRespond)).status).toBe(403);
		expect(await json(await call("DELETE", `/devices/${device.id}`, asRespond))).toEqual({
			error: "own_device_only",
		});

		expect(
			(await call("PATCH", `/devices/${device.id}`, asKey(bobManage.key), { deviceName: "shared" }))
				.status,
		).toBe(200);
		expect(
			(
				await call("PATCH", `/devices/${device.id}`, await cookieHeadersFor(bob.id), {
					deviceName: "dash",
				})
			).status,
		).toBe(200);
	});

	test("an unknown id is a 404", async () => {
		const a = await alice();
		expect((await call("PATCH", "/devices/no-such", a.headers, { deviceName: "x" })).status).toBe(
			404,
		);
		expect((await call("DELETE", "/devices/no-such", a.headers)).status).toBe(404);
	});
});

describe("PATCH /devices/:id", () => {
	test("renames and replaces prefs", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const res = await call("PATCH", `/devices/${device.id}`, a.headers, {
			deviceName: "Kitchen iPhone",
			prefs: { quietHours: { enabled: true, start: "21:00", end: "06:30" }, digestHour: 8 },
		});
		expect(res.status).toBe(200);
		expect(await json(res)).toMatchObject({
			deviceName: "Kitchen iPhone",
			prefs: { quietHours: { enabled: true, start: "21:00", end: "06:30" }, digestHour: 8 },
		});
	});

	test("an empty body, a bad name and bad prefs are 400", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		for (const body of [
			{},
			{ deviceName: "" },
			{ deviceName: 3 },
			{ prefs: [] },
			{ prefs: null },
		]) {
			const res = await call("PATCH", `/devices/${device.id}`, a.headers, body);
			expect({ body, status: res.status }).toEqual({ body, status: 400 });
		}
	});

	test("a revoked phone can't be changed", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		await call("DELETE", `/devices/${device.id}`, a.headers);
		expect(
			(await call("PATCH", `/devices/${device.id}`, a.headers, { deviceName: "x" })).status,
		).toBe(404);
	});
});

describe("DELETE /devices/:id", () => {
	test("a phone paired with a code: deleting it deactivates the key the pairing produced", async () => {
		const owner = await seedLocalUser("dev-del-paired");
		const paired = await pairedKey(owner.id);
		const device = await json(
			await call("POST", "/devices", asKey(paired.key), await deviceBody()),
		);
		expect(device.paired).toBe(true);

		const res = await call("DELETE", `/devices/${device.id}`, asKey(paired.key));

		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ ok: true, keyRevoked: true });
		const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, paired.keyId));
		expect(key?.isActive).toBe(false);
		const [row] = await getDb().select().from(mobileDevices);
		expect(row?.revokedAt).not.toBeNull();
		expect(row?.revokedReason).toBe("deleted");
	});

	test("a phone using a pasted personal key: deleting it never touches the key", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		expect(device.paired).toBe(false);

		const res = await call("DELETE", `/devices/${device.id}`, a.headers);

		expect(await json(res)).toEqual({ ok: true, keyRevoked: false });
		const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, a.key.id));
		expect(key?.isActive).toBe(true);
		const [row] = await getDb().select().from(mobileDevices);
		expect(row?.revokedAt).not.toBeNull();
		expect(row?.revokedReason).toBe("deleted");
		// and the key still works
		expect((await call("GET", "/devices", a.headers)).status).toBe(200);
	});

	test("a manage key that registers a phone is likewise left alone unless a code made it", async () => {
		const owner = await seedLocalUser("dev-del-manage");
		const manage = await seedKey("dev-del-manage-key", ["manage"], owner.id);
		const device = await json(
			await call("POST", "/devices", asKey(manage.key), await deviceBody()),
		);
		await call("DELETE", `/devices/${device.id}`, asKey(manage.key));
		const [key] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, manage.id));
		expect(key?.isActive).toBe(true);
	});

	test("deleting twice is fine and answers keyRevoked false the second time", async () => {
		const owner = await seedLocalUser("dev-del-twice");
		const paired = await pairedKey(owner.id);
		const headers = asKey(paired.key);
		const device = await json(await call("POST", "/devices", headers, await deviceBody()));
		expect((await json(await call("DELETE", `/devices/${device.id}`, headers))).keyRevoked).toBe(
			true,
		);
		// the key is dead now, so a second delete from this key is a 401: ask as the owner instead
		const asOwner = await cookieHeadersFor(owner.id);
		const again = await call("DELETE", `/devices/${device.id}`, asOwner);
		expect(again.status).toBe(200);
		expect(await json(again)).toEqual({ ok: true, keyRevoked: false });
	});

	test("the person who owns the phone can delete it from the dashboard, revoking a paired key", async () => {
		const owner = await seedLocalUser("dev-del-dash");
		const paired = await pairedKey(owner.id);
		const device = await json(
			await call("POST", "/devices", asKey(paired.key), await deviceBody()),
		);
		const res = await call("DELETE", `/devices/${device.id}`, await cookieHeadersFor(owner.id));
		expect(await json(res)).toEqual({ ok: true, keyRevoked: true });
	});

	test("pairing provenance is set at registration and kept when the phone registers again", async () => {
		const owner = await seedLocalUser("dev-prov");
		const paired = await pairedKey(owner.id);
		const body = await deviceBody();
		await call("POST", "/devices", asKey(paired.key), body);
		const [first] = await getDb().select().from(mobileDevices);
		const [code] = await getDb().select().from(pairingCodes);
		expect(first?.pairedViaCodeId).toBe(code?.id);

		await call("POST", "/devices", asKey(paired.key), { ...body, deviceName: "again" });
		const [second] = await getDb().select().from(mobileDevices);
		expect(second?.pairedViaCodeId).toBe(code?.id);
	});
});

describe("POST /devices/:id/test", () => {
	test("is limited to five a minute per phone; until push is wired the answer is 503", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const statuses: number[] = [];
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE + 1; i++) {
			statuses.push((await call("POST", `/devices/${device.id}/test`, a.headers)).status);
		}
		expect(statuses).toEqual([503, 503, 503, 503, 503, 429]);
		const limited = await call("POST", `/devices/${device.id}/test`, a.headers);
		expect(limited.headers.get("Retry-After")).toBe("60");
	});

	test("the limit is per phone", async () => {
		const a = await alice();
		const one = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		const two = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		for (let i = 0; i < DEVICE_TEST_PUSHES_PER_MINUTE; i++) {
			await call("POST", `/devices/${one.id}/test`, a.headers);
		}
		expect((await call("POST", `/devices/${one.id}/test`, a.headers)).status).toBe(429);
		expect((await call("POST", `/devices/${two.id}/test`, a.headers)).status).toBe(503);
	});

	test("a revoked phone is a 404", async () => {
		const a = await alice();
		const device = await json(await call("POST", "/devices", a.headers, await deviceBody()));
		await call("DELETE", `/devices/${device.id}`, a.headers);
		expect((await call("POST", `/devices/${device.id}/test`, a.headers)).status).toBe(404);
	});
});

describe("re-registering after a phone was removed", () => {
	test("the key that removed it can't register it again: 409 device_removed, the phone stays revoked", async () => {
		const a = await alice();
		const body = await deviceBody();
		const first = await json(await call("POST", "/devices", a.headers, body));
		await call("DELETE", `/devices/${first.id}`, a.headers);

		const res = await call("POST", "/devices", a.headers, body);

		expect(res.status).toBe(409);
		expect(await json(res)).toEqual({ error: "device_removed" });
		const [row] = await getDb().select().from(mobileDevices);
		expect(row?.revokedAt).not.toBeNull();
		expect((await json(await call("GET", "/devices", a.headers))).devices).toEqual([]);
	});

	test("a different key of the same person (newly paired or pasted) may register it: the row is reset and listed again", async () => {
		const a = await alice();
		const body = await deviceBody();
		const first = await json(await call("POST", "/devices", a.headers, body));
		await call("DELETE", `/devices/${first.id}`, a.headers);
		const next = await seedKey("dev-alice-next", ["respond"], a.user.id);

		const res = await call("POST", "/devices", asKey(next.key), { ...body, deviceName: "Fresh" });

		expect(res.status).toBe(200);
		expect((await json(res)).id).toBe(first.id);
		const [row] = await getDb().select().from(mobileDevices);
		expect(row?.revokedAt).toBeNull();
		expect(row?.apiKeyId).toBe(next.id);
		expect((await json(await call("GET", "/devices", asKey(next.key)))).devices).toHaveLength(1);
	});
});
