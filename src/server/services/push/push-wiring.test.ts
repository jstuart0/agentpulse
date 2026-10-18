/**
 * Push wired into the server: the device table as the target source, the
 * revocation sink on the device rows, `/devices/:id/test` sending for real,
 * capabilities advertising only what works, and push degrading cleanly when the
 * relay or the secrets key is missing. The relay here is a local server; the
 * sealing, queueing and posting are the real modules.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { eq } from "drizzle-orm";
import "../../db/__test_db.js";
import { asKey, deviceBody } from "../../test-utils/device-fixtures.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../../test-utils/team-fixtures.js";

const { config } = await import("../../config.js");
const { initializeDatabase, getDb } = await import("../../db/client.js");
const { mobileDevices, mobileDeviceActivities, sessions } = await import(
	"../../db/schema/index.js"
);
const { app } = await import("../../app.js");
const { _resetDeviceLimitsForTest, onKeysDeactivated } = await import(
	"../mobile-devices-service.js"
);
const { decryptSecretAsync } = await import("../ai/secrets.js");
const { HPKE_INFO, pushAad } = await import("./hpke-seal.js");
const { dispatchEvent, getPushRuntime } = await import("./dispatch.js");
const { DbPushDeviceSource, getPushDevice, parsePrefs, toPushDevice } = await import(
	"./device-source.js"
);
const { createRevocationSink, pushAvailability, startPush, stopPush } = await import(
	"./push-runtime.js"
);

// biome-ignore lint/suspicious/noExplicitAny: response bodies are dynamically shaped JSON
type Json = Record<string, any>;
const suite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const quiet = { info: () => undefined, warn: () => undefined };

const originalSecretsKey = config.secretsKey;
let relay: ReturnType<typeof Bun.serve>;
let relayUrl = "";
let seen: { path: string; auth: string | null; body: Json }[] = [];
let answer: () => Response = () =>
	new Response(JSON.stringify({ pushId: "11111111-2222-3333-4444-555555555555" }), { status: 202 });

beforeAll(async () => {
	await initializeDatabase();
	relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			seen.push({
				path: new URL(req.url).pathname,
				auth: req.headers.get("authorization"),
				body: (await req.json()) as Json,
			});
			return answer();
		},
	});
	relayUrl = `http://127.0.0.1:${relay.port}`;
});

afterAll(() => {
	relay.stop(true);
	config.secretsKey = originalSecretsKey;
});

async function reset() {
	stopPush();
	await getDb().delete(mobileDeviceActivities);
	await getDb().delete(mobileDevices);
	await resetIdentityState();
	await clearInstanceSettings();
	_resetDeviceLimitsForTest();
	seen = [];
	answer = () =>
		new Response(JSON.stringify({ pushId: "11111111-2222-3333-4444-555555555555" }), {
			status: 202,
		});
	config.secretsKey = "wiring-test-secrets-key";
}
beforeEach(reset);
afterEach(async () => {
	await reset();
	config.secretsKey = originalSecretsKey;
});

const call = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

async function owner(name = "wire-alice") {
	const user = await seedLocalUser(name);
	const key = await seedKey(`${name}-respond`, ["respond"], user.id);
	return { user, key, headers: asKey(key.key) };
}

/** Registers a phone with a real key pair so what the server seals can be opened here. */
async function phone(headers: Headers, over: Record<string, unknown> = {}) {
	const pair = await suite.kem.generateKeyPair();
	const publicKey = Buffer.from(
		new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)),
	).toString("base64url");
	const body = await deviceBody({ publicKey, ...over });
	const res = await call("POST", "/devices", headers, body);
	expect(res.status).toBe(201);
	const dto = (await res.json()) as Json;
	const open = async (envelope: { e: string; c: string; d: string; p: string }) =>
		JSON.parse(
			new TextDecoder().decode(
				await suite.open(
					{
						recipientKey: pair.privateKey,
						enc: b64(envelope.e),
						info: new TextEncoder().encode(HPKE_INFO),
					},
					b64(envelope.c),
					new TextEncoder().encode(pushAad(envelope.d, envelope.p)),
				),
			),
		) as Json;
	return { id: dto.id as string, body, open };
}

const enable = () => startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);

