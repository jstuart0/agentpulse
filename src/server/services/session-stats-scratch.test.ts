/**
 * Hiding scratch workspaces applies to every number the dashboard shows: the
 * poll's cards and tab badges, its operational counts, the per-owner grouping
 * and the list all describe the same set of sessions.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { projects, sessions } = await import("../db/schema/index.js");
const { getSessions, getStats, getStatsByOwner } = await import("./session-tracker.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const ALICE = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	await getDb().delete(projects).execute();
	await getDb()
		.insert(projects)
		.values([
			{ id: "p-scratch", name: "scratch-area", cwd: "/scratch", tags: ["scratch"] },
			{ id: "p-real", name: "real-area", cwd: "/real", tags: [] },
		])
		.execute();
});

const now = () => new Date().toISOString();

async function mk(
	sessionId: string,
	projectId: string | null,
	overrides: Record<string, unknown> = {},
) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			projectId,
			ownerUserId: ALICE,
			startedAt: now(),
			lastActivityAt: now(),
			totalToolUses: 10,
			...overrides,
		} as never)
		.execute();
}

async function seedPlainAndScratch() {
	await mk("plain-active", "p-real");
	await mk("scratch-active", "p-scratch");
	await mk("plain-completed", "p-real", { status: "completed", endedAt: now() });
	await mk("scratch-completed", "p-scratch", { status: "completed", endedAt: now() });
	await mk("plain-archived", "p-real", { isArchived: true });
	await mk("scratch-archived", "p-scratch", { isArchived: true });
	await mk("plain-waiting", "p-real", { lastAgentTurnCompletedAt: now() });
	await mk("scratch-waiting", "p-scratch", { lastAgentTurnCompletedAt: now() });
	await mk("no-project", null);
}

describe("excludeScratch reaches every count in a stats response", () => {
	test("completed and archived counts leave the scratch sessions out", async () => {
		await seedPlainAndScratch();
		const stats = await getStats({ excludeScratch: true });
		expect(stats.completedCount).toBe(1);
		expect(stats.archivedCount).toBe(1);
	});

	test("so do the active, today and tool-use totals and the per-type breakdown", async () => {
		await seedPlainAndScratch();
		const all = await getStats();
		const hidden = await getStats({ excludeScratch: true });
		// 9 sessions; 4 are scratch. Active (status "active"): plain-active, plain-archived,
		// plain-waiting and no-project, plus the scratch twins of the first three.
		expect(all.activeSessions).toBe(7);
		expect(hidden.activeSessions).toBe(4);
		expect(all.totalSessionsToday).toBe(9);
		expect(hidden.totalSessionsToday).toBe(5);
		expect(all.totalToolUsesToday).toBe(90);
		expect(hidden.totalToolUsesToday).toBe(50);
		expect(hidden.byAgentType.claude_code).toBe(4);
	});

	test("the operational counts already agree, so the whole response describes one set", async () => {
		await seedPlainAndScratch();
		const hidden = await getStats({ excludeScratch: true });
		expect(hidden.operational.waiting).toBe(1);
	});

	test("the poll, the per-owner grouping and the list agree on the same set", async () => {
		await seedPlainAndScratch();
		const stats = await getStats({ excludeScratch: true });
		const grouped = await getStatsByOwner({ excludeScratch: true });
		const list = await getSessions({ excludeScratch: true, limit: 1000 });
		const groupedTotal = grouped.groups.reduce((sum, g) => sum + g.total, 0);
		const groupedCompleted = grouped.groups.reduce((sum, g) => sum + g.completed, 0);
		expect(list.total).toBe(5);
		expect(groupedTotal).toBe(list.total);
		expect(groupedCompleted).toBe(stats.completedCount);
	});

	test("without the flag scratch sessions count everywhere, as before", async () => {
		await seedPlainAndScratch();
		const stats = await getStats();
		expect(stats.completedCount).toBe(2);
		expect(stats.archivedCount).toBe(2);
	});

	test("an owner scope and the scratch exclusion compose", async () => {
		await seedPlainAndScratch();
		await mk("other-completed", "p-real", {
			status: "completed",
			endedAt: now(),
			ownerUserId: "9a1c2d3e-4f5a-4b6f-8a7e-0c1d2e3f4a5b",
		});
		const stats = await getStats({ excludeScratch: true, owner: { kind: "user", userId: ALICE } });
		expect(stats.completedCount).toBe(1);
	});
});

describe("statements", () => {
	test("hiding scratch looks the scratch projects up once, however many queries use them", async () => {
		await seedPlainAndScratch();
		const stats = await countDbCalls(async () => {
			await getStats({ excludeScratch: true });
		});
		const grouped = await countDbCalls(async () => {
			await getStatsByOwner({ excludeScratch: true });
		});
		expect({ stats, grouped }).toEqual({ stats: 3, grouped: 3 });
	});
});

describe("the unrecognised-agent-type count follows the scratch toggle", () => {
	test("an unrecognised type active only in a scratch workspace is left out when scratch is hidden, and counted when shown", async () => {
		await mk("plain-legacy", "p-real", { agentType: "legacy_agent" });
		await mk("scratch-legacy", "p-scratch", { agentType: "legacy_agent" });
		await mk("scratch-only", "p-scratch", { agentType: "scratch_only_agent" });
		const shown = await getStats();
		expect(shown.byAgentType.legacy_agent).toBe(2);
		expect(shown.byAgentType.scratch_only_agent).toBe(1);
		const hidden = await getStats({ excludeScratch: true });
		expect(hidden.byAgentType.legacy_agent).toBe(1);
		expect("scratch_only_agent" in hidden.byAgentType).toBe(false);
		expect(hidden.activeSessions).toBe(1);
	});
});
