/**
 * Who a socket may hear about. A key without manage (the mobile companion's
 * `respond`) is a restricted reader: it can't subscribe to `*`, can subscribe to
 * `session:<id>` only for a session it can read, and in team mode sees only the
 * sessions it can read on the `sessions` channel. What it can read is re-judged
 * on every sweep and at once when ownership, a role, the instance mode or a key
 * changes (driven here through the real HTTP routes where one exists). A mobile
 * socket never sees a raw payload and gets bounded fields. Sockets here are
 * in-process stand-ins; the upgrade path and a real client have their own tests.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { WS_HEARTBEAT_INTERVAL_MS } from "../../shared/constants.js";
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
const { apiKeys, launchRequests, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const dbClient = await import("../db/client.js");
const { setWsRevalidationListener } = await import("./revalidation.js");
const apiKeyModule = await import("../auth/api-key.js");
const { changeSessionOwner } = await import("../services/session-owner-admin.js");
const { setUserRole } = await import("../services/user-management.js");
const { setMode } = await import("../services/instance-mode.js");
const { associateObservedSession } = await import("../services/launch-dispatch.js");
const {
	WS_CLOSE_AUTHORITY_CHANGED,
	WS_CLOSE_AUTH_REVOKED,
	WS_MAX_CHANNELS_PER_MESSAGE,
	WS_MAX_CHANNELS_PER_SOCKET,
	WS_SWEEP_QUERY_CHUNK,
	broadcast,
	broadcastToSession,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	heartbeatTick,
	sendHeartbeats,
} = await import("./handler.js");
const { requestWsRevalidation } = await import("./revalidation.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(launchRequests);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

interface Received {
	type: string;
	// biome-ignore lint/suspicious/noExplicitAny: wire payloads are inspected loosely
	data: any;
}

interface FakeSocket {
	/** Data frames: everything but heartbeats and subscribe_rejected notices. */
	received: Received[];
	/** The reasons of the subscribe_rejected notices the server sent. */
	rejected: string[];
	bytes: () => number;
	closedWith: () => { code: number; reason: string } | null;
	subscribe: (...channels: string[]) => Promise<void>;
	send: (message: unknown) => Promise<void>;
	disconnect: () => void;
	/** Settles when the open handler has finished resolving the socket's authority. */
	opened: Promise<void>;
}

const open: Array<() => void> = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

/** Opens a socket the way the upgrade would have: with the identity and profile it resolved. */
async function openSocket(identity: {
	userId?: string | null;
	keyId?: string | null;
	scopes: string[];
	profile?: "web" | "mobile";
	/** Don't wait for the open handler: the socket is used while its authority resolves. */
	noWait?: boolean;
}): Promise<FakeSocket> {
	const raw: string[] = [];
	let closed: { code: number; reason: string } | null = null;
	const ws = {
		data: {
			userId: identity.userId ?? null,
			keyId: identity.keyId ?? null,
			scopes: identity.scopes,
			profile: identity.profile ?? (identity.scopes.includes("manage") ? "web" : "mobile"),
		},
		send: (message: string) => raw.push(message),
		close: (code: number, reason: string) => {
			closed = { code, reason };
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	const opened = handleWsOpen(ws as any);
	if (!identity.noWait) await opened;
	const disconnect = () => {
		// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
		handleWsClose(ws as any);
	};
	open.push(disconnect);
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	const send = (message: unknown) => handleWsMessage(ws as any, JSON.stringify(message));
	return {
		get received() {
			return raw
				.map((m) => JSON.parse(m) as Received)
				.filter((m) => m.type !== "heartbeat" && m.type !== "subscribe_rejected");
		},
		get rejected() {
			return raw
				.map((m) => JSON.parse(m) as Received)
				.filter((m) => m.type === "subscribe_rejected")
				.map((m) => m.data?.reason ?? (m as unknown as { reason: string }).reason);
		},
		bytes: () => raw.reduce((sum, m) => sum + new TextEncoder().encode(m).length, 0),
		closedWith: () => closed,
		subscribe: (...channels) => send({ type: "subscribe", channels }),
		send,
		disconnect,
		opened,
	} as FakeSocket;
}

async function seedSession(sessionId: string, ownerUserId: string | null) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", ownerUserId });
}

/** alice and bob (members), an admin, each with a respond key, plus a session each and an unowned one. */
async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("az-alice");
	const bob = await seedLocalUser("az-bob");
	const admin = await seedLocalUser("az-admin", "admin");
	await seedLocalUser("az-admin-2", "admin");
	const aliceKey = await seedKey("az-alice-key", ["respond"], alice.id);
	const bobKey = await seedKey("az-bob-key", ["respond"], bob.id);
	const adminKey = await seedKey("az-admin-key", ["respond"], admin.id);
	const looseKey = await seedKey("az-loose-key", ["respond"], null);
	await seedSession("s-alice", alice.id);
	await seedSession("s-bob", bob.id);
	await seedSession("s-open", null);
	const respondFor = (user: { id: string }, key: { id: string }, noWait = false) =>
		openSocket({ userId: user.id, keyId: key.id, scopes: ["respond"], noWait });
	return { alice, bob, admin, aliceKey, bobKey, adminKey, looseKey, respondFor };
}

