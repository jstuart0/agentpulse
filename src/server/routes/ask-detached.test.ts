/**
 * An Ask stream whose client goes away after its turn started: the turn finishes
 * with its writes suppressed, the reply is saved to the thread, and the requester's
 * phones are told one reply is waiting (`ask_reply`). A turn still queued for a
 * slot when the client leaves is dropped: no turn, no push. A stream that runs to
 * its end with a client attached sends no push.
 *
 * SQLite only, like the other Ask turn suites: the world fixture writes through the
 * raw handle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const llm = await import("../test-utils/scripted-llm.js");
const REGISTRY_PATH = "../services/ai/llm/registry.js";
const realRegistry = { ...(await import("../services/ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { config } = await import("../config.js");
const { getSqlite } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const fixture = await import("../test-utils/ask-turn-fixture.js");
const { _resetDispatchForTest, configurePushRuntime } = await import(
	"../services/push/dispatch.js"
);
const limiter = await import("../services/ask/ask-turn-limiter.js");
const { cookieHeadersFor, seedLocalUser, seedKey, setStoredMode, clearInstanceSettings } =
	await import("../test-utils/team-fixtures.js");

import type { PushEvent } from "../services/push/types.js";

const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;
const STREAM = "/api/v1/ai/ask/stream";

let key = "";
let keyId = "";
const held: Array<{ release(): void }> = [];
const pushed: PushEvent[] = [];

async function waitFor(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const stats = () => limiter.getAskTurnLimiterStats();
const assistantMessages = () =>
	getSqlite()
		.prepare("SELECT id, thread_id FROM ask_messages WHERE role = 'assistant'")
		.all() as Array<{
		id: string;
		thread_id: string;
	}>;

function post() {
	return app.request(STREAM, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ message: "hello there caching" }),
	});
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await fixture.setupAskFixture();
	const created = await createApiKey(`ask-detached-${crypto.randomUUID()}`, ["manage"]);
	key = created.key;
	keyId = created.id;
});
afterAll(() => {
	mock.module(REGISTRY_PATH, () => realRegistry);
	if (!isSqliteTest) return;
	fixture.teardownAskFixture();
});
beforeEach(async () => {
	if (!isSqliteTest) return;
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = 2;
	await fixture.resetAskWorld();
	_resetDispatchForTest();
	pushed.length = 0;
	configurePushRuntime({
		targets: {
			resolve: async (event) => {
				pushed.push(event);
				return [];
			},
		},
		service: { sendToDevices: async () => [] },
		logger: { info: () => undefined, warn: () => undefined },
	});
});
afterEach(() => {
	if (!isSqliteTest) return;
	for (const slot of held.splice(0)) slot.release();
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
	configurePushRuntime(null);
});

describeSqliteOnly("Ask replies that outlive their stream", () => {
	test("a client that goes away mid-turn: the turn finishes, the reply is saved, one ask_reply names it", async () => {
		const release = llm.holdLlmCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");

		await reader.cancel();
		release();
		await waitFor(() => stats().running === 0, "the turn to settle");
		await waitFor(() => pushed.length > 0, "the push");

		const saved = assistantMessages();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toBeDefined();
		expect(pushed).toEqual([
			{
				type: "ask_reply",
				threadId: saved[0]?.thread_id as string,
				assistantMessageId: saved[0]?.id as string,
				// the thread's title is the question's first words; no proposal was made
				title: "hello there caching",
				proposalCount: 0,
				requesterUserId: null,
				requesterKeyId: keyId,
			},
		]);
	});

	test("a client that goes away while still queued: no turn, nothing saved, no push", async () => {
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => stats().waiting === 1, "the stream to queue");

		await reader.cancel();
		await waitFor(() => stats().waiting === 0, "the waiter to leave");
		await Bun.sleep(100);

		expect(assistantMessages()).toHaveLength(0);
		expect(llm.llmCalls).toHaveLength(0);
		expect(pushed).toEqual([]);
	});

	test("a stream that is read to its end sends no push", async () => {
		const res = await post();
		const text = await res.text();
		await Bun.sleep(100);

		expect(text).toContain('"kind":"done"');
		expect(assistantMessages()).toHaveLength(1);
		expect(pushed).toEqual([]);
	});

	test("a signed-in person (cookie) who leaves mid-turn is told by user id, with no key", async () => {
		const user = await seedLocalUser("ask-cookie");
		const cookie = await cookieHeadersFor(user.id);
		const release = llm.holdLlmCalls();
		const res = await app.request(STREAM, {
			method: "POST",
			headers: { cookie: cookie.get("Cookie") as string, "content-type": "application/json" },
			body: JSON.stringify({ message: "hello there caching" }),
		});
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");
		await reader.cancel();
		release();
		await waitFor(() => stats().running === 0, "the turn to settle");
		await waitFor(() => pushed.length > 0, "the push");

		expect(pushed[0]).toMatchObject({
			type: "ask_reply",
			requesterUserId: user.id,
			requesterKeyId: null,
		});
	});

	test("a key owned by a person is told by that person's id and still names the key", async () => {
		const user = await seedLocalUser("ask-owner");
		const owned = await seedKey("ask-owned", ["manage"], user.id);
		const release = llm.holdLlmCalls();
		const res = await app.request(STREAM, {
			method: "POST",
			headers: { authorization: `Bearer ${owned.key}`, "content-type": "application/json" },
			body: JSON.stringify({ message: "hello there caching" }),
		});
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");
		await reader.cancel();
		release();
		await waitFor(() => stats().running === 0, "the turn to settle");
		await waitFor(() => pushed.length > 0, "the push");

		expect(pushed[0]).toMatchObject({
			type: "ask_reply",
			requesterUserId: user.id,
			requesterKeyId: owned.id,
		});
	});
});

/** Reads frames until the stream names its thread. */
async function threadOf(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for (let i = 0; i < 200; i++) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value);
		const match = /"kind":"start","thread":\{"id":"([^"]+)"/.exec(text);
		if (match) return match[1] as string;
	}
	throw new Error("the stream never named its thread");
}

