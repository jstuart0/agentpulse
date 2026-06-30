/**
 * AC 9 — supervisor route-split (Phase 3)
 *
 * Verifies:
 *  1. Old management path /api/v1/supervisors/enroll → 404 (edge-public path no
 *     longer mints tokens).
 *  2. Admin router enforces requireAuth(): /api/v1/admin/supervisors/enroll
 *     with no auth → 401.
 *  3. Agent endpoints under /api/v1/supervisors/* still work (register reachable;
 *     auth is enforced in-handler, not by the route split itself).
 *  4. Admin endpoints with a valid auth session → reach the handler (201 from enroll).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { Hono } = await import("hono");
const { supervisorsAgentRouter, supervisorsAdminRouter } = await import("./supervisors.js");
const { createUser, issueSession, SESSION_DURATION_MS } = await import(
	"../services/local-auth-service.js"
);
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { registerSupervisor } = await import("../services/supervisor-registry.js");

// Mirror the real app.ts mount:
//   agent router at /api/v1        → /api/v1/supervisors/*
//   admin router at /api/v1/admin  → /api/v1/admin/supervisors/*
const app = new Hono()
	.route("/api/v1", supervisorsAgentRouter)
	.route("/api/v1/admin", supervisorsAdminRouter);

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	// Ensure auth is enforced for these tests.
	(config as Record<string, unknown>).disableAuth = false;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

// ── AC 9.1: old path /api/v1/supervisors/enroll → 404 ────────────────────────
describe("old management path is gone (AC 9.1)", () => {
	test("POST /api/v1/supervisors/enroll → 404", async () => {
		const res = await app.request("/api/v1/supervisors/enroll", { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("GET /api/v1/supervisors → 404 (list no longer on agent router)", async () => {
		const res = await app.request("/api/v1/supervisors", { method: "GET" });
		expect(res.status).toBe(404);
	});

	test("POST /api/v1/supervisors/fake-id/rotate → 404", async () => {
		const res = await app.request("/api/v1/supervisors/fake-id/rotate", { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("POST /api/v1/supervisors/fake-id/revoke → 404", async () => {
		const res = await app.request("/api/v1/supervisors/fake-id/revoke", { method: "POST" });
		expect(res.status).toBe(404);
	});
});

// ── AC 9.2: admin router enforces requireAuth() ───────────────────────────────
describe("admin router requires auth (AC 9.2)", () => {
	test("POST /api/v1/admin/supervisors/enroll with no auth → 401", async () => {
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
	});

	test("GET /api/v1/admin/supervisors with no auth → 401", async () => {
		const res = await app.request("/api/v1/admin/supervisors", { method: "GET" });
		expect(res.status).toBe(401);
	});

	test("POST /api/v1/admin/supervisors/fake-id/rotate with no auth → 401", async () => {
		const res = await app.request("/api/v1/admin/supervisors/fake-id/rotate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
	});

	test("POST /api/v1/admin/supervisors/fake-id/revoke with no auth → 401", async () => {
		const res = await app.request("/api/v1/admin/supervisors/fake-id/revoke", {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});
});

// ── AC 9.3: agent endpoints still reachable ───────────────────────────────────
describe("agent endpoints still reachable on /api/v1/supervisors (AC 9.3)", () => {
	test("POST /api/v1/supervisors/register without token → 401 (in-handler auth)", async () => {
		// register is on the agent router; with auth enabled and no credential it
		// returns 401 from in-handler logic, NOT 404 (proves the route is mounted).
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "test",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
			}),
		});
		// 401 = route found, in-handler auth fired (not 404)
		expect(res.status).toBe(401);
	});

	test("POST /api/v1/supervisors/fake-id/heartbeat without supervisor token → 401", async () => {
		const res = await app.request("/api/v1/supervisors/fake-id/heartbeat", {
			method: "POST",
		});
		// requireSupervisorAuth() fires → 401, not 404
		expect(res.status).toBe(401);
	});
});

// ── AGEN-8: unscoped-token slot-takeover guard ────────────────────────────────
describe("unscoped-token slot-takeover guard (AGEN-8)", () => {
	test("unscoped token + existing supervisor id → 409 supervisor_exists_use_rotate", async () => {
		// Directly register a supervisor so it already exists in the DB (the "victim").
		const { supervisor } = await registerSupervisor({
			hostName: "slot-takeover-victim",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
		});

		// Create an UNSCOPED enrollment token (supervisorId = null).
		const { token } = await createSupervisorEnrollmentToken("attacker-unscoped", null, null);

		// Attempt to register the victim's id using the unscoped token.
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "attacker-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				enrollmentToken: token,
				id: supervisor.id, // ← the takeover vector
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("supervisor_exists_use_rotate");
	});

	test("unscoped token + non-existent id → succeeds and returns credential", async () => {
		const { token } = await createSupervisorEnrollmentToken("fresh-unscoped", null, null);
		const freshId = crypto.randomUUID(); // guaranteed not in DB

		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "brand-new-host",
				platform: "darwin",
				arch: "arm64",
				version: "1.0.0",
				enrollmentToken: token,
				id: freshId,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { supervisorCredential: string };
		expect(typeof body.supervisorCredential).toBe("string");
	});

	test("scoped token (rotate path) is unaffected even when supervisor already exists", async () => {
		// Register a supervisor directly.
		const { supervisor } = await registerSupervisor({
			hostName: "scoped-rotate-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
		});

		// The admin rotate endpoint issues a SCOPED token bound to supervisor.id.
		const { token } = await createSupervisorEnrollmentToken(
			`rotate:${supervisor.hostName}`,
			null,
			supervisor.id, // ← scoped
		);

		// Registration via scoped token: the guard must NOT fire.
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "scoped-rotate-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				enrollmentToken: token,
				// id intentionally omitted — token provides it
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { supervisorCredential: string };
		expect(typeof body.supervisorCredential).toBe("string");
	});
});

// ── AC 9.4: admin handler reachable with valid session ────────────────────────
describe("admin handler reachable with valid local session (AC 9.4)", () => {
	test("POST /api/v1/admin/supervisors/enroll with valid session → 201", async () => {
		// Create a real local user, then issue a session for it.
		const user = await createUser({
			username: "testadmin",
			password: "TestPass123!",
			role: "user",
		});
		const { token } = await issueSession({
			userId: user.id,
			durationMs: SESSION_DURATION_MS,
		});
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `ap_session=${token}`,
			},
			body: JSON.stringify({ name: "test-supervisor" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");
	});
});
