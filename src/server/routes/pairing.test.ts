/**
 * Mobile pairing end to end: a signed-in person mints a single-use code, a
 * phone redeems it (no credential but the code) for a key owned by that person.
 * Drives the real routes; the clock, the sleep and the limiter are injected where
 * a test needs a time or a population the wall clock can't give.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const dbClient = await import("../db/client.js");
const { config } = await import("../config.js");
const { apiKeys, authSessions, pairingCodes, users } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const apiKeyModule = await import("../auth/api-key.js");
const pairing = await import("../services/pairing-service.js");
const { SESSION_COOKIE_NAME, revokeSessionByToken } = await import(
	"../services/local-auth-service.js"
);
const { deleteExpiredPairingCodes, runRetentionPass, PAIRING_CODE_GRACE_MS } = await import(
	"../services/retention-service.js"
);
const { upsertSetting } = await import("../services/settings-service.js");
const { _resetKeyMintLimitForTest } = await import("../services/key-mint-limit.js");

const {
	PAIRING_CODE_LENGTH,
	PAIRING_CODE_TTL_MS,
	PAIRING_FAILURES_GLOBAL,
	PAIRING_FAILURES_PER_IP,
	PAIRING_TARPIT_MAX_HELD,
	PAIRING_TARPIT_MS,
	PairingLimiter,
	hashPairingCode,
	mintPairingCode,
	normalizePairingCode,
	redeemPairingCode,
	InvalidPairingCodeError,
} = pairing;

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(pairingCodes);
	pairing._resetPairingLimiterForTest();
	_resetKeyMintLimitForTest();
}
beforeEach(reset);
afterEach(reset);

const T0 = new Date("2026-10-01T12:00:00.000Z");
const at = (secondsAfter: number) => new Date(T0.getTime() + secondsAfter * 1000);
const fill = (char: string) => char.repeat(PAIRING_CODE_LENGTH);

async function person(label = "pair-user", role: "user" | "admin" = "user") {
	const user = await seedLocalUser(label, role);
	const headers = await cookieHeadersFor(user.id);
	const token = (headers.get("Cookie") ?? "").split("=")[1] as string;
	return { user, headers, token };
}

async function mint(headers: Headers, body: unknown = { access: "respond" }) {
	return app.request("/api/v1/pairing-codes", jsonRequest("POST", body, headers));
}

async function redeemOverHttp(
	code: unknown,
	extra: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	const request = jsonRequest("POST", {
		code,
		deviceName: "Test Phone",
		platform: "ios",
		...extra,
	});
	const merged = new Headers(request.headers);
	for (const [name, value] of Object.entries(headers)) merged.set(name, value);
	return app.request("/api/v1/pair", { ...request, headers: merged });
}

type Minted = { id: string; code: string; expiresAt: string };
async function mintedFor(headers: Headers, body?: unknown): Promise<Minted> {
	const res = await mint(headers, body);
	expect(res.status).toBe(201);
	return (await res.json()) as Minted;
}

/** Plant a code with a known value, bypassing the generator. */
async function plant(code: string, over: Partial<typeof pairingCodes.$inferInsert> = {}) {
	await getDb()
		.insert(pairingCodes)
		.values({
			codeHash: await hashPairingCode(code),
			userId: null,
			access: "respond",
			createdAt: T0.toISOString(),
			expiresAt: new Date(T0.getTime() + PAIRING_CODE_TTL_MS).toISOString(),
			...over,
		});
}

/** Waits for a condition, polling until a deadline: lookups go through a connection pool, so how long they take is not the test's to guess. */
async function until(condition: () => boolean, what: string, deadlineMs = 15_000): Promise<void> {
	const stop = Date.now() + deadlineMs;
	while (!condition()) {
		if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const future = () => new Date(Date.now() + 60_000).toISOString();

async function keyRow(keyId: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, keyId));
	return row;
}