const cancel = (threadId: string, headers: Record<string, string>) =>
	app.request(`/api/v1/ai/ask/threads/${threadId}/cancel`, { method: "POST", headers });

describeSqliteOnly("cancelling an Ask turn that is still writing", () => {
	test("the asker's cancel stops an attached turn: no reply saved, no push, the slot comes back", async () => {
		const release = llm.holdAnswerCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		const threadId = await threadOf(reader);

		const stopped = await cancel(threadId, { authorization: `Bearer ${key}` });
		expect(stopped.status).toBe(200);
		expect(await stopped.json()).toEqual({ ok: true, stopping: true });
		release();
		await waitFor(() => stats().running === 0, "the slot to be released");
		await Bun.sleep(100);

		expect(assistantMessages()).toHaveLength(0);
		expect(pushed).toEqual([]);
	});

	test("it stops a turn the phone has already left (the detached one) too", async () => {
		const release = llm.holdAnswerCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const threadId = await threadOf(reader);
		await reader.cancel(); // the phone goes away; the turn keeps running

		const stopped = await cancel(threadId, { authorization: `Bearer ${key}` });
		expect(stopped.status).toBe(200);
		release();
		await waitFor(() => stats().running === 0, "the slot to be released");
		await Bun.sleep(100);

		expect(assistantMessages()).toHaveLength(0);
		expect(pushed).toEqual([]);
	});

	test("solo mode is one person: any of their keys, a respond key included, may stop a running turn", async () => {
		const respond = await createApiKey(`ask-respond-${crypto.randomUUID()}`, ["respond"]);
		const release = llm.holdAnswerCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const threadId = await threadOf(reader);

		const stopped = await cancel(threadId, { authorization: `Bearer ${respond.key}` });
		expect(stopped.status).toBe(200);
		release();
		await waitFor(() => stats().running === 0, "the slot to be released");
		expect(assistantMessages()).toHaveLength(0);
	});

	test("a second cancel finds nothing running: 404", async () => {
		const release = llm.holdAnswerCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const threadId = await threadOf(reader);
		expect((await cancel(threadId, { authorization: `Bearer ${key}` })).status).toBe(200);
		release();
		await waitFor(() => stats().running === 0, "the slot to be released");
		const again = await cancel(threadId, { authorization: `Bearer ${key}` });
		expect(again.status).toBe(404);
		expect(await again.json()).toMatchObject({ error: "not_found" });
	});

	test("a second turn on a thread that is already streaming is refused up front: 409 thread_busy, and nothing is written for it", async () => {
		const release = llm.holdAnswerCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const threadId = await threadOf(reader);
		const before = (
			getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_messages").get() as { n: number }
		).n;

		const second = await app.request(STREAM, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ message: "another question", threadId }),
		});

		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ error: "thread_busy" });
		expect(
			(getSqlite().prepare("SELECT COUNT(*) AS n FROM ask_messages").get() as { n: number }).n,
		).toBe(before);
		release();
		await waitFor(() => stats().running === 0, "the first turn to settle");
		// once it has finished the thread takes another turn
		const next = await app.request(STREAM, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ message: "and another", threadId }),
		});
		expect(next.status).toBe(200);
		await next.text();
	});

	test("a turn still waiting for a slot has no thread yet, so there is nothing to cancel: 404, and leaving the queue is the client's disconnect", async () => {
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => stats().waiting === 1, "the stream to queue");

		const tried = await cancel("any-thread", { authorization: `Bearer ${key}` });
		expect(tried.status).toBe(404);
		await reader.cancel();
		await waitFor(() => stats().waiting === 0, "the waiter to leave");
		expect(assistantMessages()).toHaveLength(0);
		expect(pushed).toEqual([]);
	});

	test("a thread with no running turn is 404, and a respond key reaches the route (404, not 403)", async () => {
		const respond = await createApiKey(`ask-respond-${crypto.randomUUID()}`, ["respond"]);
		const none = await cancel("no-such-thread", { authorization: `Bearer ${respond.key}` });
		expect(none.status).toBe(404);
		const observe = await createApiKey(`ask-observe-${crypto.randomUUID()}`, ["observe"]);
		expect(
			(await cancel("no-such-thread", { authorization: `Bearer ${observe.key}` })).status,
		).toBe(403);
	});

	test("in team mode an admin may stop anyone's turn and another member may not", async () => {
		await setStoredMode("team");
		try {
			const alice = await seedLocalUser("ask-t-alice");
			const bob = await seedLocalUser("ask-t-bob");
			const admin = await seedLocalUser("ask-t-admin", "admin");
			const aliceCookie = (await cookieHeadersFor(alice.id)).get("Cookie") as string;
			const release = llm.holdAnswerCalls();
			const res = await app.request(STREAM, {
				method: "POST",
				headers: { cookie: aliceCookie, "content-type": "application/json" },
				body: JSON.stringify({ message: "hello there caching" }),
			});
			const reader = (res.body as ReadableStream<Uint8Array>).getReader();
			const threadId = await threadOf(reader);

			const bobTries = await cancel(threadId, {
				cookie: (await cookieHeadersFor(bob.id)).get("Cookie") as string,
			});
			expect(bobTries.status).toBe(404);
			const adminStops = await cancel(threadId, {
				cookie: (await cookieHeadersFor(admin.id)).get("Cookie") as string,
			});
			expect(adminStops.status).toBe(200);
			release();
			await waitFor(() => stats().running === 0, "the slot to be released");
			expect(assistantMessages()).toHaveLength(0);
		} finally {
			await clearInstanceSettings();
		}
	});
});

// Last, because it removes the provider the other turns need.
describeSqliteOnly("a turn that fails after its client left", () => {
	test("a client that goes away and a turn that fails saves its error reply but sends no push", async () => {
		const release = llm.holdLlmCalls();
		const res = await post();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");
		await reader.cancel();
		// Make the answer call fail: the scripted adapter answers, so empty the provider instead.
		getSqlite().prepare("DELETE FROM llm_providers").run();
		release();
		await waitFor(() => stats().running === 0, "the turn to settle");
		await Bun.sleep(100);

		const failed = getSqlite()
			.prepare("SELECT error_message FROM ask_messages WHERE role = 'assistant'")
			.all() as Array<{ error_message: string | null }>;
		expect(failed).toHaveLength(1);
		expect(failed[0]?.error_message).toBeTruthy();
		expect(pushed).toEqual([]);
	});
});
