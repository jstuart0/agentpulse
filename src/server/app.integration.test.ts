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

// ─── M-2d: manage-scoped ap_ API key → 201; ingest-only → 403 ──────────────

describe("M-2d — admin enroll: manage-scoped ap_ API key → 201", () => {
	test("manage-scoped Bearer key → requireScope(manage) passes → 201 enrollment token", async () => {
		const { key: manageKey } = await createApiKey("app-int-manage-key", ["ingest", "manage"]);

		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${manageKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "api-key-supervisor-m2d" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");
	});
});

// ─── AGEN-9: Scope enforcement tests ─────────────────────────────────────────

describe("AGEN-9 — scope enforcement: ingest-only key → 403 on management routes", () => {
	test("ingest-only key → POST /api/v1/admin/supervisors/enroll → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-ingest-key", ["ingest"]);

		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "should-fail" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; required: string };
		expect(body.error).toBe("insufficient_scope");
		expect(body.required).toBe("manage");
	});

	test("ingest-only key → POST /api/v1/api-keys → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-ingest-for-crud", ["ingest"]);

		const res = await app.request("/api/v1/api-keys", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "should-also-fail" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});
});

describe("AGEN-9 — scope enforcement: forwardauth session passes manage gate", () => {
	test("forwardauth headers → POST /api/v1/admin/supervisors/enroll → 201 (not blocked by scope gate)", async () => {
		const h = forwardauthHeaders({ "Content-Type": "application/json" });
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: h,
			body: JSON.stringify({ name: "fa-supervisor-scope-test" }),
		});

		expect(res.status).toBe(201);
	});
});

describe("AGEN-9 — scope enforcement: ingest key can POST hooks; manage-only key cannot", () => {
	test("ingest-scoped key → POST /api/v1/hooks → hook accepted (200 or rate-limited)", async () => {
		const { key: ingestKey } = await createApiKey("app-int-hooks-ingest", ["ingest"]);

		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ type: "SessionStart", session_id: "test-session-scope" }),
		});

		// Hook endpoint always returns 200 (always-200 contract); any 4xx is a bug.
		expect(res.status).toBe(200);
	});

	test("manage-only key (no ingest) → POST /api/v1/hooks → 403 insufficient_scope", async () => {
		const { key: manageOnlyKey } = await createApiKey("app-int-hooks-manage-only", ["manage"]);

		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${manageOnlyKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ type: "SessionStart", session_id: "test-session-scope-2" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; required: string };
		expect(body.error).toBe("insufficient_scope");
		expect(body.required).toBe("ingest");
	});
});

describe("AGEN-9 — scope enforcement: fake-Bearer + cookie regression", () => {
	test("Bearer ap_invalid + valid SSO cookie → 401 (bearer is authoritative; scoping did not regress this)", async () => {
		const { token: ssoToken } = await issueSession({
			userId: "sso:scope-regression-subject",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: "scope-regression-subject",
			ssoUsername: TEST_USERNAME,
			provider: TEST_PROVIDER,
		});

		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Cookie: `${SESSION_COOKIE_NAME}=${ssoToken}`,
				Authorization: "Bearer ap_completelyboguskey0000000000",
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "scope-regression-test" }),
		});

		expect(res.status).toBe(401);
	});
});

// ─── AGEN-9 extension: coherent scope enforcement across all dashboard routers ─

describe("AGEN-9 extension — C-1/C-2: ingest key → 403 on AI control-plane routes", () => {
	test("ingest-only key → POST /api/v1/ai/proposals/:id/decision → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-c1-ingest", ["ingest"]);

		const res = await app.request("/api/v1/ai/proposals/fake-id/decision", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ decision: "approve" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});

	test("ingest-only key → PUT /api/v1/ai/sessions/:id/watcher → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-c2-ingest", ["ingest"]);

		const res = await app.request("/api/v1/ai/sessions/fake-session/watcher", {
			method: "PUT",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ enabled: true }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});

	test("manage+ingest key → AI route → passes scope gate (may 404 on fake id)", async () => {
		const { key: manageKey } = await createApiKey("app-int-c1-manage", ["ingest", "manage"]);

		const res = await app.request("/api/v1/ai/proposals/fake-id/decision", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${manageKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ decision: "approve" }),
		});

		// Not 403 (scope gate passed); may be 404/409/501 if AI is disabled in test env.
		expect(res.status).not.toBe(403);
	});
});

