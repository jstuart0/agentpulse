import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { settingsRouter } = await import("./settings.js");
const { requireAuth } = await import("../auth/middleware.js");
const aiStatusRouter = (await import("./ai-status.js")).default;
const aiProvidersRouter = (await import("./ai-providers.js")).default;
const aiWatcherRouter = (await import("./ai-watcher.js")).default;
const aiInboxRouter = (await import("./ai-inbox.js")).default;
const aiIntelligenceRouter = (await import("./ai-intelligence.js")).default;
const { Hono } = await import("hono");

// Mount the routers behind /api/v1 the same way the real server does so the
// path matchers behave identically (single auth gate wrapping all AI sub-routers).
const aiRouter = new Hono();
aiRouter.use("*", requireAuth());
aiRouter.route("/", aiStatusRouter);
aiRouter.route("/", aiProvidersRouter);
aiRouter.route("/", aiWatcherRouter);
aiRouter.route("/", aiInboxRouter);
aiRouter.route("/", aiIntelligenceRouter);
const app = new Hono().route("/api/v1", settingsRouter).route("/api/v1", aiRouter);

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	// Tests bypass auth the same way local dev does.
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(settings).execute();
});

async function putSetting(body: unknown) {
	return app.request("/api/v1/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readSetting(key: string) {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
	return row;
}

describe("PUT /api/v1/settings", () => {
	test("writes a non-protected key", async () => {
		const res = await putSetting({ key: "ui.theme", value: "dark" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
		const row = await readSetting("ui.theme");
		expect(row?.value).toBe("dark");
	});

	test("returns 400 when key is missing", async () => {
		const res = await putSetting({ value: "anything" });
		expect(res.status).toBe(400);
	});

	test("rejects ai.enabled with 403 protected_setting", async () => {
		const res = await putSetting({ key: "ai.enabled", value: true });
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toBe("protected_setting");
		expect(body.message).toBe("Setting key 'ai.enabled' is reserved for internal use.");
		const row = await readSetting("ai.enabled");
		expect(row).toBeUndefined();
	});

	test("rejects ai.killSwitch with 403", async () => {
		const res = await putSetting({ key: "ai.killSwitch", value: true });
		expect(res.status).toBe(403);
	});

	test("rejects vectorSearch.enabled with 403", async () => {
		const res = await putSetting({ key: "vectorSearch.enabled", value: true });
		expect(res.status).toBe(403);
		const row = await readSetting("vectorSearch.enabled");
		expect(row).toBeUndefined();
	});

	test("rejects telegram:credentials with 403", async () => {
		const res = await putSetting({
			key: "telegram:credentials",
			value: { token: "x", chatId: "y" },
		});
		expect(res.status).toBe(403);
		const row = await readSetting("telegram:credentials");
		expect(row).toBeUndefined();
	});
});

describe("PUT /api/v1/ai/status (trusted internal upsert)", () => {
	test("flips ai.enabled even though the generic endpoint would 403", async () => {
		const res = await app.request("/api/v1/ai/status", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(res.status).toBe(200);
		const row = await readSetting("ai.enabled");
		expect(row?.value).toBe(true);

		const generic = await putSetting({ key: "ai.enabled", value: false });
		expect(generic.status).toBe(403);
		// And the AI-internal value remains unchanged.
		const after = await readSetting("ai.enabled");
		expect(after?.value).toBe(true);
	});
});

// CH-L2 regression: GET /ai/vector-search/status must return the exact shape
// (build/active/enabled/model/providerId/progress) regardless of whether the
// three settings rows exist in the DB (previously 3 separate queries, now a
// single batched inArray query).
describe("GET /api/v1/ai/vector-search/status shape", () => {
	test("returns expected keys with DB-default fallbacks when rows are absent", async () => {
		const res = await app.request("/api/v1/ai/vector-search/status");
		expect(res.status).toBe(200);
		const body = await res.json();

		// These five keys must always be present — operators have dashboards keyed on them.
		expect(Object.keys(body)).toContain("build");
		expect(Object.keys(body)).toContain("active");
		expect(Object.keys(body)).toContain("enabled");
		expect(Object.keys(body)).toContain("model");
		expect(Object.keys(body)).toContain("providerId");
		expect(Object.keys(body)).toContain("progress");

		// Defaults: enabled=false, model=DEFAULT_EMBEDDING_MODEL fallback, providerId=null.
		expect(body.enabled).toBe(false);
		expect(typeof body.model).toBe("string");
		expect(body.model.length).toBeGreaterThan(0);
		expect(body.providerId).toBeNull();
	});

	test("reads persisted values from DB (bypasses build-flag gate on PUT)", async () => {
		// Write the three settings directly to DB so we don't depend on the
		// AGENTPULSE_VECTOR_SEARCH build flag being set in the test environment.
		const { upsertSetting } = await import("../services/settings-service.js");
		const { VECTOR_SEARCH_ENABLED_KEY, VECTOR_SEARCH_MODEL_KEY, VECTOR_SEARCH_PROVIDER_ID_KEY } =
			await import("../services/ai/feature.js");
		await upsertSetting(VECTOR_SEARCH_ENABLED_KEY, true, { allowProtected: true });
		await upsertSetting(VECTOR_SEARCH_MODEL_KEY, "text-embedding-3-small", {
			allowProtected: true,
		});
		await upsertSetting(VECTOR_SEARCH_PROVIDER_ID_KEY, "openai", { allowProtected: true });

		const res = await app.request("/api/v1/ai/vector-search/status");
		expect(res.status).toBe(200);
		const body = await res.json();

		// All three stored values must be reflected in the response.
		expect(body.enabled).toBe(true);
		expect(body.model).toBe("text-embedding-3-small");
		expect(body.providerId).toBe("openai");
	});
});
