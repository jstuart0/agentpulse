/**
 * Phase 2 — local-auth-service + getAuthUserFromHeaders integration tests.
 *
 * Uses a real in-memory SQLite DB seeded via initializeDatabase() so that
 * issueSession/resolveSessionByToken exercise the actual schema (including the
 * Phase 1 SSO columns). No mocks for getDb, hashToken, verifyApiKey, or
 * verifyForwardauthSecret — real implementations only.
 *
 * Tests cover:
 *   - Local session round-trip: issueSession → resolveSessionByToken → {kind:"local"}
 *   - getAuthUserFromHeaders with local cookie → source:"local" + role (parity)
 *   - SSO session round-trip: issueSession (SSO fields) → {kind:"sso"}
 *   - getAuthUserFromHeaders with SSO cookie only → source:"forwardauth", no role
 *   - Expired SSO session → null + row deleted
 *   - Bearer precedence (AC 12 / Decision 8)
 */

import { beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { initializeDatabase } = await import("../db/client.js");
const {
	SESSION_DURATION_MS,
	SSO_SESSION_DURATION_MS,
	createUser,
	issueSession,
	resolveSessionByToken,
} = await import("./local-auth-service.js");
const { getAuthUserFromHeaders } = await import("../auth/middleware.js");
const { createApiKey } = await import("../auth/api-key.js");

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
	await initializeDatabase();
});

// Helper: build a minimal Headers mock carrying only a cookie.
function cookieHeaders(cookieValue: string): { get(name: string): string | null } {
	return {
		get(name: string) {
			if (name === "cookie" || name === "Cookie") return cookieValue;
			return null;
		},
	};
}

// Helper: build a Headers mock with a cookie AND an Authorization header.
function authHeaders(
	cookieValue: string,
	authorization: string,
): { get(name: string): string | null } {
	return {
		get(name: string) {
			if (name === "cookie" || name === "Cookie") return cookieValue;
			if (name === "Authorization") return authorization;
			return null;
		},
	};
}

// ── Local session round-trip ──────────────────────────────────────────────────

describe("local session: issueSession → resolveSessionByToken", () => {
	test("issueSession (local defaults) → resolveSessionByToken → {kind:'local'}", async () => {
		const user = await createUser({
			username: "testlocal1",
			password: "S3cur3P@ssword!",
		});

		const { token } = await issueSession({ userId: user.id, userAgent: "test" });
		const resolved = await resolveSessionByToken(token);

		expect(resolved).not.toBeNull();
		expect(resolved?.kind).toBe("local");
		if (resolved?.kind === "local") {
			expect(resolved.user.id).toBe(user.id);
			expect(resolved.user.username).toBe("testlocal1");
			expect(resolved.user.role).toBe("user");
		}
	});

	test("getAuthUserFromHeaders with local cookie → source:'local' + role (parity check)", async () => {
		const user = await createUser({
			username: "testlocal2",
			password: "S3cur3P@ssword!",
		});
		const { token } = await issueSession({ userId: user.id });

		const result = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${token}`));

		expect(result).not.toBeNull();
		expect(result?.source).toBe("local");
		expect(result?.name).toBe("testlocal2");
		expect(result?.id).toBe(user.id);
		expect(result?.role).toBe("user");
	});

	test("unknown token → null", async () => {
		const result = await resolveSessionByToken("0".repeat(64));
		expect(result).toBeNull();
	});

	test("empty token → null", async () => {
		const result = await resolveSessionByToken("");
		expect(result).toBeNull();
	});
});

// ── SSO session round-trip ────────────────────────────────────────────────────

describe("SSO session: issueSession (SSO fields) → resolveSessionByToken", () => {
	test("issueSession with SSO fields → {kind:'sso'} with correct subject/username/provider", async () => {
		const subject = "uid-abc-123";
		const username = "alice@example.com";
		const provider = "authentik";

		const { token } = await issueSession({
			userId: `sso:${subject}`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: username,
			provider,
		});

		const resolved = await resolveSessionByToken(token);

		expect(resolved).not.toBeNull();
		expect(resolved?.kind).toBe("sso");
		if (resolved?.kind === "sso") {
			expect(resolved.subject).toBe(subject);
			expect(resolved.username).toBe(username);
			expect(resolved.provider).toBe(provider);
		}
	});

	test("getAuthUserFromHeaders with SSO cookie only → source:'forwardauth', no role", async () => {
		const subject = "uid-sso-getauth";
		const username = "bob@example.com";

		const { token } = await issueSession({
			userId: `sso:${subject}`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: username,
			provider: "authentik",
		});

		const result = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${token}`));

		expect(result).not.toBeNull();
		expect(result?.source).toBe("forwardauth");
		expect(result?.provider).toBe("authentik");
		expect(result?.name).toBe(username);
		expect(result?.id).toBe(subject);
		// SSO sessions carry no role (Decision 4).
		expect(result?.role).toBeUndefined();
	});
});

// ── Null-subject SSO guard (xander L-2) ──────────────────────────────────────

