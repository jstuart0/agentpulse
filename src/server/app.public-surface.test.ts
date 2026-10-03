/**
 * Phase 3 (2026-09-29-deliver-supervisor-auth-routing, AGEN-17): the
 * public-surface drift guard. Proves no operator wildcard shadows an
 * edge-public route (checks (a)-(f)) and that the agent router is
 * root-mounted, not merely present a second time alongside a dead in-bundle
 * mount (check (g)). Built on app.integration.test.ts:17-86's real-app
 * scaffold — a bare Hono() (supervisors-split.test.ts's old pattern) can't
 * observe cross-router shadowing, which is exactly what hid AGEN-17.
 *
 * Test contract items 37-45, 48, 55; crash-loop repro cases A-F.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./db/__test_db.js";
import { deleteAllSupervisors } from "./services/__test_supervisors.js";

const { config } = await import("./config.js");
const { initializeDatabase, getDb } = await import("./db/client.js");
const { app } = await import("./app.js");
const { createApiKey } = await import("./auth/api-key.js");
const { markDbReady, _resetDbReadyForTest } = await import("./routes/health.js");
const { events, launchRequests, managedSessions } = await import("./db/schema/index.js");
const { supervisorsAgentRouter } = await import("./routes/supervisors.js");

const MOUNTS = ["/api/v1", "/app-api/v1"] as const;
const REPO_ROOT = join(import.meta.dir, "../../");
const INGRESSROUTE_PATH = join(REPO_ROOT, "deploy/k8s/07-ingressroute.yaml");

const FAKE_CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code"],
	launchModes: ["headless"],
	os: "linux",
	terminalSupport: [],
	features: [],
};

type Credential = { id: string; token: string };

const originalDisableAuth = config.disableAuth;

let ingestKey: string;
let manageKey: string;
let supervisorX: Credential;

async function enrollAndRegister(hostName: string): Promise<Credential> {
	const enrollRes = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name: hostName }),
	});
	expect(enrollRes.status).toBe(201);
	const { token: enrollmentToken } = (await enrollRes.json()) as { token: string };

	// The manage Bearer here is defense against ordering: this bootstrap must
	// succeed both before AND after the Phase 3 fix (repro case C), since it
	// runs in beforeAll ahead of every test.
	const registerRes = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({
			hostName,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken,
			capabilities: FAKE_CAPABILITIES,
			trustedRoots: [],
		}),
	});
	expect(registerRes.status).toBe(200);
	const body = (await registerRes.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

function fillParams(path: string): string {
	return path
		.replace(/:id\b/g, supervisorX.id)
		.replace(/:launchId\b/g, "probe-launch-id")
		.replace(/:sessionId\b/g, "probe-session-id")
		.replace(/:actionId\b/g, "probe-action-id");
}

beforeAll(async () => {
	await initializeDatabase();
	markDbReady();
	(config as Record<string, unknown>).disableAuth = false;
	ingestKey = (await createApiKey("public-surface-test-ingest", ["ingest"])).key;
	manageKey = (await createApiKey("public-surface-test-manage", ["manage"])).key;
	supervisorX = await enrollAndRegister(`sup-x-${crypto.randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	_resetDbReadyForTest(false);
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
});

// ─── (a) population ──────────────────────────────────────────────────────

const agentRouteProbes = supervisorsAgentRouter.routes.map((r) => ({
	method: r.method,
	path: `/api/v1${r.path}`,
}));

// Hand-authored, cross-checked against each route handler's own .get/.post
// definition (health.ts, ingest.ts, auth.ts, channels.ts, setup.ts,
// csp-report.ts). Methods aren't expressible in the IngressRoute YAML
// (Traefik routes by host+path, not method), so the population's
// set-equality check below compares PATHS only; the method here exists for
// (b)/(b2)/(c) probing.
const NON_AGENT_PUBLIC_ROUTES: Array<{ method: string; path: string }> = [
	{ method: "GET", path: "/api/v1/health" },
	{ method: "GET", path: "/api/v1/ready" },
	{ method: "POST", path: "/api/v1/hooks" },
	{ method: "POST", path: "/api/v1/hooks/status" },
	{ method: "GET", path: "/api/v1/auth/me" },
	{ method: "POST", path: "/api/v1/auth/login" },
	{ method: "POST", path: "/api/v1/auth/logout" },
	{ method: "POST", path: "/api/v1/auth/signup" },
	// Exempt so a local account behind SSO can change its password: the
	// in-handler requireAuth still refuses a request with no credential.
	{ method: "POST", path: "/api/v1/auth/change-password" },
	{ method: "GET", path: "/app-api/v1/auth/me" },
	{ method: "POST", path: "/app-api/v1/auth/login" },
	{ method: "POST", path: "/app-api/v1/auth/logout" },
	{ method: "POST", path: "/app-api/v1/auth/signup" },
	{ method: "POST", path: "/app-api/v1/auth/change-password" },
	{ method: "POST", path: "/api/v1/channels/telegram/webhook" },
	{ method: "GET", path: "/setup.sh" },
	{ method: "GET", path: "/setup-relay.sh" },
	{ method: "GET", path: "/install-local.sh" },
	{ method: "GET", path: "/install-local.ps1" },
	{ method: "POST", path: "/api/v1/csp-report" },
];

const PUBLIC_ROUTES = [...NON_AGENT_PUBLIC_ROUTES, ...agentRouteProbes];

// Documented exclusions from the YAML's Path/PathPrefix rules (D3/plan):
//  - PathPrefix(/assets/) — static, not an API route.
//  - PathPrefix(/api/v1/internal) — edge-deny rule (routes to a 503 service).
//  - Path(/app-api/v1/ws) — a Bun WebSocket upgrade, not a Hono route.
const EXCLUDED_YAML_PATHS = new Set(["/assets/", "/api/v1/internal", "/app-api/v1/ws"]);

function extractYamlPathRules(yamlContent: string): Array<{ path: string; prefix: boolean }> {
	const rules: Array<{ path: string; prefix: boolean }> = [];
	for (const rawLine of yamlContent.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("- match:")) continue;
		// Exclude compound conditions beyond a bare Host(...) && Path[Prefix](...)
		// — e.g. the Bearer-bypass rule also ANDs a HeaderRegexp(...).
		const andCount = (line.match(/&&/g) ?? []).length;
		if (andCount > 1) continue;
		const prefixMatch = line.match(/PathPrefix\(`([^`]+)`\)/);
		if (prefixMatch) {
			rules.push({ path: prefixMatch[1], prefix: true });
			continue;
		}
		const pathMatch = line.match(/Path\(`([^`]+)`\)/);
		if (pathMatch) {
			rules.push({ path: pathMatch[1], prefix: false });
		}
	}
	return rules;
}

function yamlDerivedPathSet(): Set<string> {
	const content = readFileSync(INGRESSROUTE_PATH, "utf-8");
	const rules = extractYamlPathRules(content);
	const paths = new Set<string>();
	for (const rule of rules) {
		if (EXCLUDED_YAML_PATHS.has(rule.path)) continue;
		if (rule.prefix && rule.path === "/api/v1/supervisors") {
			for (const r of supervisorsAgentRouter.routes) {
				paths.add(`/api/v1${r.path}`);
			}
			continue;
		}
		paths.add(rule.path);
	}
	return paths;
}

describe("(a) population — PUBLIC_ROUTES matches the IngressRoute forwardauth exemptions", () => {
	test("PUBLIC_ROUTES path set equals the YAML-derived exemption set (PathPrefix(/api/v1/supervisors) expanded from the live router)", () => {
		const yamlPaths = yamlDerivedPathSet();
		const tablePaths = new Set(PUBLIC_ROUTES.map((r) => r.path));
		expect([...tablePaths].sort()).toEqual([...yamlPaths].sort());
	});

	test("floor: at least 9 agent-route probes and 15 path probes total", () => {
		expect(agentRouteProbes.length).toBeGreaterThanOrEqual(9);
		expect(PUBLIC_ROUTES.length).toBeGreaterThanOrEqual(15);
	});

	test("named member: POST /api/v1/supervisors/:id/heartbeat is present", () => {
		expect(
			PUBLIC_ROUTES.some(
				(r) => r.method === "POST" && r.path === "/api/v1/supervisors/:id/heartbeat",
			),
		).toBe(true);
	});
});

// ─── (b) shadowing check, ingest Bearer ─────────────────────────────────────

describe("(b) shadowing check — ingest Bearer never gets insufficient_scope on an agent route", () => {
	test("every agent-route probe, sent with an ingest-only key, is not 403 insufficient_scope", async () => {
		for (const { method, path } of agentRouteProbes) {
			const url = fillParams(path);
			const res = await app.request(url, {
				method,
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${ingestKey}` },
			});
			if (res.status === 403) {
				const body = (await res
					.clone()
					.json()
					.catch(() => null)) as { error?: string } | null;
				expect(body?.error, `${method} ${url} got 403 ${JSON.stringify(body)}`).not.toBe(
					"insufficient_scope",
				);
			}
		}
	});
});

// ─── (b2) shadowing check, no credential at all ─────────────────────────────

const PUBLIC_NO_CRED_EXPECT: Record<string, { status: number; error?: string }> = {
	"POST /api/v1/supervisors/register": {
		status: 401,
		error: "Supervisor registration requires enrollment token or credential",
	},
	"POST /api/v1/supervisors/:id/heartbeat": { status: 401, error: "Missing supervisor credential" },
	"POST /api/v1/supervisors/:id/launches/claim": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/supervisors/:id/launches/:launchId/status": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/supervisors/:id/managed-session-state": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/supervisors/:id/managed-sessions/:sessionId/events": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"GET /api/v1/supervisors/:id/provider-sync": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/supervisors/:id/control-actions/claim": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/supervisors/:id/control-actions/:actionId/status": {
		status: 401,
		error: "Missing supervisor credential",
	},
	"POST /api/v1/hooks": { status: 401, error: "Missing API key" },
	"POST /api/v1/hooks/status": { status: 401, error: "Missing API key" },
	"GET /api/v1/health": { status: 200 },
	"GET /api/v1/ready": { status: 200 },
	"GET /setup.sh": { status: 200 },
	// D19/F172/F174 (cli-parity): /setup-relay.sh refuses to serve when it
	// can't safely resolve a public address — PUBLIC_URL unset (as in this
	// test env) plus a non-loopback-looking Host (Hono's app.request() sends
	// none by default) is exactly that case. See
	// setup-relay-served.test.ts's "PUBLIC_URL unset + non-loopback Host →
	// 503 public_url_unset" for the dedicated coverage; the 503 body here is
	// a shell script, not JSON, so no `error` field to assert.
	"GET /setup-relay.sh": { status: 503 },
	"GET /install-local.sh": { status: 200 },
	"GET /install-local.ps1": { status: 200 },
	// auth/*, telegram webhook, csp-report — already root-mounted, unaffected
	// by the Phase 3 fix. Recorded verbatim from the observed pre-fix (and
	// therefore also post-fix) behavior.
	"GET /api/v1/auth/me": { status: 200 },
	"POST /api/v1/auth/login": { status: 401, error: "Invalid credentials" },
	"POST /api/v1/auth/logout": { status: 200 },
	"POST /api/v1/auth/signup": { status: 400, error: "Password must be at least 12 characters." },
	"GET /app-api/v1/auth/me": { status: 200 },
	"POST /app-api/v1/auth/login": { status: 401, error: "Invalid credentials" },
	"POST /app-api/v1/auth/logout": { status: 200 },
	"POST /app-api/v1/auth/signup": {
		status: 400,
		error: "Password must be at least 12 characters.",
	},
	"POST /api/v1/auth/change-password": { status: 401 },
	"POST /app-api/v1/auth/change-password": { status: 401 },
	"POST /api/v1/channels/telegram/webhook": { status: 404, error: "telegram_disabled" },
	"POST /api/v1/csp-report": { status: 204 },
};

// Bodies needed for handlers that read the request body before any auth
// check runs (register's own field validation; auth/login and auth/signup
// parsing username/password; a JSON body so csp-report/telegram-webhook
// don't 500 on an empty stream). The short "y" password reproduces the
// exact "Password must be at least 12 characters." message recorded in
// PUBLIC_NO_CRED_EXPECT for signup.
function noCredentialProbeBody(path: string): string | undefined {
	if (path === "/api/v1/supervisors/register") {
		return JSON.stringify({
			hostName: "probe-b2",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
		});
	}
	if (path.endsWith("/auth/login") || path.endsWith("/auth/signup")) {
		return JSON.stringify({ username: "probe-b2-user", password: "y" });
	}
	if (path === "/api/v1/channels/telegram/webhook" || path === "/api/v1/csp-report") {
		return JSON.stringify({});
	}
	return undefined;
}

describe("(b2) shadowing check — no credential at all, per-route expected status/error", () => {
	test("PUBLIC_NO_CRED_EXPECT's key set equals (a)'s PUBLIC_ROUTES set", () => {
		const tableKeys = new Set(PUBLIC_ROUTES.map((r) => `${r.method} ${r.path}`));
		const expectKeys = new Set(Object.keys(PUBLIC_NO_CRED_EXPECT));
		expect([...expectKeys].sort()).toEqual([...tableKeys].sort());
	});

	test("every public route, with no credential, matches its documented status/error and never looks like an operator-gate rejection", async () => {
		for (const { method, path } of PUBLIC_ROUTES) {
			const key = `${method} ${path}`;
			const expected = PUBLIC_NO_CRED_EXPECT[key];
			expect(expected, `no PUBLIC_NO_CRED_EXPECT entry for ${key}`).toBeDefined();

			const url = fillParams(path);
			const body = noCredentialProbeBody(path);
			const res = await app.request(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body,
			});

			expect(res.status, `${key}`).toBe(expected.status);

			let parsedError: string | undefined;
			if (res.status !== 204) {
				const json = (await res
					.clone()
					.json()
					.catch(() => null)) as { error?: string } | null;
				parsedError = json?.error;
			}
			if (expected.error !== undefined) {
				expect(parsedError, `${key}`).toBe(expected.error);
			}

			// Global rule: no row may carry the sibling operator-gate's exact
			// rejection signature — the whole point of this pass.
			// The change-password routes are the exception: they are exempt from
			// forwardauth only so a local account can reach them, and require a
			// signed-in user in the handler, so their 401 is that handler's own.
			const looksLikeSiblingGate =
				(res.status === 401 && parsedError === "Unauthorized") ||
				(res.status === 403 && parsedError === "insufficient_scope");
			if (!path.endsWith("/auth/change-password")) {
				expect(looksLikeSiblingGate, `${key} looked like a shadowed operator gate`).toBe(false);
			}
		}
	});
});

// ─── (c) positive, both mounts ───────────────────────────────────────────────

describe("(c) positive — both mounts, token-only and token+ingest Bearer", () => {
	test("register (re-register, with id), heartbeat, launches/claim, provider-sync, control-actions/claim all succeed at both mounts, with and without an ingest Bearer", async () => {
		for (const mount of MOUNTS) {
			const tokenOnly: Record<string, string> = {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisorX.token,
			};
			const tokenPlusIngest: Record<string, string> = {
				...tokenOnly,
				Authorization: `Bearer ${ingestKey}`,
			};

			for (const headers of [tokenOnly, tokenPlusIngest]) {
				const registerRes = await app.request(`${mount}/supervisors/register`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						id: supervisorX.id,
						hostName: "probe-c",
						platform: "linux",
						arch: "x64",
						version: "1.0.0",
						capabilities: FAKE_CAPABILITIES,
						trustedRoots: [],
					}),
				});
				expect(registerRes.status, `${mount} register`).toBe(200);

				const heartbeatRes = await app.request(`${mount}/supervisors/${supervisorX.id}/heartbeat`, {
					method: "POST",
					headers,
				});
				expect(heartbeatRes.status, `${mount} heartbeat`).toBe(200);

				const claimRes = await app.request(
					`${mount}/supervisors/${supervisorX.id}/launches/claim`,
					{ method: "POST", headers },
				);
				expect(claimRes.status, `${mount} launches/claim`).toBe(200);

				const syncRes = await app.request(`${mount}/supervisors/${supervisorX.id}/provider-sync`, {
					method: "GET",
					headers,
				});
				expect(syncRes.status, `${mount} provider-sync`).toBe(200);

				const actionClaimRes = await app.request(
					`${mount}/supervisors/${supervisorX.id}/control-actions/claim`,
					{ method: "POST", headers },
				);
				expect(actionClaimRes.status, `${mount} control-actions/claim`).toBe(200);
			}
		}
	});
});

// ─── (d) reverse-leak guard ───────────────────────────────────────────────────

describe("(d) reverse-leak guard — supervisor creds and ingest keys don't leak into operator routes", () => {
	const OPERATOR_PATHS = [
		"/sessions",
		"/settings",
		"/templates",
		"/projects",
		"/admin/supervisors",
	];

	test("supervisor token (header or Bearer) and ingest key are all refused on operator routes, at both mounts", async () => {
		for (const mount of MOUNTS) {
			for (const opPath of OPERATOR_PATHS) {
				const tokenHeaderRes = await app.request(`${mount}${opPath}`, {
					headers: { "X-AgentPulse-Supervisor-Token": supervisorX.token },
				});
				expect(tokenHeaderRes.status, `${mount}${opPath} token header`).toBe(401);

				const tokenBearerRes = await app.request(`${mount}${opPath}`, {
					headers: { Authorization: `Bearer ${supervisorX.token}` },
				});
				expect(tokenBearerRes.status, `${mount}${opPath} token as Bearer`).toBe(401);

				const ingestRes = await app.request(`${mount}${opPath}`, {
					headers: { Authorization: `Bearer ${ingestKey}` },
				});
				expect(ingestRes.status, `${mount}${opPath} ingest key`).toBe(403);
				const body = (await ingestRes.json()) as { error: string };
				expect(body.error).toBe("insufficient_scope");
			}
		}
	});

	test("GET /api/v1/supervisors/register (no handler) with an ingest key is still 403 insufficient_scope — an unmatched agent-prefix path falls through to the gates (repro case F)", async () => {
		const res = await app.request("/api/v1/supervisors/register", {
			method: "GET",
			headers: { Authorization: `Bearer ${ingestKey}` },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});
});

// ─── (e) DISABLE_AUTH, both mounts ───────────────────────────────────────────

describe("(e) DISABLE_AUTH=true, both mounts", () => {
	test("register and heartbeat succeed with no credential, GET /sessions succeeds — iterated at both mounts since they're separate app.route() calls", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			for (const mount of MOUNTS) {
				const freshId = crypto.randomUUID();
				const registerRes = await app.request(`${mount}/supervisors/register`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: freshId,
						hostName: "probe-e",
						platform: "linux",
						arch: "x64",
						version: "1.0.0",
						capabilities: FAKE_CAPABILITIES,
						trustedRoots: [],
					}),
				});
				expect(registerRes.status, `${mount} register`).toBe(200);

				const heartbeatRes = await app.request(`${mount}/supervisors/${freshId}/heartbeat`, {
					method: "POST",
				});
				expect(heartbeatRes.status, `${mount} heartbeat`).toBe(200);

				const sessionsRes = await app.request(`${mount}/sessions`, { method: "GET" });
				expect(sessionsRes.status, `${mount} GET /sessions`).toBe(200);
			}
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});
});

// ─── (f) identity pin ─────────────────────────────────────────────────────────

describe("(f) identity pin — supervisor identity never satisfies an operator scope gate", () => {
	test("requireSupervisorAuth() sets authUser with source/id and no scopes key; requireOperatorScope() alone rejects it", async () => {
		const { Hono } = await import("hono");
		const { requireSupervisorAuth } = await import("./auth/middleware.js");
		const { requireOperatorScope } = await import("./auth/route-scope-policy.js");

		const identityApp = new Hono();
		identityApp.get("/:id/whoami", requireSupervisorAuth(), (c) => {
			const getVar = c.get as unknown as (key: string) => Record<string, unknown>;
			return c.json(getVar("authUser"));
		});
		const identityRes = await identityApp.request(`/${supervisorX.id}/whoami`, {
			headers: { "X-AgentPulse-Supervisor-Token": supervisorX.token },
		});
		expect(identityRes.status).toBe(200);
		const identityBody = (await identityRes.json()) as Record<string, unknown>;
		expect(identityBody.source).toBe("api_key");
		expect(identityBody.id).toBe(supervisorX.id);
		expect("scopes" in identityBody).toBe(false);

		const scopeApp = new Hono();
		scopeApp.get("/:id/scoped", requireSupervisorAuth(), requireOperatorScope(), (c) =>
			c.json({ ok: true }),
		);
		const scopeRes = await scopeApp.request(`/${supervisorX.id}/scoped`, {
			headers: { "X-AgentPulse-Supervisor-Token": supervisorX.token },
		});
		expect(scopeRes.status).toBe(403);
	});
});

// ─── (g) structural anti-regression ──────────────────────────────────────────

describe("(g) structural anti-regression — the agent router is root-mounted, not merely present twice", () => {
	test("structural: zero in-bundle agent mounts, exactly two root mounts, both precede app.route('/api', api)", () => {
		const appTsPath = join(REPO_ROOT, "src/server/app.ts");
		const source = readFileSync(appTsPath, "utf-8");

		// No in-bundle mount survives, at any call shape.
		const bundleMountMatches = source.match(/\bapi\.route\([^)]*supervisorsAgentRouter/g) ?? [];
		expect(bundleMountMatches).toEqual([]);

		// Exactly two root mounts, one per prefix — a text match alone doesn't
		// prove they still run FIRST (someone could move both after
		// app.route("/api", api) during an unrelated refactor and this count
		// would stay identical), so the offset check below is load-bearing.
		const rootMountRegex = /^app\.route\("\/(app-)?api\/v1", supervisorsAgentRouter\);$/gm;
		const rootMountMatches = [...source.matchAll(rootMountRegex)];
		expect(rootMountMatches.length).toBe(2);
		const prefixes = rootMountMatches.map((m) => (m[1] === "app-" ? "/app-api/v1" : "/api/v1"));
		expect(new Set(prefixes)).toEqual(new Set(["/api/v1", "/app-api/v1"]));

		const bundleRegistrationOffset = source.indexOf('app.route("/api", api)');
		expect(bundleRegistrationOffset).toBeGreaterThan(-1);
		for (const match of rootMountMatches) {
			expect(match.index ?? Number.POSITIVE_INFINITY).toBeLessThan(bundleRegistrationOffset);
		}
	});
});

// ─── crash-loop repro cases A-F (dick's investigation) ──────────────────────

describe("crash-loop repro cases A-F", () => {
	test("A: token + ingest Bearer, POST register (re-register) → 200", async () => {
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisorX.token,
				Authorization: `Bearer ${ingestKey}`,
			},
			body: JSON.stringify({
				id: supervisorX.id,
				hostName: "repro-a",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: FAKE_CAPABILITIES,
				trustedRoots: [],
			}),
		});
		expect(res.status).toBe(200);
	});

	test("B: token only, no Bearer, POST register (re-register) → 200", async () => {
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisorX.token,
			},
			body: JSON.stringify({
				id: supervisorX.id,
				hostName: "repro-b",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: FAKE_CAPABILITIES,
				trustedRoots: [],
			}),
		});
		expect(res.status).toBe(200);
	});

	test("C: token + manage Bearer, POST register (re-register) → 200 (unchanged — Bearer is ignored, not required)", async () => {
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisorX.token,
				Authorization: `Bearer ${manageKey}`,
			},
			body: JSON.stringify({
				id: supervisorX.id,
				hostName: "repro-c",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: FAKE_CAPABILITIES,
				trustedRoots: [],
			}),
		});
		expect(res.status).toBe(200);
	});

	test("D: token + ingest Bearer, POST heartbeat → 200", async () => {
		const res = await app.request(`/api/v1/supervisors/${supervisorX.id}/heartbeat`, {
			method: "POST",
			headers: {
				"X-AgentPulse-Supervisor-Token": supervisorX.token,
				Authorization: `Bearer ${ingestKey}`,
			},
		});
		expect(res.status).toBe(200);
	});

	test("E: token only, POST heartbeat → 200", async () => {
		const res = await app.request(`/api/v1/supervisors/${supervisorX.id}/heartbeat`, {
			method: "POST",
			headers: { "X-AgentPulse-Supervisor-Token": supervisorX.token },
		});
		expect(res.status).toBe(200);
	});

	test("F: GET /api/v1/supervisors/register (no handler), ingest Bearer → still 403 insufficient_scope (must-not-regress control)", async () => {
		const res = await app.request("/api/v1/supervisors/register", {
			method: "GET",
			headers: { Authorization: `Bearer ${ingestKey}` },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("insufficient_scope");
	});
});
