/**
 * Pins today's exact response shapes for existing caller types, so a later
 * phase can't change them unnoticed. Ids, timestamps, and key prefixes are
 * replaced with stable placeholders before comparison; every other key and
 * value is asserted exactly, with object keys sorted for a deterministic
 * diff. Fixture names carry a per-run random suffix (RUN_SUFFIX) rather
 * than a fixed literal — the ones that land behind a UNIQUE constraint
 * (users.username, sessions.session_id) would otherwise collide with a
 * previous run's leftover rows on a database that isn't wiped between
 * runs. The normalized output is still exactly as deterministic within one
 * run: every assertion below reads the same RUN_SUFFIX the fixture was
 * created with, not a second independent random value.
 *
 * Additive fields introduced by the identity phase (the only allowed
 * differences from that phase's own snapshot): AuthMeResponse.user.userId,
 * AuthMeResponse.user.displayName.
 *
 * The access-gate and role-policy work add AuthMeResponse.user.mustChangePassword,
 * AuthMeResponse.user.effectiveRole, and the top-level mode and modeLockedByEnv.
 *
 * The attribution phase's DTO step removes ingestKeyId from every
 * session response (it never leaves the server) and adds ownerKind
 * ("user" | "service" | "unassigned"), derived from ownerUserId/
 * ingestKeyId. /api-keys is untouched by that phase; the ownership work later adds
 * adminService, createdByUserId and ownerUserId to each key.
 *
 * The acknowledgement-model phase adds two nullable session fields,
 * `lastAgentTurnCompletedAt` and `lastUserAcknowledgedAt` (both null for a
 * session that has only seen SessionStart), plus a derived `operationalStatus`
 * ("idle" for that same session — active, not working, nothing finished yet).
 *
 * The session-host change adds one more nullable session field, `reportedHost`
 * (null for a session no relay or observer reported a machine for). The machine
 * filter adds `machine` to list rows (the effective machine, null here); the
 * detail response is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "./db/__test_db.js";

const { config } = await import("./config.js");
const { initializeDatabase } = await import("./db/client.js");
const { app } = await import("./app.js");
const { createUser, issueSession, SESSION_COOKIE_NAME } = await import(
	"./services/local-auth-service.js"
);
const { createApiKey } = await import("./auth/api-key.js");
const { getInFlightCount } = await import("./routes/ingest-counters.js");
const { clearInstanceSettings } = await import("./test-utils/team-fixtures.js");

const TEST_SECRET = "baseline-shapes-secret-32-chars!!";

// Suffixes every fixture identifier that lands behind a UNIQUE constraint
// (users.username, sessions.session_id) so running this file twice against
// the same, unwiped database (no beforeEach table reset here — see the
// module docstring) doesn't collide with a previous run's rows. The
// snapshot values compared below still come from this same constant, so
// the normalized output is exactly as deterministic within one run as a
// literal string would be — it just isn't the identical text across runs.
const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);

// Hook ingestion returns its 200 before the session row is actually
// written (the always-200 contract) — a rename issued immediately after
// can race the background insert, especially under Postgres's real network
// round trips (SQLite's near-instant in-process writes mostly hide this).
// Same pattern as ingest-canonicalize.test.ts/ingest-copilot.test.ts.
async function waitForQuiescence(): Promise<void> {
	for (let i = 0; i < 200 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
}

function forwardauthHeaders(overrides: Record<string, string> = {}): Headers {
	return new Headers({
		"X-Authentik-Username": "baseline-sso-user",
		"X-Authentik-Uid": "baseline-sso-uid",
		"X-Authentik-Verify": TEST_SECRET,
		...overrides,
	});
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const ID_KEY_RE = /(^id$|Id$)/;
const TIME_KEY_RE = /(At$|^expiresAt$)/;

/**
 * Recursively sorts object keys and replaces id-shaped/timestamp-shaped
 * values with stable placeholders, so the result is deterministic across
 * runs and environments. Values are matched by key name (an "id"/"...Id"
 * or "...At" field is always opaque) as well as by shape (a UUID or
 * timestamp-looking string anywhere is replaced even under an unrelated
 * key), plus a couple of named fields that are randomly generated and
 * carry no contract meaning (an API key's display prefix).
 */