/** A call to the real HTTP route as a signed-in admin. */
async function asAdmin(adminId: string, method: string, path: string, body?: unknown) {
	return app.request(
		`/api/v1${path}`,
		jsonRequest(method, body ?? {}, await cookieHeadersFor(adminId)),
	);
}

const sessionRow = (sessionId: string, ownerUserId: string | null | undefined) => ({
	session: { sessionId, ownerUserId, status: "active" },
});
const event = (sessionId: string, extra: Record<string, unknown> = {}) => ({
	id: 1,
	sessionId,
	eventType: "assistant_message",
	content: "hello",
	toolInput: null,
	toolResponse: null,
	rawPayload: { secret: "do-not-send" },
	createdAt: "2026-10-01T00:00:00.000Z",
	...extra,
});
const idsOf = (socket: FakeSocket) => socket.received.map((m) => m.data.sessionId).sort();

describe("subscribe authorization", () => {
	test("a respond socket's `*` is dropped; a manage socket's `*` is honoured (positive control)", async () => {
		const t = await team();
		const respond = await t.respondFor(t.alice, t.aliceKey);
		const manage = await openSocket({ scopes: ["manage"] });
		await respond.subscribe("*");
		await manage.subscribe("*");

		broadcast("stats_updated", { n: 1 }, "some-other-channel");

		expect(respond.received).toEqual([]);
		expect(manage.received.map((m) => m.type)).toEqual(["stats_updated"]);
	});

	test("a key with respond and manage is unrestricted: `*` honoured, web profile, unfiltered", async () => {
		const t = await team();
		const both = await openSocket({ userId: t.alice.id, scopes: ["respond", "manage"] });
		await both.subscribe("*");
		broadcast("session_updated", sessionRow("s-bob", t.bob.id));
		broadcast("stats_updated", { n: 1 }, "some-other-channel");
		expect(both.received.map((m) => m.type)).toEqual(["session_updated", "stats_updated"]);
	});

	test("a respond socket can't subscribe to arbitrary channels either", async () => {
		const t = await team();
		const respond = await t.respondFor(t.alice, t.aliceKey);
		await respond.subscribe("stats", "inbox", "session:", "not a channel");
		broadcast("stats_updated", { n: 1 }, "stats");
		broadcast("stats_updated", { n: 1 }, "inbox");
		expect(respond.received).toEqual([]);
	});

	test("in team mode another member's session:<id> is dropped; the member's own, an unowned one and an admin's reach are kept", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const admin = await t.respondFor(t.admin, t.adminKey);
		await alice.subscribe("session:s-alice", "session:s-bob", "session:s-open");
		await admin.subscribe("session:s-bob");

		for (const id of ["s-alice", "s-bob", "s-open"]) broadcastToSession(id, "new_event", event(id));

		expect(idsOf(alice)).toEqual(["s-alice", "s-open"]);
		expect(idsOf(admin)).toEqual(["s-bob"]);
	});

	test("a mixed subscribe keeps the readable channel and drops `*`; an unsubscribe ends delivery", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("*", "session:s-alice", "session:s-bob");

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-bob", "new_event", event("s-bob"));
		expect(idsOf(alice)).toEqual(["s-alice"]);

		await alice.send({ type: "unsubscribe", channels: ["session:s-alice"] });
		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(idsOf(alice)).toEqual(["s-alice"]); // still just the first one
	});

	test("an unknown session id is dropped, and an ownerless key can't read an unowned session in team mode", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const loose = await openSocket({ userId: null, keyId: t.looseKey.id, scopes: ["respond"] });
		await alice.subscribe("session:does-not-exist");
		await loose.subscribe("session:s-open", "session:s-alice");

		broadcastToSession("does-not-exist", "new_event", event("does-not-exist"));
		broadcastToSession("s-open", "new_event", event("s-open"));

		expect(alice.received).toEqual([]);
		expect(loose.received).toEqual([]);
	});

	test("solo mode: any respond socket may follow any session", async () => {
		const t = await team();
		await setStoredMode("solo");
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-bob");
		broadcastToSession("s-bob", "new_event", event("s-bob"));
		expect(idsOf(alice)).toEqual(["s-bob"]);
	});

	test("a message that arrives while the socket's authority is still resolving is judged once it is", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey, true);
		await alice.subscribe("session:s-alice", "session:s-bob"); // before open settled
		await alice.opened;

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-bob", "new_event", event("s-bob"));
		expect(idsOf(alice)).toEqual(["s-alice"]);
	});

	test("a key deleted after open but before the subscribe closes the socket instead of subscribing", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await getDb().delete(apiKeys).where(eq(apiKeys.id, t.aliceKey.id));

		await alice.subscribe("session:s-alice");

		expect(alice.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);
		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(alice.received).toEqual([]);
	});
});

