// Body validation on the small session write routes: a missing or mistyped
// field answers 400 invalid_body instead of reaching the database.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Hono } = await import("hono");
const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { sessionsRouter } = await import("./sessions.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: "s1",
			displayName: "s1",
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			notes: "keep me",
		})
		.execute();
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

function put(path: string, body: string) {
	return app.request(`/api/v1/sessions/s1/${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body,
	});
}

async function row() {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "s1"));
	return r;
}

describe("pin", () => {
	test.each([["{}"], ['{"pinned":"yes"}'], ['{"pinned":null}'], ["[]"], ["not json"], ["null"]])(
		"body %s answers 400 invalid_body",
		async (body) => {
			const res = await put("pin", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
			expect((await row())?.isPinned).toBe(false);
		},
	);

	test("a boolean pins and unpins", async () => {
		expect((await put("pin", '{"pinned":true}')).status).toBe(200);
		expect((await row())?.isPinned).toBe(true);
		expect((await put("pin", '{"pinned":false}')).status).toBe(200);
		expect((await row())?.isPinned).toBe(false);
	});
});

describe("archive", () => {
	test("a present non-boolean answers 400 invalid_body and changes nothing", async () => {
		const res = await put("archive", '{"archived":"no"}');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_body" });
		expect((await row())?.isArchived).toBe(false);
	});

	test("an omitted field still archives; false unarchives", async () => {
		expect((await put("archive", "{}")).status).toBe(200);
		expect((await row())?.isArchived).toBe(true);
		expect((await put("archive", '{"archived":false}')).status).toBe(200);
		expect((await row())?.isArchived).toBe(false);
	});
});

describe("notes", () => {
	test.each([["{}"], ['{"notes":5}'], ["not json"]])(
		"body %s answers 400 invalid_body and keeps the notes",
		async (body) => {
			const res = await put("notes", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
			expect((await row())?.notes).toBe("keep me");
		},
	);

	test("a string saves, null clears", async () => {
		expect((await put("notes", '{"notes":"new"}')).status).toBe(200);
		expect((await row())?.notes).toBe("new");
		expect((await put("notes", '{"notes":null}')).status).toBe(200);
		expect((await row())?.notes).toBe("");
	});
});

describe("rename", () => {
	test.each([['{"name":5}'], ["not json"], ["[]"]])(
		"body %s answers 400 invalid_body and keeps the name",
		async (body) => {
			const res = await put("rename", body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
			expect((await row())?.displayName).toBe("s1");
		},
	);

	test("a missing name keeps its existing answer", async () => {
		const res = await put("rename", "{}");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Name required" });
	});
});