describe("happy path", () => {
	test("mint -> redeem -> the key works, belongs to the minter, and is the scope asked for", async () => {
		const { user, headers } = await person();
		const res = await mint(headers, { access: "respond", deviceLabel: "Kitchen phone" });
		expect(res.status).toBe(201);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const minted = (await res.json()) as Minted;
		expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
		expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(PAIRING_CODE_TTL_MS - 5000);

		const paired = await redeemOverHttp(minted.code);
		expect(paired.status).toBe(201);
		expect(paired.headers.get("Cache-Control")).toBe("no-store");
		const body = (await paired.json()) as Record<string, unknown>;
		// the response is the key, its id and its scopes, and nothing about who owns it
		expect(Object.keys(body).sort()).toEqual(["key", "keyId", "scopes"]);
		expect(body.scopes).toEqual(["respond"]);
		expect((body.key as string).startsWith("ap_")).toBe(true);

		const row = await keyRow(body.keyId as string);
		expect(row?.ownerUserId).toBe(user.id);
		expect(row?.createdByUserId).toBe(user.id);
		expect(row?.isActive).toBe(true);

		const asPhone = await app.request("/api/v1/capabilities", {
			headers: bearerHeaders(body.key as string),
		});
		expect(asPhone.status).toBe(200);
	});

	test('the stored scopes are exactly ["respond"] for respond and ["manage"] for full', async () => {
		const { headers } = await person();
		const respond = (await (await redeemOverHttp((await mintedFor(headers)).code)).json()) as {
			keyId: string;
		};
		const full = (await (
			await redeemOverHttp((await mintedFor(headers, { access: "full" })).code)
		).json()) as { keyId: string };
		expect((await keyRow(respond.keyId))?.scopes).toBe('["respond"]');
		expect((await keyRow(full.keyId))?.scopes).toBe('["manage"]');
	});

	test("a paired respond key can't mint another pairing code; a paired manage key can", async () => {
		const { headers } = await person();
		const respond = (await (await redeemOverHttp((await mintedFor(headers)).code)).json()) as {
			key: string;
		};
		const full = (await (
			await redeemOverHttp((await mintedFor(headers, { access: "full" })).code)
		).json()) as { key: string };

		const asRespond = await mint(
			bearerHeaders(respond.key, { "Content-Type": "application/json" }),
			{
				access: "respond",
			},
		);
		expect(asRespond.status).toBe(403);
		const asFull = await mint(bearerHeaders(full.key, { "Content-Type": "application/json" }), {
			access: "respond",
		});
		expect(asFull.status).toBe(201);
	});

	test("a second redemption of the same code is the same 400 as a wrong code", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		expect((await redeemOverHttp(minted.code)).status).toBe(201);

		const reuse = await redeemOverHttp(minted.code);
		const wrong = await redeemOverHttp(fill("Z"));
		for (const res of [reuse, wrong]) {
			expect(res.status).toBe(400);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(await res.json()).toEqual({ error: "invalid_code" });
		}
	});

	test("an expired code is the same 400 with the same headers", async () => {
		await plant(fill("A"), { expiresAt: new Date(Date.now() - 1000).toISOString() });
		const res = await redeemOverHttp(fill("A"));
		expect(res.status).toBe(400);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	test("every kind of failure is that one body: malformed code, missing name, bad platform, non-JSON, oversize", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		const attempts: Array<Response | Promise<Response>> = [
			redeemOverHttp(12345),
			redeemOverHttp(null),
			redeemOverHttp("short"),
			redeemOverHttp("ABCDEFGH23"), // the old 10-character length
			redeemOverHttp(minted.code, { deviceName: "" }),
			redeemOverHttp(minted.code, { deviceName: 42 }),
			redeemOverHttp(minted.code, { deviceName: "‮​" }), // nothing left once hidden characters go
			redeemOverHttp(minted.code, { platform: "IOS; DROP" }),
			redeemOverHttp(minted.code, { platform: undefined }),
			app.request("/api/v1/pair", { method: "POST", body: "not json" }),
			app.request("/api/v1/pair", jsonRequest("POST", { code: "x".repeat(8000) })),
			redeemOverHttp(minted.code, { padding: "x".repeat(6000) }),
		];
		for (const res of await Promise.all(attempts)) {
			expect(res.status).toBe(400);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(await res.json()).toEqual({ error: "invalid_code" });
		}
		// none of those redeemed the real code (a dozen failures from one client use its allowance up, so start afresh)
		pairing._resetPairingLimiterForTest();
		expect((await redeemOverHttp(minted.code)).status).toBe(201);
	});

	test("the dashboard prefix redeems too", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		const res = await app.request(
			"/app-api/v1/pair",
			jsonRequest("POST", { code: minted.code, deviceName: "p", platform: "ios" }),
		);
		expect(res.status).toBe(201);
	});
});

describe("expiry", () => {
	test("valid at 299 s, gone at 300 s and 301 s", async () => {
		const owner = await seedLocalUser("ttl-owner");
		const outcomes: Record<number, string> = {};
		for (const seconds of [299, 300, 301]) {
			const minted = await mintPairingCode({ userId: owner.id, access: "respond", now: T0 });
			try {
				await redeemPairingCode({
					code: minted.code,
					deviceName: "p",
					platform: "ios",
					ip: `203.0.113.${seconds % 250}`,
					now: at(seconds),
				});
				outcomes[seconds] = "redeemed";
			} catch (err) {
				outcomes[seconds] = err instanceof InvalidPairingCodeError ? "invalid" : "error";
			}
		}
		expect(outcomes).toEqual({ 299: "redeemed", 300: "invalid", 301: "invalid" });
	});

	test("the code's own expiresAt is five minutes after it was made", async () => {
		const minted = await mintPairingCode({ userId: null, access: "full", now: T0 });
		expect(Date.parse(minted.expiresAt) - T0.getTime()).toBe(300_000);
	});
});

describe("Crockford input", () => {
	test("a code is 20 characters", () => {
		expect(PAIRING_CODE_LENGTH).toBe(20);
		expect(pairing.generatePairingCode()).toHaveLength(20);
	});

	test("normalization: case, spaces, hyphens, I/L as 1, O as 0; U, wrong lengths and strays refused", () => {
		expect(normalizePairingCode("ab-cd ef\tgh jk ab-cd ef\tgh jk")).toBe("ABCDEFGHJKABCDEFGHJK");
		expect(normalizePairingCode("ilo01 olil1 ilo01 olil1")).toBe("11001011111100101111");
		expect(normalizePairingCode("01234567890123456789")).toBe("01234567890123456789");
		expect(normalizePairingCode("ABCDEFGHJKABCDEFGHJU")).toBeNull();
		expect(normalizePairingCode("abcdefghjkabcdefghju")).toBeNull();
		expect(normalizePairingCode("ABCDEFGHJ")).toBeNull();
		expect(normalizePairingCode("ABCDEFGHJK")).toBeNull(); // the old length
		expect(normalizePairingCode("ABCDEFGHJKABCDEFGHJKM")).toBeNull();
		expect(normalizePairingCode("ABCDEFGHJKABCDEFGH!K")).toBeNull();
		expect(normalizePairingCode("")).toBeNull();
	});

	test("a code typed sloppily redeems the same row", async () => {
		await plant("10ABCDEFGH10ABCDEFGH", { expiresAt: future() });
		const res = await redeemOverHttp("  io-abc defgh io-abc defgh ");
		expect(res.status).toBe(201);
	});

	test("the generated alphabet never contains I, L, O or U", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 400; i++) for (const ch of pairing.generatePairingCode()) seen.add(ch);
		for (const banned of "ILOU") expect(seen.has(banned)).toBe(false);
		expect(seen.size).toBeGreaterThan(20);
	});
});

