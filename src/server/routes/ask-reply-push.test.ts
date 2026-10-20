/**
 * The `ask_reply` push end to end: a thread is asked, the client goes away mid-turn, the real push runtime
 * (device table, targeting policy, send path) tells the asker's phones, and the phone then opens the thread
 * with its own respond key. The invariant (F94): a phone is pushed only if its key can then read the thread
 * under the respond key's own-thread rule, so a tap never lands on "wasn't found".
 *
 * Only the relay is a local server and the LLM is scripted. SQLite only, like the other Ask turn suites:
 * the world fixture writes through the raw handle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const llm = await import("../test-utils/scripted-llm.js");
const REGISTRY_PATH = "../services/ai/llm/registry.js";
const realRegistry = { ...(await import("../services/ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { getSqlite } = await import("../db/client.js");
const { app } = await import("../app.js");
const fixture = await import("../test-utils/ask-turn-fixture.js");
const limiter = await import("../services/ask/ask-turn-limiter.js");
const { config } = await import("../config.js");
const { _resetDispatchForTest } = await import("../services/push/dispatch.js");
const { startPush, stopPush } = await import("../services/push/push-runtime.js");
const { _resetDeviceLimitsForTest } = await import("../services/mobile-devices-service.js");
const { resetIdentityState } = await import("../test-utils/identity-reset.js");
const { asKey, pairedKey, registerWith } = await import("../test-utils/device-fixtures.js");
const {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} = await import("../test-utils/team-fixtures.js");

const STREAM = "/api/v1/ai/ask/stream";
const quiet = { info: () => undefined, warn: () => undefined };
const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;

let relay: ReturnType<typeof Bun.serve>;
let relayUrl = "";
let sentTo: string[] = [];

beforeAll(async () => {
	if (!isSqliteTest) return;
	await fixture.setupAskFixture();
	relay = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			sentTo.push(req.headers.get("authorization") ?? "");
			await req.arrayBuffer();
			return new Response(JSON.stringify({ pushId: "11111111-2222-3333-4444-555555555555" }), {
				status: 202,
			});
		},
	});
	relayUrl = `http://127.0.0.1:${relay.port}`;
});
afterAll(() => {
	mock.module(REGISTRY_PATH, () => realRegistry);
	if (!isSqliteTest) return;
	relay.stop(true);
	fixture.teardownAskFixture();
});
beforeEach(async () => {
	if (!isSqliteTest) return;
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = 4;
	await fixture.resetAskWorld();
	_resetDispatchForTest();
	_resetDeviceLimitsForTest();
	sentTo = [];
	startPush({ AGENTPULSE_PUSH_RELAY_URL: relayUrl }, quiet);
});
afterEach(async () => {
	if (!isSqliteTest) return;
	stopPush();
	getSqlite().exec("DELETE FROM mobile_device_activities");
	getSqlite().exec("DELETE FROM mobile_devices");
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
	await resetIdentityState();
	await clearInstanceSettings();
});

async function waitFor(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** A phone registered under a key; `sendToken` is how the relay's request names the device it was sent for. */
async function phoneOf(key: string): Promise<{ key: string; sendToken: string }> {
	const sendToken = `send-token-${crypto.randomUUID()}`;
	const res = await registerWith(asKey(key), { sendToken });
	expect(res.status).toBe(201);
	return { key, sendToken };
}

async function pairedPhone(userId: string) {
	return phoneOf((await pairedKey(userId)).key);
}

/** Asks on the streaming route as `headers`, then drops the connection mid-turn so the reply is detached. Returns the thread id. */
async function askAndWalkAway(headers: Headers, threadId?: string): Promise<string> {
	const release = llm.holdLlmCalls();
	const callsBefore = llm.llmCalls.length;
	const merged = new Headers(headers);
	merged.set("content-type", "application/json");
	const res = await app.request(STREAM, {
		method: "POST",
		headers: merged,
		body: JSON.stringify({ message: "hello there caching", threadId }),
	});
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await reader.read();
	await waitFor(() => llm.llmCalls.length > callsBefore, "the turn to reach the LLM");
	await reader.cancel();
	release();
	await waitFor(() => limiter.getAskTurnLimiterStats().running === 0, "the turn to settle");
	const rows = getSqlite()
		.prepare("SELECT thread_id FROM ask_messages WHERE role = 'assistant' ORDER BY rowid DESC")
		.all() as Array<{ thread_id: string }>;
	return (rows[0] as { thread_id: string }).thread_id;
}