describe("starting push", () => {
	test("with a relay and the secrets key it comes up, and says which relay", () => {
		expect(enable()).toEqual({ available: true, relayOrigin: relayUrl });
		expect(getPushRuntime()).not.toBeNull();
		expect(pushAvailability()).toEqual({ available: true, relayOrigin: relayUrl });
	});

	test("with no relay URL it stays off and installs nothing", () => {
		expect(startPush({}, quiet)).toEqual({ available: false, reason: "relay_not_configured" });
		expect(startPush({ AGENTPULSE_PUSH_RELAY_URL: "  " }, quiet)).toEqual({
			available: false,
			reason: "relay_not_configured",
		});
		expect(getPushRuntime()).toBeNull();
	});

	test("with an unusable relay URL it stays off and says so, without throwing", () => {
		for (const bad of [
			"not a url",
			"http://relay.example.com",
			`https://${"user"}:${"pw"}@relay.example.com`,
		]) {
			expect(startPush({ AGENTPULSE_PUSH_RELAY_URL: bad }, quiet)).toEqual({
				available: false,
				reason: "relay_url_invalid",
			});
		}
		expect(getPushRuntime()).toBeNull();
	});

	test("without the secrets key it stays off and warns once, naming the variable", () => {
		config.secretsKey = "";
		const warnings: string[] = [];
		const result = startPush(
			{ AGENTPULSE_PUSH_RELAY_URL: relayUrl },
			{ info: () => undefined, warn: (m) => void warnings.push(m) },
		);
		expect(result).toEqual({ available: false, reason: "secrets_key_missing" });
		expect(getPushRuntime()).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("AGENTPULSE_SECRETS_KEY");
	});

	test("if the secrets key goes away later, availability follows it", () => {
		enable();
		config.secretsKey = "";
		expect(pushAvailability()).toEqual({ available: false, reason: "secrets_key_missing" });
	});

	test("starting again replaces the runtime; stopping removes it", () => {
		enable();
		const first = getPushRuntime();
		enable();
		expect(getPushRuntime()).not.toBe(first);
		stopPush();
		expect(getPushRuntime()).toBeNull();
		expect(pushAvailability().available).toBe(false);
	});

	test("when push is off, dispatching an event is a no-op that touches nothing", async () => {
		const a = await owner();
		await phone(a.headers);
		await dispatchEvent({ type: "permission_wait", sessionId: "s-off" });
		expect(seen).toHaveLength(0);
	});
});

describe("capabilities advertise push only when it works", () => {
	const features = async (headers: Headers) => {
		const res = await app.request("/api/v1/capabilities", { headers });
		expect(res.status).toBe(200);
		return (await res.json()) as Json;
	};

	test("relay and secrets key: features.mobilePush true and push.relayOrigin, and nothing else new", async () => {
		const a = await owner();
		enable();
		const body = await features(a.headers);
		expect(body.features.mobilePush).toBe(true);
		expect(body.push).toEqual({ relayOrigin: relayUrl });
		expect(Object.values(body.features).every((v) => typeof v === "boolean")).toBe(true);
	});

	test("no relay, an invalid relay, or no secrets key: neither the flag nor the origin", async () => {
		const a = await owner();
		const absent = async () => {
			const body = await features(a.headers);
			expect("mobilePush" in body.features).toBe(false);
			expect("push" in body).toBe(false);
		};
		await absent(); // never started
		startPush({ AGENTPULSE_PUSH_RELAY_URL: "http://relay.example.com" }, quiet);
		await absent();
		config.secretsKey = "";
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await absent();
		config.secretsKey = "back-again";
		enable();
		config.secretsKey = "";
		await absent(); // started, then the key went missing
	});
});