describe("what a restricted socket is sent (an allow-list, not a deny-list)", () => {
	test("session_created, session_updated and session_ended are filtered by owner", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const admin = await t.respondFor(t.admin, t.adminKey);
		const web = await openSocket({ userId: t.alice.id, scopes: ["*"], profile: "web" });

		for (const type of ["session_updated", "session_created", "session_ended"] as const) {
			broadcast(type, sessionRow("s-alice", t.alice.id));
			broadcast(type, sessionRow("s-bob", t.bob.id));
			broadcast(type, sessionRow("s-open", null));
		}

		const ids = (socket: FakeSocket, type: string) =>
			socket.received.filter((m) => m.type === type).map((m) => m.data.session.sessionId);
		for (const type of ["session_updated", "session_created", "session_ended"]) {
			expect({ type, ids: ids(alice, type) }).toEqual({ type, ids: ["s-alice", "s-open"] });
			expect({ type, ids: ids(admin, type) }).toEqual({
				type,
				ids: ["s-alice", "s-bob", "s-open"],
			});
			// the dashboard socket keeps the unfiltered team feed
			expect({ type, ids: ids(web, type) }).toEqual({ type, ids: ["s-alice", "s-bob", "s-open"] });
		}
	});

	test("a session payload with no owner field is denied, even to an admin (unknown is not unowned)", async () => {
		const t = await team();
		const admin = await t.respondFor(t.admin, t.adminKey);
		broadcast("session_updated", sessionRow("s-x", undefined));
		broadcast("session_updated", { notASession: true });
		expect(admin.received).toEqual([]);
	});

	test("an unknown message type is denied to a restricted socket and delivered to a dashboard socket", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		broadcast("inbox_changed" as never, { at: "x" });
		broadcast("something_new" as never, { session: sessionRow("s-alice", t.alice.id).session });
		expect(alice.received).toEqual([]);
		expect(web.received.map((m) => m.type)).toEqual(["inbox_changed", "something_new"]);
	});

	test("stats_updated carries team-wide counts: denied in team mode, delivered in solo", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		broadcast("stats_updated", { total: 12 });
		expect(alice.received).toEqual([]);

		await setStoredMode("solo");
		const soloAlice = await t.respondFor(t.alice, t.aliceKey);
		broadcast("stats_updated", { total: 12 });
		expect(soloAlice.received.map((m) => m.type)).toEqual(["stats_updated"]);
	});

	test("an ownerless respond key sees no owned session and no unowned one in team mode", async () => {
		const t = await team();
		const loose = await openSocket({ userId: null, keyId: t.looseKey.id, scopes: ["respond"] });
		broadcast("session_updated", sessionRow("s-alice", t.alice.id));
		broadcast("session_updated", sessionRow("s-open", null));
		expect(loose.received).toEqual([]);
	});

	test("solo mode: nothing is filtered by owner", async () => {
		const t = await team();
		await setStoredMode("solo");
		const alice = await t.respondFor(t.alice, t.aliceKey);
		broadcast("session_created", sessionRow("s-bob", t.bob.id));
		expect(alice.received.map((m) => m.data.session.sessionId)).toEqual(["s-bob"]);
	});

	test("a mobile socket never gets new_event on the sessions channel; a web socket does", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		broadcast("new_event", event("s-alice"));
		expect(alice.received).toEqual([]);
		expect(web.received.length).toBe(1);
	});

	test("a manage key that asks for the mobile profile is shaped but not owner-filtered", async () => {
		const t = await team();
		const mobileManage = await openSocket({
			userId: t.alice.id,
			scopes: ["manage"],
			profile: "mobile",
		});
		await mobileManage.subscribe("session:s-bob");

		broadcast("session_updated", sessionRow("s-bob", t.bob.id)); // another member's: still delivered
		broadcastToSession("s-bob", "new_event", event("s-bob"));

		expect(mobileManage.received.map((m) => m.type)).toEqual(["session_updated", "new_event"]);
		const shaped = mobileManage.received[1]?.data;
		expect("rawPayload" in shaped).toBe(false);
	});
});

