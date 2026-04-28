import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { db, initializeDatabase } = await import("../db/client.js");
const { settings } = await import("../db/schema.js");
const { settingsRouter } = await import("./settings.js");
const {
	DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS,
	DEFAULT_GIT_CLONE_ALLOW_SSH_URLS,
	DEFAULT_GIT_CLONE_DEFAULT_DEPTH,
	DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
	DEFAULT_WORKSPACE_GIT_INIT,
	DEFAULT_WORKSPACE_ROOT,
	DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
} = await import("../services/workspace/feature.js");
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
			workspace: {
				defaultRoot: DEFAULT_WORKSPACE_ROOT,
				templateClaudeMd: DEFAULT_WORKSPACE_TEMPLATE_CLAUDE_MD,
				gitInit: DEFAULT_WORKSPACE_GIT_INIT,
			},
			gitClone: {
				allowSshUrls: DEFAULT_GIT_CLONE_ALLOW_SSH_URLS,
				allowLocalUrls: DEFAULT_GIT_CLONE_ALLOW_LOCAL_URLS,
				defaultDepth: DEFAULT_GIT_CLONE_DEFAULT_DEPTH,
				timeoutSeconds: DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
			},
		});
	});

	test("returns the new gitClone fields under a nested key", async () => {
		const res = await get();
		const body = await res.json();
		expect(body.gitClone).toBeDefined();
		expect(body.gitClone.allowSshUrls).toBe(false);
		expect(body.gitClone.allowLocalUrls).toBe(false);
		expect(body.gitClone.defaultDepth).toBe(null);
		expect(body.gitClone.timeoutSeconds).toBe(300);
	});

	test("reflects values written by PUT", async () => {
		const putRes = await put({
			workspace: {
				defaultRoot: "~/work",
				templateClaudeMd: "tmpl",
				gitInit: true,
			},
			gitClone: {
				allowSshUrls: true,
				allowLocalUrls: false,
				defaultDepth: 1,
				timeoutSeconds: 600,
			},
		});
		expect(putRes.status).toBe(200);

		const res = await get();
		const body = await res.json();
		expect(body.workspace.defaultRoot).toBe("~/work");
		expect(body.workspace.templateClaudeMd).toBe("tmpl");
		expect(body.workspace.gitInit).toBe(true);
		expect(body.gitClone.allowSshUrls).toBe(true);
		expect(body.gitClone.defaultDepth).toBe(1);
		expect(body.gitClone.timeoutSeconds).toBe(600);
	});
});

describe("PUT /api/v1/settings/workspace", () => {
	test("rejects a relative defaultRoot with 400", async () => {
		const res = await put({ workspace: { defaultRoot: "relative/path" } });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe("string");
	});

	test("accepts a partial workspace update without clobbering other fields", async () => {
		await put({
			workspace: {
				defaultRoot: "/root",
				templateClaudeMd: "tmpl",
				gitInit: false,
			},
		});
		const res = await put({ workspace: { gitInit: true } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.workspace.defaultRoot).toBe("/root");
		expect(body.workspace.templateClaudeMd).toBe("tmpl");
		expect(body.workspace.gitInit).toBe(true);
	});

	test("accepts a partial gitClone update without clobbering workspace fields", async () => {
		await put({
			workspace: { defaultRoot: "/root", templateClaudeMd: "tmpl", gitInit: true },
		});
		const res = await put({ gitClone: { allowSshUrls: true } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.workspace.defaultRoot).toBe("/root");
		expect(body.workspace.gitInit).toBe(true);
		expect(body.gitClone.allowSshUrls).toBe(true);
		expect(body.gitClone.allowLocalUrls).toBe(false);
	});

	test("returns 400 when gitInit is not a boolean", async () => {
		const res = await put({ workspace: { gitInit: "yes" } });
		expect(res.status).toBe(400);
	});

	test("returns 400 when defaultRoot is not a string", async () => {
		const res = await put({ workspace: { defaultRoot: 42 } });
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

	test("returns 400 on bad defaultDepth (-1)", async () => {
		const res = await put({ gitClone: { defaultDepth: -1 } });
		expect(res.status).toBe(400);
	});

	test("returns 400 on bad defaultDepth (0)", async () => {
		const res = await put({ gitClone: { defaultDepth: 0 } });
		expect(res.status).toBe(400);
	});

	test("returns 400 on bad defaultDepth (1.5)", async () => {
		const res = await put({ gitClone: { defaultDepth: 1.5 } });
		expect(res.status).toBe(400);
	});

	test("accepts null defaultDepth", async () => {
		const res = await put({ gitClone: { defaultDepth: null } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.gitClone.defaultDepth).toBe(null);
	});

	test("returns 400 on bad timeoutSeconds (10 — under 30)", async () => {
		const res = await put({ gitClone: { timeoutSeconds: 10 } });
		expect(res.status).toBe(400);
	});

	test("returns 400 on bad timeoutSeconds (5000 — over 3600)", async () => {
		const res = await put({ gitClone: { timeoutSeconds: 5000 } });
		expect(res.status).toBe(400);
	});

	test("returns 400 when allowSshUrls is the string 'true'", async () => {
		const res = await put({ gitClone: { allowSshUrls: "true" } });
		expect(res.status).toBe(400);
	});

	test("returns 400 when allowLocalUrls is a number", async () => {
		const res = await put({ gitClone: { allowLocalUrls: 1 } });
		expect(res.status).toBe(400);
	});

	test("returns 400 when gitClone is not an object", async () => {
		const res = await put({ gitClone: "nope" });
		expect(res.status).toBe(400);
	});
});