function normalize(value: unknown, keyHint?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((v) => normalize(v));
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		);
		const out: Record<string, unknown> = {};
		for (const [k, v] of entries) {
			out[k] = normalize(v, k);
		}
		return out;
	}
	if (keyHint === "keyPrefix" && typeof value === "string" && value.length > 0) {
		return "<KEY_PREFIX>";
	}
	if ((typeof value === "string" || typeof value === "number") && keyHint) {
		if (ID_KEY_RE.test(keyHint) && String(value).length > 0) return "<ID>";
		if (TIME_KEY_RE.test(keyHint) && String(value).length > 0) return "<TIMESTAMP>";
	}
	if (typeof value === "string") {
		if (UUID_RE.test(value)) return "<ID>";
		if (TIMESTAMP_RE.test(value)) return "<TIMESTAMP>";
	}
	return value;
}

beforeAll(async () => {
	await initializeDatabase();
	// These shapes are solo's: a mode another file left (stored, or in the
	// environment) would narrow the key list.
	// biome-ignore lint/performance/noDelete: removing the variable, not blanking it
	delete process.env.AGENTPULSE_MODE;
	await clearInstanceSettings();
	process.env.FORWARDAUTH_TRUST_SECRET = TEST_SECRET;
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

const originalDisableAuth = config.disableAuth;
const originalModeEnv = process.env.AGENTPULSE_MODE;
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalModeEnv === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an absent env var
		delete process.env.AGENTPULSE_MODE;
	} else {
		process.env.AGENTPULSE_MODE = originalModeEnv;
	}
});

describe("GET /auth/me — baseline shapes per caller type", () => {
	test("DISABLE_AUTH", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await app.request("/api/v1/auth/me");
			const body = await res.json();
			expect(normalize(body)).toEqual({
				allowSignup: false,
				authenticated: true,
				disableAuth: true,
				localAuthEnabled: true,
				mode: "solo",
				modeLockedByEnv: false,
				signOutUrl: null,
				user: {
					displayName: "anonymous",
					mustChangePassword: false,
					effectiveRole: "admin",
					id: "<ID>",
					name: "anonymous",
					provider: null,
					role: null,
					scopes: ["*"],
					source: "api_key",
					userId: null,
				},
			});
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("local admin", async () => {
		const user = await createUser({
			username: `baseline-snapshot-admin-${RUN_SUFFIX}`,
			password: "Adm1nBaseline!",
			role: "admin",
		});
		const { token } = await issueSession({ userId: user.id });
		const res = await app.request("/api/v1/auth/me", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
		});
		const body = await res.json();
		expect(normalize(body)).toEqual({
			allowSignup: false,
			authenticated: true,
			disableAuth: false,
			localAuthEnabled: true,
			mode: "solo",
			modeLockedByEnv: false,
			signOutUrl: "/api/v1/auth/logout",
			user: {
				displayName: `baseline-snapshot-admin-${RUN_SUFFIX}`,
				mustChangePassword: false,
				effectiveRole: "admin",
				id: "<ID>",
				name: `baseline-snapshot-admin-${RUN_SUFFIX}`,
				provider: null,
				role: "admin",
				source: "local",
				userId: "<ID>",
			},
		});
	});

	test("local member", async () => {
		const user = await createUser({
			username: `baseline-snapshot-member-${RUN_SUFFIX}`,
			password: "Memb3rBaseline!",
			role: "user",
		});
		const { token } = await issueSession({ userId: user.id });
		const res = await app.request("/api/v1/auth/me", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
		});
		const body = await res.json();
		expect(normalize(body)).toEqual({
			allowSignup: false,
			authenticated: true,
			disableAuth: false,
			localAuthEnabled: true,
			mode: "solo",
			modeLockedByEnv: false,
			signOutUrl: "/api/v1/auth/logout",
			user: {
				displayName: `baseline-snapshot-member-${RUN_SUFFIX}`,
				mustChangePassword: false,
				effectiveRole: "member",
				id: "<ID>",
				name: `baseline-snapshot-member-${RUN_SUFFIX}`,
				provider: null,
				role: "user",
				source: "local",
				userId: "<ID>",
			},
		});
	});

	test("api key, ingest scope", async () => {
		const { key } = await createApiKey(`baseline-snapshot-ingest-key-${RUN_SUFFIX}`, ["ingest"]);
		const res = await app.request("/api/v1/auth/me", {
			headers: { Authorization: `Bearer ${key}` },
		});
		const body = await res.json();
		expect(normalize(body)).toEqual({
			allowSignup: false,
			authenticated: true,
			disableAuth: false,
			localAuthEnabled: true,
			mode: "solo",
			modeLockedByEnv: false,
			signOutUrl: null,
			user: {
				displayName: `baseline-snapshot-ingest-key-${RUN_SUFFIX}`,
				mustChangePassword: false,
				effectiveRole: "member",
				id: "<ID>",
				name: `baseline-snapshot-ingest-key-${RUN_SUFFIX}`,
				provider: null,
				role: null,
				scopes: ["ingest"],
				source: "api_key",
				userId: null,
			},
		});
	});

	test("api key, manage scope", async () => {
		const { key } = await createApiKey(`baseline-snapshot-manage-key-${RUN_SUFFIX}`, ["manage"]);
		const res = await app.request("/api/v1/auth/me", {
			headers: { Authorization: `Bearer ${key}` },
		});
		const body = await res.json();
		expect(normalize(body)).toEqual({
			allowSignup: false,
			authenticated: true,
			disableAuth: false,
			localAuthEnabled: true,
			mode: "solo",
			modeLockedByEnv: false,
			signOutUrl: null,
			user: {
				displayName: `baseline-snapshot-manage-key-${RUN_SUFFIX}`,
				mustChangePassword: false,
				effectiveRole: "admin",
				id: "<ID>",
				name: `baseline-snapshot-manage-key-${RUN_SUFFIX}`,
				provider: null,
				role: null,
				scopes: ["manage"],
				source: "api_key",
				userId: null,
			},
		});
	});

	test("SSO caller", async () => {
		const res = await app.request("/api/v1/auth/me", { headers: forwardauthHeaders() });
		const body = await res.json();
		expect(normalize(body)).toEqual({
			allowSignup: false,
			authenticated: true,
			disableAuth: false,
			localAuthEnabled: true,
			mode: "solo",
			modeLockedByEnv: false,
			signOutUrl: "/outpost.goauthentik.io/sign_out",
			user: {
				displayName: "baseline-sso-user",
				mustChangePassword: false,
				effectiveRole: "member",
				id: "<ID>",
				name: "baseline-sso-user",
				provider: "authentik",
				role: "user",
				source: "forwardauth",
				userId: "<ID>",
			},
		});
	});
});