describe("bounds on subscribe", () => {
	test("a message naming too many channels is ignored whole; one at the limit is honoured", async () => {
		const t = await team();
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		const names = (n: number) => Array.from({ length: n }, (_, i) => `c-${n}-${i}`);

		await web.subscribe(...names(WS_MAX_CHANNELS_PER_MESSAGE + 1));
		broadcast("stats_updated", {}, "c-51-0");
		expect(web.received).toEqual([]);

		await web.subscribe(...names(WS_MAX_CHANNELS_PER_MESSAGE));
		broadcast("stats_updated", {}, "c-50-0");
		expect(web.received.length).toBe(1);
		void t;
	});

	test("a socket holds at most the per-socket limit; the rest are not added", async () => {
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		// 20 messages is the burst; 5 x 50 = 250 channels fit in 5 of them.
		for (let m = 0; m < 5; m++) {
			await web.subscribe(...Array.from({ length: 50 }, (_, i) => `bulk-${m}-${i}`));
		}
		let delivered = 0;
		for (let m = 0; m < 5; m++) {
			for (let i = 0; i < 50; i++) {
				const before = web.received.length;
				broadcast("stats_updated", {}, `bulk-${m}-${i}`);
				if (web.received.length > before) delivered++;
			}
		}
		// `sessions` is already held, so 199 more fit.
		expect(delivered).toBe(WS_MAX_CHANNELS_PER_SOCKET - 1);
	});

	test("a non-array channels field is rejected, and so are non-string names", async () => {
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		await web.send({ type: "subscribe", channels: "sessions" });
		await web.send({ type: "subscribe", channels: { length: 1, 0: "x" } });
		await web.send({ type: "subscribe", channels: [1, null, {}, "ok-channel"] });
		broadcast("stats_updated", {}, "ok-channel");
		broadcast("stats_updated", {}, "x");
		expect(web.received.length).toBe(1);
	});

	test("a socket that floods control messages is cut off by the token bucket", async () => {
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		for (let i = 0; i < 100; i++) await web.subscribe(`flood-${i}`);
		let held = 0;
		for (let i = 0; i < 100; i++) {
			const before = web.received.length;
			broadcast("stats_updated", {}, `flood-${i}`);
			if (web.received.length > before) held++;
		}
		expect(held).toBeGreaterThan(0);
		expect(held).toBeLessThan(40); // the burst (20) plus whatever refilled while the loop ran
	});

	test("a rejected subscribe is answered with one small notice saying why, not dropped silently", async () => {
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		await web.subscribe(
			...Array.from({ length: WS_MAX_CHANNELS_PER_MESSAGE + 1 }, (_, i) => `n-${i}`),
		);
		expect(web.rejected).toEqual(["too_many_channels"]);
	});

	test("the notice names the cause: a non-array, the bucket, the per-socket limit", async () => {
		const notice = async (act: (s: FakeSocket) => Promise<void>) => {
			const socket = await openSocket({ scopes: ["manage"], profile: "web" });
			await act(socket);
			return socket.rejected;
		};
		expect(await notice((s) => s.send({ type: "subscribe", channels: "sessions" }))).toEqual([
			"invalid_channels",
		]);
		expect(
			await notice(async (s) => {
				for (let i = 0; i < 40; i++) await s.subscribe(`flood-${i}`);
			}),
		).toEqual(["rate_limited"]); // one notice, however many were refused
		expect(
			await notice(async (s) => {
				for (let m = 0; m < 5; m++) {
					await s.subscribe(...Array.from({ length: 50 }, (_, i) => `lim-${m}-${i}`));
				}
			}),
		).toEqual(["channel_limit"]);
	});

	test("an accepted subscribe, and an unsubscribe, get no notice", async () => {
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		await web.subscribe("a", "b");
		await web.send({ type: "unsubscribe", channels: ["a"] });
		expect(web.rejected).toEqual([]);
	});
});

