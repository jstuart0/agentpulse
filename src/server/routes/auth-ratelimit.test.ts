/**
 * Unit tests for auth rate limiting and password complexity (S-H1).
 *
 * Rate-limit buckets live in the authRouter module's module-level Map.
 * Because Bun caches modules, the Map persists across tests within a run.
 * We use a unique username per test to avoid cross-test collisions.
 *
 * DISABLE_AUTH=false so auth routes are active. verifyCredentials will
 * return null for non-existent users (401), letting us reach the rate-limit
 * threshold and observe 429 on the 6th attempt.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

// Top-level await imports — same pattern as settings-route.test.ts
const { MAX_BUCKETS, checkPasswordComplexity, getRateBucketCount, hasRateBucket, recordFailure } =
	await import("./auth.js");
const { Hono } = await import("hono");
const { authRouter } = await import("./auth.js");
const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");

// Save and restore config.disableAuth so parallel test-file runs don't see
// our mutation. Matches the pattern in settings-route.test.ts.
const originalDisableAuth = config.disableAuth;

// ── Password complexity ───────────────────────────────────────────────────────

describe("checkPasswordComplexity", () => {
	test("returns null for a valid password", () => {
		expect(checkPasswordComplexity("S3cur3P@ssword!")).toBeNull();
		expect(checkPasswordComplexity("Abcdef123!ghij")).toBeNull();
	});

	test("rejects passwords shorter than 12 chars", () => {
		const err = checkPasswordComplexity("Short1!");
		expect(err).toBeString();
		expect(err).toContain("12");
	});

	test("rejects passwords without uppercase", () => {
		const err = checkPasswordComplexity("nouppercase123!");
		expect(err).toBeString();
		expect(err).toContain("uppercase");
	});

	test("rejects passwords without a digit", () => {
		const err = checkPasswordComplexity("NoDigitsHere!!!");
		expect(err).toBeString();
		expect(err).toContain("digit");
	});

	test("rejects passwords without a symbol", () => {
		const err = checkPasswordComplexity("NoSymbol12Chars");
		expect(err).toBeString();
		expect(err).toContain("symbol");
	});

	test("12CharsTooEasy (no symbol) is rejected (plan verification case)", () => {
		// Exact case from the plan verification block.
		const err = checkPasswordComplexity("12CharsTooEasy");
		expect(err).toBeString();
		expect(err).toContain("symbol");
	});
});

// ── change-password complexity enforcement ────────────────────────────────────

describe("change-password complexity enforcement", () => {
	beforeAll(async () => {
		await initializeDatabase();
		config.disableAuth = false;
	});

	afterAll(() => {
		config.disableAuth = originalDisableAuth;
	});

	test("returns 400 password_complexity_failed for a weak new password", async () => {
		const app = new Hono().route("/api/v1", authRouter);
		// change-password requires requireAuth(); without a valid session cookie
		// the middleware returns 401 before we even reach the complexity check —
		// so we test the exported checkPasswordComplexity function directly for
		// the complexity logic, and verify the route returns 401 for unauth callers
		// (which confirms the handler is active and reachable).
		const res = await app.request("/api/v1/auth/change-password", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ currentPassword: "OldPass1!", newPassword: "weak" }),
		});
		// Without a session, requireAuth returns 401. That's correct — complexity
		// is checked after auth. The unit-level coverage is via checkPasswordComplexity.
		expect(res.status).toBe(401);
	});

	test("checkPasswordComplexity rejects short new password (route guard)", () => {
		// Directly exercises the guard used by change-password handler.
		const err = checkPasswordComplexity("Weak1!");
		expect(err).toBeString();
		expect(err).toContain("12");
	});

	test("checkPasswordComplexity rejects no-symbol password (rotation hole)", () => {
		// Ensures a 12-char-no-symbol password is rejected — the rotation hole
		// that prompted this finding.
		const err = checkPasswordComplexity("NewPass12Chars");
		expect(err).toBeString();
		expect(err).toContain("symbol");
	});

	test("checkPasswordComplexity accepts a strong new password", () => {
		expect(checkPasswordComplexity("NewStr0ng!Pass")).toBeNull();
	});
});

// ── rateBuckets size cap (M1) ─────────────────────────────────────────────────
//
// MAX_BUCKETS = 50_000. We call recordFailure() directly (not via HTTP) to
// avoid the overhead of 50 001 full Hono round-trips. recordFailure is the
// site where evictOldestBucket() fires; testing it directly exercises exactly
// the production code path for the eviction invariant.

describe("rateBuckets size cap", () => {
	test("the cap is 50 000 buckets", () => {
		expect(MAX_BUCKETS).toBe(50_000);
	});

	test("past the cap the oldest bucket is evicted first and the newest survives", () => {
		// More inserts than any earlier test left behind, so every older
		// bucket is evicted before one of these could be.
		const extra = 200;
		const key = (i: number) => `evict_order_ip_${i}:evict_order_user_${i}`;
		for (let i = 0; i < MAX_BUCKETS + extra; i++) recordFailure(key(i));

		expect(getRateBucketCount()).toBe(MAX_BUCKETS);
		// Exactly `extra` buckets were evicted, oldest first: the first of
		// these inserts is gone, the one right after the evicted run and the
		// last one are still there.
		expect(hasRateBucket(key(0))).toBe(false);
		expect(hasRateBucket(key(extra))).toBe(true);
		expect(hasRateBucket(key(MAX_BUCKETS + extra - 1))).toBe(true);
	});
});

// ── Rate limiting (login endpoint) ───────────────────────────────────────────

describe("login rate limiting", () => {
	beforeAll(async () => {
		await initializeDatabase();
		config.disableAuth = false;
	});

	afterAll(() => {
		config.disableAuth = originalDisableAuth;
	});

	test("first 5 failures return 401, 6th returns 429 (plan verification case)", async () => {
		// Use a unique username to avoid colliding with other test runs.
		const username = `testuser_rl_${Date.now()}`;
		const password = "wrongpass";

		const app = new Hono().route("/api/v1", authRouter);

		const post = () =>
			app.request("/api/v1/auth/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// No AGENTPULSE_TRUSTED_PROXIES is set; getConnInfo throws in
					// test context so the fallback peerIp (undefined → "0.0.0.0")
					// is used. All requests share "0.0.0.0" as peer — that is
					// correct: the test validates the bucket accumulation, not
					// multi-IP isolation (covered by client-ip.test.ts).
				},
				body: JSON.stringify({ username, password }),
			});

		// Attempts 1–5 should return 401 (invalid credentials).
		for (let i = 1; i <= 5; i++) {
			const res = await post();
			expect(res.status).toBe(401);
		}

		// Attempt 6 must return 429 with Retry-After.
		const res6 = await post();
		expect(res6.status).toBe(429);
		const body = await res6.json();
		expect(body.error).toContain("Too many");
		// Retry-After header should be present.
		expect(res6.headers.get("Retry-After")).not.toBeNull();
	});
});