describe("what is stored and logged", () => {
	test("only the hash: no column of the row holds the code", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.codeHash).toBe(await hashPairingCode(minted.code));
		expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(row)).not.toContain(minted.code);
	});

	test("a redemption records the key and the device that took the code", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		const paired = (await (await redeemOverHttp(minted.code)).json()) as { keyId: string };
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedKeyId).toBe(paired.keyId);
		expect(row?.redeemedDeviceName).toBe("Test Phone");
		expect(row?.redeemedAt).not.toBeNull();
	});

	test("the minter's credential is remembered: the session by hash, a key by id", async () => {
		const { headers } = await person("cred-session");
		await mintedFor(headers);
		const k = await seedKey("cred-key", ["manage"], null);
		await mint(bearerHeaders(k.key, { "Content-Type": "application/json" }));
		const rows = await getDb().select().from(pairingCodes);
		const handles = rows.map((r) => r.minterCredential).sort();
		expect(handles[0]).toMatch(/^key:/);
		expect(handles[0]).toBe(`key:${k.id}`);
		expect(handles[1]).toMatch(/^session:[0-9a-f]{64}$/);
		// the credential is a handle, not the cookie value
		const cookie = headers.get("Cookie") ?? "";
		expect(handles[1]).not.toContain(cookie.split("=")[1] as string);
	});

	test("the code is never logged, and both log lines carry the code's id", async () => {
		const lines: string[] = [];
		const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		const log = spyOn(console, "log").mockImplementation(capture);
		const error = spyOn(console, "error").mockImplementation(capture);
		const warn = spyOn(console, "warn").mockImplementation(capture);
		try {
			const { headers } = await person("pair-logs");
			const minted = await mintedFor(headers);
			await redeemOverHttp(fill("Y"));
			await redeemOverHttp(minted.code);
			await redeemOverHttp(minted.code);
			const text = lines.join("\n");
			expect(text).not.toContain(minted.code);
			expect(text).not.toContain(fill("Y"));
			const mintLine = lines.find((l) => l.includes("pairing_code_minted")) ?? "";
			const redeemLine = lines.find((l) => l.includes("pairing_redeemed")) ?? "";
			expect(JSON.parse(mintLine).codeId).toBe(minted.id);
			expect(JSON.parse(redeemLine).codeId).toBe(minted.id);
		} finally {
			log.mockRestore();
			error.mockRestore();
			warn.mockRestore();
		}
	});

	test("hidden formatting is stripped from device names: bidi controls and zero-width characters", async () => {
		const { headers } = await person("names");
		const minted = await mintedFor(headers);
		const res = await redeemOverHttp(minted.code, { deviceName: "Ph‮one​ ⁦X⁩﻿" });
		expect(res.status).toBe(201);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedDeviceName).toBe("Phone X");
		const paired = (await res.json()) as { keyId: string };
		expect((await keyRow(paired.keyId))?.name).toBe("Phone X (ios)");
	});

	test("redeemed_key_id can't be changed once set: a trigger refuses it, setting it from null and rewriting the same value are fine", async () => {
		await plant(fill("B"), { redeemedAt: T0.toISOString() });
		const set = async (value: string | null) => {
			await getDb().update(pairingCodes).set({ redeemedKeyId: value });
		};
		await set("first"); // null -> value
		await set("first"); // same value
		await expect(set("second")).rejects.toThrow();
		await expect(set(null)).rejects.toThrow();
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedKeyId).toBe("first");
		// deleting is still how retention retires a row
		await getDb().delete(pairingCodes);
		expect((await getDb().select().from(pairingCodes)).length).toBe(0);
	});
});