describe("sessions and api-keys endpoints for a manage caller — baseline shapes", () => {
	test("GET /sessions, GET /sessions/:id, GET /api-keys", async () => {
		const { key } = await createApiKey(`baseline-snapshot-session-key-${RUN_SUFFIX}`, [
			"ingest",
			"manage",
		]);
		// The key list is asserted below for these two; the tests above also make
		// them, but test order is not the contract (the order may be shuffled), so
		// this test makes sure they exist.
		// Used once each, as the tests above use theirs, so the listed lastUsedAt is set.
		for (const [name, scopes] of [
			[`baseline-snapshot-ingest-key-${RUN_SUFFIX}`, ["ingest"]],
			[`baseline-snapshot-manage-key-${RUN_SUFFIX}`, ["manage"]],
		] as const) {
			const { key: made } = await createApiKey(name, [...scopes]);
			await app.request("/api/v1/auth/me", { headers: { Authorization: `Bearer ${made}` } });
		}
		const sessionId = `baseline-snapshot-session-${RUN_SUFFIX}`;
		const hookRes = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: sessionId,
				cwd: "/tmp/baseline",
			}),
		});
		expect(hookRes.status).toBe(200);
		await waitForQuiescence();

		// The session's displayName is otherwise a randomly generated
		// adjective-noun pair — pin it to a fixed name so the whole snapshot
		// is deterministic, the same way an operator would.
		const renameRes = await app.request(`/api/v1/sessions/${sessionId}/rename`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: `baseline-snapshot-session-name-${RUN_SUFFIX}`,
				source: "user",
			}),
		});
		expect(renameRes.status).toBe(200);

		const sessionShape = {
			agentType: "claude_code",
			aiSpendCents: 0,
			claudeMdChecksum: null,
			claudeMdContent: null,
			claudeMdPath: null,
			claudeMdUpdatedAt: null,
			currentTask: null,
			cwd: "/tmp/baseline",
			displayName: `baseline-snapshot-session-name-${RUN_SUFFIX}`,
			endedAt: null,
			gitBranch: null,
			id: "<ID>",
			isArchived: false,
			isPinned: false,
			isWorking: false,
			lastActivityAt: "<TIMESTAMP>",
			lastAgentTurnCompletedAt: null,
			lastUserAcknowledgedAt: null,
			metadata: { renameSource: "user" },
			model: null,
			nameSource: "user",
			nativeName: null,
			notes: "",
			operationalStatus: "idle",
			ownerKind: "service",
			ownerUserId: null,
			planSummary: null,
			projectId: null,
			reportedHost: null,
			semanticStatus: null,
			sessionId: "<ID>",
			startedAt: "<TIMESTAMP>",
			status: "active",
			totalToolUses: 0,
			transcriptPath: null,
			watcherLastRunAt: null,
			watcherLastUserPromptAt: null,
			watcherState: null,
		};

		const detailRes = await app.request(`/api/v1/sessions/${sessionId}`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		const detailBody = (await detailRes.json()) as { session: { id: string } };
		const dbId = detailBody.session.id;

		// The list endpoint returns every session in the database, not just
		// this fixture's — other test files in a full-suite run leave rows
		// behind. Find this fixture's row (by its real DB id, captured above)
		// and compare only that one; the list's overall length/total is not
		// part of this phase's contract.
		const listRes = await app.request("/api/v1/sessions", {
			headers: { Authorization: `Bearer ${key}` },
		});
		const listBody = (await listRes.json()) as { sessions: Array<{ id: string }> };
		const listedSession = listBody.sessions.find((s) => s.id === dbId);
		expect(listedSession).toBeDefined();
		expect(normalize(listedSession)).toEqual({ ...sessionShape, machine: null, managed: false });

		expect(normalize(detailBody)).toEqual({
			controlActions: [],
			events: [
				{
					category: "system_event",
					content: "Claude session started",
					createdAt: "<TIMESTAMP>",
					eventType: "SessionStart",
					id: "<ID>",
					isNoise: false,
					providerEventType: "SessionStart",
					rawPayload: {
						cwd: "/tmp/baseline",
						hook_event_name: "SessionStart",
						session_id: sessionId,
					},
					sessionId: "<ID>",
					source: "observed_hook",
					toolInput: null,
					toolName: null,
					toolResponse: null,
				},
			],
			reportedByKey: { name: `baseline-snapshot-session-key-${RUN_SUFFIX}`, serviceKey: false },
			session: { ...sessionShape, managedSession: null },
		});

		const keysRes = await app.request("/api/v1/api-keys", {
			headers: { Authorization: `Bearer ${key}` },
		});
		const keysBody = await keysRes.json();
		const normalizedKeys = normalize(keysBody) as {
			keys: Array<{
				name: string;
				createdAt: string;
				id: string;
				isActive: boolean;
				keyPrefix: string;
				lastUsedAt: string;
				scopes: string[];
				adminService: boolean;
				serviceKey: boolean;
				createdByUserId: string | null;
				ownerUserId: string | null;
			}>;
		};
		const byName = Object.fromEntries(normalizedKeys.keys.map((k) => [k.name, k]));
		expect(byName[`baseline-snapshot-ingest-key-${RUN_SUFFIX}`]).toEqual({
			adminService: false,
			serviceKey: false,
			createdByUserId: null,
			ownerUserId: null,
			createdAt: "<TIMESTAMP>",
			id: "<ID>",
			isActive: true,
			keyPrefix: "<KEY_PREFIX>",
			lastUsedAt: "<TIMESTAMP>",
			name: `baseline-snapshot-ingest-key-${RUN_SUFFIX}`,
			scopes: ["ingest"],
		});
		expect(byName[`baseline-snapshot-manage-key-${RUN_SUFFIX}`]).toEqual({
			adminService: false,
			serviceKey: false,
			createdByUserId: null,
			ownerUserId: null,
			createdAt: "<TIMESTAMP>",
			id: "<ID>",
			isActive: true,
			keyPrefix: "<KEY_PREFIX>",
			lastUsedAt: "<TIMESTAMP>",
			name: `baseline-snapshot-manage-key-${RUN_SUFFIX}`,
			scopes: ["manage"],
		});
		expect(byName[`baseline-snapshot-session-key-${RUN_SUFFIX}`]).toEqual({
			adminService: false,
			serviceKey: false,
			createdByUserId: null,
			ownerUserId: null,
			createdAt: "<TIMESTAMP>",
			id: "<ID>",
			isActive: true,
			keyPrefix: "<KEY_PREFIX>",
			lastUsedAt: "<TIMESTAMP>",
			name: `baseline-snapshot-session-key-${RUN_SUFFIX}`,
			scopes: ["ingest", "manage"],
		});
	});
});