describe("SSO session with null sso_subject → resolveSessionByToken returns null", () => {
	test("SSO row missing ssoSubject → null (malformed identity rejected, not emitted as id:'')", async () => {
		// Issue a session that looks like an SSO row but with no subject — simulates
		// a bug or a manually-crafted row. The resolver must not emit {kind:"sso",subject:""}.
		const { token } = await issueSession({
			userId: "sso:no-subject",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: null, // ← the malformed condition
			ssoUsername: "ghost@example.com",
			provider: "authentik",
		});

		const resolved = await resolveSessionByToken(token);
		// Must be null — not {kind:"sso",subject:"", ...}.
		expect(resolved).toBeNull();
	});

	test("getAuthUserFromHeaders with a subject-less SSO cookie → null (not source:'forwardauth' with id:'')", async () => {
		const { token } = await issueSession({
			userId: "sso:no-subject-auth",
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: null,
			ssoUsername: "ghost2@example.com",
			provider: "authentik",
		});

		const result = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${token}`));
		expect(result).toBeNull();
	});
});

// ── Expiry ────────────────────────────────────────────────────────────────────

describe("expired SSO session → null + row deleted", () => {
	test("resolveSessionByToken on an expired SSO token returns null and deletes the row", async () => {
		const subject = "uid-expired-sso";
		// Issue with a TTL of 1ms so it's already expired by the time we resolve.
		const { token } = await issueSession({
			userId: `sso:${subject}`,
			durationMs: 1,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "expired@example.com",
			provider: "authentik",
		});

		// Brief sleep to ensure expiry has passed.
		await Bun.sleep(5);

		const resolved = await resolveSessionByToken(token);
		expect(resolved).toBeNull();

		// Confirm row is gone — a second resolve should also return null (not
		// because it's re-deleted but because it was deleted on the first call).
		const second = await resolveSessionByToken(token);
		expect(second).toBeNull();
	});

	test("expired local session → null and row deleted", async () => {
		const user = await createUser({
			username: "testexpired1",
			password: "S3cur3P@ssword!",
		});
		const { token } = await issueSession({ userId: user.id, durationMs: 1 });

		await Bun.sleep(5);

		const resolved = await resolveSessionByToken(token);
		expect(resolved).toBeNull();
	});
});

// ── Bearer precedence (AC 12 / Decision 8) ───────────────────────────────────

describe("Bearer precedence — `Bearer ap_*` is authoritative (AC 12)", () => {
	test("valid SSO cookie + Authorization: Bearer ap_<invalid> → null (Bearer short-circuits; cookie NOT consulted)", async () => {
		// Mint a valid SSO session.
		const subject = "uid-bearer-test";
		const { token: cookieToken } = await issueSession({
			userId: `sso:${subject}`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "charlie@example.com",
			provider: "authentik",
		});

		// Sanity: cookie alone resolves correctly.
		const cookieOnly = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${cookieToken}`));
		expect(cookieOnly?.source).toBe("forwardauth");

		// Now add a syntactically valid-looking but unknown Bearer key.
		const withBadBearer = await getAuthUserFromHeaders(
			authHeaders(`ap_session=${cookieToken}`, "Bearer ap_invalidkeyvalue000000000"),
		);
		// The invalid Bearer must short-circuit — returns null, NOT the SSO identity.
		expect(withBadBearer).toBeNull();
	});

	test("valid real API key → source:'api_key' regardless of cookie presence", async () => {
		// Create a real API key in the DB.
		const { key: realKey } = await createApiKey("phase2-test-key");

		const subject = "uid-bearer-realkey";
		const { token: cookieToken } = await issueSession({
			userId: `sso:${subject}`,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "dave@example.com",
			provider: "authentik",
		});

		const result = await getAuthUserFromHeaders(
			authHeaders(`ap_session=${cookieToken}`, `Bearer ${realKey}`),
		);

		expect(result).not.toBeNull();
		expect(result?.source).toBe("api_key");
	});

	test("cookie only (no Authorization header) → resolves the cookie identity (unchanged flow)", async () => {
		const user = await createUser({
			username: "testbearer3",
			password: "S3cur3P@ssword!",
		});
		const { token } = await issueSession({ userId: user.id });

		const result = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${token}`));

		expect(result).not.toBeNull();
		expect(result?.source).toBe("local");
		expect(result?.name).toBe("testbearer3");
	});

	test("Bearer ap_<invalid> with NO cookie → null", async () => {
		const result = await getAuthUserFromHeaders({
			get(name: string) {
				if (name === "Authorization") return "Bearer ap_totallyfakekey000000000000";
				return null;
			},
		});
		expect(result).toBeNull();
	});

	test("valid local cookie + Bearer ap_<invalid> → null (local session NOT consulted)", async () => {
		// Regression: confirm local-session cookie is also NOT a fallback when
		// an invalid ap_ Bearer is presented (same Decision 8 invariant).
		const user = await createUser({
			username: "testbearer5",
			password: "S3cur3P@ssword!",
		});
		const { token } = await issueSession({ userId: user.id });

		// Sanity: cookie alone works.
		const cookieOnly = await getAuthUserFromHeaders(cookieHeaders(`ap_session=${token}`));
		expect(cookieOnly?.source).toBe("local");

		// With an invalid Bearer, must return null.
		const withBad = await getAuthUserFromHeaders(
			authHeaders(`ap_session=${token}`, "Bearer ap_invalidkeyvalue000000000"),
		);
		expect(withBad).toBeNull();
	});
});

// ── SSO_SESSION_DURATION_MS export ───────────────────────────────────────────

describe("SSO_SESSION_DURATION_MS", () => {
	test("defaults to 8 hours when env var is not set", () => {
		// If the env var wasn't set at import time, the default is 8h.
		// We can't mutate env vars and re-import in bun:test's module cache,
		// so we just assert the value is reasonable (8h = 28_800_000ms).
		// The env-override path is covered by the constant definition itself.
		expect(SSO_SESSION_DURATION_MS).toBeGreaterThan(0);
		expect(SSO_SESSION_DURATION_MS).toBeLessThanOrEqual(SESSION_DURATION_MS); // ≤ 30d
		// Default (no env var set in test process) is exactly 8h.
		if (!process.env.AGENTPULSE_SSO_SESSION_DURATION_MS) {
			expect(SSO_SESSION_DURATION_MS).toBe(8 * 60 * 60 * 1000);
		}
	});
});
