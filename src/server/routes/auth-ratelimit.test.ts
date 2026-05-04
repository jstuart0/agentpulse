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

import { beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

// Top-level await imports — same pattern as settings-route.test.ts
const { checkPasswordComplexity } = await import("./auth.js");
const { Hono } = await import("hono");
const { authRouter } = await import("./auth.js");
const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");

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

// ── Rate limiting (login endpoint) ───────────────────────────────────────────

describe("login rate limiting", () => {
	beforeAll(() => {
		initializeDatabase();
		config.disableAuth = false;
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
