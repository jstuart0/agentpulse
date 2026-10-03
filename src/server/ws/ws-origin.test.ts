/**
 * Which Origins may open the live-update WebSocket: the configured allowlist,
 * or an Origin that is the request's own (its host and port equal the Host
 * header — the rule the admin routes use). With authentication on, an install
 * opened on any address other than its configured public URL still gets live
 * updates. With authentication off nothing identifies the caller, so a
 * same-origin request counts only when the Host is a loopback address or an
 * allowlisted name (a page on a hostile name that resolves to 127.0.0.1 is
 * refused). A foreign Origin, the literal "null", anything that only looks like
 * the host (a path, userinfo, another port) and a request with no Host at all
 * are refused. Driven through the server's real request handler against a real
 * server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { handleWsOpen, handleWsMessage, handleWsClose } = await import("./handler.js");
const { handleServerRequest } = await import("../server-fetch.js");

const originalDisableAuth = config.disableAuth;
const CONFIGURED_ORIGIN = config.allowedOrigins[0] as string;

let server: ReturnType<typeof Bun.serve>;
let hostAndPort = "";
const opened: WebSocket[] = [];

beforeAll(async () => {
	await initializeDatabase();
	// Authentication has its own tests; here every request passes it.
	(config as Record<string, unknown>).disableAuth = true;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: handleServerRequest,
		websocket: { open: handleWsOpen, message: handleWsMessage, close: handleWsClose },
	});
	hostAndPort = `127.0.0.1:${server.port}`;
});

afterEach(() => {
	(config as Record<string, unknown>).disableAuth = true;
	for (const ws of opened.splice(0)) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	server.stop(true);
});

/** The real upgrade path's answer to a plain request: 403 when the Origin is refused, anything else when it got past the check. */
async function verdict(origin: string | null, host?: string, path = "/api/v1/ws"): Promise<number> {
	const headers: Record<string, string> = {};
	if (origin !== null) headers.Origin = origin;
	if (host) headers.Host = host;
	return (await fetch(`http://${hostAndPort}${path}`, { headers })).status;
}

async function opensSocket(origin: string, path = "/api/v1/ws"): Promise<boolean> {
	const ws = new WebSocket(`ws://${hostAndPort}${path}`, {
		headers: { Origin: origin },
	} as unknown as string[]);
	opened.push(ws);
	return new Promise((resolve) => {
		ws.addEventListener("open", () => resolve(true));
		ws.addEventListener("error", () => resolve(false));
		ws.addEventListener("close", () => resolve(false));
	});
}

describe("accepted origins", () => {
	test("an origin on the configured allowlist is accepted", async () => {
		expect(await verdict(CONFIGURED_ORIGIN)).not.toBe(403);
	});

	test("the request's own origin is accepted, so a socket really opens", async () => {
		expect(await opensSocket(`http://${hostAndPort}`)).toBe(true);
	});

	test("with authentication on, whatever address the app was reached on counts, with the scheme's default port implied", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		for (const [origin, host] of [
			["http://198.51.100.20:3000", "198.51.100.20:3000"],
			["http://dash.example", "dash.example"],
			["https://dash.example", "dash.example"],
			["http://DASH.Example:8080", "dash.example:8080"],
			["http://localhost:3000", "localhost:3000"],
		] as const) {
			expect({ origin, host, status: await verdict(origin, host) }).not.toEqual({
				origin,
				host,
				status: 403,
			});
		}
	});

	test("with authentication off, a loopback host is accepted", async () => {
		for (const [origin, host] of [
			["http://localhost:3000", "localhost:3000"],
			["http://LOCALHOST:3000", "localhost:3000"],
			["http://127.0.0.1:3000", "127.0.0.1:3000"],
			["http://127.5.6.7:3000", "127.5.6.7:3000"],
			["http://[::1]:3000", "[::1]:3000"],
			["http://localhost", "localhost"],
		] as const) {
			expect({ origin, host, status: await verdict(origin, host) }).not.toEqual({
				origin,
				host,
				status: 403,
			});
		}
	});

	test("with authentication off, an allowlisted name is accepted as the request's own origin", async () => {
		const original = process.env.PUBLIC_URL;
		process.env.PUBLIC_URL = "https://dash.example,http://localhost:5173";
		try {
			for (const [origin, host] of [
				["http://dash.example", "dash.example"],
				["https://dash.example", "dash.example"],
				["http://dash.example:8080", "dash.example:8080"],
			] as const) {
				expect({ origin, host, status: await verdict(origin, host) }).not.toEqual({
					origin,
					host,
					status: 403,
				});
			}
		} finally {
			if (original === undefined) Reflect.deleteProperty(process.env, "PUBLIC_URL");
			else process.env.PUBLIC_URL = original;
		}
	});
});

