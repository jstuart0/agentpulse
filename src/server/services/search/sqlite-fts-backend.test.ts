import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema.js");
const { SqliteFtsBackend } = await import("./sqlite-fts-backend.js");
const { Database } = await import("bun:sqlite");
const { config } = await import("../../config.js");

/**
 * These tests exercise the SQLite FTS5 backend end-to-end against the
 * real shared test DB (triggers, virtual tables, BM25 ranking, snippet
 * highlighting). The triggers are installed by initializeDatabase()
 * which we call in beforeAll, so writes to `sessions` / `events` via
 * drizzle automatically populate the FTS tables.
 */

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
});

async function insertSession(
	id: string,
	overrides?: {
		displayName?: string;
		cwd?: string;
		currentTask?: string;
		notes?: string;
		agentType?: string;
		status?: string;
	},
) {
	const now = new Date().toISOString();
	await db
		.insert(sessions)
		.values({
			sessionId: id,
			agentType: overrides?.agentType ?? "claude_code",
			displayName: overrides?.displayName ?? null,
			cwd: overrides?.cwd ?? null,
			currentTask: overrides?.currentTask ?? null,
			notes: overrides?.notes ?? null,
			status: overrides?.status ?? "active",
			isWorking: false,
			lastActivityAt: now,
			startedAt: now,
		})
		.execute();
}

async function insertEvent(
	sessionId: string,
	eventType: string,
	rawPayload: Record<string, unknown>,
	content: string | null = null,
) {
	await db
		.insert(events)
		.values({
			sessionId,
			eventType,
			rawPayload,
			content,
			source: "observed_hook",
			createdAt: new Date().toISOString(),
		})
		.execute();
}

function freshBackend() {
	return new SqliteFtsBackend(new Database(config.sqlitePath));
}

describe("SqliteFtsBackend", () => {
	test("finds sessions by display name", async () => {
		await insertSession("s1", { displayName: "brave-falcon" });
		await insertSession("s2", { displayName: "calm-river" });

		const backend = freshBackend();
		const res = await backend.search({ q: "falcon" });
		expect(res.hits.map((h) => h.sessionId)).toContain("s1");
		expect(res.hits.map((h) => h.sessionId)).not.toContain("s2");
	});

	test("finds events by user prompt content", async () => {
		await insertSession("s1");
		await insertEvent("s1", "UserPromptSubmit", {
			prompt: "refactor the authentication middleware",
		});
		await insertEvent("s1", "UserPromptSubmit", { prompt: "write unit tests for the parser" });

		const backend = freshBackend();
		const res = await backend.search({ q: "authentication" });
		expect(res.hits.length).toBeGreaterThanOrEqual(1);
		expect(res.hits[0].kind).toBe("event");
		expect(res.hits[0].eventType).toBe("UserPromptSubmit");
	});

	test("snippet contains the matching term wrapped in <mark>", async () => {
		await insertSession("s1");
		await insertEvent("s1", "AssistantMessage", {
			message: "I have finished implementing the login flow with OAuth2 support.",
		});

		const backend = freshBackend();
		const res = await backend.search({ q: "OAuth2" });
		expect(res.hits.length).toBe(1);
		expect(res.hits[0].snippet).toContain("<mark>");
		expect(res.hits[0].snippet).toContain("</mark>");
	});

	test("filters by eventType", async () => {
		await insertSession("s1");
		await insertEvent("s1", "UserPromptSubmit", { prompt: "deploy the staging build" });
		await insertEvent("s1", "AssistantMessage", { message: "staging build deployed" });

		const backend = freshBackend();
		const res = await backend.search({ q: "staging", eventType: "UserPromptSubmit" });
		expect(res.hits.every((h) => h.eventType === "UserPromptSubmit" || h.kind === "session")).toBe(
			true,
		);
	});

	test("filters by agentType via session join", async () => {
		await insertSession("s1", { agentType: "claude_code" });
		await insertSession("s2", { agentType: "codex_cli" });
		await insertEvent("s1", "UserPromptSubmit", { prompt: "deploy app" });
		await insertEvent("s2", "UserPromptSubmit", { prompt: "deploy app" });

		const backend = freshBackend();
		const res = await backend.search({
			q: "deploy",
			agentType: "claude_code",
			kinds: ["event"],
		});
		expect(res.hits.every((h) => h.sessionId === "s1")).toBe(true);
	});

	test("empty query returns no hits", async () => {
		await insertSession("s1", { displayName: "anything" });
		const backend = freshBackend();
		const res = await backend.search({ q: "" });
		expect(res.hits).toEqual([]);
		expect(res.total).toBe(0);
	});

	test("search is case-insensitive and stems", async () => {
		await insertSession("s1");
		await insertEvent("s1", "UserPromptSubmit", {
			prompt: "Refactoring the authentication subsystem.",
		});

		const backend = freshBackend();
		// `refactor` should match `refactoring` via the porter stemmer.
		const res1 = await backend.search({ q: "refactor" });
		expect(res1.hits.length).toBeGreaterThanOrEqual(1);

		// Case-insensitive matching comes from unicode61 tokenizer.
		const res2 = await backend.search({ q: "AUTHENTICATION" });
		expect(res2.hits.length).toBeGreaterThanOrEqual(1);
	});

	test("rebuild backfills the index from existing rows", async () => {
		await insertSession("s1", { displayName: "pre-index" });
		// Simulate row that predates triggers by clearing the FTS tables:
		const backend = freshBackend();
		await backend.removeSession("s1");

		let res = await backend.search({ q: "pre-index" });
		expect(res.hits).toEqual([]);

		const stats = await backend.rebuild();
		expect(stats.sessionsIndexed).toBeGreaterThanOrEqual(1);

		res = await backend.search({ q: "pre-index" });
		expect(res.hits.length).toBeGreaterThanOrEqual(1);
	});

	test("deleting a session and its events clears both FTS indexes", async () => {
		await insertSession("s1", { displayName: "goner" });
		await insertEvent("s1", "UserPromptSubmit", { prompt: "this will disappear" });

		// Schema has no ON DELETE CASCADE — delete events first, then the
		// session. Both triggers fire and the FTS rows are removed.
		await db.delete(events).execute();
		await db.delete(sessions).execute();

		const backend = freshBackend();
		const eventRes = await backend.search({ q: "disappear" });
		expect(eventRes.hits).toEqual([]);
		const sessionRes = await backend.search({ q: "goner" });
		expect(sessionRes.hits).toEqual([]);
	});
});
