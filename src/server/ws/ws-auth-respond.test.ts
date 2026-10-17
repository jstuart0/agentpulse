/**
 * The WebSocket upgrade for the mobile companion: a Bearer `ap_` key may open a
 * socket with no Origin header (a native client sends none); a browser identity
 * (cookie, SSO) and auth-off never may. `respond` opens a socket and is forced
 * into the mobile profile; `observe` and `ingest` still don't open one.
 * Drives the real upgrade path against a real Bun.serve and a real client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { createUser, issueSession, SESSION_COOKIE_NAME } = await import(
	"../services/local-auth-service.js"
);
const { createApiKey } = await import("../auth/api-key.js");
const { handleWsOpen, handleWsMessage, handleWsClose } = await import("./handler.js");
const { guardWsUpgrade, handleWsUpgradeRequest } = await import("./ws-auth.js");

const originalDisableAuth = config.disableAuth;
const ORIGIN = config.allowedOrigins[0] as string;
const FOREIGN_ORIGIN = "https://evil.example";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const opened: WebSocket[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req, srv) {
			return handleWsUpgradeRequest(req, srv as Parameters<typeof handleWsUpgradeRequest>[1]);
		},
		websocket: { open: handleWsOpen, message: handleWsMessage, close: handleWsClose },
	});
	baseUrl = `127.0.0.1:${server.port}`;
});

afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = false;
	for (const ws of opened.splice(0)) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
	await resetIdentityState();
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	server.stop(true);
});

/** True when a real socket opens with exactly these request headers. */
async function opens(headers: Record<string, string>, query = ""): Promise<boolean> {
	const ws = new WebSocket(`ws://${baseUrl}/api/v1/ws${query}`, { headers } as unknown as string[]);
	opened.push(ws);
	return new Promise((resolve) => {
		ws.addEventListener("open", () => resolve(true));
		ws.addEventListener("error", () => resolve(false));
		ws.addEventListener("close", () => resolve(false));
	});
}

/** The status the upgrade path answers a plain request with. */
async function status(headers: Record<string, string>): Promise<number> {
	return (await fetch(`http://${baseUrl}/api/v1/ws`, { headers })).status;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe("respond key: Bearer with no Origin", () => {
	test("a respond key opens a socket with no Origin header", async () => {
		const { key } = await createApiKey("ws-respond", ["respond"]);
		expect(await opens(bearer(key))).toBe(true);
	});

	test("a manage key also opens with no Origin (the native client may hold either)", async () => {
		const { key } = await createApiKey("ws-manage", ["manage"]);
		expect(await opens(bearer(key))).toBe(true);
	});

	test("a respond key with the configured Origin still opens", async () => {
		const { key } = await createApiKey("ws-respond-origin", ["respond"]);
		expect(await opens({ Origin: ORIGIN, ...bearer(key) })).toBe(true);
	});
});

describe("what still refuses", () => {
	test("a cookie user with no Origin -> 403 (the browser rule is unchanged)", async () => {
		const user = await createUser({
			username: `ws-cookie-${crypto.randomUUID().slice(0, 8)}`,
			password: "a-very-long-password-123",
			role: "user",
		});
		const { token } = await issueSession({ userId: user.id });
		const cookie = { Cookie: `${SESSION_COOKIE_NAME}=${token}` };
		expect(await status(cookie)).toBe(403);
		expect(await status({ Origin: ORIGIN, ...cookie })).not.toBe(403);
	});

	test("a respond key with a foreign Origin -> 403 (a present Origin is always judged)", async () => {
		const { key } = await createApiKey("ws-respond-foreign", ["respond"]);
		expect(await status({ Origin: FOREIGN_ORIGIN, ...bearer(key) })).toBe(403);
		expect(await opens({ Origin: FOREIGN_ORIGIN, ...bearer(key) })).toBe(false);
	});

	test("an observe key -> 403, with or without an Origin", async () => {
		const { key } = await createApiKey("ws-observe", ["observe"]);
		expect(await status({ Origin: ORIGIN, ...bearer(key) })).toBe(403);
		expect(await status(bearer(key))).toBe(403);
		expect(await opens(bearer(key))).toBe(false);
	});

	test("an ingest key -> 403", async () => {
		const { key } = await createApiKey("ws-ingest", ["ingest"]);
		expect(await status({ Origin: ORIGIN, ...bearer(key) })).toBe(403);
	});

	test("an unknown Bearer key or no credential, with no Origin -> 403, never an upgrade", async () => {
		expect(await status(bearer("ap_00000000000000000000000000000000"))).toBe(403);
		expect(await status({})).toBe(403);
	});

	test("auth off: a no-Origin socket is refused even with a Bearer header", async () => {
		const { key } = await createApiKey("ws-authoff", ["respond"]);
		(config as Record<string, unknown>).disableAuth = true;
		expect(await status(bearer(key))).toBe(403);
		expect(await status({ Origin: ORIGIN })).not.toBe(403);
	});
});

describe("the identity a socket carries", () => {
	function headers(key: string) {
		return new Headers(bearer(key));
	}

	test("a respond key carries its scopes and is forced into the mobile profile", async () => {
		const { key, id } = await createApiKey("ws-data-respond", ["respond"]);
		const web = await guardWsUpgrade(headers(key), { originPresent: false });
		const forced = await guardWsUpgrade(headers(key), {
			originPresent: false,
			requestedProfile: "web",
		});
		for (const decision of [web, forced]) {
			expect(decision.allowed).toBe(true);
			if (!decision.allowed) return;
			expect(decision.data).toEqual({
				userId: null,
				keyId: id,
				scopes: ["respond"],
				profile: "mobile",
			});
		}
	});

	test("a manage key is web by default and mobile only on request", async () => {
		const { key } = await createApiKey("ws-data-manage", ["manage"]);
		const plain = await guardWsUpgrade(headers(key));
		const asked = await guardWsUpgrade(headers(key), { requestedProfile: "mobile" });
		expect(plain.allowed && plain.data.profile).toBe("web");
		expect(asked.allowed && asked.data.profile).toBe("mobile");
	});

	test("a key with respond and manage is a full reader: web by default", async () => {
		const { key } = await createApiKey("ws-data-both", ["respond", "manage"]);
		const decision = await guardWsUpgrade(headers(key));
		expect(decision.allowed && decision.data.profile).toBe("web");
	});
});