describe("refused origins", () => {
	test("a foreign origin, even one that matches no host header", async () => {
		expect(await verdict("https://evil.example")).toBe(403);
		expect(await verdict("http://evil.example:3000", "app.example:3000")).toBe(403);
	});

	test("the literal null origin", async () => {
		expect(await verdict("null")).toBe(403);
	});

	test("no origin at all", async () => {
		expect(await verdict(null)).toBe(403);
	});

	test("something that only looks like the host", async () => {
		const host = "app.example:3000";
		for (const origin of [
			"http://app.example:3001", // another port
			"http://app.example", // another (default) port
			"https://app.example:3000/", // trailing slash
			"http://app.example:3000/path",
			"http://user@app.example:3000",
			"http://app.example:3000?x=1",
			"ftp://app.example:3000",
			"app.example:3000",
		]) {
			expect({ origin, status: await verdict(origin, host) }).toEqual({ origin, status: 403 });
		}
	});

	test("with authentication off, a same-origin request on any other name or address", async () => {
		for (const [origin, host] of [
			["http://198.51.100.20:3000", "198.51.100.20:3000"],
			["http://dash.example", "dash.example"],
			["https://evil.example", "evil.example"],
			["http://localhost.evil.example:3000", "localhost.evil.example:3000"],
			["http://127.0.0.1.evil.example:3000", "127.0.0.1.evil.example:3000"],
			["http://128.0.0.1:3000", "128.0.0.1:3000"],
		] as const) {
			expect({ origin, host, status: await verdict(origin, host) }).toEqual({
				origin,
				host,
				status: 403,
			});
		}
	});

	test("a request with no Host header, whatever the origin and the auth mode", async () => {
		for (const disableAuth of [true, false]) {
			(config as Record<string, unknown>).disableAuth = disableAuth;
			for (const origin of [CONFIGURED_ORIGIN, "http://localhost:3000"]) {
				const req = new Request(`http://${hostAndPort}/api/v1/ws`, { headers: { Origin: origin } });
				expect(req.headers.get("Host")).toBeNull();
				const res = await handleServerRequest(req, server);
				expect({ disableAuth, origin, status: res.status }).toEqual({
					disableAuth,
					origin,
					status: 403,
				});
			}
		}
	});

	test("a socket from a foreign origin never opens", async () => {
		expect(await opensSocket("https://evil.example")).toBe(false);
	});
});

describe("the app-api path alias", () => {
	const ALIAS = "/app-api/v1/ws";

	test("goes through the same origin guard: a foreign origin is refused, the request's own is accepted", async () => {
		expect(await verdict("https://evil.example", undefined, ALIAS)).toBe(403);
		expect(await verdict(null, undefined, ALIAS)).toBe(403);
		expect(await verdict(`http://${hostAndPort}`, hostAndPort, ALIAS)).not.toBe(403);
	});

	test("opens a socket for the request's own origin and never for a foreign one", async () => {
		expect(await opensSocket(`http://${hostAndPort}`, ALIAS)).toBe(true);
		expect(await opensSocket("https://evil.example", ALIAS)).toBe(false);
	});
});

describe("an uppercase Host header", () => {
	async function throughHandler(origin: string, host: string, path = "/api/v1/ws") {
		const req = new Request(`http://${hostAndPort}${path}`, {
			headers: { Origin: origin, Host: host },
		});
		return (await handleServerRequest(req, server)).status;
	}

	test("with authentication on, matches the same origin written in lowercase", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		expect(await throughHandler("http://dash.example:8080", "DASH.Example:8080")).not.toBe(403);
		expect(await throughHandler("http://DASH.EXAMPLE:8080", "dash.example:8080")).not.toBe(403);
		expect(await throughHandler("http://dash.example:8080", "DASH.Example:8081")).toBe(403);
	});

	test("with authentication off, a loopback name in capitals is still loopback and another name is still refused", async () => {
		expect(await throughHandler("http://localhost:4567", "LOCALHOST:4567")).not.toBe(403);
		expect(await throughHandler("http://dash.example:3000", "DASH.EXAMPLE:3000")).toBe(403);
	});

	test("the alias applies the same rule", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		expect(
			await throughHandler("http://dash.example:8080", "DASH.Example:8080", "/app-api/v1/ws"),
		).not.toBe(403);
	});
});