describe("the sweep reads sessions in bounded queries", () => {
	test("more channels than one chunk across several sockets: each chunk is a query, and every handover is still caught", async () => {
		const t = await team();
		const total = WS_SWEEP_QUERY_CHUNK + 120;
		const ids = Array.from({ length: total }, (_, i) => `s-bulk-${i}`);
		for (let start = 0; start < ids.length; start += 100) {
			await getDb()
				.insert(sessions)
				.values(
					ids.slice(start, start + 100).map((sessionId) => ({
						sessionId,
						agentType: "claude_code",
						status: "active",
						ownerUserId: t.alice.id,
					})),
				);
		}
		const perSocket = 160;
		const sockets: FakeSocket[] = [];
		for (let first = 0; first < total; first += perSocket) {
			const socket = await t.respondFor(t.alice, t.aliceKey);
			const mine = ids.slice(first, first + perSocket);
			for (let i = 0; i < mine.length; i += 50) {
				await socket.subscribe(...mine.slice(i, i + 50).map((id) => `session:${id}`));
			}
			sockets.push(socket);
		}
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.bob.id })
			.where(eq(sessions.sessionId, ids[3] as string));
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.bob.id })
			.where(eq(sessions.sessionId, ids[total - 2] as string));

		let ownerQueries = 0;
		const realGetDb = dbClient.getDb;
		const spy = spyOn(dbClient, "getDb").mockImplementation(() => {
			const db = realGetDb();
			return new Proxy(db, {
				get(target, prop, receiver) {
					if (prop !== "select") return Reflect.get(target, prop, receiver);
					return (fields?: Record<string, unknown>) => {
						if (fields && "sessionId" in fields && "ownerUserId" in fields) ownerQueries++;
						return (target.select as (f?: unknown) => unknown)(fields);
					};
				},
			});
		});
		try {
			await heartbeatTick();
		} finally {
			spy.mockRestore();
		}

		expect(ownerQueries).toBe(Math.ceil(total / WS_SWEEP_QUERY_CHUNK));
		for (const id of [ids[3] as string, ids[total - 2] as string, ids[10] as string]) {
			broadcastToSession(id, "new_event", event(id));
		}
		const heard = sockets.flatMap((s) => s.received.map((m) => m.data.sessionId));
		expect(heard).toEqual([ids[10]]); // the two handed over are dropped, the rest still held
	});
});

