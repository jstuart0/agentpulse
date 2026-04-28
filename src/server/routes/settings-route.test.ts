import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { db, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { settingsRouter } = await import("./settings.js");
const { aiRouter } = await import("./ai.js");
const { Hono } = await import("hono");

// Mount the routers behind /api/v1 the same way the real server does so the
// path matchers behave identically.
const app = new Hono().route("/api/v1", settingsRouter).route("/api/v1", aiRouter);

const originalDisableAuth = config.disableAuth;

beforeAll(() => {
	initializeDatabase();
	// Tests bypass auth the same way local dev does.
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await db.delete(settings).execute();
});

async function putSetting(body: unknown) {
	return app.request("/api/v1/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readSetting(key: string) {
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
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