describe("the failure limiter", () => {
	const ipOf = (n: number) => `203.0.113.${n}`;
	const wrong = (ip: string, limiter: InstanceType<typeof PairingLimiter>) =>
		redeemPairingCode({ code: fill("Z"), deviceName: "p", platform: "ios", ip, limiter }).catch(
			(err) => err,
		);
	const valid = async (
		ip: string,
		limiter: InstanceType<typeof PairingLimiter>,
		userId: string,
	) => {
		const minted = await mintPairingCode({ userId, access: "respond" });
		return redeemPairingCode({
			code: minted.code,
			deviceName: "p",
			platform: "ios",
			ip,
			limiter,
		}).catch((err) => err);
	};

	test("the limits are literally 10 per client and 500 across everyone", () => {
		expect(PAIRING_FAILURES_PER_IP).toBe(10);
		expect(PAIRING_FAILURES_GLOBAL).toBe(500);
	});

	test("per client: after 9 failures a correct code still works; after 10 even a correct code is refused; another client is untouched", async () => {
		const owner = await seedLocalUser("lim-owner");

		const nine = new PairingLimiter();
		for (let i = 0; i < 9; i++) await wrong(ipOf(1), nine);
		expect((await valid(ipOf(1), nine, owner.id)).keyId).toBeDefined();

		const ten = new PairingLimiter();
		for (let i = 0; i < 10; i++) await wrong(ipOf(1), ten);
		expect(await valid(ipOf(1), ten, owner.id)).toBeInstanceOf(InvalidPairingCodeError);
		expect((await valid(ipOf(2), ten, owner.id)).keyId).toBeDefined();
	});

	test("a refused attempt is not looked up at all, and the code is not spent", async () => {
		const limiter = new PairingLimiter();
		const owner = await seedLocalUser("lim-unspent");
		for (let i = 0; i < 10; i++) await wrong(ipOf(3), limiter);
		const minted = await mintPairingCode({ userId: owner.id, access: "respond" });
		const refused = await redeemPairingCode({
			code: minted.code,
			deviceName: "p",
			platform: "ios",
			ip: ipOf(3),
			limiter,
		}).catch((err) => err);
		expect(refused).toBeInstanceOf(InvalidPairingCodeError);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedAt).toBeNull();
	});

	test("the slot is reserved before the lookup: thirty concurrent guesses from one client reach the database ten times", async () => {
		const limiter = new PairingLimiter();
		const realGetDb = dbClient.getDb;
		let lookups = 0;
		const spy = spyOn(dbClient, "getDb").mockImplementation(() => {
			lookups++;
			return realGetDb();
		});
		try {
			await Promise.all(Array.from({ length: 30 }, () => wrong(ipOf(4), limiter)));
		} finally {
			spy.mockRestore();
		}
		expect(lookups).toBe(PAIRING_FAILURES_PER_IP);
	});

	test("successes are not counted: more than ten correct redemptions from one client all work", async () => {
		const limiter = new PairingLimiter();
		const owner = await seedLocalUser("lim-ok");
		for (let i = 0; i < PAIRING_FAILURES_PER_IP + 3; i++) {
			expect((await valid(ipOf(5), limiter, owner.id)).keyId).toBeDefined();
		}
	});

	test("a disabled owner's failure still counts toward the limit", async () => {
		const limiter = new PairingLimiter();
		const owner = await seedLocalUser("lim-disabled");
		const minted = await mintPairingCode({ userId: owner.id, access: "respond" });
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, owner.id));
		const attempt = () =>
			redeemPairingCode({
				code: minted.code,
				deviceName: "p",
				platform: "ios",
				ip: ipOf(6),
				limiter,
			}).catch((err) => err);
		for (let i = 0; i < PAIRING_FAILURES_PER_IP; i++) {
			expect(await attempt()).toBeInstanceOf(InvalidPairingCodeError);
		}
		await getDb().update(users).set({ disabledAt: null }).where(eq(users.id, owner.id));
		// the owner is fine again, but the client has used up its failures
		expect(await attempt()).toBeInstanceOf(InvalidPairingCodeError);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedAt).toBeNull();
	});

	test("the windows end: after ten minutes the client limit releases", async () => {
		let now = 1_000_000;
		const limiter = new PairingLimiter({ clock: () => now });
		const owner = await seedLocalUser("lim-window");
		for (let i = 0; i < PAIRING_FAILURES_PER_IP; i++) await wrong(ipOf(7), limiter);
		expect(await valid(ipOf(7), limiter, owner.id)).toBeInstanceOf(InvalidPairingCodeError);
		now += 601_000;
		expect((await valid(ipOf(7), limiter, owner.id)).keyId).toBeDefined();
	});

	test("IPv6 clients count by /64: rotating the low 64 bits does not get fresh attempts, another /64 does", async () => {
		const limiter = new PairingLimiter();
		const owner = await seedLocalUser("lim-v6");
		for (let i = 0; i < PAIRING_FAILURES_PER_IP; i++) {
			await wrong(`2001:db8:1:2:${i.toString(16)}:aaaa::${i + 1}`, limiter);
		}
		expect(await valid("2001:db8:1:2:ffff::9", limiter, owner.id)).toBeInstanceOf(
			InvalidPairingCodeError,
		);
		expect(await valid("2001:0db8:0001:0002::1", limiter, owner.id)).toBeInstanceOf(
			InvalidPairingCodeError,
		); // the same /64 written another way
		expect((await valid("2001:db8:1:3::1", limiter, owner.id)).keyId).toBeDefined();
	});

	describe("globally: a tarpit, not a wall", () => {
		function tarpitLimiter() {
			const sleeps: number[] = [];
			const limiter = new PairingLimiter({
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
			return { limiter, sleeps };
		}
		async function spread(limiter: InstanceType<typeof PairingLimiter>, failures: number) {
			// thinly, so no single client comes near its own limit
			for (let i = 0; i < failures; i++) {
				await wrong(`198.51.${Math.floor(i / 9)}.${i % 9}`, limiter);
			}
		}

		test("499 failures delay nothing; once 500 are counted a miss is held, and a correct code is served at once", async () => {
			const { limiter, sleeps } = tarpitLimiter();
			const owner = await seedLocalUser("lim-tarpit");

			await spread(limiter, PAIRING_FAILURES_GLOBAL - 1);
			expect((await valid("192.0.2.1", limiter, owner.id)).keyId).toBeDefined();
			expect(sleeps).toEqual([]); // 499 counted: below the threshold

			await wrong("192.0.2.2", limiter); // the 500th
			expect(sleeps).toEqual([]);

			const served = await valid("192.0.2.3", limiter, owner.id);
			expect(served.keyId).toBeDefined();
			expect(sleeps).toEqual([]); // a hit is never delayed

			await wrong("192.0.2.4", limiter);
			expect(sleeps).toEqual([PAIRING_TARPIT_MS]); // a miss is
		});

		test("the delay is bounded and so is the number held at once; with every slot taken a correct code still redeems at once", async () => {
			const owner = await seedLocalUser("lim-saturated");
			const releases: Array<() => void> = [];
			const limiter = new PairingLimiter({
				sleep: () => new Promise<void>((resolve) => releases.push(resolve)),
			});
			await spread(limiter, PAIRING_FAILURES_GLOBAL); // the threshold is reached (these were not held)
			expect(PAIRING_TARPIT_MS).toBeLessThanOrEqual(5000);

			const held = Array.from({ length: PAIRING_TARPIT_MAX_HELD }, (_, i) =>
				wrong(`192.0.2.${i}`, limiter),
			);
			await until(() => releases.length >= PAIRING_TARPIT_MAX_HELD, "every slot to be held");
			expect(releases.length).toBe(PAIRING_TARPIT_MAX_HELD);

			const extra = await wrong("192.0.2.250", limiter); // answered without waiting
			expect(extra).toBeInstanceOf(InvalidPairingCodeError);
			expect(releases.length).toBe(PAIRING_TARPIT_MAX_HELD);

			// every slot is taken, and a phone with the right code is not kept waiting
			const phone = await valid("192.0.2.251", limiter, owner.id);
			expect(phone.keyId).toBeDefined();
			expect(releases.length).toBe(PAIRING_TARPIT_MAX_HELD);

			for (const release of releases) release();
			await Promise.all(held);
			// a freed slot can be held again
			const again = wrong("192.0.2.252", limiter);
			await until(
				() => releases.length >= PAIRING_TARPIT_MAX_HELD + 1,
				"the freed slot to be held",
			);
			expect(releases.length).toBe(PAIRING_TARPIT_MAX_HELD + 1);
			releases[releases.length - 1]?.();
			await again;
		});

		test("the global window ends too: after ten minutes nothing is delayed", async () => {
			let now = 5_000_000;
			const sleeps: number[] = [];
			const limiter = new PairingLimiter({
				clock: () => now,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
			await spread(limiter, PAIRING_FAILURES_GLOBAL + 1);
			await wrong("192.0.2.9", limiter);
			expect(sleeps.length).toBeGreaterThan(0);
			sleeps.length = 0;
			now += 601_000;
			await wrong("192.0.2.10", limiter);
			expect(sleeps).toEqual([]);
		});
	});
});

describe("the client address over HTTP", () => {
	/** Ten wrong codes, each with the given forwarded-for, then a correct one with `finalFor`. */
	async function tenWrongThenValid(forwardedFor: (i: number) => string, finalFor: string) {
		const { headers } = await person("xff");
		const minted = await mintedFor(headers);
		for (let i = 0; i < PAIRING_FAILURES_PER_IP; i++) {
			await redeemOverHttp(fill("Z"), {}, { "X-Forwarded-For": forwardedFor(i) });
		}
		return redeemOverHttp(minted.code, {}, { "X-Forwarded-For": finalFor });
	}

	test("from an untrusted peer, a rotating X-Forwarded-For does not escape the limit", async () => {
		const res = await tenWrongThenValid((i) => `198.51.100.${i + 1}`, "198.51.100.200");
		expect(res.status).toBe(400);
	});

	test("from a trusted peer, the leftmost forwarded address is the client: its own bucket, not the peer's", async () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "0.0.0.0/32";
		// ten failures from client A, then a correct code from A is refused but from B it works
		const refused = await tenWrongThenValid(() => "198.51.100.7, 192.0.2.1", "198.51.100.7");
		expect(refused.status).toBe(400);
		const { headers } = await person("xff-b");
		const minted = await mintedFor(headers);
		const served = await redeemOverHttp(minted.code, {}, { "X-Forwarded-For": "198.51.100.8" });
		expect(served.status).toBe(201);
	});

	test("rotating forwarded addresses from a trusted peer gives each its own attempts", async () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "0.0.0.0/32";
		const res = await tenWrongThenValid((i) => `198.51.100.${i + 1}`, "198.51.100.200");
		expect(res.status).toBe(201);
	});

	test("IPv6 through a trusted peer counts by /64", async () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "0.0.0.0/32";
		const sameNet = await tenWrongThenValid(
			(i) => `2001:db8:5:6:${i.toString(16)}::1`,
			"2001:db8:5:6:ffff::7",
		);
		expect(sameNet.status).toBe(400);

		await reset();
		process.env.AGENTPULSE_TRUSTED_PROXIES = "0.0.0.0/32";
		const otherNet = await tenWrongThenValid(
			(i) => `2001:db8:5:6:${i.toString(16)}::1`,
			"2001:db8:5:7::7",
		);
		expect(otherNet.status).toBe(201);
	});
});

