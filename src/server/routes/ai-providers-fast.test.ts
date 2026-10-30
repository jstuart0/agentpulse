/** AGEN-79: choosing the provider for quick calls through the providers API. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { llmProviders, settings } = await import("../db/schema/index.js");
const { eq, inArray } = await import("drizzle-orm");
const { requireAuth } = await import("../auth/middleware.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { invalidateAiFlagsCache } = await import("../services/ai/feature.js");
const aiProvidersRouter = (await import("./ai-providers.js")).default;
const { Hono } = await import("hono");

const aiRouter = new Hono();
aiRouter.use("*", requireAuth());
aiRouter.route("/", aiProvidersRouter);
const app = new Hono().route("/api/v1", aiRouter);

const saved = {
	disableAuth: config.disableAuth,
	aiEnabled: config.aiEnabled,
	secretsKey: config.secretsKey,
};

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
	config.aiEnabled = true;
	config.secretsKey = "test-secrets-key-32-characters!!";
});
afterAll(async () => {
	Object.assign(config, saved);
	await getDb().delete(llmProviders);
	await getDb()
		.delete(settings)
		.where(inArray(settings.key, ["ai.enabled", "ai.fastProviderId"]));
	invalidateAiFlagsCache();
});
beforeEach(async () => {
	await getDb().delete(llmProviders);
	await getDb().delete(settings).where(eq(settings.key, "ai.fastProviderId"));
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	invalidateAiFlagsCache();
});

const json = { "Content-Type": "application/json" };
async function add(name: string, isDefault = false): Promise<string> {
	const res = await app.request("/api/v1/ai/providers", {
		method: "POST",
		headers: json,
		body: JSON.stringify({
			name,
			kind: "openai_compatible",
			model: "m",
			baseUrl: "http://llm.example.test/v1",
			apiKey: "k",
			isDefault,
		}),
	});
	return ((await res.json()) as { provider: { id: string } }).provider.id;
}
const put = (id: string, body: unknown) =>
	app.request(`/api/v1/ai/providers/${id}`, {
		method: "PUT",
		headers: json,
		body: JSON.stringify(body),
	});
async function list() {
	const res = await app.request("/api/v1/ai/providers");
	return (await res.json()) as { defaultProviderId: string | null; fastProviderId: string | null };
}

describe("fast provider selection", () => {
	test("none is set to begin with", async () => {
		await add("a", true);
		expect((await list()).fastProviderId).toBeNull();
	});

	test("isFast marks a provider, a second one moves it, isFast:false clears it", async () => {
		await add("default", true);
		const a = await add("a");
		const b = await add("b");

		expect((await put(a, { isFast: true })).status).toBe(200);
		expect((await list()).fastProviderId).toBe(a);

		await put(b, { isFast: true });
		expect((await list()).fastProviderId).toBe(b);

		// Unmarking a provider that is not the fast one leaves the setting alone.
		await put(a, { isFast: false });
		expect((await list()).fastProviderId).toBe(b);

		await put(b, { isFast: false });
		expect((await list()).fastProviderId).toBeNull();
	});

	test("it does not change which provider is the default", async () => {
		const d = await add("default", true);
		const a = await add("a");
		await put(a, { isFast: true });
		expect((await list()).defaultProviderId).toBe(d);
	});

	test("deleting the fast provider clears the setting", async () => {
		await add("default", true);
		const a = await add("a");
		await put(a, { isFast: true });
		await app.request(`/api/v1/ai/providers/${a}`, { method: "DELETE" });
		expect((await list()).fastProviderId).toBeNull();
	});

	test("a non-boolean isFast is refused and an unknown provider is 404", async () => {
		const a = await add("a", true);
		expect((await put(a, { isFast: "yes" })).status).toBe(400);
		expect((await put("nope", { isFast: true })).status).toBe(404);
		expect((await list()).fastProviderId).toBeNull();
	});
});
