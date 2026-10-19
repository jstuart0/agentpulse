/**
 * `GET /search?sessionStatus=archived` finds archived sessions: the archive flag, not only
 * the legacy `archived` status that new rows no longer carry. Runs through the route on
 * whichever search backend the dialect uses (FTS5 on SQLite, ILIKE on Postgres), for both
 * kinds of hit (the session itself, and an event in it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { searchRouter } = await import("./search.js");

const app = new Hono().route("/api/v1", searchRouter);
const originalDisableAuth = config.disableAuth;
const TERM = "zebrafish";

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

async function seed(sessionId: string, row: Record<string, unknown>) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: `${TERM} ${sessionId}`,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			startedAt: now,
			lastActivityAt: now,
			...row,
		} as never);
	await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "UserPromptSubmit",
			category: "prompt",
			source: "observed_hook",
			content: `${TERM} event of ${sessionId}`,
			rawPayload: {},
			dedupKey: `search-archived-${sessionId}`,
		} as never);
}

async function search(query: string) {
	const res = await app.request(`/api/v1/search?q=${TERM}&${query}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		hits: Array<{ kind: "session" | "event"; sessionId: string }>;
	};
	const bySessions = (kind: "session" | "event") =>
		[...new Set(body.hits.filter((h) => h.kind === kind).map((h) => h.sessionId))].sort();
	return { sessions: bySessions("session"), events: bySessions("event") };
}

describe("sessionStatus=archived", () => {
	beforeEach(async () => {
		await seed("flag-archived", { isArchived: true });
		await seed("legacy-archived", { status: "archived" });
		await seed("active-one", {});
		await seed("completed-one", { status: "completed" });
	});

	test("matches a session archived by the flag and one carrying the legacy status, in both kinds of hit", async () => {
		const found = await search("sessionStatus=archived");
		expect(found.sessions).toEqual(["flag-archived", "legacy-archived"]);
		expect(found.events).toEqual(["flag-archived", "legacy-archived"]);
	});

	test("finds a session the moment it is archived, with no re-index", async () => {
		expect((await search("sessionStatus=archived")).sessions).not.toContain("active-one");
		await getDb()
			.update(sessions)
			.set({ isArchived: true })
			.where(eq(sessions.sessionId, "active-one"));
		const found = await search("sessionStatus=archived");
		expect(found.sessions).toContain("active-one");
		expect(found.events).toContain("active-one");
	});

	test("and drops it again when it is restored", async () => {
		await getDb()
			.update(sessions)
			.set({ isArchived: false })
			.where(eq(sessions.sessionId, "flag-archived"));
		expect((await search("sessionStatus=archived")).sessions).toEqual(["legacy-archived"]);
	});

	test("composes with the other filters", async () => {
		expect((await search("sessionStatus=archived&agentType=codex_cli")).sessions).toEqual([]);
		expect((await search("sessionStatus=archived&agentType=claude_code")).sessions).toEqual([
			"flag-archived",
			"legacy-archived",
		]);
		expect((await search("sessionStatus=archived&sessionId=flag-archived")).sessions).toEqual([
			"flag-archived",
		]);
	});

	test("the other statuses keep matching the status column, as before", async () => {
		expect((await search("sessionStatus=completed")).sessions).toEqual(["completed-one"]);
		expect((await search("")).sessions).toEqual([
			"active-one",
			"completed-one",
			"flag-archived",
			"legacy-archived",
		]);
	});
});
