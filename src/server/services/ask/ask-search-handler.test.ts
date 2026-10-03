import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";
import { itSqliteOnly } from "../../test-utils/backend.js";
import { OWN_TURN_MAX_WAITING, runInOwnTurn } from "../../util/own-turn.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema/index.js");
const { buildSearchFilters, formatSearchResults, handleNlSearch } = await import(
	"./ask-search-handler.js"
);
const { searchGatePasses } = await import("./launch-intent-detector.js");
import type { SearchHit } from "../search/types.js";

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function insertSession(input: {
	id: string;
	displayName: string;
	status: string;
	agentType: string;
	cwd?: string;
	isWorking?: boolean;
	lastAgentTurnCompletedAt?: string | null;
	endedAt?: string | null;
}) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: input.id,
			// biome-ignore lint/suspicious/noExplicitAny: test helper intentionally bypasses strict union
			agentType: input.agentType as any,
			displayName: input.displayName,
			// biome-ignore lint/suspicious/noExplicitAny: test helper intentionally bypasses strict union
			status: input.status as any,
			cwd: input.cwd ?? "/tmp/test",
			isWorking: input.isWorking ?? false,
			lastActivityAt: now,
			startedAt: now,
			lastAgentTurnCompletedAt: input.lastAgentTurnCompletedAt ?? null,
			endedAt: input.endedAt ?? null,
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

// ---- Waiting / needs attention -------------------------------------------
//
// The dashboard talks in operational states (Waiting, Working, Idle, Error)
// while the lifecycle filters above talk in active/idle/completed. A question
// about what is waiting, or what needs attention, is answered from the same
// classifier the dashboard uses.

describe("waiting and needs-attention questions", () => {
	test("the search gate lets them through", () => {
		for (const message of [
			"what's waiting",
			"what is waiting for me",
			"show waiting sessions",
			"which sessions need attention",
			"what needs attention",
			"does anything need my attention",
		]) {
			expect({ message, passes: searchGatePasses(message) }).toEqual({ message, passes: true });
		}
	});

	test("waiting maps to the waiting state, needs attention to waiting and error", () => {
		expect(buildSearchFilters("what's waiting", []).operational).toEqual(["waiting"]);
		expect(buildSearchFilters("show waiting sessions", []).operational).toEqual(["waiting"]);
		expect(buildSearchFilters("what needs attention", []).operational).toEqual([
			"waiting",
			"error",
		]);
		expect(buildSearchFilters("which sessions need attention", []).operational).toEqual([
			"waiting",
			"error",
		]);
		expect(buildSearchFilters("anything needing my attention", []).operational).toEqual([
			"waiting",
			"error",
		]);
	});

	test("they don't set a lifecycle status, and the trigger words don't reach the text query", () => {
		const waiting = buildSearchFilters("what's waiting", []);
		expect(waiting.sessionStatus).toBeUndefined();
		expect(waiting.q).toBe("");
		const attention = buildSearchFilters("which sessions need attention", []);
		expect(attention.q).toBe("");
		expect(buildSearchFilters("waiting sessions about billing", []).q).toBe("billing");
	});

	test("the existing questions are read as before", () => {
		expect(buildSearchFilters("stuck sessions", []).sessionStatus).toBe("idle");
		expect(buildSearchFilters("stuck sessions", []).operational).toBeUndefined();
		expect(buildSearchFilters("list failed", []).sessionStatus).toBe("failed");
		expect(buildSearchFilters("active sessions", []).sessionStatus).toBe("active");
		expect(buildSearchFilters("what sessions about billing", []).operational).toBeUndefined();
	});

	describe("answers", () => {
		const turnDone = () => new Date().toISOString();
		beforeEach(async () => {
			await insertSession({
				id: "w-waiting",
				displayName: "amber-heron",
				status: "active",
				agentType: "claude_code",
				lastAgentTurnCompletedAt: turnDone(),
			});
			await insertSession({
				id: "w-working",
				displayName: "teal-otter",
				status: "active",
				agentType: "claude_code",
				isWorking: true,
			});
			await insertSession({
				id: "w-idle",
				displayName: "grey-badger",
				status: "idle",
				agentType: "claude_code",
			});
			await insertSession({
				id: "w-error",
				displayName: "red-lynx",
				status: "failed",
				agentType: "codex_cli",
				endedAt: turnDone(),
			});
			await insertSession({
				id: "w-done",
				displayName: "blue-seal",
				status: "completed",
				agentType: "claude_code",
				endedAt: turnDone(),
			});
		});

		test("waiting lists only sessions the dashboard shows as Waiting, labelled with that state", async () => {
			const reply = await handleNlSearch("what's waiting", []);
			expect(reply).toContain("amber-heron");
			expect(reply).toContain("(waiting, claude_code)");
			for (const other of ["teal-otter", "grey-badger", "red-lynx", "blue-seal"]) {
				expect(reply).not.toContain(other);
			}
		});

		test("needs attention lists waiting and error sessions, newest first", async () => {
			const reply = await handleNlSearch("which sessions need attention", []);
			expect(reply).toContain("amber-heron");
			expect(reply).toContain("(error, codex_cli)");
			expect(reply).toContain("red-lynx");
			for (const other of ["teal-otter", "grey-badger", "blue-seal"]) {
				expect(reply).not.toContain(other);
			}
		});

		test("with a text query the matches are narrowed to the waiting ones", async () => {
			await insertSession({
				id: "w-bill-waiting",
				displayName: "invoice reconciliation",
				status: "active",
				agentType: "claude_code",
				lastAgentTurnCompletedAt: turnDone(),
			});
			await insertSession({
				id: "w-bill-working",
				displayName: "invoice export",
				status: "active",
				agentType: "claude_code",
				isWorking: true,
			});
			const reply = await handleNlSearch("waiting sessions about invoice", []);
			expect(reply).toContain("invoice reconciliation");
			expect(reply).not.toContain("invoice export");
			expect(reply).not.toContain("amber-heron");
		});

		test("nothing waiting is a null reply, so Ask falls through", async () => {
			await getDb().delete(sessions).execute();
			expect(await handleNlSearch("what's waiting", [])).toBeNull();
		});
	});
});