describe("who the key belongs to", () => {
	test("a team member's code makes a key owned by that member", async () => {
		await setStoredMode("team");
		const { user, headers } = await person("team-member");
		const minted = await mintedFor(headers);
		const paired = (await (await redeemOverHttp(minted.code)).json()) as { keyId: string };
		expect((await keyRow(paired.keyId))?.ownerUserId).toBe(user.id);
	});

	test("an owner disabled after minting: 400, no key, and the code is not spent (solo and team)", async () => {
		for (const mode of ["solo", "team"] as const) {
			await reset();
			await setStoredMode(mode);
			const { user, headers } = await person(`disabled-later-${mode}`);
			const minted = await mintedFor(headers);
			const before = (await getDb().select().from(apiKeys)).length;
			await getDb()
				.update(users)
				.set({ disabledAt: new Date().toISOString() })
				.where(eq(users.id, user.id));

			const res = await redeemOverHttp(minted.code);

			expect({ mode, status: res.status }).toEqual({ mode, status: 400 });
			expect(await res.json()).toEqual({ error: "invalid_code" });
			expect((await getDb().select().from(apiKeys)).length).toBe(before);
			const [row] = await getDb().select().from(pairingCodes);
			expect(row?.redeemedAt).toBeNull();
		}
	});

	test("solo: a manage key with no owner makes an ownerless key, as POST /api-keys does", async () => {
		const loose = await seedKey("pair-loose", ["manage"], null);
		const minted = (await (
			await mint(bearerHeaders(loose.key, { "Content-Type": "application/json" }), {
				access: "respond",
			})
		).json()) as Minted;
		const paired = (await (await redeemOverHttp(minted.code)).json()) as { keyId: string };
		expect((await keyRow(paired.keyId))?.ownerUserId).toBeNull();
	});

	test("team mode: an ownerless code from a kept admin service key redeems to an ownerless key (a member with no identity)", async () => {
		await setStoredMode("team");
		const adminKey = await seedKey("pair-admin-service", ["manage"], null);
		await setAdminServiceKeyList([adminKey.id]);
		const minted = (await (
			await mint(bearerHeaders(adminKey.key, { "Content-Type": "application/json" }), {
				access: "respond",
			})
		).json()) as Minted;
		const res = await redeemOverHttp(minted.code);
		expect(res.status).toBe(201);
		const paired = (await res.json()) as { key: string; keyId: string };
		const row = await keyRow(paired.keyId);
		expect(row?.ownerUserId).toBeNull();
		expect(row?.scopes).toBe('["respond"]');
		const [code] = await getDb().select().from(pairingCodes);
		expect(code?.userId).toBeNull();
	});

	test("an ownerless code minted in solo is refused once the instance has switched to team", async () => {
		const loose = await seedKey("pair-solo-loose", ["manage"], null);
		const minted = (await (
			await mint(bearerHeaders(loose.key, { "Content-Type": "application/json" }), {
				access: "full",
			})
		).json()) as Minted;
		await setStoredMode("team");

		const res = await redeemOverHttp(minted.code);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_code" });
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedAt).toBeNull();
		expect(
			(await getDb().select().from(apiKeys).where(eq(apiKeys.name, "Test Phone (ios)"))).length,
		).toBe(0);
	});

	test("a code minted by a person in solo still redeems after the switch: the key has an owner", async () => {
		const { headers } = await person("solo-then-team");
		const minted = await mintedFor(headers);
		await setStoredMode("team");
		expect((await redeemOverHttp(minted.code)).status).toBe(201);
	});
});

