/**
 * Unit tests for guardWsUpgrade (WS scope gate — AGEN-9 extension).
 *
 * We test the guard function directly rather than spinning up a real
 * Bun.serve, because the WS upgrade happens outside the Hono router and
 * cannot be reached via app.request().
 *
 * Uses the same in-process SQLite pattern as app.integration.test.ts:
 * __test_db.js sets SQLITE_PATH before any module imports, then
 * initializeDatabase() creates all tables from the schema.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { initializeDatabase } = await import("../db/client.js");
const { createApiKey } = await import("../auth/api-key.js");
const { SESSION_COOKIE_NAME, issueSession } = await import("../services/local-auth-service.js");
const { guardWsUpgrade } = await import("./ws-auth.js");
const { config } = await import("../config.js");

beforeAll(async () => {
	await initializeDatabase();
	// Ensure scope checks fire (don't skip due to disableAuth)
	(config as Record<string, unknown>).disableAuth = false;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = true;
});

function bearerHeaders(key: string): Headers {
	return new Headers({ Authorization: `Bearer ${key}` });
}

function cookieHeaders(token: string): Headers {
	return new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` });
}

// ─── Ingest-only key: must be rejected (403) ─────────────────────────────────

describe("guardWsUpgrade — ingest-only api_key → 403", () => {
	test("ingest-scoped key → returns 403 with insufficient_scope", async () => {
		const { key } = await createApiKey("ws-guard-ingest-only", ["ingest"]);
		const result = await guardWsUpgrade(bearerHeaders(key));
		if (!result) throw new Error("expected a rejection Response, got null");
		expect(result.status).toBe(403);
		const body = (await result.json()) as { error: string; required: string };
		expect(body.error).toBe("insufficient_scope");
		expect(body.required).toBe("manage");
	});
});

// ─── Manage-scoped keys: must be allowed (null) ───────────────────────────────

describe("guardWsUpgrade — manage-scoped api_key → allowed", () => {
	test("ingest+manage key → returns null (allowed)", async () => {
		const { key } = await createApiKey("ws-guard-ingest-manage", ["ingest", "manage"]);
		const result = await guardWsUpgrade(bearerHeaders(key));
		expect(result).toBeNull();
	});

	test("manage-only key → returns null (WS does not require ingest)", async () => {
		const { key } = await createApiKey("ws-guard-manage-only", ["manage"]);
		const result = await guardWsUpgrade(bearerHeaders(key));
		expect(result).toBeNull();
	});
});

// ─── SSO session cookie: must be allowed ─────────────────────────────────────
// (SSO sessions are self-contained; no local_auth_users row required.)

describe("guardWsUpgrade — SSO session cookie → allowed", () => {
	test("valid SSO session cookie → returns null (allowed)", async () => {
		const { token } = await issueSession({
			userId: "sso:ws-guard-sso-subject",
			durationMs: 3_600_000,
			authSource: "forwardauth",
			ssoSubject: "ws-guard-sso-subject",
			ssoUsername: "ws-guard-user",
			provider: "authentik",
		});
		const result = await guardWsUpgrade(cookieHeaders(token));
		expect(result).toBeNull();
	});
});

// ─── Unauthenticated: must get 401 ───────────────────────────────────────────

describe("guardWsUpgrade — unauthenticated → 401", () => {
	test("no auth headers → returns 401", async () => {
		const result = await guardWsUpgrade(new Headers());
		if (!result) throw new Error("expected a rejection Response, got null");
		expect(result.status).toBe(401);
	});

	test("invalid Bearer token → returns 401", async () => {
		const result = await guardWsUpgrade(bearerHeaders("ap_completelybogus000000000000"));
		if (!result) throw new Error("expected a rejection Response, got null");
		expect(result.status).toBe(401);
	});
});
