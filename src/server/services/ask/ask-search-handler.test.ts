import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema.js");
const { formatSearchResults, handleNlSearch } = await import("./ask-search-handler.js");
import type { SearchHit } from "../search/types.js";

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
});

async function insertSession(input: {
	id: string;
	displayName: string;
	status: string;
	agentType: string;
	cwd?: string;
}) {
	const now = new Date().toISOString();
	await db
		.insert(sessions)
		.values({
			sessionId: input.id,
			// biome-ignore lint/suspicious/noExplicitAny: test helper intentionally bypasses strict union
			agentType: input.agentType as any,
			displayName: input.displayName,
			// biome-ignore lint/suspicious/noExplicitAny: test helper intentionally bypasses strict union
			status: input.status as any,
			cwd: input.cwd ?? "/tmp/test",
			isWorking: false,
			lastActivityAt: now,
			startedAt: now,
		})
		.execute();
}

// ---- Pure helper: formatSearchResults -------------------------------------

describe("formatSearchResults", () => {
	test("renders status and agentType from sessionMeta", () => {
		const hits: SearchHit[] = [
			{
				kind: "session",
				sessionId: "s1",
				eventId: null,
				eventType: null,
				snippet: "doing some work",
				score: 1.0,
				timestamp: new Date().toISOString(),
				sessionDisplayName: "brave-falcon",
				sessionCwd: "/repos/myproject",
			},
		];
		const meta = new Map([["s1", { status: "failed", agentType: "claude_code" }]]);
		const result = formatSearchResults(hits, false, meta);
		expect(result).toContain("(failed, claude_code)");
		expect(result).toContain("brave-falcon");
		// Old internal kind tag must not appear
		expect(result).not.toContain("(session)");
		expect(result).not.toContain("(event)");
	});

	test("falls back gracefully when meta is absent for a hit", () => {
		const hits: SearchHit[] = [
			{
				kind: "event",
				sessionId: "s2",
				eventId: 42,
				eventType: "UserPromptSubmit",
				snippet: "refactor the auth module",
				score: 0.8,
				timestamp: new Date().toISOString(),
				sessionDisplayName: "calm-river",
				sessionCwd: "/repos/auth",
			},
		];
		// Pass empty map — no meta for s2
		const result = formatSearchResults(hits, false, new Map());
		expect(result).toContain("calm-river");
		// No parenthetical at all when meta is missing
		expect(result).not.toMatch(/\(.*,.*\)/);
	});

	test("appends capped notice when capped=true", () => {
		const hits: SearchHit[] = [
			{
				kind: "session",
				sessionId: "s3",
				eventId: null,
				eventType: null,
				snippet: "snippet text",
				score: 1.0,
				timestamp: new Date().toISOString(),
				sessionDisplayName: "delta-echo",
				sessionCwd: null,
			},
		];
		const result = formatSearchResults(hits, true);
		expect(result).toContain("refine your query");
	});

	test("returns empty string for zero hits", () => {
		expect(formatSearchResults([], false)).toBe("");
	});
});

// ---- Integration: handleNlSearch with real DB ----------------------------

describe("handleNlSearch — meta enrichment", () => {
	// These tests use messages whose residual q is empty after stripping status
	// and stopword tokens. That guarantees querySessionsDirect is used, which
	// does a real DB query rather than going through FTS (FTS requires sessions
	// to be indexed via indexSession, which only happens via the event processor
	// in production). Example: "list failed" → q="" + sessionStatus="failed".
	test("status filter path includes (status, agentType) in reply", async () => {
		await insertSession({
			id: "crashed-session",
			displayName: "crimson-bolt",
			status: "failed",
			agentType: "claude_code",
			cwd: "/repos/backend",
		});

		// "list failed" → q="" + sessionStatus="failed" → querySessionsDirect
		const reply = await handleNlSearch("list failed", []);
		expect(reply).not.toBeNull();
		expect(reply).toContain("(failed, claude_code)");
		expect(reply).toContain("crimson-bolt");
	});

	test("returns null when no sessions match", async () => {
		// DB is empty (beforeEach cleared it)
		const reply = await handleNlSearch("list failed", []);
		expect(reply).toBeNull();
	});

	test("failed filter returns agentType=codex_cli correctly", async () => {
		await insertSession({
			id: "codex-crashed",
			displayName: "silver-hawk",
			status: "failed",
			agentType: "codex_cli",
			cwd: "/repos/frontend",
		});

		// "list failed" → q="" + sessionStatus="failed" → querySessionsDirect
		const reply = await handleNlSearch("list failed", []);
		expect(reply).not.toBeNull();
		expect(reply).toContain("(failed, codex_cli)");
		expect(reply).toContain("silver-hawk");
	});
});