describe("a code dies with the credential that minted it", () => {
	const redeemAttempt = (code: string) => redeemOverHttp(code);

	test("session revoked (signed out): the code is refused and not spent; a code from a live session still works", async () => {
		const live = await person("minter-live");
		const signedOut = await person("minter-out");
		const liveCode = await mintedFor(live.headers);
		const doomed = await mintedFor(signedOut.headers);

		await revokeSessionByToken(signedOut.token);

		const refused = await redeemAttempt(doomed.code);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "invalid_code" });
		const rows = await getDb().select().from(pairingCodes);
		expect(rows.find((r) => r.id === doomed.id)?.redeemedAt).toBeNull();
		expect((await redeemAttempt(liveCode.code)).status).toBe(201);
	});

	test("session expired: refused", async () => {
		const minter = await person("minter-expired");
		const minted = await mintedFor(minter.headers);
		await getDb()
			.update(authSessions)
			.set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(authSessions.userId, minter.user.id));
		expect((await redeemAttempt(minted.code)).status).toBe(400);
	});

	test("key revoked: refused; the same key's code before it was revoked would have worked", async () => {
		const owner = await seedLocalUser("minter-key-owner");
		const k = await seedKey("minter-key", ["manage"], owner.id);
		const headers = bearerHeaders(k.key, { "Content-Type": "application/json" });
		const ok = (await (await mint(headers)).json()) as Minted;
		const doomed = (await (await mint(headers)).json()) as Minted;
		expect((await redeemAttempt(ok.code)).status).toBe(201);

		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, k.id));

		expect((await redeemAttempt(doomed.code)).status).toBe(400);
		const rows = await getDb().select().from(pairingCodes);
		expect(rows.find((r) => r.id === doomed.id)?.redeemedAt).toBeNull();
	});

	test("a revoke that lands between the read and the claim still stops the key: nothing is created", async () => {
		const minter = await person("minter-race");
		const minted = await mintedFor(minter.headers);
		const keysBefore = (await getDb().select().from(apiKeys)).length;
		const real = apiKeyModule.createApiKey;
		const spy = spyOn(apiKeyModule, "createApiKey").mockImplementation(async (...args) => {
			await revokeSessionByToken(minter.token); // the person signs out at that instant
			return real(...args);
		});
		try {
			expect((await redeemAttempt(minted.code)).status).toBe(400);
		} finally {
			spy.mockRestore();
		}
		expect((await getDb().select().from(apiKeys)).length).toBe(keysBefore);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedAt).toBeNull();
	});

	test("auth off: a code with no credential is bound to its five minutes alone", async () => {
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await mint(new Headers({ "Content-Type": "application/json" }));
			const minted = (await res.json()) as Minted;
			const [row] = await getDb().select().from(pairingCodes);
			expect(row?.minterCredential).toBeNull();
			expect((await redeemAttempt(minted.code)).status).toBe(201);
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});
});

