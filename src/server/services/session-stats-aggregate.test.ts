/**
 * The poll's aggregate over the sessions table. Grouping it by agent type made
 * the SQLite planner walk the non-covering agent-type index with a table lookup
 * for every row (about twice the cost of one plain scan at 20,000 rows), so the
 * totals are one ungrouped pass and the per-type active counts ride along as
 * conditional counts for the known agent types. An unrecognised historic type
 * is looked up by a second statement, only when one is actually present.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "./ai/__test_db.js";
import { AGENT_TYPES } from "../../shared/constants.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getStats, _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

let counter = 0;
async function mk(agentType: string, overrides: Record<string, unknown> = {}) {
	counter += 1;
	await getDb()
		.insert(sessions)
		.values({
			sessionId: `agg-${counter}`,
			displayName: `agg-${counter}`,
			agentType,
			status: "active",
			metadata: {},
			...overrides,
		} as never)
		.execute();
}

describe("per-type active counts", () => {
	test("known types are counted per type and zero-filled; the totals sum them", async () => {
		await mk("claude_code");
		await mk("claude_code");
		await mk("codex_cli");
		await mk("codex_cli", { status: "idle" });
		const stats = await getStats();
		const expected: Record<string, number> = { claude_code: 2, codex_cli: 1 };
		expect(stats.byAgentType).toEqual(
			Object.fromEntries(AGENT_TYPES.map((t) => [t, expected[t] ?? 0])),
		);
		expect(stats.activeSessions).toBe(3);
	});

	test("an unrecognised historic type that has active sessions keeps its own key", async () => {
		await mk("claude_code");
		await mk("legacy_agent");
		await mk("legacy_agent");
		await mk("older_agent", { status: "completed", endedAt: new Date().toISOString() });
		const stats = await getStats();
		expect(stats.byAgentType.legacy_agent).toBe(2);
		expect("older_agent" in stats.byAgentType).toBe(false);
		expect(stats.byAgentType.claude_code).toBe(1);
		expect(stats.activeSessions).toBe(3);
		expect(Object.keys(stats.byAgentType)).toEqual([...AGENT_TYPES, "legacy_agent"]);
	});

	test("two unrecognised types come back in a stable order", async () => {
		await mk("zeta_agent");
		await mk("alpha_agent");
		const stats = await getStats();
		expect(Object.keys(stats.byAgentType)).toEqual([...AGENT_TYPES, "alpha_agent", "zeta_agent"]);
	});
});

describe("statements issued by the aggregate", () => {
	test("known types only: one aggregate and the candidate scan", async () => {
		await mk("claude_code");
		await mk("codex_cli");
		const calls = await countDbCalls(async () => {
			await getStats();
		});
		expect(calls).toBe(2);
	});

	test("an unrecognised active type adds exactly one lookup", async () => {
		await mk("claude_code");
		await mk("legacy_agent");
		const calls = await countDbCalls(async () => {
			await getStats();
		});
		expect(calls).toBe(3);
	});
});

describeSqliteOnly("the aggregate plan (SQLite)", () => {
	test("the totals are not read through the agent-type index", async () => {
		for (let i = 0; i < 30; i++) await mk(AGENT_TYPES[i % AGENT_TYPES.length] as string);
		const statements: string[] = [];
		const db = getSqlite();
		const original = db.prepare.bind(db);
		const prepare = spyOn(db, "prepare").mockImplementation(((query: string) => {
			statements.push(query);
			return original(query);
		}) as never);
		try {
			await getStats();
		} finally {
			prepare.mockRestore();
		}
		const aggregate = statements.find((s) => s.includes('"started_at" >='));
		expect(aggregate).toBeDefined();
		const explain = db.prepare(`EXPLAIN QUERY PLAN ${aggregate}`);
		try {
			const params = new Array((String(aggregate).match(/\?/g) ?? []).length).fill(null);
			const plan = explain
				.all(...(params as never[]))
				.map((row) => String((row as { detail: string }).detail))
				.join(" | ");
			expect(plan).not.toContain("idx_sessions_agent_type_last_activity");
		} finally {
			explain.finalize();
		}
	});
});