describe("ongoing authorization", () => {
	test("an ownership handover drops that subscription within one sweep and leaves the socket and its other subscriptions alone", async () => {
		const t = await team();
		await seedSession("s-alice-2", t.alice.id);
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice", "session:s-alice-2", "session:s-open");
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.bob.id })
			.where(eq(sessions.sessionId, "s-alice"));

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(alice.received.length).toBe(1); // before the sweep: still subscribed

		await heartbeatTick();

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-alice-2", "new_event", event("s-alice-2"));
		broadcastToSession("s-open", "new_event", event("s-open"));
		expect(alice.closedWith()).toBeNull();
		expect(idsOf(alice)).toEqual(["s-alice", "s-alice-2", "s-open"]); // one old, two new
		expect(alice.received.slice(1).map((m) => m.data.sessionId)).toEqual(["s-alice-2", "s-open"]);
	});

	test("changing the owner through the service drops it at once, socket still open", async () => {
		const t = await team();
		await seedSession("s-alice-2", t.alice.id);
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice", "session:s-alice-2");

		await changeSessionOwner("s-alice", t.bob.id);

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-alice-2", "new_event", event("s-alice-2"));
		expect(alice.closedWith()).toBeNull();
		expect(idsOf(alice)).toEqual(["s-alice-2"]);
	});

	test("PATCH /sessions/:id/owner drops it at once", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice", "session:s-open");

		const res = await asAdmin(t.admin.id, "PATCH", "/sessions/s-alice/owner", {
			ownerUserId: t.bob.id,
		});
		expect(res.status).toBe(200);

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-open", "new_event", event("s-open"));
		expect(alice.closedWith()).toBeNull();
		expect(idsOf(alice)).toEqual(["s-open"]);
	});

	test("a launch that gives an unowned session an owner drops the members who followed it as open", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-open");
		await getDb().insert(launchRequests).values({
			id: crypto.randomUUID(),
			launchCorrelationId: "s-open",
			agentType: "claude_code",
			cwd: "/tmp/x",
			requestedLaunchMode: "interactive_terminal",
			status: "validated",
			requestedByUserId: t.bob.id,
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});

		await associateObservedSession({ sessionId: "s-open" });

		broadcastToSession("s-open", "new_event", event("s-open"));
		expect(alice.closedWith()).toBeNull();
		expect(alice.received).toEqual([]);
	});

	test("a launch whose guarded owner write changes nothing (the session already has an owner) re-judges no one", async () => {
		const t = await team();
		await getDb().insert(launchRequests).values({
			id: crypto.randomUUID(),
			launchCorrelationId: "s-bob",
			agentType: "claude_code",
			cwd: "/tmp/x",
			requestedLaunchMode: "interactive_terminal",
			status: "validated",
			requestedByUserId: t.alice.id,
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		});
		let calls = 0;
		setWsRevalidationListener(async () => {
			calls++;
		});
		try {
			await associateObservedSession({ sessionId: "s-bob" });
		} finally {
			setWsRevalidationListener(heartbeatTick);
		}
		expect(calls).toBe(0);
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "s-bob"));
		expect(row?.ownerUserId).toBe(t.bob.id);
	});

	test("a session deleted while subscribed ends the subscription on the sweep and nothing breaks", async () => {
		const t = await team();
		await seedSession("s-alice-2", t.alice.id);
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice", "session:s-alice-2");
		await getDb().delete(sessions).where(eq(sessions.sessionId, "s-alice"));

		await heartbeatTick();

		broadcastToSession("s-alice", "new_event", event("s-alice"));
		broadcastToSession("s-alice-2", "new_event", event("s-alice-2"));
		expect(alice.closedWith()).toBeNull();
		expect(idsOf(alice)).toEqual(["s-alice-2"]);
	});

	test("demoting an admin takes their reach away at once, but they still hear unowned sessions", async () => {
		const t = await team();
		const admin = await t.respondFor(t.admin, t.adminKey);
		await admin.subscribe("session:s-bob", "session:s-open");
		broadcastToSession("s-bob", "new_event", event("s-bob"));
		expect(admin.received.length).toBe(1);

		await setUserRole(t.admin.id, "user", { userId: null, label: "system" });

		broadcastToSession("s-bob", "new_event", event("s-bob"));
		broadcastToSession("s-open", "new_event", event("s-open"));
		broadcast("session_updated", sessionRow("s-bob", t.bob.id));
		broadcast("session_updated", sessionRow("s-open", null));
		expect(admin.closedWith()).toBeNull();
		expect(idsOf(admin).filter(Boolean)).toEqual(["s-bob", "s-open"]); // the first s-bob, then s-open
		const after = admin.received.slice(1);
		expect(after.map((m) => `${m.type}:${m.data.sessionId ?? m.data.session.sessionId}`)).toEqual([
			"new_event:s-open",
			"session_updated:s-open",
		]);
	});

	test("a mode switch closes the socket with the authority-changed code, at once and by sweep, solo to team too", async () => {
		const t = await team();
		const viaHook = await t.respondFor(t.alice, t.aliceKey);
		await setStoredMode("solo");
		await requestWsRevalidation();
		expect(viaHook.closedWith()?.code).toBe(WS_CLOSE_AUTHORITY_CHANGED);

		const viaSweep = await t.respondFor(t.bob, t.bobKey); // now in solo
		await setStoredMode("team");
		await heartbeatTick();
		expect(viaSweep.closedWith()?.code).toBe(WS_CLOSE_AUTHORITY_CHANGED);
	});

	test("setMode itself triggers the re-check", async () => {
		const t = await team();
		const socket = await t.respondFor(t.alice, t.aliceKey);
		await setMode(
			{ mode: "solo", serviceKeyDecisions: [] },
			{
				userId: t.admin.id,
				label: "user",
				role: "admin",
			},
		);
		expect(socket.closedWith()?.code).toBe(WS_CLOSE_AUTHORITY_CHANGED);
	});

	test("DELETE /api-keys/:id closes the socket with the auth-revoked code, at once, in team mode and in solo", async () => {
		const t = await team();
		const inTeam = await t.respondFor(t.alice, t.aliceKey);
		expect((await asAdmin(t.admin.id, "DELETE", `/api-keys/${t.aliceKey.id}`)).status).toBe(200);
		expect(inTeam.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);

		await setStoredMode("solo");
		const inSolo = await t.respondFor(t.bob, t.bobKey);
		expect((await asAdmin(t.admin.id, "DELETE", `/api-keys/${t.bobKey.id}`)).status).toBe(200);
		expect(inSolo.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);
	});

	test("a key deactivated behind the server's back, or deleted, closes the socket on the sweep", async () => {
		const t = await team();
		const deactivated = await t.respondFor(t.alice, t.aliceKey);
		const deleted = await t.respondFor(t.bob, t.bobKey);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, t.aliceKey.id));
		await getDb().delete(apiKeys).where(eq(apiKeys.id, t.bobKey.id));

		await heartbeatTick();

		expect(deactivated.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);
		expect(deleted.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);
	});

	test("PATCH /api-keys/:id handing the key to someone else ends the old identity's socket (authority changed)", async () => {
		const t = await team();
		const socket = await t.respondFor(t.alice, t.aliceKey);
		const other = await t.respondFor(t.bob, t.bobKey);

		const res = await asAdmin(t.admin.id, "PATCH", `/api-keys/${t.aliceKey.id}`, {
			ownerUserId: t.bob.id,
		});

		expect(res.status).toBe(200);
		expect(socket.closedWith()?.code).toBe(WS_CLOSE_AUTHORITY_CHANGED);
		expect(other.closedWith()).toBeNull();
	});

	test("PATCH /api-keys/:id with attributeSessions re-judges sockets whose sessions were just given an owner", async () => {
		const t = await team();
		const reporting = await seedKey("az-reporting", ["ingest"], null);
		await getDb()
			.update(sessions)
			.set({ ingestKeyId: reporting.id })
			.where(eq(sessions.sessionId, "s-open"));
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-open"); // unowned: open to a member

		const res = await asAdmin(t.admin.id, "PATCH", `/api-keys/${reporting.id}`, {
			ownerUserId: t.bob.id,
			attributeSessions: true,
		});
		expect(res.status).toBe(200);

		broadcastToSession("s-open", "new_event", event("s-open"));
		expect(alice.closedWith()).toBeNull();
		expect(alice.received).toEqual([]);
	});

	test("a socket opened for an already-revoked or missing key is closed before it hears anything", async () => {
		const t = await team();
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, t.aliceKey.id));
		await getDb().delete(apiKeys).where(eq(apiKeys.id, t.bobKey.id));
		const revoked = await t.respondFor(t.alice, t.aliceKey);
		const missing = await t.respondFor(t.bob, t.bobKey);
		broadcast("session_updated", sessionRow("s-alice", t.alice.id));
		broadcast("session_updated", sessionRow("s-bob", t.bob.id));
		for (const socket of [revoked, missing]) {
			expect(socket.closedWith()?.code).toBe(WS_CLOSE_AUTH_REVOKED);
			expect(socket.received).toEqual([]);
		}
	});

	test("a manage socket is untouched by the restricted sweep", async () => {
		const t = await team();
		const web = await openSocket({ userId: t.alice.id, scopes: ["*"], profile: "web" });
		await heartbeatTick();
		await setStoredMode("solo");
		await requestWsRevalidation();
		expect(web.closedWith()).toBeNull();
	});

	test("a subscribe that races a sweep is not undone by it", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const sweep = heartbeatTick(); // not awaited: it is mid-flight when the subscribe lands
		await alice.subscribe("session:s-alice");
		await sweep;
		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(idsOf(alice)).toEqual(["s-alice"]);
	});
});