describe("concurrency and rollback", () => {
	test("eight phones racing one code: exactly one 201, exactly one key", async () => {
		const { headers } = await person();
		const minted = await mintedFor(headers);
		const keysBefore = (await getDb().select().from(apiKeys)).length;

		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				redeemOverHttp(minted.code, { deviceName: `Phone ${i}` }),
			),
		);

		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([201, 400, 400, 400, 400, 400, 400, 400]);
		expect((await getDb().select().from(apiKeys)).length).toBe(keysBefore + 1);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedKeyId).not.toBeNull();
	});

	test("a forced CAS failure rolls the key back: no key row, code not redeemed by this attempt", async () => {
		const { headers } = await person("rollback");
		const minted = await mintedFor(headers);
		const keysBefore = (await getDb().select().from(apiKeys)).length;
		const real = apiKeyModule.createApiKey;
		// Another request wins the code between our read and our claim.
		const spy = spyOn(apiKeyModule, "createApiKey").mockImplementation(async (...args) => {
			await getDb()
				.update(pairingCodes)
				.set({ redeemedAt: T0.toISOString(), redeemedKeyId: "someone-else" });
			return real(...args);
		});
		try {
			const res = await redeemOverHttp(minted.code);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_code" });
		} finally {
			spy.mockRestore();
		}
		expect((await getDb().select().from(apiKeys)).length).toBe(keysBefore);
		const [row] = await getDb().select().from(pairingCodes);
		expect(row?.redeemedKeyId).toBe("someone-else");
	});
});

describe("POST /pairing-codes", () => {
	test("observe, respond and ingest keys are refused; no credential is 401", async () => {
		for (const scopes of [["observe"], ["respond"], ["ingest"]]) {
			const k = await seedKey("pc-refused", scopes, null);
			const res = await mint(bearerHeaders(k.key, { "Content-Type": "application/json" }), {
				access: "full",
			});
			expect({ scopes, status: res.status }).toEqual({ scopes, status: 403 });
		}
		expect(
			(await app.request("/api/v1/pairing-codes", jsonRequest("POST", { access: "full" }))).status,
		).toBe(401);
	});

	test("access must be full or respond", async () => {
		const { headers } = await person();
		for (const body of [{}, { access: "admin" }, { access: 1 }, null]) {
			expect((await mint(headers, body)).status).toBe(400);
		}
	});

	test("a team-mode caller with no user needs to be an admin; a member's own key is fine", async () => {
		await setStoredMode("team");
		const loose = await seedKey("pc-team-loose", ["manage"], null);
		const refused = await mint(bearerHeaders(loose.key, { "Content-Type": "application/json" }));
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ error: "admin_required" });

		const member = await seedLocalUser("pc-team-member");
		const ownKey = await seedKey("pc-team-own", ["manage"], member.id);
		const ok = await mint(bearerHeaders(ownKey.key, { "Content-Type": "application/json" }));
		expect(ok.status).toBe(201);
	});

	test("a foreign Origin is refused, as for every credential-minting route", async () => {
		const { headers } = await person();
		const withOrigin = new Headers(headers);
		withOrigin.set("Origin", "https://evil.example");
		expect((await mint(withOrigin)).status).toBe(403);
	});

	test("minting is rate-limited per person", async () => {
		const { headers } = await person("pc-rate");
		let limited = 0;
		for (let i = 0; i < 14; i++) if ((await mint(headers)).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
	});
});

describe("GET /pairing-codes/:id", () => {
	const get = (h: Headers, id: string) =>
		app.request(`/api/v1/pairing-codes/${id}`, { headers: h });

	test("the minter sees pending, then who redeemed it; someone else gets 404", async () => {
		const { headers } = await person("status-owner");
		const other = await person("status-other");
		const minted = await mintedFor(headers);

		const pending = await get(headers, minted.id);
		expect(pending.status).toBe(200);
		expect(await pending.json()).toMatchObject({ state: "pending", redeemedDeviceName: null });
		expect((await get(other.headers, minted.id)).status).toBe(404);
		expect((await get(headers, "no-such-id")).status).toBe(404);

		const paired = (await (
			await redeemOverHttp(minted.code, { deviceName: "Jay's Phone" })
		).json()) as { keyId: string };
		expect(await (await get(headers, minted.id)).json()).toMatchObject({
			state: "redeemed",
			redeemedDeviceName: "Jay's Phone",
			redeemedKeyId: paired.keyId,
		});
	});

	test("an ownerless caller sees only its own ownerless codes: another ownerless key's status is a 404", async () => {
		const a = await seedKey("status-loose-a", ["manage"], null);
		const b = await seedKey("status-loose-b", ["manage"], null);
		const headersA = bearerHeaders(a.key, { "Content-Type": "application/json" });
		const headersB = bearerHeaders(b.key, { "Content-Type": "application/json" });
		const minted = (await (await mint(headersA)).json()) as Minted;

		expect((await get(headersA, minted.id)).status).toBe(200);
		expect((await get(headersB, minted.id)).status).toBe(404);
		const member = await person("status-member");
		expect((await get(member.headers, minted.id)).status).toBe(404);
	});

	test("a person never sees an ownerless code", async () => {
		const loose = await seedKey("status-loose-c", ["manage"], null);
		const minted = (await (
			await mint(bearerHeaders(loose.key, { "Content-Type": "application/json" }))
		).json()) as Minted;
		const member = await person("status-nobody");
		expect((await get(member.headers, minted.id)).status).toBe(404);
	});

	test("auth off: everyone is the one anonymous operator and sees the ownerless codes", async () => {
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const minted = (await (
				await mint(new Headers({ "Content-Type": "application/json" }))
			).json()) as Minted;
			expect((await get(new Headers(), minted.id)).status).toBe(200);
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});

	test("a code past its time reads as expired", async () => {
		const { user, headers } = await person("status-expired");
		const minted = await mintPairingCode({
			userId: user.id,
			access: "respond",
			now: new Date(Date.now() - 10 * 60_000),
		});
		const res = await get(headers, minted.id);
		expect(await res.json()).toMatchObject({ state: "expired" });
	});

	test("respond and observe keys can't read it", async () => {
		const k = await seedKey("status-refused", ["respond"], null);
		const res = await app.request("/api/v1/pairing-codes/x", { headers: bearerHeaders(k.key) });
		expect(res.status).toBe(403);
	});
});

