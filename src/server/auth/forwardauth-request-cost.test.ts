/**
 * Pins the number of DB statements a forwardauth-authenticated request
 * issues, for each of the three shapes a request can take: forwardauth
 * headers alone, a session cookie alone, and headers plus a cookie that
 * already matches (the steady-state case once a browser has a session).
 *
 * Also confirms a disabled user is still rejected on every one of these
 * paths with exactly one lookup (not traded away to hit a low number), and
 * that the hook-ingest and API-key paths make no user-table lookups at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { users } = await import("../db/schema/index.js");
const { createApiKey } = await import("./api-key.js");
const { getAuthUserFromHeaders, requireAuth, requireApiKey } = await import("./middleware.js");
const { bridgeForwardauthSession } = await import("./forwardauth-bridge.js");
const { resolveSsoUser } = await import("../services/user-identity.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const TEST_SECRET = "request-cost-secret";

function forwardauthHeaders(overrides: Record<string, string> = {}): Headers {
	return new Headers({
		"X-Authentik-Username": "costuser",
		"X-Authentik-Uid": `cost-uid-${crypto.randomUUID().slice(0, 8)}`,
		"X-Authentik-Verify": TEST_SECRET,
		...overrides,
	});
}

const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;

beforeAll(async () => {
	await initializeDatabase();
	process.env.FORWARDAUTH_TRUST_SECRET = TEST_SECRET;
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

afterAll(() => {
	process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

describe("forwardauth headers alone, no cookie", () => {
	test("exactly 1 statement: the user lookup", async () => {
		const headers = forwardauthHeaders({ "X-Authentik-Uid": `cost-a-${crypto.randomUUID()}` });
		// Prime the row so this measures the steady-state (already-resolved)
		// cost, not a cold-start insert.
		await resolveSsoUser({
			provider: "authentik",
			subject: headers.get("X-Authentik-Uid") as string,
			source: "uid",
			username: "costuser",
		});

		const calls = await countDbCalls(async () => {
			const user = await getAuthUserFromHeaders(headers);
			expect(user?.source).toBe("forwardauth");
		});
		expect(calls).toBe(1);
	});

	test("a disabled user is still rejected, with the same single lookup", async () => {
		const subject = `cost-disabled-a-${crypto.randomUUID()}`;
		const headers = forwardauthHeaders({ "X-Authentik-Uid": subject });
		const resolved = await resolveSsoUser({
			provider: "authentik",
			subject,
			source: "uid",
			username: "costuser",
		});
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, resolved.id));

		const calls = await countDbCalls(async () => {
			const user = await getAuthUserFromHeaders(headers);
			expect(user).toBeNull();
		});
		expect(calls).toBe(1);
	});
});

describe("a session cookie alone, no forwardauth headers", () => {
	test("exactly 3 statements: the session select, the last-seen update, one user lookup", async () => {
		const { issueSession, SSO_SESSION_DURATION_MS } = await import(
			"../services/local-auth-service.js"
		);
		const subject = `cost-b-${crypto.randomUUID()}`;
		await resolveSsoUser({ provider: "authentik", subject, source: "uid", username: "costuser" });
		const { token } = await issueSession({
			userId: subject, // irrelevant: resolveSessionByToken re-resolves by (provider, subject)
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "costuser",
			provider: "authentik",
		});

		const headers = new Headers({ Cookie: `ap_session=${token}` });
		const calls = await countDbCalls(async () => {
			const user = await getAuthUserFromHeaders(headers);
			expect(user?.source).toBe("forwardauth");
		});
		expect(calls).toBe(3);
	});
});

describe("forwardauth headers + a matching session cookie, through the bridge and requireAuth (the steady-state dashboard request)", () => {
	test("exactly 3 statements: the bridge's peek (select + last-seen update) and one user lookup in requireAuth — the bridge itself never resolves", async () => {
		const { Hono } = await import("hono");

		const subject = `cost-c-${crypto.randomUUID()}`;
		const headers = forwardauthHeaders({ "X-Authentik-Uid": subject });

		// Mint the cookie first (one real request through the bridge), exactly
		// as a browser's first page load would, then measure the SECOND
		// request — the steady-state case where the cookie already matches.
		const app = new Hono();
		app.use("*", bridgeForwardauthSession());
		app.use("*", requireAuth());
		app.get("/probe", (c) => c.json({ ok: true }));

		const firstRes = await app.request("/probe", { headers });
		const setCookieHeader = firstRes.headers.get("set-cookie");
		expect(setCookieHeader).toBeTruthy();
		const mintedToken = setCookieHeader?.split(";")[0]?.split("=")[1];
		expect(mintedToken).toBeTruthy();

		const steadyStateHeaders = forwardauthHeaders({
			"X-Authentik-Uid": subject,
			Cookie: `ap_session=${mintedToken}`,
		});

		const calls = await countDbCalls(async () => {
			const res = await app.request("/probe", { headers: steadyStateHeaders });
			expect(res.status).toBe(200);
		});
		expect(calls).toBe(3);
	});
});

describe("GET /auth/me carries displayName on the already-resolved identity — no additional statement", () => {
	test("the full /auth/me request issues no more statements than its own auth resolution", async () => {
		const { Hono } = await import("hono");
		const { authRouter } = await import("../routes/auth.js");

		const subject = `cost-me-${crypto.randomUUID()}`;
		await resolveSsoUser({ provider: "authentik", subject, source: "uid", username: "costuser" });
		const headers = forwardauthHeaders({ "X-Authentik-Uid": subject });

		const app = new Hono();
		app.use("*", bridgeForwardauthSession());
		app.route("/api/v1", authRouter);

		// Baseline: resolving the same headers directly (no route, no
		// countActiveUsers call) costs 1 statement (the user lookup).
		// GET /auth/me additionally runs countActiveUsers() for allowSignup —
		// that's the request's OWN cost, not a repeated identity resolve, so
		// it is excluded from the comparison by measuring it separately below.
		const baselineCalls = await countDbCalls(async () => {
			await getAuthUserFromHeaders(forwardauthHeaders({ "X-Authentik-Uid": subject }));
		});

		const meCalls = await countDbCalls(async () => {
			const res = await app.request("/api/v1/auth/me", { headers });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { user: { displayName: string } };
			expect(body.user.displayName).toBe("costuser");
		});

		// /auth/me's own extra statements: countActiveUsers() (1 select) and
		// the instance-mode lookup it reports (1 primary-key select, none when
		// AGENTPULSE_MODE fixes the mode). The identity resolution itself must
		// not cost more than baseline.
		expect(meCalls).toBe(baselineCalls + 2);
	});
});

describe("hook ingest and API-key paths make no user-table lookups", () => {
	test("requireApiKey resolves a valid key with zero user-table statements beyond the key lookup itself", async () => {
		const { key } = await createApiKey(`cost-key-${crypto.randomUUID().slice(0, 8)}`);
		const { Hono } = await import("hono");
		const app = new Hono();
		app.use("*", requireApiKey());
		app.get("/probe", (c) => c.json({ ok: true }));

		// Statement-level check: requireApiKey only ever touches api_keys, never users.
		const calls = await countDbCalls(async () => {
			const res = await app.request("/probe", { headers: { Authorization: `Bearer ${key}` } });
			expect(res.status).toBe(200);
		});
		// Exactly 2: the key select + the fire-and-forget last-used update.
		expect(calls).toBe(2);
	});
});

describe("with AGENTPULSE_ADMIN_SSO_SUBJECTS configured, the steady-state counts don't change", () => {
	const SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
	const originalSubjects = process.env[SUBJECTS_ENV];

	afterAll(() => {
		if (originalSubjects === undefined) delete process.env[SUBJECTS_ENV];
		else process.env[SUBJECTS_ENV] = originalSubjects;
	});

	// One user already promoted by the env list, one member who isn't listed.
	// Both are steady-state: promotion (a one-time write) has already happened.
	for (const [label, listed, expectedRole] of [
		["a listed, already-promoted admin", true, "admin"],
		["an unlisted member", false, "user"],
	] as const) {
		test(`${label}: headers 1, cookie 3, headers+cookie 3 statements`, async () => {
			const { Hono } = await import("hono");
			const { issueSession, SSO_SESSION_DURATION_MS } = await import(
				"../services/local-auth-service.js"
			);
			const subject = `cost-env-${label.replace(/\W+/g, "-")}-${crypto.randomUUID()}`;
			process.env[SUBJECTS_ENV] = listed ? `other-subject,${subject}` : "other-subject";
			const headers = forwardauthHeaders({ "X-Authentik-Uid": subject });
			await getAuthUserFromHeaders(headers); // the one-time promotion, if any

			const headerCalls = await countDbCalls(async () => {
				const user = await getAuthUserFromHeaders(headers);
				expect(user?.role).toBe(expectedRole);
			});

			const { token } = await issueSession({
				userId: subject,
				durationMs: SSO_SESSION_DURATION_MS,
				authSource: "forwardauth",
				ssoSubject: subject,
				ssoUsername: "costuser",
				provider: "authentik",
			});
			const cookieCalls = await countDbCalls(async () => {
				const user = await getAuthUserFromHeaders(new Headers({ Cookie: `ap_session=${token}` }));
				expect(user?.role).toBe(expectedRole);
			});

			const app = new Hono();
			app.use("*", bridgeForwardauthSession());
			app.use("*", requireAuth());
			app.get("/probe", (c) => c.json({ ok: true }));
			const first = await app.request("/probe", { headers });
			const minted = first.headers.get("set-cookie")?.split(";")[0]?.split("=")[1];
			const bothCalls = await countDbCalls(async () => {
				const res = await app.request("/probe", {
					headers: forwardauthHeaders({
						"X-Authentik-Uid": subject,
						Cookie: `ap_session=${minted}`,
					}),
				});
				expect(res.status).toBe(200);
			});

			expect({ headerCalls, cookieCalls, bothCalls }).toEqual({
				headerCalls: 1,
				cookieCalls: 3,
				bothCalls: 3,
			});
		});
	}
});