describe("when the database fails", () => {
	test("a socket whose authority can't be resolved at open is closed, not left unjudged", async () => {
		const t = await team();
		const failing = spyOn(apiKeyModule, "getApiKeyLiveStates").mockRejectedValue(
			new Error("db down"),
		);
		try {
			const socket = await t.respondFor(t.alice, t.aliceKey);
			broadcast("session_updated", sessionRow("s-alice", t.alice.id));
			expect(socket.closedWith()?.code).toBe(1011);
			expect(socket.received).toEqual([]);
		} finally {
			failing.mockRestore();
		}
	});

	test("a refresh that fails inside a subscribe closes the socket like open does, and nothing is added", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const failing = spyOn(apiKeyModule, "getApiKeyLiveStates").mockRejectedValue(
			new Error("db down"),
		);
		const quiet = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await alice.subscribe("session:s-alice");
		} finally {
			failing.mockRestore();
			quiet.mockRestore();
		}
		expect(alice.closedWith()?.code).toBe(1011);
		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(alice.received).toEqual([]);
	});

	test("a failing identity sweep doesn't skip the restricted sweep", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice");
		await getDb()
			.update(sessions)
			.set({ ownerUserId: t.bob.id })
			.where(eq(sessions.sessionId, "s-alice"));
		const failing = spyOn(apiKeyModule, "getInactiveApiKeyIds").mockRejectedValue(
			new Error("db down"),
		);
		const quiet = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await heartbeatTick();
		} finally {
			failing.mockRestore();
			quiet.mockRestore();
		}
		broadcastToSession("s-alice", "new_event", event("s-alice"));
		expect(alice.received).toEqual([]);
	});
});

