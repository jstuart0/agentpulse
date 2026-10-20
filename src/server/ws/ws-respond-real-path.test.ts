/**
 * The mobile companion's socket end to end: a real Bun.serve with the server's
 * own WebSocket handlers (limits included), a real client, and real keys in
 * team mode. Proves what an in-process stand-in can't: that the profile, the
 * subscribe authorization and the feed filter survive the actual upgrade, and
 * that the inbound frame limit is enforced without breaking an ordinary client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { sessions } = await import("../db/schema/index.js");
const { issueSession, SESSION_COOKIE_NAME } = await import("../services/local-auth-service.js");
const { WS_MAX_INBOUND_BYTES, WS_MAX_SOCKETS_PER_KEY, broadcast, broadcastToSession, wsHandlers } =
	await import("./handler.js");
const { handleWsUpgradeRequest } = await import("./ws-auth.js");

const originalDisableAuth = config.disableAuth;
const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;
const originalProvider = process.env.FORWARDAUTH_PROVIDER;
const ORIGIN = config.allowedOrigins[0] as string;
const TRUST_SECRET = "ws-real-path-secret-32-characters!!";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const opened: WebSocket[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	process.env.FORWARDAUTH_TRUST_SECRET = TRUST_SECRET;
	process.env.FORWARDAUTH_PROVIDER = "authentik";
	// biome-ignore lint/performance/noDelete: clear the memoised trust secret so the env value takes effect
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req, srv) {
			return handleWsUpgradeRequest(req, srv as Parameters<typeof handleWsUpgradeRequest>[1]);
		},
		websocket: wsHandlers,
	});
	baseUrl = `127.0.0.1:${server.port}`;
});

afterEach(async () => {
	for (const ws of opened.splice(0)) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalSecret === undefined) process.env.FORWARDAUTH_TRUST_SECRET = undefined;
	else process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
	if (originalProvider === undefined) process.env.FORWARDAUTH_PROVIDER = undefined;
	else process.env.FORWARDAUTH_PROVIDER = originalProvider;
	// biome-ignore lint/performance/noDelete: clear memo for teardown parity
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
	server.stop(true);
});

interface Client {
	ws: WebSocket;
	received: Array<{ type: string; data: any }>;
	closed: Promise<{ code: number }>;
	send: (message: unknown) => void;
}

/** A real client; a native one sends a Bearer key and no Origin. */
async function connect(headers: Record<string, string>, query = ""): Promise<Client> {
	const ws = new WebSocket(`ws://${baseUrl}/api/v1/ws${query}`, { headers } as unknown as string[]);
	opened.push(ws);
	const received: Client["received"] = [];
	ws.addEventListener("message", (e) => {
		const parsed = JSON.parse(String(e.data));
		if (parsed.type !== "heartbeat") received.push(parsed);
	});
	const closed = new Promise<{ code: number }>((resolve) =>
		ws.addEventListener("close", (e) => resolve({ code: e.code })),
	);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("socket did not open")));
	});
	await Bun.sleep(40); // the server-side open handler resolves the socket's authority
	return { ws, received, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

const settle = () => Bun.sleep(80);
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("rp-alice");
	const bob = await seedLocalUser("rp-bob");
	const aliceRespond = await seedKey("rp-alice-respond", ["respond"], alice.id);
	const aliceManage = await seedKey("rp-alice-manage", ["manage"], alice.id);
	for (const [id, owner] of [
		["rp-alice", alice.id],
		["rp-bob", bob.id],
	] as const) {
		await getDb()
			.insert(sessions)
			.values({ sessionId: id, agentType: "claude_code", status: "active", ownerUserId: owner });
	}
	return { alice, bob, aliceRespond, aliceManage };
}

const event = (sessionId: string) => ({
	id: 1,
	sessionId,
	eventType: "assistant_message",
	content: "hi",
	toolInput: null,
	toolResponse: null,
	rawPayload: { secret: "do-not-send", duration_ms: 1500 },
	createdAt: "2026-10-01T00:00:00.000Z",
});

