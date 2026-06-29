/**
 * Real-app integration tests for src/server/app.ts.
 *
 * Unlike the helper-app bridge tests (forwardauth-bridge.test.ts), these import
 * the actual exported `app` to verify bridge middleware ordering, route-level auth
 * gating, and Bearer-precedence end-to-end on the real mounted surface.
 *
 * AC coverage:
 *  M-2a  — Valid forwardauth headers on GET / → ap_session Set-Cookie from the real app.
 *  M-2b  — POST /api/v1/admin/supervisors/enroll with valid SSO cookie
 *           + Authorization: Bearer ap_<invalid> → 401 (bearer is authoritative, cookie ignored).
 *  M-2c  — POST /api/v1/admin/supervisors/enroll with live forwardauth headers → 201.
 *  M-2d  — POST /api/v1/admin/supervisors/enroll with a valid ap_ API key → 201.
 *  AC7   — SSO ap_session logout: POST /auth/logout revokes the row server-side;
 *           subsequent GET /auth/me with the same cookie → authenticated:false.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "./db/__test_db.js";

const { config } = await import("./config.js");
const { initializeDatabase } = await import("./db/client.js");
const { app } = await import("./app.js");
const { SESSION_COOKIE_NAME, SSO_SESSION_DURATION_MS, issueSession } = await import(
	"./services/local-auth-service.js"
);
const { createApiKey } = await import("./auth/api-key.js");

// ─── Test configuration ──────────────────────────────────────────────────────

const TEST_SECRET = "app-int-test-secret-32-chars!!!!";
const TEST_SUBJECT = "app-int-subject";
const TEST_USERNAME = "app-int-user";
const TEST_PROVIDER = "authentik";

function forwardauthHeaders(overrides: Record<string, string> = {}): Headers {
	return new Headers({
		"X-Authentik-Username": TEST_USERNAME,
		"X-Authentik-Uid": TEST_SUBJECT,
		"X-Authentik-Verify": TEST_SECRET,
		...overrides,
	});
}

function countSessionCookies(res: Response): number {
	let count = 0;
	res.headers.forEach((value, key) => {
		if (key.toLowerCase() === "set-cookie" && value.startsWith(`${SESSION_COOKIE_NAME}=`)) {
			count++;
		}
	});
	return count;
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

const originalDisableAuth = config.disableAuth;
const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;
const originalProvider = process.env.FORWARDAUTH_PROVIDER;

beforeAll(async () => {
	await initializeDatabase();
	process.env.FORWARDAUTH_TRUST_SECRET = TEST_SECRET;
	process.env.FORWARDAUTH_PROVIDER = TEST_PROVIDER;
	(config as Record<string, unknown>).disableAuth = false;
	// Clear the memoised trust-secret so the just-set env var takes effect.
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalSecret === undefined) {
		process.env.FORWARDAUTH_TRUST_SECRET = undefined;
	} else {
		process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
	}
	if (originalProvider === undefined) {
		process.env.FORWARDAUTH_PROVIDER = undefined;
	} else {
		process.env.FORWARDAUTH_PROVIDER = originalProvider;
	}
	// biome-ignore lint/performance/noDelete: clear memo for teardown parity
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

// ─── M-2a: Bridge mounts on real app ────────────────────────────────────────

describe("M-2a — real app: valid forwardauth headers on GET / → ap_session Set-Cookie", () => {
	test("bridge middleware is wired before SPA catch-all on the exported app", async () => {
		const res = await app.request("/", { headers: forwardauthHeaders() });
		// GET / returns 404 in test mode (no SPA bundle), but the bridge fires on every
		// request via app.use("*", ...) so Set-Cookie must be present regardless.
		expect(countSessionCookies(res)).toBe(1);
	});
});

// ─── M-2b: Bearer ap_invalid + SSO cookie → 401 ─────────────────────────────

describe("M-2b — admin enroll: valid SSO cookie + Bearer ap_invalid → 401", () => {
	test("invalid Bearer short-circuits to 401; cookie identity is not consulted", async () => {
		const { token: ssoToken } = await issueSession({
			userId: `sso:${TEST_SUBJECT}-m2b`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: `${TEST_SUBJECT}-m2b`,
			ssoUsername: TEST_USERNAME,
			provider: TEST_PROVIDER,
		});

		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Cookie: `${SESSION_COOKIE_NAME}=${ssoToken}`,
				Authorization: "Bearer ap_totallyinvalidkey00000000",
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "test-supervisor-m2b" }),
		});

		expect(res.status).toBe(401);
	});
});

// ─── M-2c: Live forwardauth headers → 201 ────────────────────────────────────

describe("M-2c — admin enroll: live forwardauth headers → 201", () => {
	test("forwardauth identity resolves via step-1 → requireAuth passes → 201 enrollment token", async () => {
		const h = forwardauthHeaders({ "Content-Type": "application/json" });
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: h,
			body: JSON.stringify({ name: "fa-supervisor-m2c" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");
		expect(body.token.length).toBeGreaterThan(0);
	});
});

// ─── M-2d: Valid ap_ API key → 201 ──────────────────────────────────────────

describe("M-2d — admin enroll: valid ap_ API key → 201", () => {
	test("valid ap_ Bearer key resolves as api_key source → requireAuth passes → 201", async () => {
		const { key: apiKey } = await createApiKey("app-int-test-key");

		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "api-key-supervisor-m2d" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");
	});
});

// ─── AC7: SSO logout revokes row; /auth/me unauthenticated after ─────────────

describe("AC7 — SSO ap_session logout: POST /auth/logout → row revoked → /auth/me unauthenticated", () => {
	test("minted SSO session is revoked server-side; subsequent /auth/me with same cookie is unauthenticated", async () => {
		const { token } = await issueSession({
			userId: `sso:${TEST_SUBJECT}-ac7`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: `${TEST_SUBJECT}-ac7`,
			ssoUsername: TEST_USERNAME,
			provider: TEST_PROVIDER,
		});

		// Sanity: /auth/me with the cookie resolves as authenticated.
		const me1 = await app.request("/api/v1/auth/me", {
			headers: new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` }),
		});
		const body1 = (await me1.json()) as { authenticated: boolean };
		expect(body1.authenticated).toBe(true);

		// POST /auth/logout — revokes the session row server-side.
		const logoutRes = await app.request("/api/v1/auth/logout", {
			method: "POST",
			headers: new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` }),
		});
		expect(logoutRes.status).toBe(200);

		// Same (now-revoked) cookie → /auth/me must return unauthenticated.
		const me2 = await app.request("/api/v1/auth/me", {
			headers: new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` }),
		});
		const body2 = (await me2.json()) as { authenticated: boolean };
		expect(body2.authenticated).toBe(false);
	});
});
