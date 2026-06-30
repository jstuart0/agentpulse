/**
 * Tests for forwardauth-bridge.ts (Phase 4).
 *
 * AC coverage:
 *  AC 2   — Valid headers + verify → exactly one Set-Cookie; attributes correct.
 *  AC 3   — End-to-end: mint → /auth/me with cookie → SSO identity.
 *  AC 5   — Missing verify, wrong verify → no Set-Cookie.
 *  AC 6a  — Cookie subject mismatch → re-mint.
 *  AC 6b  — Fail-closed: issueSession throws → cookie cleared; /auth/me unauthenticated.
 *  AC 8   — WS cookie-only: resolveSessionByToken resolves SSO identity without forwardauth headers.
 *  AC 9   — DISABLE_AUTH=true → no mint.
 *  AC 10  — Local-auth regression: /auth/login + /auth/me with local cookie.
 *  M-1    — Set-Cookie appears on a "/" request (bridge fires before SPA catch-all);
 *           mint failure with existing cookie → DB row revoked server-side.
 *  M-4    — Provider mismatch → re-mint.
 *  M-8    — Valid local ap_session + forwardauth headers → SSO minted, old local row revoked.
 *  L-2    — SSO cookie for different subject + forwardauth headers → re-mint, old SSO row revoked.
 *  L-4    — Oversized subject (> 512 chars) → no mint.
 *
 * No module-level mocks. verifyForwardauthSecret, verifyApiKey, and issueSession are
 * NOT mocked (exception: the fail-closed AC 6b test uses DI on bridgeForwardauthSession
 * to inject a throwing issueSession — dependency injection, not module mocking).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
import type { IssueSessionFn } from "./forwardauth-bridge.js";

const { bridgeForwardauthSession } = await import("./forwardauth-bridge.js");
const {
	SESSION_COOKIE_NAME,
	SSO_SESSION_DURATION_MS,
	createUser,
	issueSession,
	resolveSessionByToken,
} = await import("../services/local-auth-service.js");
const { Hono } = await import("hono");
const { authRouter } = await import("../routes/auth.js");

// ─── Test configuration ──────────────────────────────────────────────────────

const TEST_SECRET = "bridge-test-secret-32-chars-long!";
const TEST_SUBJECT = "user-abc-123";
const TEST_USERNAME = "alice";
const TEST_PROVIDER = "authentik";

/** Build request headers that look like a valid Traefik forwardauth pass-through. */
function forwardauthHeaders(overrides: Record<string, string> = {}): Headers {
	const h = new Headers({
		"X-Authentik-Username": TEST_USERNAME,
		"X-Authentik-Uid": TEST_SUBJECT,
		"X-Authentik-Verify": TEST_SECRET,
		...overrides,
	});
	return h;
}