describe("a respond key over a real socket", () => {
	test("`*` and another member's session are dropped; its own session and the filtered feed arrive", async () => {
		const t = await team();
		const phone = await connect(bearer(t.aliceRespond.key));

		phone.send({ type: "subscribe", channels: ["*", "session:rp-bob"] });
		await settle();
		broadcast("stats_updated", {}, "any-channel");
		broadcastToSession("rp-bob", "new_event", event("rp-bob"));
		await settle();
		expect(phone.received).toEqual([]);

		phone.send({ type: "subscribe", channels: ["session:rp-alice"] });
		await settle();
		broadcastToSession("rp-alice", "new_event", event("rp-alice"));
		broadcast("session_updated", { session: { sessionId: "rp-bob", ownerUserId: t.bob.id } });
		broadcast("session_updated", { session: { sessionId: "rp-alice", ownerUserId: t.alice.id } });
		await settle();

		expect(
			phone.received.map((m) => `${m.type}:${m.data.sessionId ?? m.data.session.sessionId}`),
		).toEqual(["new_event:rp-alice", "session_updated:rp-alice"]);
		// only the duration/outcome subset crosses (F106); the rest of the raw payload never does
		expect(phone.received[0].data.rawPayload).toEqual({ duration_ms: 1500 });
	});

	test("a manage key that asks for ?profile=mobile gets no rawPayload but is not owner-filtered", async () => {
		const t = await team();
		const phone = await connect(bearer(t.aliceManage.key), "?profile=mobile");
		phone.send({ type: "subscribe", channels: ["session:rp-bob"] });
		await settle();

		broadcastToSession("rp-bob", "new_event", event("rp-bob"));
		broadcast("session_updated", { session: { sessionId: "rp-bob", ownerUserId: t.bob.id } });
		await settle();

		expect(phone.received.map((m) => m.type)).toEqual(["new_event", "session_updated"]);
		// only the duration/outcome subset crosses (F106); the rest of the raw payload never does
		expect(phone.received[0].data.rawPayload).toEqual({ duration_ms: 1500 });
	});

	test("a manage key with no profile gets the dashboard feed, raw payload included", async () => {
		const t = await team();
		const web = await connect(bearer(t.aliceManage.key));
		web.send({ type: "subscribe", channels: ["session:rp-bob"] });
		await settle();
		broadcastToSession("rp-bob", "new_event", event("rp-bob"));
		await settle();
		expect(web.received[0]?.data.rawPayload).toEqual({ secret: "do-not-send", duration_ms: 1500 });
	});
});

describe("the inbound frame limit", () => {
	test("a frame over the limit ends the connection; an ordinary subscribe on the same server still works", async () => {
		const t = await team();
		const ordinary = await connect(bearer(t.aliceRespond.key));
		ordinary.send({ type: "subscribe", channels: ["session:rp-alice"] });
		await settle();
		broadcastToSession("rp-alice", "new_event", event("rp-alice"));
		await settle();
		expect(ordinary.received.length).toBe(1);

		const abusive = await connect(bearer(t.aliceRespond.key));
		abusive.send({ type: "subscribe", channels: ["x".repeat(WS_MAX_INBOUND_BYTES + 1)] });
		const verdict = await Promise.race([
			abusive.closed,
			Bun.sleep(1500).then(() => ({ code: -1 })),
		]);
		expect(verdict.code).not.toBe(-1);
	});
});

describe("no-Origin refusals", () => {
	async function status(headers: Record<string, string>): Promise<number> {
		return (await fetch(`http://${baseUrl}/api/v1/ws`, { headers })).status;
	}

	test("a forwardauth (SSO) identity with no Origin -> 403; with the configured Origin it gets past the check", async () => {
		const sso = {
			"X-Authentik-Username": "rp-sso-user",
			"X-Authentik-Uid": "rp-sso-subject",
			"X-Authentik-Verify": TRUST_SECRET,
		};
		expect(await status(sso)).toBe(403);
		expect(await status({ Origin: ORIGIN, ...sso })).not.toBe(403);
	});

	test("an invalid ap_ Bearer next to a valid cookie, no Origin -> 403 (the Bearer is authoritative, and it is wrong)", async () => {
		const user = await seedLocalUser("rp-cookie");
		const { token } = await issueSession({ userId: user.id });
		const cookie = `${SESSION_COOKIE_NAME}=${token}`;
		const headers = { Cookie: cookie, Authorization: "Bearer ap_00000000000000000000000000000000" };
		expect(await status(headers)).toBe(403);
		expect(await status({ Cookie: cookie })).toBe(403);
	});

	test("a valid respond Bearer with a valid cookie and no Origin opens (the key is the identity)", async () => {
		const t = await team();
		const { token } = await issueSession({ userId: t.alice.id });
		const phone = await connect({
			...bearer(t.aliceRespond.key),
			Cookie: `${SESSION_COOKIE_NAME}=${token}`,
		});
		expect(phone.ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe("sockets per key", () => {
	const upgradeStatus = async (headers: Record<string, string>) =>
		(await fetch(`http://${baseUrl}/api/v1/ws`, { headers })).status;

	test("a key holding the cap of open sockets is refused with 429 at the upgrade; another key and a freed slot are not", async () => {
		const t = await team();
		const clients: Client[] = [];
		for (let i = 0; i < WS_MAX_SOCKETS_PER_KEY; i++) {
			clients.push(await connect(bearer(t.aliceRespond.key)));
		}

		expect(await upgradeStatus(bearer(t.aliceRespond.key))).toBe(429);
		expect(await upgradeStatus(bearer(t.aliceManage.key))).not.toBe(429); // another key
		expect(await connect(bearer(t.aliceManage.key))).toBeDefined();

		clients[0]?.ws.close();
		await Bun.sleep(150);
		expect(await upgradeStatus(bearer(t.aliceRespond.key))).not.toBe(429);
	});
});
