/**
 * `truncated` is exactly "more candidates matched than the cap": a scan that
 * holds precisely `cap` candidates is complete, one more is not, whatever kind
 * of session the candidates are (each state, and the attention tier's every
 * arm), for the poll and the per-owner grouping alike.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getStats, getStatsByOwner, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);

const CAP = 5;
const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
	_setOperationalCandidateCapForTest(CAP);
});
afterEach(() => _setOperationalCandidateCapForTest(null));

const KINDS: Array<[string, Record<string, unknown>, "waiting" | "working" | "idle" | "error"]> = [
	["idle", {}, "idle"],
	["working", { isWorking: true }, "working"],
	["a finished turn nobody acknowledged", { lastAgentTurnCompletedAt: iso(HOUR) }, "waiting"],
	["an agent-reported wait", { semanticStatus: "waiting" }, "waiting"],
	["a permission wait", { metadata: { permissionWait: { ids: ["t"], anon: 0 } } }, "waiting"],
	["an open failure", { status: "failed", endedAt: iso(HOUR) }, "error"],
];

async function seed(n: number, extra: Record<string, unknown>) {
	await getDb()
		.insert(sessions)
		.values(
			Array.from({ length: n }, (_, i) => ({
				sessionId: `cap-${i}`,
				displayName: `cap-${i}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				lastActivityAt: iso(i * 10),
				...extra,
			})) as never,
		)
		.execute();
}

describe("exactly the cap, and one more", () => {
	for (const [kind, extra, state] of KINDS) {
		test(`${kind}: ${CAP} candidates are complete, ${CAP + 1} are truncated`, async () => {
			await seed(CAP, extra);
			const exact = await getStats();
			expect(exact.truncated).toBe(false);
			expect(exact.operational[state]).toBe(CAP);
			expect((await getStatsByOwner()).truncated).toBe(false);

			await getDb().delete(sessions).execute();
			await seed(CAP + 1, extra);
			expect((await getStats()).truncated).toBe(true);
			expect((await getStatsByOwner()).truncated).toBe(true);
		});
	}

	test("rows that are not candidates (completed, archived) do not count towards the cap", async () => {
		await seed(CAP, {});
		await getDb()
			.insert(sessions)
			.values([
				{
					sessionId: "done-1",
					displayName: "done-1",
					agentType: "claude_code",
					status: "completed",
					endedAt: iso(HOUR),
					metadata: {},
				},
				{
					sessionId: "arch-1",
					displayName: "arch-1",
					agentType: "claude_code",
					status: "active",
					isArchived: true,
					metadata: {},
				},
			] as never)
			.execute();
		expect((await getStats()).truncated).toBe(false);
	});
});