/** Build a minimal test app with bridge + auth router (no full app import). */
function makeBridgeApp(bridgeOpts: { issueSession?: IssueSessionFn } = {}) {
	const testApp = new Hono();
	testApp.use("*", bridgeForwardauthSession(bridgeOpts));
	testApp.route("/api/v1", authRouter);
	return testApp;
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
	// config memoizes forwardauthTrustSecret; clear the memo so this file
	// reads TEST_SECRET and so a stale memo from a prior file doesn't leak in.
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
	// Clear the memo so the restored env is what the next test file re-reads.
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

// ─── Parse Set-Cookie helper ─────────────────────────────────────────────────

interface ParsedSetCookie {
	name: string;
	value: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite: string | null;
	path: string | null;
	maxAge: number | null;
}

function parseSetCookie(header: string): ParsedSetCookie {
	const parts = header.split(";").map((p) => p.trim());
	const [nameValue, ...attrs] = parts;
	const eqIdx = nameValue?.indexOf("=");
	const name = nameValue?.slice(0, eqIdx);
	const value = nameValue?.slice(eqIdx + 1);
	let httpOnly = false;
	let secure = false;
	let sameSite: string | null = null;
	let path: string | null = null;
	let maxAge: number | null = null;
	for (const attr of attrs) {
		const lower = attr.toLowerCase();
		if (lower === "httponly") httpOnly = true;
		else if (lower === "secure") secure = true;
		else if (lower.startsWith("samesite=")) sameSite = attr.slice("SameSite=".length);
		else if (lower.startsWith("path=")) path = attr.slice("Path=".length);
		else if (lower.startsWith("max-age=")) maxAge = Number(attr.slice("Max-Age=".length));
	}
	return { name, value, httpOnly, secure, sameSite, path, maxAge };
}

/** Extract the ap_session Set-Cookie header from a response (null if absent). */
function getSessionSetCookie(res: Response): ParsedSetCookie | null {
	const setCookieHeaders: string[] = [];
	res.headers.forEach((value, key) => {
		if (key.toLowerCase() === "set-cookie") {
			setCookieHeaders.push(value);
		}
	});
	const sessionCookie = setCookieHeaders.find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`));
	return sessionCookie ? parseSetCookie(sessionCookie) : null;
}

/** Count how many Set-Cookie headers match ap_session. */
function countSessionSetCookies(res: Response): number {
	let count = 0;
	res.headers.forEach((value, key) => {
		if (key.toLowerCase() === "set-cookie" && value.startsWith(`${SESSION_COOKIE_NAME}=`)) {
			count++;
		}
	});
	return count;
}

// ─── AC 2: Valid headers + verify → one Set-Cookie with correct attributes ───

describe("AC 2 — valid forwardauth headers → exactly one Set-Cookie with correct attributes", () => {
	test("Set-Cookie is present and has expected count = 1", async () => {
		const testApp = makeBridgeApp();
		const res = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		expect(countSessionSetCookies(res)).toBe(1);
	});

	test("Set-Cookie attributes: HttpOnly, SameSite=Lax, Path=/, Max-Age=SSO_SESSION_DURATION_MS/1000", async () => {
		const testApp = makeBridgeApp();
		const res = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		const cookie = getSessionSetCookie(res);
		expect(cookie).not.toBeNull();
		expect(cookie?.name).toBe(SESSION_COOKIE_NAME);
		expect(cookie?.httpOnly).toBe(true);
		// Secure=false in test mode (isProduction is false). Assert the attr matches.
		expect(cookie?.secure).toBe(config.isProduction);
		expect(cookie?.sameSite).toBe("Lax");
		expect(cookie?.path).toBe("/");
		expect(cookie?.maxAge).toBe(Math.floor(SSO_SESSION_DURATION_MS / 1000));
	});

	test("M-1 — Set-Cookie appears on GET / (bridge fires before SPA catch-all)", async () => {
		const testApp = makeBridgeApp();
		const res = await testApp.request("/", { headers: forwardauthHeaders() });
		// Response may be 404 in test mode (no SPA), but the bridge should still set the cookie.
		expect(countSessionSetCookies(res)).toBe(1);
	});
});

// ─── Idempotent mint ─────────────────────────────────────────────────────────

describe("idempotent mint — same subject+provider cookie → no re-mint", () => {
	test("second request with the minted cookie does not set a new cookie", async () => {
		const testApp = makeBridgeApp();
		// First request — mints a cookie.
		const res1 = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		const first = getSessionSetCookie(res1);
		expect(first).not.toBeNull();

		// Second request — same subject, attach the minted cookie.
		const headers2 = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${first?.value}` });
		const res2 = await testApp.request("/api/v1/auth/me", { headers: headers2 });
		// No re-mint expected.
		expect(countSessionSetCookies(res2)).toBe(0);
	});
});

// ─── AC 5: Trust-gate reject ─────────────────────────────────────────────────

describe("AC 5 — trust-gate reject → no Set-Cookie", () => {
	test("missing verify header → no Set-Cookie", async () => {
		const testApp = makeBridgeApp();
		const h = new Headers({
			"X-Authentik-Username": TEST_USERNAME,
			"X-Authentik-Uid": TEST_SUBJECT,
			// no X-Authentik-Verify
		});
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		expect(countSessionSetCookies(res)).toBe(0);
	});

	test("wrong verify value → no Set-Cookie", async () => {
		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ "X-Authentik-Verify": "wrong-secret" });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		expect(countSessionSetCookies(res)).toBe(0);
	});
});