// ---- Waiting questions past the candidate cap ------------------------------
//
// "What's waiting" reads the same candidate scan as the dashboard's poll: the
// rows that can need attention come first, so an old waiting session isn't
// pushed out by a burst of newer idle ones, and when the scan was capped the
// reply says its list may be incomplete instead of presenting it as everything.

describe("waiting questions past the candidate cap", () => {
	const HOUR = 3_600_000;
	const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

	async function insertIdleNoise(count: number) {
		await getDb()
			.insert(sessions)
			.values(
				Array.from({ length: count }, (_, i) => ({
					sessionId: `noise-${i}`,
					displayName: `noise-${i}`,
					agentType: "claude_code",
					status: "active",
					metadata: {},
					cwd: "/tmp/test",
					lastActivityAt: agoIso(i * 1000),
				})) as never,
			)
			.execute();
	}

	async function insertWaiting(id: string, name: string, agoMs: number) {
		await getDb()
			.insert(sessions)
			.values({
				sessionId: id,
				displayName: name,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				cwd: "/tmp/test",
				lastAgentTurnCompletedAt: agoIso(agoMs),
				lastActivityAt: agoIso(agoMs),
			} as never)
			.execute();
	}

	afterEach(async () => {
		const { _setOperationalCandidateCapForTest } = await import("../session-tracker.js");
		_setOperationalCandidateCapForTest(null);
	});

	test("an old waiting session behind newer idle ones is still listed", async () => {
		const { _setOperationalCandidateCapForTest } = await import("../session-tracker.js");
		_setOperationalCandidateCapForTest(3);
		await insertIdleNoise(8);
		await insertWaiting("w-old", "ancient-heron", 30 * HOUR);
		const reply = await handleNlSearch("what's waiting", []);
		expect(reply).toContain("ancient-heron");
	});

	test("a capped scan says the list may be incomplete", async () => {
		const { _setOperationalCandidateCapForTest } = await import("../session-tracker.js");
		_setOperationalCandidateCapForTest(3);
		await insertIdleNoise(8);
		await insertWaiting("w-1", "first-heron", 2 * HOUR);
		const reply = await handleNlSearch("what's waiting", []);
		expect(reply).toContain("may be incomplete");
	});

	test("a scan that fit under the cap says nothing of the kind", async () => {
		await insertWaiting("w-2", "lone-heron", 2 * HOUR);
		const reply = await handleNlSearch("what's waiting", []);
		expect(reply).toContain("lone-heron");
		expect(reply).not.toContain("may be incomplete");
	});

	test("the directory and time filters still narrow it", async () => {
		await insertWaiting("w-3", "here-heron", 2 * HOUR);
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "w-4",
				displayName: "there-heron",
				agentType: "claude_code",
				status: "active",
				metadata: {},
				cwd: "/srv/elsewhere",
				lastAgentTurnCompletedAt: agoIso(HOUR),
				lastActivityAt: agoIso(HOUR),
			} as never)
			.execute();
		const reply = await handleNlSearch("what's waiting in /tmp/test", []);
		expect(reply).toContain("here-heron");
		expect(reply).not.toContain("there-heron");
	});
});

describe("when the scan queue is full", () => {
	// SQLite funnels operational scans through the one-at-a-time scan queue;
	// Postgres runs them directly, so there is no queue to fill there.
	async function withFullScanQueue(run: () => Promise<void>): Promise<void> {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = Array.from({ length: OWN_TURN_MAX_WAITING }, () => runInOwnTurn(() => gate));
		try {
			await run();
		} finally {
			release();
			await Promise.all(held);
		}
	}

	itSqliteOnly("a waiting question answers try again in a moment, not an error", async () => {
		await withFullScanQueue(async () => {
			const reply = await handleNlSearch("what's waiting", []);
			expect(reply).toContain("try again in a moment");
		});
	});
});