describe("the device table as the target source", () => {
	test("lists live phones with a token, mapped to what the push modules need, the token still encrypted", async () => {
		const a = await owner();
		const { id, body } = await phone(a.headers, {
			prefs: {
				showContent: false,
				includeAgentText: true,
				quietHours: { enabled: true, start: "22:00", end: "07:00" },
				timezone: "Europe/Berlin",
				categories: { SESSION_COMPLETED: true },
				digestHour: 8,
			},
		});
		const [device] = await new DbPushDeviceSource().listActiveDevices();
		expect(device).toMatchObject({
			id,
			userId: a.user.id,
			platform: "ios",
			relayDeviceId: body.relayDeviceId,
			kid: body.kid,
			publicKey: body.publicKey,
			clientServerRef: body.clientServerRef,
			prefs: {
				showContent: false,
				includeAgentText: true,
				quietHours: { enabled: true, start: "22:00", end: "07:00" },
				timezone: "Europe/Berlin",
				categories: { SESSION_COMPLETED: true },
			},
		});
		expect(device?.sendTokenCiphertext).not.toBe(body.sendToken);
		expect(await decryptSecretAsync(device?.sendTokenCiphertext ?? "")).toBe(
			body.sendToken as string,
		);
	});

	test("a revoked phone is not a target: deleted by hand, or its key deactivated", async () => {
		const a = await owner();
		const kept = await phone(a.headers);
		const deleted = await phone(a.headers);
		await call("DELETE", `/devices/${deleted.id}`, a.headers);
		const other = await owner("wire-bob");
		const bobs = await phone(other.headers);
		await onKeysDeactivated([other.key.id]);
		const ids = (await new DbPushDeviceSource().listActiveDevices()).map((d) => d.id);
		expect(ids).toEqual([kept.id]);
		expect(await getPushDevice(deleted.id)).toBeNull();
		expect(await getPushDevice(bobs.id)).toBeNull();
		expect((await getPushDevice(kept.id))?.id).toBe(kept.id);
	});

	test("a phone with a revoked_at is out even if its token was somehow not wiped", async () => {
		const a = await owner();
		const { id } = await phone(a.headers);
		await getDb()
			.update(mobileDevices)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(mobileDevices.id, id));
		expect(await new DbPushDeviceSource().listActiveDevices()).toEqual([]);
		expect(await getPushDevice(id)).toBeNull();
	});

	test("an ownerless key's phones are grouped by the key", async () => {
		const key = await seedKey("wire-ownerless", ["respond"], null);
		const { id } = await phone(asKey(key.key));
		expect((await getPushDevice(id))?.userId).toBe(`key:${key.id}`);
	});

	test("unreadable or oddly typed stored prefs are ignored, never fatal", () => {
		expect(parsePrefs(null)).toEqual({});
		expect(parsePrefs("not json")).toEqual({});
		expect(
			parsePrefs(
				JSON.stringify({
					showContent: "yes",
					quietHours: { enabled: true },
					categories: { SESSION_FAILED: 1, STUCK: true },
					timezone: 5,
				}),
			),
		).toEqual({ categories: { STUCK: true } });
	});

	test("solo targeting reaches every live phone; team mode reaches none until team targeting exists", async () => {
		const a = await owner();
		const b = await owner("wire-carol");
		await phone(a.headers);
		await phone(b.headers);
		enable();
		const targets = getPushRuntime()?.targets;
		expect(
			((await targets?.resolve({ type: "permission_wait", sessionId: "s" })) ?? []).length,
		).toBe(2);
		await setStoredMode("team");
		expect(await targets?.resolve({ type: "permission_wait", sessionId: "s" })).toEqual([]);
	});

	test("dispatchEvent reaches the live phones through the real source and sends nothing for a revoked one", async () => {
		const a = await owner();
		const live = await phone(a.headers);
		const gone = await phone(a.headers);
		await call("DELETE", `/devices/${gone.id}`, a.headers);
		enable();
		await dispatchEvent({
			type: "permission_wait",
			sessionId: "sess-dispatch",
			sessionName: "refactor",
		});
		expect(seen).toHaveLength(1);
		const [request] = seen;
		expect(request?.path).toBe("/v1/push");
		expect(request?.auth).toBe(`Bearer ${live.body.sendToken}`);
		const payload = await live.open(request?.body.envelope);
		expect(payload).toMatchObject({
			t: "permission_wait",
			cat: "NEEDS_YOU_PERMISSION",
			sid: "sess-dispatch",
			sname: "refactor",
		});
	});

	test("a phone revoked a moment after a dispatch hears nothing from the next one, although the device list is cached", async () => {
		const a = await owner();
		const staying = await phone(a.headers);
		const leaving = await phone(a.headers);
		enable();
		await dispatchEvent({ type: "permission_wait", sessionId: "warm-cache" });
		expect(seen).toHaveLength(2);
		seen = [];
		expect((await call("DELETE", `/devices/${leaving.id}`, a.headers)).status).toBe(200);
		await dispatchEvent({ type: "permission_wait", sessionId: "right-after" });
		expect(seen.map((r) => r.auth)).toEqual([`Bearer ${staying.body.sendToken}`]);
	});
});