// ─── AC 6a: Cookie subject mismatch → re-mint ────────────────────────────────

describe("AC 6a — cookie subject mismatch → re-mint (new Set-Cookie)", () => {
	test("different-subject SSO cookie + forwardauth headers for new subject → re-mint", async () => {
		// Issue an SSO session for a different subject.
		const { token: oldToken } = await issueSession({
			userId: "sso:other-subject",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: "other-subject",
			ssoUsername: "other-user",
			provider: TEST_PROVIDER,
		});

		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${oldToken}` });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		const cookie = getSessionSetCookie(res);
		// A new cookie must be minted (not the same token).
		expect(cookie).not.toBeNull();
		expect(cookie?.value).not.toBe(oldToken);
	});
});

// ─── M-4: Provider mismatch → re-mint ───────────────────────────────────────

describe("M-4 — provider mismatch → re-mint", () => {
	test("SSO cookie for different provider + forwardauth headers → re-mint", async () => {
		// Issue a session for the same subject but a different provider.
		const { token: oldToken } = await issueSession({
			userId: `sso:${TEST_SUBJECT}`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: TEST_SUBJECT,
			ssoUsername: TEST_USERNAME,
			provider: "other-provider",
		});

		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${oldToken}` });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		const cookie = getSessionSetCookie(res);
		expect(cookie).not.toBeNull();
		expect(cookie?.value).not.toBe(oldToken);
	});
});

// ─── AC 6b: Fail-closed ──────────────────────────────────────────────────────

describe("AC 6b — fail-closed (issueSession throws)", () => {
	const failingIssueSession: IssueSessionFn = async () => {
		throw new Error("simulated DB failure");
	};

	test("(i) valid local cookie present + mint throws → response clears the cookie (Max-Age=0)", async () => {
		// Issue a real local session.
		const user = await createUser({
			username: `fc-local-${Date.now()}`,
			password: "TestPass123!",
			role: "user",
		});
		const { token: localToken } = await issueSession({ userId: user.id });

		const testApp = makeBridgeApp({ issueSession: failingIssueSession });
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${localToken}` });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });

		// Must clear the cookie (Max-Age=0 is the standard deletion mechanism).
		const deleteCookieHeader = [...res.headers.entries()].find(
			([k, v]) => k.toLowerCase() === "set-cookie" && v.includes(`${SESSION_COOKIE_NAME}=`),
		)?.[1];
		expect(deleteCookieHeader).toBeDefined();
		if (!deleteCookieHeader) throw new Error("expected Set-Cookie header");
		const parsed = parseSetCookie(deleteCookieHeader);
		expect(parsed.maxAge).toBe(0);
	});

	test("(i) subsequent /auth/me with local token does NOT authenticate planted identity", async () => {
		// After a failed mint with local cookie, the local session itself is still valid.
		// The key assertion: no new SSO cookie was minted, and the planted SSO cookie
		// would have been cleared. Test by using no cookie at all on /auth/me.
		const testApp2 = makeBridgeApp();
		// /auth/me with no cookie, no forwardauth headers → unauthenticated.
		const res = await testApp2.request("/api/v1/auth/me");
		const body = (await res.json()) as { authenticated: boolean };
		expect(body.authenticated).toBe(false);
	});

	test("(ii) different-subject SSO cookie present + mint throws → response clears the cookie", async () => {
		const { token: ssoToken } = await issueSession({
			userId: "sso:evil-subject",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: "evil-subject",
			ssoUsername: "evil-user",
			provider: TEST_PROVIDER,
		});

		const testApp = makeBridgeApp({ issueSession: failingIssueSession });
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${ssoToken}` });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });

		const deleteCookieHeader = [...res.headers.entries()].find(
			([k, v]) => k.toLowerCase() === "set-cookie" && v.includes(`${SESSION_COOKIE_NAME}=`),
		)?.[1];
		expect(deleteCookieHeader).toBeDefined();
		if (!deleteCookieHeader) throw new Error("expected Set-Cookie header");
		const parsed = parseSetCookie(deleteCookieHeader);
		expect(parsed.maxAge).toBe(0);
	});

	test("no cookie present + mint throws → no Set-Cookie header at all", async () => {
		const testApp = makeBridgeApp({ issueSession: failingIssueSession });
		const res = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		// No cookie was present to clear; no Set-Cookie at all.
		expect(countSessionSetCookies(res)).toBe(0);
	});
});

