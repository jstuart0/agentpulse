/**
 * POST /devices/:id/activities and DELETE /devices/:id/activities/:sessionId
 * against the real app, tables and publisher, with a local server standing in
 * for the relay. What matters here: who may follow what (the caller, and the
 * phone's own user, must both be able to read the session), the bookkeeping of
 * slot and generation, and that the phone is sent its first state and its end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../../db/__test_db.js";
import { asKey, deviceBody } from "../../test-utils/device-fixtures.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../../test-utils/team-fixtures.js";

const { config } = await import("../../config.js");
const { initializeDatabase, getDb } = await import("../../db/client.js");
const { mobileDeviceActivities, mobileDevices, sessions } = await import(
	"../../db/schema/index.js"
);
const { app } = await import("../../app.js");
const { _resetDeviceLimitsForTest, revokeDeviceRow } = await import("../mobile-devices-service.js");
const { startPush, stopPush, getLiveActivityPublisher } = await import("./push-runtime.js");
const { DEVICE_ACTIVITY_STARTS_PER_MINUTE } = await import("../mobile-devices-service.js");
const { MAX_LIVE_ACTIVITIES_PER_DEVICE } = await import("./live-activity-publisher.js");

// biome-ignore lint/suspicious/noExplicitAny: response bodies are dynamically shaped JSON
type Json = Record<string, any>;
const quiet = { info: () => undefined, warn: () => undefined };
const originalSecretsKey = config.secretsKey;

let relay: ReturnType<typeof Bun.serve>;
let relayUrl = "";
let seen: { auth: string | null; body: Json }[] = [];

beforeAll(async () => {
	await initializeDatabase();
	relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			seen.push({ auth: req.headers.get("authorization"), body: (await req.json()) as Json });
			return new Response(JSON.stringify({ pushId: "11111111-2222-3333-4444-555555555555" }), {
				status: 202,
			});
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
	await getDb().delete(sessions).execute();
	await resetIdentityState();
	await clearInstanceSettings();
	_resetDeviceLimitsForTest();
	seen = [];
	config.secretsKey = "activity-routes-secrets-key";
}
beforeEach(reset);
afterEach(async () => {
	await reset();
	config.secretsKey = originalSecretsKey;
});

const call = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

async function member(name: string, role: "user" | "admin" = "user") {
	const user = await seedLocalUser(name, role);
	const key = await seedKey(`${name}-respond`, ["respond"], user.id);
	const headers = asKey(key.key);
	const res = await call("POST", "/devices", headers, await deviceBody());
	expect(res.status).toBe(201);
	const device = (await res.json()) as Json;
	return { user, key, headers, deviceId: device.id as string };
}

async function mkSession(sessionId: string, ownerUserId: string | null = null) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: true,
			totalToolUses: 7,
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			metadata: {},
			ownerUserId,
		})
		.execute();
}

const follow = (m: { headers: Headers; deviceId: string }, over: Record<string, unknown> = {}) =>
	call("POST", `/devices/${m.deviceId}/activities`, m.headers, {
		sessionId: "s1",
		slot: "slot-1",
		generation: 1,
		...over,
	});

const rows = () => getDb().select().from(mobileDeviceActivities);

describe("POST /devices/:id/activities", () => {
	test("follows a session: 201, the row is stored, and the phone is sent its first state", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);

		const res = await follow(a);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true, sessionId: "s1", slot: "slot-1", generation: 1 });
		const stored = await rows();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			sessionId: "s1",
			slot: "slot-1",
			generation: 1,
			endedAt: null,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.body).toMatchObject({
			kind: "liveactivity",
			slot: "slot-1",
			generation: 1,
			event: "update",
		});
		expect(Object.keys(seen[0]?.body.contentState).sort()).toEqual([
			"status",
			"statusSince",
			"toolCount",
			"trace",
		]);
		expect(seen[0]?.body.contentState.toolCount).toBe(7);
	});

	test("the same slot and generation again is a 200 that changes nothing", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await follow(a)).status).toBe(201);
		expect((await follow(a)).status).toBe(200);
		expect(await rows()).toHaveLength(1);
	});

	test("a newer generation or a new slot replaces the old; an older generation is a 409", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a, { generation: 3 });

		expect((await follow(a, { generation: 4, slot: "slot-2" })).status).toBe(200);
		expect((await rows())[0]).toMatchObject({ slot: "slot-2", generation: 4 });

		const stale = await follow(a, { generation: 2, slot: "slot-3" });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ error: "stale_generation" });
		expect((await rows())[0]).toMatchObject({ slot: "slot-2", generation: 4 });
	});

	test("following again after the activity ended reopens the row", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		expect((await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers)).status).toBe(
			200,
		);
		expect((await rows())[0]?.endedAt).not.toBeNull();
		expect((await follow(a, { generation: 2 })).status).toBe(200);
		expect((await rows())[0]).toMatchObject({ endedAt: null, generation: 2 });
	});

	test("a malformed body is a 400 naming the field", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		for (const [over, field] of [
			[{ sessionId: "" }, "sessionId"],
			[{ sessionId: 5 }, "sessionId"],
			[{ slot: "has space" }, "slot"],
			[{ slot: "x".repeat(65) }, "slot"],
			[{ generation: -1 }, "generation"],
			[{ generation: 1.5 }, "generation"],
			[{ generation: "1" }, "generation"],
		] as const) {
			const res = await follow(a, over);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_request", field });
		}
		expect(await rows()).toEqual([]);
	});

	test("a device holds a bounded number of live follows", async () => {
		const a = await member("act-alice");
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		for (let i = 0; i < MAX_LIVE_ACTIVITIES_PER_DEVICE; i++) {
			await mkSession(`cap-${i}`, a.user.id);
			expect((await follow(a, { sessionId: `cap-${i}`, slot: `slot-${i}` })).status).toBe(201);
		}
		await mkSession("one-too-many", a.user.id);
		const res = await follow(a, { sessionId: "one-too-many", slot: "slot-x" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "activity_limit" });
	});

	test("push not set up: 503, nothing stored", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		const res = await follow(a);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "push_unavailable" });
		expect(await rows()).toEqual([]);
	});

	test("a session that doesn't exist, and a revoked device, answer 404", async () => {
		const a = await member("act-alice");
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await follow(a, { sessionId: "nope" })).status).toBe(404);
		await mkSession("s1", a.user.id);
		await revokeDeviceRow(a.deviceId, "deleted");
		expect((await follow(a)).status).toBe(404);
		expect(await rows()).toEqual([]);
	});

	test("an observe key can't reach it", async () => {
		const a = await member("act-alice");
		const observe = await seedKey("act-observe", ["observe"], a.user.id);
		const res = await call(
			"POST",
			`/devices/${a.deviceId}/activities`,
			bearerHeaders(observe.key, { "Content-Type": "application/json" }),
			{
				sessionId: "s1",
				slot: "slot-1",
				generation: 1,
			},
		);
		expect(res.status).toBe(403);
	});

	test("another key's phone is not yours to point at a session", async () => {
		const a = await member("act-alice");
		const b = await member("act-bob");
		await mkSession("s1", null);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		const res = await call("POST", `/devices/${a.deviceId}/activities`, b.headers, {
			sessionId: "s1",
			slot: "slot-1",
			generation: 1,
		});
		expect([403, 404]).toContain(res.status);
		expect(await rows()).toEqual([]);
	});
});

describe("team mode: read access on both ends", () => {
	test("a member can't follow another member's session", async () => {
		await setStoredMode("team");
		const a = await member("act-alice");
		const b = await member("act-bob");
		await mkSession("bobs", b.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		const res = await follow(a, { sessionId: "bobs" });
		expect(res.status).toBe(404);
		expect(await rows()).toEqual([]);
		expect(seen).toEqual([]);
	});

	test("a member can follow an unowned session and their own", async () => {
		await setStoredMode("team");
		const a = await member("act-alice");
		await mkSession("open", null);
		await mkSession("mine", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await follow(a, { sessionId: "open", slot: "s-open" })).status).toBe(201);
		expect((await follow(a, { sessionId: "mine", slot: "s-mine" })).status).toBe(201);
	});

	test("an admin who can read the session still can't point someone else's phone at one that person can't read", async () => {
		await setStoredMode("team");
		const root = await member("act-root", "admin");
		const alice = await member("act-alice");
		const bob = await member("act-bob");
		await mkSession("bobs", bob.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		// root reads everything, but alice's phone belongs to alice, who can't read bob's session.
		// An admin-held manage key reaches alice's device the way an admin would; the device's own user is still judged.
		const manage = await seedKey("act-root-manage", ["manage"], root.user.id);
		const res = await call("POST", `/devices/${alice.deviceId}/activities`, asKey(manage.key), {
			sessionId: "bobs",
			slot: "slot-1",
			generation: 1,
		});
		expect(res.status).toBe(404);
		expect(await rows()).toEqual([]);
		// Positive controls: the same manage key does reach alice's phone for a session alice can read,
		// and root can point their own phone at bob's session. So the 404 above is the device owner's check.
		await mkSession("alices", alice.user.id);
		const control = await call("POST", `/devices/${alice.deviceId}/activities`, asKey(manage.key), {
			sessionId: "alices",
			slot: "slot-2",
			generation: 1,
		});
		expect(control.status).toBe(201);
		expect((await follow(root, { sessionId: "bobs" })).status).toBe(201);
	});
});

describe("DELETE /devices/:id/activities/:sessionId", () => {
	test("stops following: 200, the row ends, and the phone is told to end the activity", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		seen = [];
		const res = await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect((await rows())[0]?.endedAt).not.toBeNull();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.body).toMatchObject({ kind: "liveactivity", slot: "slot-1", event: "end" });
	});

	test("404 for a session this phone isn't following, and again once it has been stopped", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers)).status).toBe(
			404,
		);
		await follow(a);
		expect((await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers)).status).toBe(
			200,
		);
		expect((await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers)).status).toBe(
			404,
		);
	});

	test("it works with push off: the row is ended and nothing is sent", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		stopPush();
		seen = [];
		expect((await call("DELETE", `/devices/${a.deviceId}/activities/s1`, a.headers)).status).toBe(
			200,
		);
		expect((await rows())[0]?.endedAt).not.toBeNull();
		expect(seen).toEqual([]);
	});

	test("someone else's phone answers as a missing one", async () => {
		await setStoredMode("team");
		const a = await member("act-alice");
		const b = await member("act-bob");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		const res = await call("DELETE", `/devices/${a.deviceId}/activities/s1`, b.headers);
		expect([403, 404]).toContain(res.status);
		expect((await rows())[0]?.endedAt).toBeNull();
	});
});

describe("the publisher is wired to push", () => {
	test("a status change on a followed session reaches the phone, through the real bus", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		seen = [];

		const { notifySessionUpdated } = await import("../notifier.js");
		await getDb()
			.update(sessions)
			.set({ isWorking: false, semanticStatus: "waiting" })
			.where(eq(sessions.sessionId, "s1"));
		const [fresh] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "s1"));
		notifySessionUpdated(fresh as NonNullable<typeof fresh>);
		for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
		expect(seen).toHaveLength(1);
		expect(seen[0]?.body.contentState.status).toBe("waiting");
		expect(seen[0]?.body.event).toBe("update");
	});

	test("stopping push stops the publisher: later bus events send nothing", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		await follow(a);
		stopPush();
		seen = [];
		const { sessionBus } = await import("../notifier.js");
		const before = sessionBus.listenerCount("session_event");
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect(sessionBus.listenerCount("session_event")).toBe(before + 1);
		stopPush();
		expect(sessionBus.listenerCount("session_event")).toBe(before);
	});
});

describe("heartbeats and limits", () => {
	test("an unchanged re-post is a 200 that sends the relay nothing", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await follow(a)).status).toBe(201);
		expect(seen).toHaveLength(1);
		for (let i = 0; i < 3; i++) expect((await follow(a)).status).toBe(200);
		expect(seen).toHaveLength(1);
		// a changed generation does send
		expect((await follow(a, { generation: 2 })).status).toBe(200);
		expect(seen).toHaveLength(2);
	});

	test("a phone may make a bounded number of follow requests a minute; the rest are 429 with Retry-After", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		for (let i = 0; i < DEVICE_ACTIVITY_STARTS_PER_MINUTE; i++) {
			expect((await follow(a)).status).toBeLessThan(300);
		}
		const refused = await follow(a);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("Retry-After")).toBe("60");
		expect(await refused.json()).toEqual({ error: "rate_limited" });
	});

	test("a refused request (bad body, unknown session) spends no budget", async () => {
		const a = await member("act-alice");
		await mkSession("s1", a.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		for (let i = 0; i < DEVICE_ACTIVITY_STARTS_PER_MINUTE + 5; i++) {
			await follow(a, { slot: "bad slot" });
			await follow(a, { sessionId: "nope" });
		}
		expect((await follow(a)).status).toBe(201);
	});
});

describe("a handover with no session update", () => {
	test("the old owner's activity ends with a neutral end at the next pass, and the new owner's does not", async () => {
		await setStoredMode("team");
		const alice = await member("act-alice");
		const bob = await member("act-bob");
		await mkSession("handed", alice.user.id);
		startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
		expect((await follow(alice, { sessionId: "handed", slot: "slot-a" })).status).toBe(201);
		await getDb()
			.update(sessions)
			.set({ totalToolUses: 99 })
			.where(eq(sessions.sessionId, "handed"));
		seen = [];

		// What changeSessionOwner does: a row update and nothing on the session bus.
		await getDb()
			.update(sessions)
			.set({ ownerUserId: bob.user.id })
			.where(eq(sessions.sessionId, "handed"));
		await (
			getLiveActivityPublisher() as NonNullable<ReturnType<typeof getLiveActivityPublisher>>
		).tick();

		expect(seen).toHaveLength(1);
		expect(seen[0]?.body).toMatchObject({ event: "end", slot: "slot-a" });
		expect(seen[0]?.body.contentState).toMatchObject({ status: "completed", toolCount: 0 });
		expect((await rows())[0]?.endedAt).not.toBeNull();
		// bob can follow it now
		expect((await follow(bob, { sessionId: "handed", slot: "slot-b" })).status).toBe(201);
	});
});
