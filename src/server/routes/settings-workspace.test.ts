import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { db, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { settingsRouter } = await import("./settings.js");
const { DEFAULT_WORKSPACE_GIT_INIT, DEFAULT_WORKSPACE_ROOT, DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD } =
	await import("../services/workspace/feature.js");
const { Hono } = await import("hono");

const app = new Hono().route("/api/v1", settingsRouter);

const originalDisableAuth = config.disableAuth;

beforeAll(() => {
	initializeDatabase();
	// The workspace routes are mounted behind requireAuth(); under tests we
	// bypass it the same way local dev does.
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await db.delete(settings).execute();
});

async function get() {
	return app.request("/api/v1/settings/workspace");
}

async function put(body: unknown) {
	return app.request("/api/v1/settings/workspace", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("GET /api/v1/settings/workspace", () => {
	test("returns defaults when nothing is set", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			defaultRoot: DEFAULT_WORKSPACE_ROOT,
			templateClaudeMd: DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
			gitInit: DEFAULT_WORKSPACE_GIT_INIT,
		});
	});

	test("reflects values written by PUT", async () => {
		const putRes = await put({
			defaultRoot: "~/work",
			templateClaudeMd: "tmpl",
			gitInit: true,
		});
		expect(putRes.status).toBe(200);

		const res = await get();
		const body = await res.json();
		expect(body.defaultRoot).toBe("~/work");
		expect(body.templateClaudeMd).toBe("tmpl");
		expect(body.gitInit).toBe(true);
	});
});

describe("PUT /api/v1/settings/workspace", () => {
	test("rejects a relative defaultRoot with 400", async () => {
		const res = await put({ defaultRoot: "relative/path" });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe("string");
	});

	test("accepts a partial update without clobbering other fields", async () => {
		await put({
			defaultRoot: "/root",
			templateClaudeMd: "tmpl",
			gitInit: false,
		});
		const res = await put({ gitInit: true });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.defaultRoot).toBe("/root");
		expect(body.templateClaudeMd).toBe("tmpl");
		expect(body.gitInit).toBe(true);
	});

	test("returns 400 when gitInit is not a boolean", async () => {
		const res = await put({ gitInit: "yes" });
		expect(res.status).toBe(400);
	});

	test("returns 400 when defaultRoot is not a string", async () => {
		const res = await put({ defaultRoot: 42 });
		expect(res.status).toBe(400);
	});

	test("returns 400 on invalid JSON", async () => {
		const res = await app.request("/api/v1/settings/workspace", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "not-json",
		});
		expect(res.status).toBe(400);
	});
});
