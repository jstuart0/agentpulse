/**
 * Tests for the centralized operator route-scope policy (AGEN-12 Phase 1, D1).
 *
 * Covers:
 *  - classifyRoute(): pure matcher unit tests (no HTTP) — test contract section A.
 *  - Route x caller-class integration matrix (real app.request()) — section B.
 *  - Pre-swap characterization / regression baseline (M2), captured from the
 *    actual pre-Phase-1 app at 9d4d030 and pinned as literal expected values
 *    below (not assumed) — proves "no bleed" rather than asserting it.
 *  - Session-detail controlActions embed conditional (C1).
 *  - Route-drift guard (M5): every GET/HEAD route in the swapped bundle must
 *    be classified in OBSERVE_READ_PATHS or INTENTIONALLY_MANAGE_ONLY.
 *
 * DEVIATION from the Phase 1 test contract (documented, not silent): the
 * contract's matrix rows for `GET /templates`, `GET /launches`, and
 * `GET /ai/inbox` list `observeKey -> 200`. The plan's D1 decision (the C1
 * correction, revision r2 -- the single most emphasized decision in the plan)
 * explicitly moves these three routes to manage-only because their REST DTOs
 * carry `env` / `launchSpec` / `claimToken` / injected-prompt payloads (plan
 * lines 43-50, "Removed from observe under C1"). The task brief calls the D1
 * matcher spec "non-negotiable" and instructs a fail-closed choice on any
 * plan/contract conflict. This file asserts the fail-closed D1 behavior
 * (403 for observeKey on these three routes) instead of the contract's
 * stale 200 expectation. Flagged for mid-build review (tessa/xander).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { controlActions, sessions } = await import("../db/schema/index.js");
const { createApiKey, SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE } = await import("./api-key.js");
const { classifyRoute, OBSERVE_READ_PATHS, INTENTIONALLY_MANAGE_ONLY } = await import(
	"./route-scope-policy.js"
);

const TEST_SECRET = "rsp-test-secret-32-characters!!!";
const TEST_USERNAME = "rsp-forwardauth-user";
const TEST_UID = "rsp-forwardauth-subject";

function forwardauthHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"X-Authentik-Username": TEST_USERNAME,
		"X-Authentik-Uid": TEST_UID,
		"X-Authentik-Verify": TEST_SECRET,
		...extra,
	});
}

function authBearer(key: string): Headers {
	return new Headers({ Authorization: `Bearer ${key}` });
}

const MOUNTS = ["/api/v1", "/app-api/v1"] as const;

async function requestAllMounts(
	method: string,
	path: string,
	headers: Headers,
): Promise<Response[]> {
	return Promise.all(MOUNTS.map((mount) => app.request(`${mount}${path}`, { method, headers })));
}

const originalDisableAuth = config.disableAuth;
const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;
const originalProvider = process.env.FORWARDAUTH_PROVIDER;

let observeKey: string;
let manageKey: string;
let dualKey: string;
let ingestKey: string;

beforeAll(async () => {
	await initializeDatabase();
	process.env.FORWARDAUTH_TRUST_SECRET = TEST_SECRET;
	process.env.FORWARDAUTH_PROVIDER = "authentik";
	(config as Record<string, unknown>).disableAuth = false;
	// biome-ignore lint/performance/noDelete: clear memoised trust-secret so env var takes effect
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;

	observeKey = (await createApiKey("rsp-observe-key", [SCOPE_OBSERVE])).key;
	manageKey = (await createApiKey("rsp-manage-key", [SCOPE_MANAGE])).key;
	dualKey = (await createApiKey("rsp-dual-key", [SCOPE_OBSERVE, SCOPE_MANAGE])).key;
	ingestKey = (await createApiKey("rsp-ingest-key", [SCOPE_INGEST])).key;
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

// ─── A. Policy-matcher unit tests (no HTTP) ─────────────────────────────────

describe("classifyRoute — pure matcher (test contract section A)", () => {
	test("A.1 fresh/un-allowlisted route → manage (fail-closed default)", () => {
		expect(classifyRoute("GET", "/some-brand-new-route-never-allowlisted")).toBe(SCOPE_MANAGE);
	});

	test("A.2 POST on an otherwise-observe-eligible path → manage (method-gated)", () => {
		expect(classifyRoute("POST", "/sessions")).toBe(SCOPE_MANAGE);
	});

	test("A.3 HEAD on an observe-eligible path → observe (HEAD treated as GET)", () => {
		expect(classifyRoute("HEAD", "/sessions")).toBe(SCOPE_OBSERVE);
	});

	test("A.4 path-param matching on real ids", () => {
		expect(classifyRoute("GET", "/sessions/abc123")).toBe(SCOPE_OBSERVE);
		expect(classifyRoute("GET", "/sessions/abc123/timeline")).toBe(SCOPE_OBSERVE);
		expect(classifyRoute("GET", "/sessions/abc123/claude-md")).toBe(SCOPE_OBSERVE);
	});

	test("A.4b hypothetical /sessions/:id/prompt does not structurally match any observe template (route-aware, not naive-prefix)", () => {
		expect(classifyRoute("GET", "/sessions/abc123/prompt")).toBe(SCOPE_MANAGE);
	});

	test("A.4c path-traversal-shaped raw strings do not bypass the policy", () => {
		expect(classifyRoute("GET", "/sessions/../settings")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/../settings")).toBe(SCOPE_MANAGE);
	});

	test("A.5 explicit D1 exclusion list — one assertion per route (no loop)", () => {
		expect(classifyRoute("GET", "/settings")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/api-keys")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/channels")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/ai/providers")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/labs")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/ai/risk-classes")).toBe(SCOPE_MANAGE);
	});

	test("A.5b C1 exclusions — launches/templates/inbox/control-actions stay manage despite being GETs (D1 correction)", () => {
		expect(classifyRoute("GET", "/launches")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/launches/abc")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/templates")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/templates/abc")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/ai/inbox")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/ai/action-requests")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/sessions/abc/control-actions")).toBe(SCOPE_MANAGE);
	});

	test("A.6 read-like POSTs stay manage (regression-proofs a future 'simplify to include POSTs' refactor)", () => {
		expect(classifyRoute("POST", "/launches/recommendation")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("POST", "/templates/preview")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("POST", "/ai/intelligence/batch")).toBe(SCOPE_MANAGE);
	});

	test("dual-mount prefix stripping normalizes identically under /api/v1 and /app-api/v1", () => {
		expect(classifyRoute("GET", "/api/v1/sessions")).toBe(SCOPE_OBSERVE);
		expect(classifyRoute("GET", "/app-api/v1/sessions")).toBe(SCOPE_OBSERVE);
	});

	test("synthetic sibling route /sessions-admin does NOT match the /sessions observe entry", () => {
		expect(classifyRoute("GET", "/sessions-admin")).toBe(SCOPE_MANAGE);
		expect(classifyRoute("GET", "/api/v1/sessions-admin")).toBe(SCOPE_MANAGE);
	});
});

// ─── B. Route × caller-class integration matrix (real app.request()) ───────

describe("GET /sessions — caller-class matrix (rows 1-6)", () => {
	test("row 1: observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/sessions", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 2: manageKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/sessions", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 3: dualKey (observe+manage) → 200, identical to manageKey", async () => {
		const [a, b] = await requestAllMounts("GET", "/sessions", authBearer(dualKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 4: ingestKey → 403 { error: insufficient_scope, required: manage } (not 'observe')", async () => {
		const [a, b] = await requestAllMounts("GET", "/sessions", authBearer(ingestKey));
		expect(a.status).toBe(403);
		expect(await a.json()).toEqual({ error: "insufficient_scope", required: "manage" });
		expect(b.status).toBe(403);
		expect(await b.json()).toEqual({ error: "insufficient_scope", required: "manage" });
	});

	test("row 5: forwardauthSession → 200 (non-api_key callers pass unconditionally, unchanged)", async () => {
		const [a, b] = await Promise.all(
			MOUNTS.map((mount) => app.request(`${mount}/sessions`, { headers: forwardauthHeaders() })),
		);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 6: DISABLE_AUTH=true → 200", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const [a, b] = await Promise.all(MOUNTS.map((mount) => app.request(`${mount}/sessions`)));
			expect(a.status).toBe(200);
			expect(b.status).toBe(200);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});
});

describe("Security-critical negatives (rows 7, 9, 10) — exact body shape", () => {
	test("row 7: GET /settings with observeKey → 403 { error: insufficient_scope, required: manage }", async () => {
		const [a, b] = await requestAllMounts("GET", "/settings", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(await a.json()).toEqual({ error: "insufficient_scope", required: "manage" });
		expect(b.status).toBe(403);
		expect(await b.json()).toEqual({ error: "insufficient_scope", required: "manage" });
	});

	test("row 8: GET /settings with manageKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/settings", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 9: GET /api-keys with observeKey → 403 { error: insufficient_scope, required: manage }", async () => {
		const [a, b] = await requestAllMounts("GET", "/api-keys", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(await a.json()).toEqual({ error: "insufficient_scope", required: "manage" });
		expect(b.status).toBe(403);
		expect(await b.json()).toEqual({ error: "insufficient_scope", required: "manage" });
	});

	test("row 10: POST /sessions/:id/prompt with observeKey → 403 (sharpest method-gating test — path prefix is otherwise observe-eligible)", async () => {
		const [a, b] = await requestAllMounts(
			"POST",
			"/sessions/fake-id/prompt",
			authBearer(observeKey),
		);
		expect(a.status).toBe(403);
		expect(await a.json()).toEqual({ error: "insufficient_scope", required: "manage" });
		expect(b.status).toBe(403);
		expect(await b.json()).toEqual({ error: "insufficient_scope", required: "manage" });
	});
});

describe("Further mutating-route negatives (rows 11-13)", () => {
	test("row 11: POST /sessions/:id/stop with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("POST", "/sessions/fake-id/stop", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 12: PUT /sessions/:id/rename with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts(
			"PUT",
			"/sessions/fake-id/rename",
			authBearer(observeKey),
		);
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 13: DELETE /sessions/:id with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("DELETE", "/sessions/fake-id", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});
});

describe("/v1/admin no-bleed proof (rows 14-16)", () => {
	test("row 14: GET /admin/supervisors with observeKey → 403 (no bleed into the untouched admin mount)", async () => {
		const [a, b] = await requestAllMounts("GET", "/admin/supervisors", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 15: GET /admin/supervisors with manageKey → 200 (supervisors.ts:47 untouched, still strict manage)", async () => {
		const [a, b] = await requestAllMounts("GET", "/admin/supervisors", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 16: POST /admin/supervisors/enroll with manageKey → 201 (regression, matches existing M-2d)", async () => {
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: new Headers({
				Authorization: `Bearer ${manageKey}`,
				"Content-Type": "application/json",
			}),
			body: JSON.stringify({ name: "rsp-row16-supervisor" }),
		});
		expect(res.status).toBe(201);
	});
});

describe("Observe-eligible reads (rows 17, 22, 24, 26-28)", () => {
	test("row 17: GET /search?q=x with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/search?q=x", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 22: GET /projects with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/projects", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 24: GET /ai/digest with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/digest", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 26: GET /ai/spend with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/spend", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 27: GET /ai/status with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/status", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 28: GET /ai/diagnostics with observeKey → 200", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/diagnostics", authBearer(observeKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});
});

describe("C1 deviation — manage-only reads (rows 18, 19, 23; contract said 200, D1 says 403)", () => {
	test("row 18 (deviated): GET /templates with observeKey → 403 — env in DTO (templates-service.ts:26)", async () => {
		const [a, b] = await requestAllMounts("GET", "/templates", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 18 regression: GET /templates with manageKey → 200 (unchanged)", async () => {
		const [a, b] = await requestAllMounts("GET", "/templates", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 19 (deviated): GET /launches with observeKey → 403 — env/launchSpec/claimToken in DTO (launch-validator.ts:28-36)", async () => {
		const [a, b] = await requestAllMounts("GET", "/launches", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 19 regression: GET /launches with manageKey → 200 (unchanged)", async () => {
		const [a, b] = await requestAllMounts("GET", "/launches", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});

	test("row 23 (deviated): GET /ai/inbox with observeKey → 403 — action_* items can embed launch payloads", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/inbox", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 23 regression: GET /ai/inbox with manageKey → 200 (unchanged)", async () => {
		const [a, b] = await requestAllMounts("GET", "/ai/inbox", authBearer(manageKey));
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});
});

describe("Advisory/POST negatives (rows 20-21, 29-30)", () => {
	test("row 20: POST /launches/recommendation with observeKey → 403 (D1 tradeoff — no dry-run for observe-only)", async () => {
		const [a, b] = await requestAllMounts(
			"POST",
			"/launches/recommendation",
			authBearer(observeKey),
		);
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 21: POST /launches with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("POST", "/launches", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 29: POST /ai/inbox/hitl/:id/decide with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts(
			"POST",
			"/ai/inbox/hitl/fake-id/decide",
			authBearer(observeKey),
		);
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 30: POST /ai/ask with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("POST", "/ai/ask", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 31: POST /ai/ask with manageKey → not 403 (reaches the handler; handler-level result irrelevant here)", async () => {
		const [a, b] = await requestAllMounts("POST", "/ai/ask", authBearer(manageKey));
		expect(a.status).not.toBe(403);
		expect(b.status).not.toBe(403);
	});
});

describe("Remaining manage-only negatives (rows 32-33) + AI intelligence pass-through (row 25)", () => {
	test("row 32: GET /channels with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("GET", "/channels", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 33: GET /labs/flags with observeKey → 403", async () => {
		const [a, b] = await requestAllMounts("GET", "/labs/flags", authBearer(observeKey));
		expect(a.status).toBe(403);
		expect(b.status).toBe(403);
	});

	test("row 25: GET /ai/sessions/:id/intelligence (fake id) with observeKey → not 403 (proves the AI-router wildcard swap at app.ts:89 worked; handler's own 404 passes through)", async () => {
		const [a, b] = await requestAllMounts(
			"GET",
			"/ai/sessions/fake-id/intelligence",
			authBearer(observeKey),
		);
		expect(a.status).not.toBe(403);
		expect(b.status).not.toBe(403);
		// Pinned to the captured pre-Phase-1 baseline for a nonexistent session.
		expect(a.status).toBe(404);
		expect(b.status).toBe(404);
	});
});

// ─── M2 — pre-swap characterization / regression baseline ──────────────────
//
// Captured from the ACTUAL pre-Phase-1 app (9d4d030, clean tree) via a
// throwaway probe script before any Phase 1 source changes were made. These
// are not "compatible, no change" assertions-by-design-reasoning — they are
// literal observed values from the unmodified codebase, pinned here so the
// post-swap run proves invariance rather than asserting it.

const BASELINE_STATUS: Record<string, number> = {
	"GET /sessions": 200,
	"GET /sessions/stats": 200,
	"GET /sessions/nope": 404,
	"GET /sessions/nope/timeline": 200,
	"POST /sessions/nope/prompt": 400,
	"POST /sessions/nope/stop": 400,
	"PUT /sessions/nope/rename": 500,
	"DELETE /sessions/nope": 200,
	"GET /settings": 200,
	"GET /api-keys": 200,
	"GET /search?q=x": 200,
	"GET /templates": 200,
	"GET /launches": 200,
	"POST /launches/recommendation": 500,
	"POST /launches": 400,
	"GET /projects": 200,
	"GET /ai/inbox": 200,
	"GET /ai/digest": 200,
	"GET /ai/sessions/nope/intelligence": 404,
	"GET /ai/spend": 200,
	"GET /ai/status": 200,
	"GET /ai/diagnostics": 200,
	"POST /ai/inbox/hitl/nope/decide": 409,
	"POST /ai/ask": 409,
	"GET /channels": 200,
	"GET /labs/flags": 200,
	"GET /admin/supervisors": 200,
};

// Mounts are requested SEQUENTIALLY (not Promise.all) in this sweep: several
// baseline routes (DELETE/PUT on a shared fake session id) open a
// withTransaction() block, and firing both mounts concurrently against the
// same row races bun:sqlite into "cannot start a transaction within a
// transaction" — a test-harness artifact of hitting the identical resource
// twice at once, not a Phase 1 policy regression. The captured baseline
// itself was measured sequentially (see the probe script referenced above).
describe("Row 34 — manageKey/forwardauth/DISABLE_AUTH regression sweep vs captured 9d4d030 baseline", () => {
	test("manageKey status is unchanged from the pre-Phase-1 baseline on every route, both mounts", async () => {
		for (const [key, expectedStatus] of Object.entries(BASELINE_STATUS)) {
			const spaceIdx = key.indexOf(" ");
			const method = key.slice(0, spaceIdx);
			const path = key.slice(spaceIdx + 1);
			for (const mount of MOUNTS) {
				const res = await app.request(`${mount}${path}`, {
					method,
					headers: authBearer(manageKey),
				});
				expect(res.status).toBe(expectedStatus);
			}
		}
	});

	test("forwardauthSession status is unchanged from the pre-Phase-1 baseline on every route, both mounts (non-api_key never scope-limited)", async () => {
		for (const [key, expectedStatus] of Object.entries(BASELINE_STATUS)) {
			const spaceIdx = key.indexOf(" ");
			const method = key.slice(0, spaceIdx);
			const path = key.slice(spaceIdx + 1);
			for (const mount of MOUNTS) {
				const res = await app.request(`${mount}${path}`, { method, headers: forwardauthHeaders() });
				expect(res.status).toBe(expectedStatus);
			}
		}
	});

	test("DISABLE_AUTH=true status is unchanged from the pre-Phase-1 baseline on every route, both mounts", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			for (const [key, expectedStatus] of Object.entries(BASELINE_STATUS)) {
				const spaceIdx = key.indexOf(" ");
				const method = key.slice(0, spaceIdx);
				const path = key.slice(spaceIdx + 1);
				for (const mount of MOUNTS) {
					const res = await app.request(`${mount}${path}`, { method });
					expect(res.status).toBe(expectedStatus);
				}
			}
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("ingestKey → 403 on every operator route in the baseline table, both mounts (unchanged: neither observe nor manage)", async () => {
		for (const key of Object.keys(BASELINE_STATUS)) {
			const spaceIdx = key.indexOf(" ");
			const method = key.slice(0, spaceIdx);
			const path = key.slice(spaceIdx + 1);
			for (const mount of MOUNTS) {
				const res = await app.request(`${mount}${path}`, {
					method,
					headers: authBearer(ingestKey),
				});
				expect(res.status).toBe(403);
			}
		}
	});
});

describe("M2 — supervisor-agent routes unaffected by the sibling wildcard swap (Hono merge-semantics proof)", () => {
	test("POST /supervisors/register with no valid credential → 401, unchanged, both mounts", async () => {
		const results = await Promise.all(
			MOUNTS.map((mount) =>
				app.request(`${mount}/supervisors/register`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "probe-sup", token: "bad" }),
				}),
			),
		);
		for (const res of results) {
			expect(res.status).toBe(401);
		}
	});

	test("POST /supervisors/:id/heartbeat with no credential → 401, unchanged, both mounts", async () => {
		const results = await Promise.all(
			MOUNTS.map((mount) =>
				app.request(`${mount}/supervisors/probe-id/heartbeat`, { method: "POST" }),
			),
		);
		for (const res of results) {
			expect(res.status).toBe(401);
		}
	});
});

// ─── Detail-embed conditional (C1) ──────────────────────────────────────────

describe("GET /sessions/:sessionId — controlActions embed conditional (C1)", () => {
	const sessionId = "rsp-detail-embed-session";

	beforeAll(async () => {
		await getDb()
			.insert(sessions)
			.values({ sessionId, agentType: "claude_code", status: "active" });
		await getDb()
			.insert(controlActions)
			.values({ sessionId, actionType: "stop", status: "queued" });
	});

	test("observe caller's response omits the controlActions key entirely", async () => {
		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			headers: authBearer(observeKey),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect("controlActions" in body).toBe(false);
	});

	test("manage caller's response includes the populated controlActions array", async () => {
		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			headers: authBearer(manageKey),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { controlActions: unknown[] };
		expect(Array.isArray(body.controlActions)).toBe(true);
		expect(body.controlActions.length).toBeGreaterThan(0);
	});

	test("dualKey (observe+manage) caller's response also includes controlActions", async () => {
		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			headers: authBearer(dualKey),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { controlActions: unknown[] };
		expect(Array.isArray(body.controlActions)).toBe(true);
	});

	test("forwardauth caller's response includes controlActions (never scope-limited)", async () => {
		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			headers: forwardauthHeaders(),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { controlActions: unknown[] };
		expect(Array.isArray(body.controlActions)).toBe(true);
	});

	test("DISABLE_AUTH caller's response includes controlActions (scopes: ['*'])", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await app.request(`/api/v1/sessions/${sessionId}`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { controlActions: unknown[] };
			expect(Array.isArray(body.controlActions)).toBe(true);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});
});

// ─── Route-drift guard (M5) ──────────────────────────────────────────────────

describe("Route-drift guard — every GET/HEAD route in the swapped bundle is classified", () => {
	// Top-level path segments exclusively owned by the 10 swapped routers.
	// Routes outside this set (e.g. /auth, /health, /supervisors,
	// /admin — the untouched admin router, or root-mounted install scripts)
	// never pass through requireOperatorScope() and are out of scope here.
	const IN_SCOPE_TOP_SEGMENTS = new Set([
		"sessions",
		"settings",
		"api-keys",
		"telemetry",
		"templates",
		"projects",
		"launches",
		"search",
		"labs",
		"channels",
		"ai",
	]);

	function normalize(routePath: string): string | null {
		for (const prefix of ["/api/v1", "/app-api/v1"]) {
			if (routePath.startsWith(prefix)) {
				return routePath.slice(prefix.length) || "/";
			}
		}
		return null;
	}

	test("every GET route under a swapped-router path segment is present in OBSERVE_READ_PATHS or INTENTIONALLY_MANAGE_ONLY", () => {
		const seen = new Set<string>();
		let checked = 0;
		for (const route of app.routes) {
			if (route.method !== "GET" && route.method !== "HEAD") continue;
			const normalized = normalize(route.path);
			if (normalized === null) continue;
			const topSegment = normalized.split("/").filter(Boolean)[0];
			if (!topSegment || !IN_SCOPE_TOP_SEGMENTS.has(topSegment)) continue;
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			checked++;
			const classified =
				OBSERVE_READ_PATHS.has(normalized) || INTENTIONALLY_MANAGE_ONLY.has(normalized);
			expect(classified).toBe(true);
		}
		// Sanity: this test must actually walk a non-trivial route population,
		// or a future refactor that stops registering routes at import time
		// would let this test pass vacuously.
		expect(checked).toBeGreaterThan(30);
	});

	test("OBSERVE_READ_PATHS and INTENTIONALLY_MANAGE_ONLY do not overlap", () => {
		for (const path of OBSERVE_READ_PATHS) {
			expect(INTENTIONALLY_MANAGE_ONLY.has(path)).toBe(false);
		}
	});
});
