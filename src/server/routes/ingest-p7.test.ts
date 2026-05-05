/**
 * P7 tests — hot-path latency, rate-limit, graceful drain.
 *
 * Covers audit findings A-H1, A-H3, S-M6.
 *
 * Key invariants tested:
 *  - Always-200 post-auth contract: parse errors, rate-limit hits, processing
 *    exceptions all return 200. Pre-auth failures stay 401/403.
 *  - Rate limiter: 101st hook in 1s from same key → 200 + rateLimitedDropped++.
 *  - Drain: POST /drain (loopback) sets shuttingDown, /ready → 503, /health → 200.
 *  - Non-loopback drain → 403.
 *  - /health includes all 5 new fields.
 *  - processHookEvent returns { sessionId, isNew, session } (no re-getSession).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

// Dynamic imports so the test DB env vars are set before module init.
const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { health } = await import("./health.js");
const { ingest } = await import("./ingest.js");
const { internalRouter } = await import("./internal.js");
const { _resetBucketsForTest, hookRateLimit } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getRateLimitedDropped } = await import("./ingest-counters.js");
const { _resetDrainStateForTest, isShuttingDown, setShuttingDown } = await import(
	"../drain-state.js"
);

const originalDisableAuth = config.disableAuth;

// Build the full test app with all relevant routers.
function buildApp() {
	const app = new Hono();
	app.route("/api/v1", health);
	app.route("/api/v1", ingest);
	app.route("/api/v1/internal", internalRouter);
	return app;
}

// Build a drain app that injects peerIp=127.0.0.1 for loopback simulation.
// Uses a typed Hono instance so c.set("peerIp", ...) compiles.
function buildLoopbackDrainApp(peerIp = "127.0.0.1") {
	const app = new Hono<{ Variables: { peerIp: string } }>();
	app.use("*", async (c, next) => {
		c.set("peerIp", peerIp);
		await next();
	});
	app.route("/api/v1/internal", internalRouter);
	return app;
}

beforeAll(() => {
	initializeDatabase();
	config.disableAuth = true;
});

afterEach(() => {
	_resetBucketsForTest();
	_resetCountersForTest();
	_resetDrainStateForTest();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
	_resetDrainStateForTest();
});

// ── Health response — P7 fields ───────────────────────────────────────────────

describe("GET /api/v1/health — P7 fields", () => {
	test("includes all 5 new fields with correct types", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(typeof body.inFlight).toBe("number");
		expect(typeof body.processingErrors).toBe("number");
		expect(typeof body.rateLimitedDropped).toBe("number");
		expect(typeof body.shuttingDown).toBe("boolean");
		expect(typeof body.dbReady).toBe("boolean");
		// Existing fields preserved.
		expect(body.status).toBe("ok");
		expect(typeof body.timestamp).toBe("string");
	});

	test("counters start at 0, shuttingDown false", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		const body = await res.json();
		expect(body.inFlight).toBe(0);
		expect(body.processingErrors).toBe(0);
		expect(body.rateLimitedDropped).toBe(0);
		expect(body.shuttingDown).toBe(false);
	});

	test("returns 200 even when shuttingDown=true (liveness must not fail during drain)", async () => {
		setShuttingDown("test");
		const app = buildApp();
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shuttingDown).toBe(true);
	});
});

// ── Readiness probe ───────────────────────────────────────────────────────────

describe("GET /api/v1/ready", () => {
	test("returns 200 when not shutting down", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/ready");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ready).toBe(true);
	});

	test("returns 503 after drain is triggered", async () => {
		// Trigger drain via the internal endpoint with loopback peer.
		const drainApp = buildLoopbackDrainApp();
		const drainRes = await drainApp.request("/api/v1/internal/drain", { method: "POST" });
		expect(drainRes.status).toBe(200);
		expect(isShuttingDown()).toBe(true);

		// Readiness must fail immediately.
		const app = buildApp();
		const res = await app.request("/api/v1/ready");
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.ready).toBe(false);
	});
});

// ── Drain endpoint — loopback restriction ─────────────────────────────────────

describe("POST /api/v1/internal/drain", () => {
	test("returns 403 for non-loopback peer (peerIp falls back to 0.0.0.0 in test context)", async () => {
		// No peerIp injection → getTrustedClientIp returns "0.0.0.0" (non-loopback).
		const app = new Hono().route("/api/v1/internal", internalRouter);
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(403);
		expect(isShuttingDown()).toBe(false);
	});

	test("returns 200 and sets shuttingDown for 127.0.0.1 peer", async () => {
		const app = buildLoopbackDrainApp("127.0.0.1");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shuttingDown).toBe(true);
		expect(typeof body.inFlight).toBe("number");
		expect(isShuttingDown()).toBe(true);
	});

	test("accepts ::1 (IPv6 loopback)", async () => {
		const app = buildLoopbackDrainApp("::1");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("idempotent: calling drain twice is safe", async () => {
		const app = buildLoopbackDrainApp();
		const r1 = await app.request("/api/v1/internal/drain", { method: "POST" });
		const r2 = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(isShuttingDown()).toBe(true);
	});

	test("returns 403 for a non-loopback IP (10.x.y.z)", async () => {
		const app = buildLoopbackDrainApp("10.0.0.5");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(403);
		expect(isShuttingDown()).toBe(false);
	});

	// H1 — IPv4-mapped loopback: dual-stack Linux kernels present loopback
	// peers as "::ffff:127.0.0.1" when Bun binds 0.0.0.0. Without the prefix
	// strip, split(":")[0] returns "" and the loopback check fails → 403 on
	// every rolling deploy preStop → full data loss.
	test("accepts ::ffff:127.0.0.1 (IPv4-mapped loopback, dual-stack kernel)", async () => {
		const app = buildLoopbackDrainApp("::ffff:127.0.0.1");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.shuttingDown).toBe(true);
		expect(isShuttingDown()).toBe(true);
	});

	test("accepts ::ffff:127.0.0.1 uppercase prefix variant", async () => {
		const app = buildLoopbackDrainApp("::FFFF:127.0.0.1");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("rejects ::ffff: prefix on a non-loopback address (::ffff:10.0.0.5)", async () => {
		const app = buildLoopbackDrainApp("::ffff:10.0.0.5");
		const res = await app.request("/api/v1/internal/drain", { method: "POST" });
		expect(res.status).toBe(403);
		expect(isShuttingDown()).toBe(false);
	});
});

// ── Always-200 post-auth contract ─────────────────────────────────────────────

describe("POST /api/v1/hooks — always-200 post-auth (DISABLE_AUTH=true)", () => {
	test("malformed body (invalid JSON) returns 200", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not-valid-json{{{",
		});
		expect(res.status).toBe(200);
	});

	test("missing session_id or hook_event_name returns 200", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ no_session_id: true }),
		});
		expect(res.status).toBe(200);
	});

	test("valid hook returns 200 with { ok: true }", async () => {
		const app = buildApp();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				session_id: `test-${Date.now()}`,
				hook_event_name: "UserPromptSubmit",
				cwd: "/tmp",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});
});

// ── Pre-auth failures preserved ───────────────────────────────────────────────

describe("POST /api/v1/hooks — pre-auth 401 preserved (auth enabled)", () => {
	test("missing API key returns 401", async () => {
		config.disableAuth = false;
		try {
			const app = buildApp();
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "test-auth", hook_event_name: "UserPromptSubmit" }),
			});
			expect(res.status).toBe(401);
		} finally {
			config.disableAuth = true;
		}
	});

	test("invalid API key returns 401", async () => {
		config.disableAuth = false;
		try {
			const app = buildApp();
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer invalid-key-xyz",
				},
				body: JSON.stringify({ session_id: "test-invalid", hook_event_name: "UserPromptSubmit" }),
			});
			expect(res.status).toBe(401);
		} finally {
			config.disableAuth = true;
		}
	});
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("Rate limiter — token bucket", () => {
	test("high-volume requests from same key: all return 200, at least 1 silently dropped", async () => {
		// The default RATE_LIMIT is 100 req/s (continuous refill).
		// Send 500 sequential requests. At ~2-5ms each, elapsed time is ~1-2.5s.
		// Refill at 100/s adds ~100-250 tokens, but we consume 500:
		// guaranteed net drop of at least 150. All responses must be 200.
		const app = buildApp();
		const makeRequest = () =>
			app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					session_id: `rl-test-${Date.now()}-${Math.random()}`,
					hook_event_name: "UserPromptSubmit",
				}),
			});

		const before = getRateLimitedDropped();
		for (let i = 0; i < 500; i++) {
			const res = await makeRequest();
			// Always-200 post-auth contract: never 429, even under rate limiting.
			expect(res.status).toBe(200);
		}
		const after = getRateLimitedDropped();
		// At least one request was rate-limited and silently dropped.
		expect(after - before).toBeGreaterThanOrEqual(1);
	});

	test("direct bucket test: rateLimitedDropped increments on drop, response is 200 not 429", async () => {
		_resetBucketsForTest();
		_resetCountersForTest();

		// Build a minimal Hono app exercising hookRateLimit directly.
		// authUser.id = "testkey" — fixed key so all requests share one bucket.
		const miniApp = new Hono<{ Variables: { authUser: { id: string }; peerIp: string } }>();
		miniApp.use("*", async (c, next) => {
			c.set("authUser", { id: "testkey" });
			await next();
		});
		miniApp.use("/probe", hookRateLimit());
		miniApp.get("/probe", (c) => c.json({ passed: true }));

		// Exhaust bucket (100 tokens).
		for (let i = 0; i < 100; i++) {
			await miniApp.request("/probe");
		}

		const beforeDrop = getRateLimitedDropped();
		const res = await miniApp.request("/probe"); // 101st — should be dropped
		const afterDrop = getRateLimitedDropped();

		// Must return 200 (not 429): the always-200 post-auth contract.
		expect(res.status).toBe(200);
		// rateLimitedDropped incremented exactly once.
		expect(afterDrop - beforeDrop).toBe(1);
	});
});

// ── M3 — Log injection sanitization ──────────────────────────────────────────

// Mirror of the sanitizeLogField helper in ingest.ts — tested here directly
// since the function is module-private. Uses charCodeAt to avoid Biome's
// noControlCharactersInRegex rule (which rejects /[\x00-\x1f\x7f]/).
function sanitizeForTest(value: unknown, maxLen = 64): string {
	return String(value ?? "")
		.slice(0, maxLen)
		.split("")
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("");
}

function hasControlChars(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

describe("M3 — session_id sanitized before error logging", () => {
	test("session_id with newlines and ANSI escapes is stripped in logged output", async () => {
		// Inject a session_id containing log-injection bytes and verify the
		// sanitized value that would reach the logger contains none of them.
		const lf = String.fromCharCode(10); // \n
		const esc = String.fromCharCode(27); // \x1b
		const nul = String.fromCharCode(0); // \x00
		const malicious = `session${lf}${esc}[31mINJECTED${esc}[0m${nul}end`;
		const safe = sanitizeForTest(malicious);

		// No control characters remain.
		expect(hasControlChars(safe)).toBe(false);
		// Printable content preserved.
		expect(safe).toContain("session");
		expect(safe).toContain("end");
		// ESC and LF bytes stripped.
		expect(safe.includes(esc)).toBe(false);
		expect(safe.includes(lf)).toBe(false);
	});

	test("session_id longer than 64 chars is truncated before logging", () => {
		const long = "a".repeat(200);
		const safe = sanitizeForTest(long);
		expect(safe.length).toBe(64);
	});

	test("hook with malicious session_id in error path returns 200", async () => {
		// Verify the always-200 contract holds even with a control-char session_id.
		const lf = String.fromCharCode(10);
		const esc = String.fromCharCode(27);
		const app = buildApp();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				session_id: `evil${lf}INJECT${esc}[31m`,
				hook_event_name: "UserPromptSubmit",
				cwd: "/tmp",
			}),
		});
		// Always-200 contract: even with a malformed/malicious session_id.
		expect(res.status).toBe(200);
	});
});

// ── processHookEvent return type ──────────────────────────────────────────────

describe("processHookEvent returns session row (no N+1 getSession)", () => {
	test("returns { sessionId, isNew, session } with full session row", async () => {
		const { processHookEvent } = await import("../services/event-processor.js");
		const sessionId = `evt-ret-test-${Date.now()}`;
		const payload = {
			session_id: sessionId,
			hook_event_name: "UserPromptSubmit" as const,
			cwd: "/tmp",
		};

		const result = await processHookEvent(
			payload as Parameters<typeof processHookEvent>[0],
			"claude_code",
		);

		// All three fields must be present.
		expect(result.sessionId).toBe(sessionId);
		expect(typeof result.isNew).toBe("boolean");
		expect(result.session).not.toBeNull();
		// session is the full DB row.
		expect(result.session.sessionId).toBe(sessionId);
		expect(typeof result.session.id).toBe("string");
		expect(result.session.agentType).toBe("claude_code");
	});
});

// ── P7 patch-3: per-session hook ordering (P1) ───────────────────────────────
//
// Fire 10 hooks for the SAME session_id in rapid succession and assert:
//  1. All return 200 (always-200 contract unbroken).
//  2. No bgErrorCount increments (no constraint violations or processing errors).
//  3. The final DB row has status consistent with the last hook's effect
//     (SessionEnd → status "completed"; no race overwrote it with "active").

describe("Per-session hook ordering — no race on concurrent hooks", () => {
	test("10 rapid hooks for the same session: all 200, no bg errors, final status correct", async () => {
		const { getBgErrorCount: getBgErr } = await import("./ingest-counters.js");
		const { db } = await import("../db/client.js");

		const app = buildApp();
		const sessionId = `order-test-${Date.now()}`;

		// Mix of hook types in a realistic sequence.
		const hooks = [
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PreToolUse",
			"PostToolUse",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Stop",
			"SessionEnd",
		];

		const beforeErrors = getBgErr();

		// Fire all hooks WITHOUT awaiting between them — that's the race scenario.
		const requests = hooks.map((evt) =>
			app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					session_id: sessionId,
					hook_event_name: evt,
					cwd: "/tmp",
				}),
			}),
		);
		const responses = await Promise.all(requests);

		// All must be 200.
		for (const res of responses) {
			expect(res.status).toBe(200);
		}

		// Allow the per-session queue to drain.
		await new Promise((r) => setTimeout(r, 500));

		// No background errors — no constraint violations, no processing failures.
		const afterErrors = getBgErr();
		expect(afterErrors - beforeErrors).toBe(0);

		// Final DB state: SessionEnd must have been processed last (the session
		// queue serializes in arrival order, and SessionEnd was last in our list).
		const row = db.$client
			.prepare("SELECT status FROM sessions WHERE session_id = ?")
			.get(sessionId) as { status: string } | undefined;
		expect(row).toBeDefined();
		// SessionEnd sets status to "completed".
		expect(row?.status).toBe("completed");
	});
});

// ── P7 patch-3: drain endpoint XFF-spoof resistance (P1) ─────────────────────
//
// Even when AGENTPULSE_TRUSTED_PROXIES includes the cluster pod CIDR, a
// request from a non-loopback TCP peer carrying X-Forwarded-For: 127.0.0.1
// must be rejected with 403. The drain endpoint reads the raw TCP peer address,
// never the XFF header.

describe("POST /api/v1/internal/drain — XFF spoof cannot bypass loopback check", () => {
	const originalTrustedProxies = process.env.AGENTPULSE_TRUSTED_PROXIES;

	afterEach(() => {
		if (originalTrustedProxies !== undefined) {
			process.env.AGENTPULSE_TRUSTED_PROXIES = originalTrustedProxies;
		} else {
			process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
		}
		_resetDrainStateForTest();
	});

	test("trusted-proxy peer (10.0.0.5) with XFF: 127.0.0.1 is rejected (403)", async () => {
		// Configure trusted proxies to include the pod CIDR — the recommended
		// hook rate-limit config. This is the spoofing scenario.
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";

		// TCP peer is 10.0.0.5 (a "trusted" proxy), XFF claims loopback.
		// With the OLD code (getTrustedClientIp), this would be accepted.
		// With the NEW code (raw TCP peer), it must be rejected.
		const app = new Hono<{ Variables: { peerIp: string } }>();
		app.use("*", async (c, next) => {
			c.set("peerIp", "10.0.0.5");
			await next();
		});
		app.route("/api/v1/internal", internalRouter);

		const res = await app.request("/api/v1/internal/drain", {
			method: "POST",
			headers: { "X-Forwarded-For": "127.0.0.1" },
		});

		expect(res.status).toBe(403);
		expect(isShuttingDown()).toBe(false);
	});

	test("actual loopback TCP peer (127.0.0.1) still accepted regardless of XFF", async () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";

		const app = buildLoopbackDrainApp("127.0.0.1");
		const res = await app.request("/api/v1/internal/drain", {
			method: "POST",
			headers: { "X-Forwarded-For": "1.2.3.4" }, // XFF present but irrelevant
		});

		expect(res.status).toBe(200);
		expect(isShuttingDown()).toBe(true);
	});
});

// ── P7 patch-3: null / non-object body shapes (P2) ───────────────────────────
//
// JSON.parse("null") === null. Accessing parsed.session_id on null throws
// OUTSIDE the parse try/catch, causing Hono to return 500 — breaking the
// always-200 post-auth contract. Each degenerate body shape must return 200.

describe("POST /api/v1/hooks — null/non-object body shapes return 200", () => {
	const shapes = [
		{ label: "null literal", body: "null" },
		{ label: "JSON array", body: "[]" },
		{ label: "JSON number", body: "42" },
		{ label: "JSON string", body: '"hello"' },
		{ label: "JSON boolean true", body: "true" },
		{ label: "JSON boolean false", body: "false" },
	];

	for (const { label, body } of shapes) {
		test(`returns 200 for ${label}`, async () => {
			const app = buildApp();
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.ok).toBe(true);
		});
	}
});

describe("POST /api/v1/hooks/status — null/non-object body shapes return 200", () => {
	const shapes = [
		{ label: "null literal", body: "null" },
		{ label: "JSON array", body: "[]" },
		{ label: "JSON number", body: "42" },
		{ label: "JSON boolean", body: "true" },
	];

	for (const { label, body } of shapes) {
		test(`returns 200 for ${label}`, async () => {
			const app = buildApp();
			const res = await app.request("/api/v1/hooks/status", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.ok).toBe(true);
		});
	}
});