describe("AGEN-9 extension — H-1/H-2: ingest key → 403 on settings routes", () => {
	test("ingest-only key → GET /api/v1/settings → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-h2-settings-get", ["ingest"]);

		const res = await app.request("/api/v1/settings", {
			headers: new Headers({ Authorization: `Bearer ${ingestKey}` }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});

	test("ingest-only key → PUT /api/v1/settings/workspace → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-h1-workspace", ["ingest"]);

		const res = await app.request("/api/v1/settings/workspace", {
			method: "PUT",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ workspace: { templateClaudeMd: "injected" } }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});
});

describe("AGEN-9 extension — M-1: ingest key → 403 on channels routes", () => {
	test("ingest-only key → POST /api/v1/channels/telegram/credentials → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-m1-channels", ["ingest"]);

		const res = await app.request("/api/v1/channels/telegram/credentials", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${ingestKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ botToken: "injected-token" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});
});

describe("AGEN-9 extension — sessions/search: ingest key → 403 on dashboard routes", () => {
	test("ingest-only key → GET /api/v1/sessions → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-sessions-ingest", ["ingest"]);

		const res = await app.request("/api/v1/sessions", {
			headers: new Headers({ Authorization: `Bearer ${ingestKey}` }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});

	test("ingest-only key → GET /api/v1/search → 403 insufficient_scope", async () => {
		const { key: ingestKey } = await createApiKey("app-int-search-ingest", ["ingest"]);

		const res = await app.request("/api/v1/search?q=test", {
			headers: new Headers({ Authorization: `Bearer ${ingestKey}` }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});

	test("manage+ingest key → GET /api/v1/sessions → 200 (scope gate passes)", async () => {
		const { key: manageKey } = await createApiKey("app-int-sessions-manage", ["ingest", "manage"]);

		const res = await app.request("/api/v1/sessions", {
			headers: new Headers({ Authorization: `Bearer ${manageKey}` }),
		});

		expect(res.status).toBe(200);
	});

	test("forwardauth → GET /api/v1/sessions → 200 (scope gate transparent to human users)", async () => {
		const h = forwardauthHeaders();
		const res = await app.request("/api/v1/sessions", { headers: h });
		expect(res.status).toBe(200);
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

// ─── AGEN-12 Phase 1: GET /auth/me exposes scopes for api_key callers ───────

describe("AGEN-12 Phase 1 — GET /auth/me: scopes field (rows 35-39)", () => {
	test("row 35: observeKey → user.scopes equals ['observe']", async () => {
		const { key } = await createApiKey("app-int-me-observe", ["observe"]);
		const res = await app.request("/api/v1/auth/me", {
			headers: new Headers({ Authorization: `Bearer ${key}` }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { source: string; scopes?: string[] } };
		expect(body.user.source).toBe("api_key");
		expect(body.user.scopes).toEqual(["observe"]);
	});

	test("row 36: manageKey → user.scopes equals ['manage']", async () => {
		const { key } = await createApiKey("app-int-me-manage", ["manage"]);
		const res = await app.request("/api/v1/auth/me", {
			headers: new Headers({ Authorization: `Bearer ${key}` }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { scopes?: string[] } };
		expect(body.user.scopes).toEqual(["manage"]);
	});

	test("row 37: forwardauthSession → user.scopes is undefined (never leaked from any DB row)", async () => {
		const res = await app.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { source: string; scopes?: string[] } };
		expect(body.user.source).toBe("forwardauth");
		expect(body.user.scopes).toBeUndefined();
	});

	test("row 38: DISABLE_AUTH=true, no auth header at all → authenticated:true, user.source:'api_key', user.scopes equals ['*'] (NOT authenticated:false)", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await app.request("/api/v1/auth/me");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				authenticated: boolean;
				user: { source: string; scopes?: string[] };
			};
			expect(body.authenticated).toBe(true);
			expect(body.user.source).toBe("api_key");
			expect(body.user.scopes).toEqual(["*"]);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("row 39: ingestKey → user.scopes equals ['ingest'] (verbatim passthrough, not observe/manage-only)", async () => {
		const { key } = await createApiKey("app-int-me-ingest", ["ingest"]);
		const res = await app.request("/api/v1/auth/me", {
			headers: new Headers({ Authorization: `Bearer ${key}` }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { scopes?: string[] } };
		expect(body.user.scopes).toEqual(["ingest"]);
	});
});