const readThread = (id: string, key: string) =>
	app.request(`/api/v1/ai/ask/threads/${id}`, { headers: bearerHeaders(key) });

/** Lets a send that was going to happen finish, then reports who the relay was asked to push. */
async function settledPushes(expected: number): Promise<string[]> {
	if (expected > 0) await waitFor(() => sentTo.length >= expected, "the push");
	await Bun.sleep(150);
	return sentTo;
}

describeSqliteOnly("ask_reply push reaches only phones that can open the thread", () => {
	test("team: a thread started on the web pushes to its owner's phone, which reads it with 200; another user's phone gets no push and a 404", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("arp-alice");
		const bob = await seedLocalUser("arp-bob");
		const alicePhone = await pairedPhone(alice.id);
		const bobPhone = await pairedPhone(bob.id);

		const threadId = await askAndWalkAway(await cookieHeadersFor(alice.id));

		expect(await settledPushes(1)).toEqual([`Bearer ${alicePhone.sendToken}`]);
		expect((await readThread(threadId, alicePhone.key)).status).toBe(200);
		expect(sentTo).not.toContain(`Bearer ${bobPhone.sendToken}`);
		expect((await readThread(threadId, bobPhone.key)).status).toBe(404);
	});

	test("team: a thread asked with a person's manage key is the person's: their phone's respond key is pushed and reads it", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("arp-alice-mgr");
		const manage = await seedKey("arp-alice-manage", ["manage"], alice.id);
		const phone = await pairedPhone(alice.id);

		const threadId = await askAndWalkAway(bearerHeaders(manage.key));

		expect(await settledPushes(1)).toEqual([`Bearer ${phone.sendToken}`]);
		expect((await readThread(threadId, phone.key)).status).toBe(200);
	});

	test("team: an admin who continues a member's thread is not pushed (their phone can't open it); the member's phone is not pushed either", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("arp-alice2");
		const admin = await seedLocalUser("arp-admin", "admin");
		const alicePhone = await pairedPhone(alice.id);
		const adminPhone = await pairedPhone(admin.id);

		const first = await askAndWalkAway(await cookieHeadersFor(alice.id));
		await settledPushes(1);
		sentTo.length = 0;
		_resetDispatchForTest();
		const again = await askAndWalkAway(await cookieHeadersFor(admin.id), first);

		expect(again).toBe(first);
		expect(await settledPushes(0)).toEqual([]);
		expect((await readThread(first, adminPhone.key)).status).toBe(404);
		expect((await readThread(first, alicePhone.key)).status).toBe(200);
	});

	test("solo: a person's web thread pushes to their phone and opens with 200", async () => {
		await setStoredMode("solo");
		const me = await seedLocalUser("arp-solo-me");
		const phone = await pairedPhone(me.id);

		const threadId = await askAndWalkAway(await cookieHeadersFor(me.id));

		expect(await settledPushes(1)).toEqual([`Bearer ${phone.sendToken}`]);
		expect((await readThread(threadId, phone.key)).status).toBe(200);
	});

	test("solo: a thread asked by an ownerless manage key does not push to an ownerless respond key's phone, which would 404 on it", async () => {
		await setStoredMode("solo");
		const manage = await seedKey("arp-solo-mgr", ["manage"], null);
		const phone = await phoneOf((await seedKey("arp-solo-resp", ["respond"], null)).key);

		const threadId = await askAndWalkAway(bearerHeaders(manage.key));

		// the asking key's own devices are the only candidates, and none is paired with it
		expect(await settledPushes(0)).toEqual([]);
		expect((await readThread(threadId, phone.key)).status).toBe(404);
	});

	test("solo: an ownerless manage key that asked a thread reaches the phone enrolled under that same key, which reads it", async () => {
		await setStoredMode("solo");
		const loose = await seedKey("arp-solo-loose", ["manage"], null);
		const phone = await phoneOf(loose.key);

		const threadId = await askAndWalkAway(bearerHeaders(loose.key));

		expect(await settledPushes(1)).toEqual([`Bearer ${phone.sendToken}`]);
		expect((await readThread(threadId, phone.key)).status).toBe(200);
	});
});