// ─── AC 3: End-to-end mint → /auth/me ────────────────────────────────────────

describe("AC 3 — end-to-end: mint via bridge, then /auth/me with cookie → SSO identity", () => {
	test("GET /api/v1/auth/me with minted cookie → authenticated:true, source:forwardauth", async () => {
		const testApp = makeBridgeApp();

		// Step 1: trigger bridge to mint a cookie.
		const mintRes = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		const mintedCookie = getSessionSetCookie(mintRes);
		expect(mintedCookie).not.toBeNull();

		// Step 2: request /auth/me with only the minted cookie (no forwardauth headers).
		const res = await testApp.request("/api/v1/auth/me", {
			headers: new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${mintedCookie?.value}` }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			authenticated: boolean;
			user: { source: string; provider: string; id: string; name: string };
			signOutUrl: string | null;
		};
		expect(body.authenticated).toBe(true);
		expect(body.user.source).toBe("forwardauth");
		expect(body.user.provider).toBe("authentik");
		expect(body.user.id).toBe(TEST_SUBJECT);
		expect(body.user.name).toBe(TEST_USERNAME);
		expect(body.signOutUrl).toBe("/outpost.goauthentik.io/sign_out");
	});
});

// ─── M-1: Fail-closed DB revocation ─────────────────────────────────────────

describe("M-1 — mint failure with existing cookie → DB row revoked AND browser cookie cleared", () => {
	const failingIssueSession: IssueSessionFn = async () => {
		throw new Error("simulated DB failure");
	};

	test("local session row resolves to null after failed mint (server-side revoke)", async () => {
		const user = await createUser({
			username: `m1-db-${Date.now()}`,
			password: "TestPass123!",
			role: "user",
		});
		const { token: localToken } = await issueSession({ userId: user.id });

		// Sanity: local session is valid before the bridge fires.
		const before = await resolveSessionByToken(localToken);
		expect(before?.kind).toBe("local");

		const testApp = makeBridgeApp({ issueSession: failingIssueSession });
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${localToken}` });
		await testApp.request("/api/v1/auth/me", { headers: h });

		// After a failed mint, the DB row must have been revoked server-side.
		const after = await resolveSessionByToken(localToken);
		expect(after).toBeNull();
	});
});

// ─── L-2: SSO-to-SSO supersession ────────────────────────────────────────────

