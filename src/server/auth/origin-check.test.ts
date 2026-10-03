/**
 * The Origin check on always-admin MUTATING routes: a request carrying an
 * Origin that is neither configured (the same list the WebSocket upgrade
 * uses) nor the same origin as the request itself (its host and port equal the
 * Host header) is refused with bad_origin; an allowed Origin, or none at all
 * (curl, scripts, MCP), is judged by authentication alone. Reads and every
 * existing route are untouched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono as HonoApp } from "hono";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { Hono } = await import("hono");
const { ALWAYS_ADMIN_ROUTES, requireRolePolicy } = await import("./route-scope-policy.js");

const originalDisableAuth = config.disableAuth;
const originalPublicUrl = process.env.PUBLIC_URL;
const ALLOWED = "https://agentpulse.example.test";
const FOREIGN = "https://evil.example.test";

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalPublicUrl === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an absent env var
		delete process.env.PUBLIC_URL;
	} else {
		process.env.PUBLIC_URL = originalPublicUrl;
	}
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(async () => {
	await reset();
	process.env.PUBLIC_URL = `${ALLOWED},http://localhost:5173`;
});
afterEach(reset);

const MUTATING = [...ALWAYS_ADMIN_ROUTES.keys()].filter((entry) => !entry.startsWith("GET "));

function miniApp() {
	const app = new Hono();
	app.use("*", requireRolePolicy());
	for (const entry of ALWAYS_ADMIN_ROUTES.keys()) {
		const [method, template] = entry.split(" ");
		app.on(method, template, (c) => c.json({ reached: true }));
	}
	return app;
}

async function send(app: HonoApp, entry: string, headers: Headers) {
	const [method, template] = entry.split(" ");
	const res = await app.request(template.replace(/:[A-Za-z]+/g, "abc"), { method, headers });
	return { status: res.status, body: (await res.json()) as { error?: string; reached?: boolean } };
}

describe("on an always-admin mutating route", () => {
	test("a foreign Origin is refused with bad_origin, for every mutating entry", async () => {
		const admin = await seedLocalUser("oc-admin", "admin");
		const app = miniApp();
		expect(MUTATING.length).toBe(10);
		for (const entry of MUTATING) {
			const headers = await cookieHeadersFor(admin.id);
			headers.set("Origin", FOREIGN);
			const { status, body } = await send(app, entry, headers);
			expect({ entry, status, error: body.error }).toEqual({
				entry,
				status: 403,
				error: "bad_origin",
			});
		}
	});

	test("an allowed Origin passes, as does a dev origin from the same list", async () => {
		const admin = await seedLocalUser("oc-allowed", "admin");
		const app = miniApp();
		for (const origin of [ALLOWED, "http://localhost:5173"]) {
			const headers = await cookieHeadersFor(admin.id);
			headers.set("Origin", origin);
			const { status, body } = await send(app, "PATCH /sessions/:sessionId/owner", headers);
			expect({ origin, status, reached: body.reached }).toEqual({
				origin,
				status: 200,
				reached: true,
			});
		}
	});

	test("no Origin at all passes (curl, scripts, MCP are judged by auth alone)", async () => {
		const admin = await seedLocalUser("oc-none", "admin");
		const app = miniApp();
		const { status, body } = await send(
			app,
			"PATCH /sessions/:sessionId/owner",
			await cookieHeadersFor(admin.id),
		);
		expect(status).toBe(200);
		expect(body.reached).toBe(true);
	});

	test("an API key with a foreign Origin is refused too: the check is about the browser, not the credential", async () => {
		const { key } = await seedKey("oc-key", ["manage"]);
		const app = miniApp();
		const headers = bearerHeaders(key, { Origin: FOREIGN });
		const { status, body } = await send(app, "PATCH /sessions/:sessionId/owner", headers);
		expect(status).toBe(403);
		expect(body.error).toBe("bad_origin");
	});

	test("an unauthenticated request is still 401, whatever the Origin", async () => {
		const app = miniApp();
		const { status } = await send(
			app,
			"PATCH /sessions/:sessionId/owner",
			new Headers({ Origin: FOREIGN }),
		);
		expect(status).toBe(401);
	});

	test("a read on an always-admin route (GET /users) ignores the Origin", async () => {
		const admin = await seedLocalUser("oc-read", "admin");
		const app = miniApp();
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", FOREIGN);
		const { status } = await send(app, "GET /users", headers);
		expect(status).toBe(200);
	});

	test("the DISABLE_AUTH operator is subject to the check as well", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const app = miniApp();
		const { status, body } = await send(
			app,
			"PATCH /sessions/:sessionId/owner",
			new Headers({ Origin: FOREIGN }),
		);
		expect(status).toBe(403);
		expect(body.error).toBe("bad_origin");
	});
});

describe("existing routes are unaffected", () => {
	test("PUT /sessions/:id/notes with a foreign Origin still works", async () => {
		const { app } = await import("../app.js");
		const admin = await seedLocalUser("oc-notes", "admin");
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", FOREIGN);
		const res = await app.request(
			"/api/v1/sessions/origin-check-session/notes",
			jsonRequest("PUT", { notes: "hello" }, headers),
		);
		expect(res.status).toBe(200);
	});

	test("PUT /settings/workspace with a foreign Origin still works (a team-admin route is not always-admin)", async () => {
		const { app } = await import("../app.js");
		const admin = await seedLocalUser("oc-workspace", "admin");
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", FOREIGN);
		const res = await app.request("/api/v1/settings/workspace", jsonRequest("PUT", {}, headers));
		expect(res.status).toBe(200);
	});
});

describe("same-origin requests need no configuration", () => {
	const route = "PATCH /sessions/:sessionId/owner";
	async function sendFrom(origin: string | null, host: string | null) {
		const admin = await seedLocalUser(`oc-same-${crypto.randomUUID().slice(0, 6)}`, "admin");
		const headers = await cookieHeadersFor(admin.id);
		if (origin !== null) headers.set("Origin", origin);
		if (host !== null) headers.set("Host", host);
		return send(miniApp(), route, headers);
	}

	test("an Origin whose host and port are the request's Host passes, on a host nobody configured", async () => {
		for (const [origin, host] of [
			["http://127.0.0.1:3000", "127.0.0.1:3000"],
			["http://192.0.2.20:3000", "192.0.2.20:3000"],
			["https://notes.lan", "notes.lan"],
			["https://Notes.LAN", "notes.lan"],
		] as const) {
			const { status, body } = await sendFrom(origin, host);
			expect({ origin, host, status, reached: body.reached }).toEqual({
				origin,
				host,
				status: 200,
				reached: true,
			});
		}
	});

	test("a different host or port is still refused", async () => {
		for (const [origin, host] of [
			["http://127.0.0.1:3001", "127.0.0.1:3000"],
			["http://evil.example.test:3000", "127.0.0.1:3000"],
			["http://127.0.0.1", "127.0.0.1:3000"],
		] as const) {
			const { status, body } = await sendFrom(origin, host);
			expect({ origin, host, status, error: body.error }).toEqual({
				origin,
				host,
				status: 403,
				error: "bad_origin",
			});
		}
	});

	test("an Origin that only looks like the host (path, userinfo, fragment) is refused", async () => {
		for (const origin of [
			"https://evil.example.test/127.0.0.1:3000",
			"http://127.0.0.1:3000@evil.example.test",
			"http://evil.example.test#@127.0.0.1:3000",
			"http://127.0.0.1:3000/",
			"http://127.0.0.1:3000?x=1",
		]) {
			const { status, body } = await sendFrom(origin, "127.0.0.1:3000");
			expect({ origin, status, error: body.error }).toEqual({
				origin,
				status: 403,
				error: "bad_origin",
			});
		}
	});

	test("Origin: null is refused, even when the Host is also called null", async () => {
		for (const host of ["null", "127.0.0.1:3000", null]) {
			const { status, body } = await sendFrom("null", host);
			expect({ host, status, error: body.error }).toEqual({
				host,
				status: 403,
				error: "bad_origin",
			});
		}
	});

	test("with no Host header only the configured list applies", async () => {
		expect((await sendFrom("http://127.0.0.1:3000", null)).status).toBe(403);
		expect((await sendFrom(ALLOWED, null)).status).toBe(200);
	});
});
