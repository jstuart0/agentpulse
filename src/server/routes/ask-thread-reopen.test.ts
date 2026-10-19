/**
 * What the phone sees when it reopens a thread after a reply was saved without it (`ask_reply`): the
 * question and the answer, in the order they were written, even when they land in the same second
 * (SQLite's created_at has one-second resolution). Runs on both dialects.
 */
import { afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import "../db/__test_db.js";
import { bearerHeaders, seedKey } from "../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { initializeDatabase, getDb } = await import("../db/client.js");
const { askMessages, askThreads } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { setLabsFlag } = await import("../services/labs-service.js");
const { invalidateAiFlagsCache } = await import("../services/ai/feature.js");

beforeAll(() => initializeDatabase(), 60_000);
beforeEach(async () => {
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	invalidateAiFlagsCache();
	await setLabsFlag("askAssistant", true);
}, 60_000);
afterEach(async () => {
	await getDb().delete(askMessages);
	await getDb().delete(askThreads);
	await setLabsFlag("askAssistant", false);
	await upsertSetting("ai.enabled", false, { allowProtected: true });
	invalidateAiFlagsCache();
}, 60_000);

test("a reply written right after its question reopens after it, for twenty threads written back to back", async () => {
	const key = (await seedKey("reopen", ["manage"])).key;
	const ids: string[] = [];
	for (let i = 0; i < 20; i++) {
		const [thread] = await getDb()
			.insert(askThreads)
			.values({ title: `thread ${i}`, origin: "web" } as never)
			.returning();
		ids.push((thread as { id: string }).id);
		// written the way a turn writes them: the question first, then the answer
		await getDb()
			.insert(askMessages)
			.values({ threadId: ids[i] as string, role: "user", content: `q${i}` });
		await getDb()
			.insert(askMessages)
			.values({ threadId: ids[i] as string, role: "assistant", content: `a${i}` });
	}

	for (let i = 0; i < ids.length; i++) {
		const res = await app.request(`/api/v1/ai/ask/threads/${ids[i]}`, {
			headers: bearerHeaders(key),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
		expect(body.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
			`user:q${i}`,
			`assistant:a${i}`,
		]);
	}
});