describe("the mobile profile", () => {
	test("a respond socket never sees rawPayload; content, tool input and tool response are bounded and say so", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		const web = await openSocket({ scopes: ["manage"], profile: "web" });
		await alice.subscribe("session:s-alice");
		await web.subscribe("session:s-alice");
		const big = "é".repeat(5000);

		broadcastToSession(
			"s-alice",
			"new_event",
			event("s-alice", {
				content: big,
				toolResponse: big,
				toolInput: { command: big, path: "a.ts", nested: { blob: big } },
			}),
		);

		const got = alice.received[0]?.data;
		const bytes = (text: string) => new TextEncoder().encode(text).length;
		expect("rawPayload" in got).toBe(false);
		expect(JSON.stringify(alice.received)).not.toContain("do-not-send");
		expect(bytes(got.content)).toBeLessThanOrEqual(2048);
		expect(got.contentTruncated).toBe(true);
		expect(bytes(got.toolResponse)).toBeLessThanOrEqual(2048);
		expect(got.toolResponseTruncated).toBe(true);
		// the type is kept: still an object, a bounded preview of the top-level entries
		expect(typeof got.toolInput).toBe("object");
		expect(got.toolInputTruncated).toBe(true);
		expect(bytes(JSON.stringify(got.toolInput))).toBeLessThanOrEqual(2048);
		expect(got.toolInput.path).toBe("a.ts");
		expect(bytes(got.toolInput.command)).toBeLessThanOrEqual(256);
		expect("nested" in got.toolInput).toBe(false);
		expect(got.eventType).toBe("assistant_message");
		// positive control: the same event reaches a web socket whole
		const whole = web.received.find((m) => m.type === "new_event")?.data;
		expect(whole.rawPayload).toEqual({ secret: "do-not-send" });
		expect(whole.content).toBe(big);
		expect("contentTruncated" in whole).toBe(false);
	});

	test("a small event passes through unchanged apart from the raw payload, with no truncation flags", async () => {
		const t = await team();
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe("session:s-alice");
		broadcastToSession("s-alice", "new_event", event("s-alice", { toolInput: { path: "a.ts" } }));
		const got = alice.received[0]?.data;
		expect(got.content).toBe("hello");
		expect(got.toolInput).toEqual({ path: "a.ts" });
		for (const flag of ["contentTruncated", "toolInputTruncated", "toolResponseTruncated"]) {
			expect(flag in got).toBe(false);
		}
	});

	test("an idle respond socket with ten sessions is sent at most 5 KB in a minute: sweeps send nothing, heartbeats are summed as sent", async () => {
		const t = await team();
		for (let i = 0; i < 10; i++) await seedSession(`s-idle-${i}`, t.alice.id);
		const alice = await t.respondFor(t.alice, t.aliceKey);
		await alice.subscribe(...Array.from({ length: 10 }, (_, i) => `session:s-idle-${i}`));

		await heartbeatTick();
		await heartbeatTick();
		await heartbeatTick();
		expect(alice.bytes()).toBe(0);

		const beats = Math.ceil(60_000 / WS_HEARTBEAT_INTERVAL_MS);
		for (let i = 0; i < beats; i++) sendHeartbeats();
		expect(alice.bytes()).toBeGreaterThan(0);
		expect(alice.bytes()).toBeLessThanOrEqual(5 * 1024);
	});
});