describe("retention", () => {
	const afterExpiry = (ms: number) => new Date(T0.getTime() + PAIRING_CODE_TTL_MS + ms);
	const count = async () => (await getDb().select().from(pairingCodes)).length;

	test("an unredeemed code is purged 24 h after it expired, not before: the boundary is exact", async () => {
		await plant(fill("A"));
		expect(await deleteExpiredPairingCodes(afterExpiry(PAIRING_CODE_GRACE_MS - 1))).toBe(0);
		expect(await deleteExpiredPairingCodes(afterExpiry(PAIRING_CODE_GRACE_MS))).toBe(0);
		expect(await count()).toBe(1);
		expect(await deleteExpiredPairingCodes(afterExpiry(PAIRING_CODE_GRACE_MS + 1))).toBe(1);
		expect(await count()).toBe(0);
	});

	test("the grace period is 24 hours", () => {
		expect(PAIRING_CODE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
	});

	test("a redeemed code outlives its grace period while its key is active, and goes once the key is inactive or gone", async () => {
		const active = await seedKey("ret-active", ["respond"], null);
		const revoked = await seedKey("ret-revoked", ["respond"], null);
		const deleted = await seedKey("ret-deleted", ["respond"], null);
		for (const [char, key] of [
			["B", active],
			["C", revoked],
			["D", deleted],
		] as const) {
			await plant(fill(char), { redeemedAt: T0.toISOString(), redeemedKeyId: key.id });
		}
		const far = new Date(T0.getTime() + 400 * 24 * 3_600_000);

		await runRetentionPass(far);
		expect(await count()).toBe(3);

		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, revoked.id));
		await getDb().delete(apiKeys).where(eq(apiKeys.id, deleted.id));
		await runRetentionPass(far);

		const left = await getDb().select().from(pairingCodes);
		expect(left.map((r) => r.redeemedKeyId)).toEqual([active.id]);
	});

	test("a redeemed code inside 24 h whose key is already inactive is purged now: the grace period is for unredeemed codes only", async () => {
		const revoked = await seedKey("ret-fresh-revoked", ["respond"], null);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, revoked.id));
		await plant(fill("E"), { redeemedAt: T0.toISOString(), redeemedKeyId: revoked.id });
		expect(await deleteExpiredPairingCodes(at(60))).toBe(1);
		expect(await count()).toBe(0);
	});

	test("a redeemed row with no key id at all is purged", async () => {
		await plant(fill("F"), { redeemedAt: T0.toISOString(), redeemedKeyId: null });
		expect(await deleteExpiredPairingCodes(at(60))).toBe(1);
	});

	test("it runs even when event retention is switched off", async () => {
		await plant(fill("G"));
		const result = await runRetentionPass(afterExpiry(30 * 3_600_000));
		expect(result.disabled).toBe(true);
		expect(await count()).toBe(0);
	});

	test("a purge that fails does not stop the event retention pass", async () => {
		await upsertSetting("eventsRetentionDays", 1, { allowProtected: true });
		const rename = (from: string, to: string) =>
			config.dialect === "postgres"
				? // biome-ignore lint/suspicious/noExplicitAny: dialect-specific raw statement
					(getDb() as any).execute(sql.raw(`ALTER TABLE ${from} RENAME TO ${to}`))
				: // biome-ignore lint/suspicious/noExplicitAny: dialect-specific raw statement
					(getDb() as any).run(sql.raw(`ALTER TABLE ${from} RENAME TO ${to}`));
		const quiet = spyOn(console, "error").mockImplementation(() => undefined);
		await rename("pairing_codes", "pairing_codes_away");
		try {
			const result = await runRetentionPass(afterExpiry(0));
			expect(result.disabled).toBe(false);
			expect(result.retentionDays).toBe(1);
			expect(
				quiet.mock.calls.some((call) => String(call[0]).includes("pairing code purge failed")),
			).toBe(true);
		} finally {
			await rename("pairing_codes_away", "pairing_codes");
			quiet.mockRestore();
			await getDb()
				.delete((await import("../db/schema/index.js")).settings)
				.where(eq((await import("../db/schema/index.js")).settings.key, "eventsRetentionDays"));
		}
	});
});

describe("auth off", () => {
	test("with DISABLE_AUTH the code still has to be the right one", async () => {
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			expect((await redeemOverHttp(fill("Z"))).status).toBe(400);
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});
});