describe("POST /devices/:id/test sends for real", () => {
	test("a test push reaches the relay with the phone's own token, sealed to its key, and answers ok with the push id", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		const res = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, pushId: "11111111-2222-3333-4444-555555555555" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.auth).toBe(`Bearer ${p.body.sendToken}`);
		expect(seen[0]?.body.kind).toBe("alert");
		const payload = await p.open(seen[0]?.body.envelope);
		expect(payload).toMatchObject({
			t: "device_test",
			cat: "GENERIC_OPEN",
			il: "active",
			kid: p.body.kid,
			ref: p.body.clientServerRef,
		});
		expect(JSON.stringify(seen[0]?.body)).not.toContain("device_test");
	});

	test("it ignores the phone's category toggles: a test always goes out", async () => {
		const a = await owner();
		const p = await phone(a.headers, {
			prefs: { categories: { GENERIC_OPEN: false, NEEDS_YOU_TURN: false } },
		});
		enable();
		// Prefs can switch a category off, including this one; the test button is the explicit exception.
		expect((await call("POST", `/devices/${p.id}/test`, a.headers)).status).toBe(200);
		expect(seen).toHaveLength(1);
	});

	test("the relay saying the phone is gone: 404 device_gone, and the phone is revoked with its token wiped", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		answer = () => new Response(JSON.stringify({ gone: "device" }), { status: 410 });
		const res = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "device_gone" });
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(row?.revokedReason).toBe("relay_gone");
		expect(row?.revokedAt).not.toBeNull();
		expect(row?.sendToken).toBe("");
	});

	test("the relay rejecting the send token (its own 401): 502 push_failed, and the phone is revoked", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		answer = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
		const res = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "push_failed", reason: "unauthorized" });
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(row?.revokedReason).toBe("relay_token_rejected");
		expect(row?.sendToken).toBe("");
	});

	test("a 401 from something in front of the relay does not revoke on its own", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		answer = () => new Response("<html>sign in</html>", { status: 401 });
		expect((await call("POST", `/devices/${p.id}/test`, a.headers)).status).toBe(502);
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(row?.revokedAt).toBeNull();
		expect(row?.sendToken).not.toBe("");
	});

	test("a spent relay budget: 429 with Retry-After; an outage: 503; neither revokes anything", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		answer = () =>
			new Response(JSON.stringify({ budget: "alert" }), {
				status: 429,
				headers: { "retry-after": "12" },
			});
		const limited = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("12");
		answer = () => new Response("{}", { status: 503 });
		stopPush();
		enable();
		const down = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(down.status).toBe(503);
		expect(await down.json()).toEqual({ error: "push_unavailable" });
		const [row] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(row?.revokedAt).toBeNull();
	});

	test("push not set up: 503 push_unavailable, and nothing is sent", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		const res = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "push_unavailable" });
		expect(seen).toHaveLength(0);
	});

	test("the secrets key going missing after boot: 503 push_unavailable, nothing is decrypted or sent", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		enable();
		config.secretsKey = "";
		const res = await call("POST", `/devices/${p.id}/test`, a.headers);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "push_unavailable" });
		expect(seen).toHaveLength(0);
	});

	test("another key's phone is refused, an unknown id is 404, and neither sends anything", async () => {
		const a = await owner();
		const b = await owner("wire-dave");
		const p = await phone(a.headers);
		enable();
		// A respond key reaches only the phones registered with that same key.
		expect((await call("POST", `/devices/${p.id}/test`, b.headers)).status).toBe(403);
		expect((await call("POST", "/devices/nope/test", a.headers)).status).toBe(404);
		expect(seen).toHaveLength(0);
	});
});

describe("the revocation sink", () => {
	test("a Live Activity the relay reports gone ends that activity row only", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "wire-s1", agentType: "claude_code", status: "active" },
				{ sessionId: "wire-s2", agentType: "claude_code", status: "active" },
			]);
		const now = new Date().toISOString();
		await getDb()
			.insert(mobileDeviceActivities)
			.values([
				{ deviceId: p.id, sessionId: "wire-s1", slot: "dead", generation: 1, createdAt: now },
				{ deviceId: p.id, sessionId: "wire-s2", slot: "alive", generation: 1, createdAt: now },
			]);
		const device = await getPushDevice(p.id);
		if (!device) throw new Error("device missing");
		await createRevocationSink(quiet).activityGone(device, "dead");
		const rows = await getDb().select().from(mobileDeviceActivities);
		expect(rows.find((r) => r.slot === "dead")?.endedAt).not.toBeNull();
		expect(rows.find((r) => r.slot === "alive")?.endedAt).toBeNull();
		const [still] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(still?.revokedAt).toBeNull();
	});

	test("a device the relay reports gone is revoked once; saying it again changes nothing", async () => {
		const a = await owner();
		const p = await phone(a.headers);
		const device = await getPushDevice(p.id);
		if (!device) throw new Error("device missing");
		const sink = createRevocationSink(quiet);
		await sink.deviceGone(device);
		const [first] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		await sink.deviceGone(device);
		const [second] = await getDb().select().from(mobileDevices).where(eq(mobileDevices.id, p.id));
		expect(second?.revokedAt).toBe(first?.revokedAt ?? "");
		expect(toPushDevice(second as never).sendTokenCiphertext).toBe("");
	});
});