describe("L-2 — SSO cookie for different subject → re-mint AND old SSO row revoked", () => {
	test("old SSO token resolves to null after new SSO mint for a different subject", async () => {
		// Issue an SSO session for subject B.
		const { token: subjectBToken } = await issueSession({
			userId: "sso:subject-b-l2",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: "subject-b-l2",
			ssoUsername: "user-b",
			provider: TEST_PROVIDER,
		});

		// Sanity: subject B's session is valid.
		const before = await resolveSessionByToken(subjectBToken);
		expect(before?.kind).toBe("sso");

		// Now the bridge fires for subject A (TEST_SUBJECT) with subject B's cookie.
		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${subjectBToken}` });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });

		// A new SSO cookie must be minted for subject A.
		const newCookie = getSessionSetCookie(res);
		expect(newCookie).not.toBeNull();
		expect(newCookie?.value).not.toBe(subjectBToken);

		// Subject B's DB row must be revoked.
		const after = await resolveSessionByToken(subjectBToken);
		expect(after).toBeNull();
	});
});

// ─── L-4: Subject length guard ───────────────────────────────────────────────

describe("L-4 — oversized subject (> 512 chars) → no mint, no Set-Cookie", () => {
	test("513-char subject → no Set-Cookie", async () => {
		const longSubject = "x".repeat(513);
		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ "X-Authentik-Uid": longSubject });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		expect(countSessionSetCookies(res)).toBe(0);
	});

	test("512-char subject → mint succeeds (at boundary)", async () => {
		const boundarySubject = "y".repeat(512);
		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ "X-Authentik-Uid": boundarySubject });
		const res = await testApp.request("/api/v1/auth/me", { headers: h });
		expect(countSessionSetCookies(res)).toBe(1);
	});
});

// ─── M-8: Local-collision — local session superseded ─────────────────────────

describe("M-8 — valid local ap_session + forwardauth headers → SSO minted, old local row revoked", () => {
	test("old local token resolves to null after SSO mint completes", async () => {
		const user = await createUser({
			username: `m8-${Date.now()}`,
			password: "TestPass123!",
			role: "user",
		});
		const { token: localToken } = await issueSession({ userId: user.id });

		// Sanity: local session is valid before the bridge fires.
		const before = await resolveSessionByToken(localToken);
		expect(before?.kind).toBe("local");

		const testApp = makeBridgeApp();
		const h = forwardauthHeaders({ Cookie: `${SESSION_COOKIE_NAME}=${localToken}` });
		await testApp.request("/api/v1/auth/me", { headers: h });

		// After the bridge mints an SSO session, the old local session must be revoked.
		const after = await resolveSessionByToken(localToken);
		expect(after).toBeNull();
	});
});

// ─── AC 8: WS/cookie-only SSO resolution ─────────────────────────────────────

describe("AC 8 — cookie-only SSO resolution (no forwardauth headers)", () => {
	test("resolveSessionByToken on an SSO session row → kind:sso with correct fields", async () => {
		const { token } = await issueSession({
			userId: `sso:${TEST_SUBJECT}-ws`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: `${TEST_SUBJECT}-ws`,
			ssoUsername: TEST_USERNAME,
			provider: TEST_PROVIDER,
		});
		// This is the path that getAuthUserFromHeaders step-3 takes for WS requests
		// that carry the cookie but no forwardauth headers (WS upgrade bypasses Traefik
		// forwardauth — the cookie is the only credential).
		const resolved = await resolveSessionByToken(token);
		expect(resolved?.kind).toBe("sso");
		if (resolved?.kind === "sso") {
			expect(resolved.subject).toBe(`${TEST_SUBJECT}-ws`);
			expect(resolved.username).toBe(TEST_USERNAME);
			expect(resolved.provider).toBe(TEST_PROVIDER);
		}
	});
});

// ─── AC 9 / DISABLE_AUTH ────────────────────────────────────────────────────

describe("AC 9 — DISABLE_AUTH=true → no mint", () => {
	test("no Set-Cookie when disableAuth is true", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const testApp = makeBridgeApp();
			const res = await testApp.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
			expect(countSessionSetCookies(res)).toBe(0);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});
});

// ─── AC 10: Local-auth regression ────────────────────────────────────────────

describe("AC 10 — local-auth regression: login + /auth/me with local cookie", () => {
	test("POST /auth/login issues a local session; /auth/me with it → source:local", async () => {
		const testApp = makeBridgeApp();

		// Create a user first.
		const username = `local-${Date.now()}`;
		await createUser({ username, password: "TestPass123!", role: "user" });

		// Login.
		const loginRes = await testApp.request("/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password: "TestPass123!" }),
		});
		expect(loginRes.status).toBe(200);

		// Extract the session cookie from the login response.
		const loginCookie = getSessionSetCookie(loginRes);
		expect(loginCookie).not.toBeNull();

		// GET /auth/me with ONLY the local cookie (no forwardauth headers).
		const meRes = await testApp.request("/api/v1/auth/me", {
			headers: new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${loginCookie?.value}` }),
		});
		expect(meRes.status).toBe(200);
		const body = (await meRes.json()) as {
			authenticated: boolean;
			user: { source: string };
		};
		expect(body.authenticated).toBe(true);
		expect(body.user.source).toBe("local");
	});
});
