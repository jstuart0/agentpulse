/**
 * Phase 2 (D14, F46, F47): PUT /sessions/:id/rename {source:"reset"} stays
 * manage-only (NOT added to INGEST_WRITABLE_ROUTES) and is tested against
 * the full caller-class matrix this codebase's house style uses for every
 * security-relevant route (route-scope-policy.test.ts's pattern), plus the
 * "name" optional-only-with-reset regression (F47) and the full nameSource
 * transition sequence (D14).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { app } = await import("../app.js");
const { createApiKey, SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE } = await import(
	"../auth/api-key.js"
);

const TEST_SECRET = "srr-test-secret-32-characters!!!";
const TEST_USERNAME = "srr-forwardauth-user";
const TEST_UID = "srr-forwardauth-subject";

function forwardauthHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"X-Authentik-Username": TEST_USERNAME,
		"X-Authentik-Uid": TEST_UID,
		"X-Authentik-Verify": TEST_SECRET,
		"Content-Type": "application/json",
		...extra,
	});
}

function authBearer(key: string): Headers {
	return new Headers({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
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

	observeKey = (await createApiKey("srr-observe-key", [SCOPE_OBSERVE])).key;
	manageKey = (await createApiKey("srr-manage-key", [SCOPE_MANAGE])).key;
	dualKey = (await createApiKey("srr-dual-key", [SCOPE_OBSERVE, SCOPE_MANAGE])).key;
	ingestKey = (await createApiKey("srr-ingest-key", [SCOPE_INGEST])).key;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
	process.env.FORWARDAUTH_PROVIDER = originalProvider;
	// biome-ignore lint/performance/noDelete: clear memo for teardown parity
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			...overrides,
		})
		.execute();
}

describe("PUT /sessions/:id/rename {source:'reset'} — caller-class matrix (F46, coordinator's explicit ask)", () => {
	test("ingest-only key -> 403", async () => {
		await mkSession("reset-ingest");
		const res = await app.request("/api/v1/sessions/reset-ingest/rename", {
			method: "PUT",
			headers: authBearer(ingestKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(403);
	});

	test("observe-only key -> 403", async () => {
		await mkSession("reset-observe");
		const res = await app.request("/api/v1/sessions/reset-observe/rename", {
			method: "PUT",
			headers: authBearer(observeKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(403);
	});

	test("manage key -> 200, pin cleared, nativeName applied if present", async () => {
		await mkSession("reset-manage", {
			displayName: "human-chosen-name",
			metadata: { renameSource: "user", nativeName: "codex-thread-name" },
		});
		const res = await app.request("/api/v1/sessions/reset-manage/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(200);
		// F132: filter by id; on a shared Postgres DB other files' rows are present.
		const [row] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, "reset-manage"))
			.execute();
		expect(row.displayName).toBe("codex-thread-name");
		const metadata = row.metadata as Record<string, unknown>;
		expect(metadata.renameSource).toBeUndefined();
	});

	test("dual (observe+manage) key -> 200, identical to manage", async () => {
		await mkSession("reset-dual", { metadata: { renameSource: "user" } });
		const res = await app.request("/api/v1/sessions/reset-dual/rename", {
			method: "PUT",
			headers: authBearer(dualKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(200);
	});

	test("forwardauth caller -> 200", async () => {
		await mkSession("reset-forwardauth", { metadata: { renameSource: "user" } });
		const res = await app.request("/api/v1/sessions/reset-forwardauth/rename", {
			method: "PUT",
			headers: forwardauthHeaders(),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(200);
	});

	test("DISABLE_AUTH=true -> 200", async () => {
		await mkSession("reset-disableauth", { metadata: { renameSource: "user" } });
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await app.request("/api/v1/sessions/reset-disableauth/rename", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "reset" }),
			});
			expect(res.status).toBe(200);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("name omitted WITH source:reset -> accepted (200)", async () => {
		await mkSession("reset-no-name", { metadata: { renameSource: "user" } });
		const res = await app.request("/api/v1/sessions/reset-no-name/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(200);
	});

	test("name omitted WITHOUT source:reset -> still 400 (F47 regression: the carve-out must not leak)", async () => {
		await mkSession("plain-rename-no-name");
		const res = await app.request("/api/v1/sessions/plain-rename-no-name/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("reset on an unknown session -> 404", async () => {
		const res = await app.request("/api/v1/sessions/does-not-exist/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("nameSource transition (D14): generated -> native -> user -> native", () => {
	test("full transition sequence through the real routes", async () => {
		await mkSession("transition-1", { displayName: "brave-falcon" });

		// 1. /native-name: generated -> native
		const r1 = await app.request("/api/v1/sessions/transition-1/native-name", {
			method: "PUT",
			headers: authBearer(ingestKey),
			body: JSON.stringify({ name: "claude-native-name" }),
		});
		expect(r1.status).toBe(200);
		let detail = await (
			await app.request("/api/v1/sessions/transition-1", { headers: authBearer(manageKey) })
		).json();
		expect(detail.session.nameSource).toBe("native");

		// 2. /native-name again: still native (idempotent)
		const r2 = await app.request("/api/v1/sessions/transition-1/native-name", {
			method: "PUT",
			headers: authBearer(ingestKey),
			body: JSON.stringify({ name: "claude-native-name" }),
		});
		expect(r2.status).toBe(200);
		detail = await (
			await app.request("/api/v1/sessions/transition-1", { headers: authBearer(manageKey) })
		).json();
		expect(detail.session.nameSource).toBe("native");

		// 3. /rename {source:"user"}: native -> user (the pin)
		const r3 = await app.request("/api/v1/sessions/transition-1/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({ name: "human-chosen-name", source: "user" }),
		});
		expect(r3.status).toBe(200);
		detail = await (
			await app.request("/api/v1/sessions/transition-1", { headers: authBearer(manageKey) })
		).json();
		expect(detail.session.nameSource).toBe("user");

		// 4. /rename {source:"reset"} + a subsequent /native-name: user -> native
		const r4 = await app.request("/api/v1/sessions/transition-1/rename", {
			method: "PUT",
			headers: authBearer(manageKey),
			body: JSON.stringify({ source: "reset" }),
		});
		expect(r4.status).toBe(200);
		const r5 = await app.request("/api/v1/sessions/transition-1/native-name", {
			method: "PUT",
			headers: authBearer(ingestKey),
			body: JSON.stringify({ name: "claude-native-name-2" }),
		});
		expect(r5.status).toBe(200);
		detail = await (
			await app.request("/api/v1/sessions/transition-1", { headers: authBearer(manageKey) })
		).json();
		expect(detail.session.nameSource).toBe("native");
	});
});
