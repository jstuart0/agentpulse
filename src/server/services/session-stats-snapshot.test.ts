/**
 * Under the candidate cap, the counts in one stats response describe one
 * database state. On SQLite a write that lands on any turn of the event loop
 * between the card counts and the candidate scan would otherwise make them
 * disagree (sessions counted as active but missing from the four states).
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getSessions, getStats, getStatsByOwner, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

const rows = (tag: string, n: number) =>
	Array.from({ length: n }, (_, i) => ({
		sessionId: `${tag}-${i}`,
		displayName: `${tag}-${i}`,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		lastAgentTurnCompletedAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
	}));

/** Inserts `n` sessions synchronously on the `turn`-th turn of the event loop from now. */
function writeOnTurn(turn: number, tag: string, n: number): void {
	let seen = 0;
	const tick = () => {
		seen += 1;
		if (seen < turn) return void setImmediate(tick);
		// biome-ignore lint/suspicious/noExplicitAny: bun-sqlite's synchronous run()
		(getDb().insert(sessions).values(rows(tag, n)) as any).run();
	};
	setImmediate(tick);
}

const TURNS = [1, 2, 3, 4, 5, 6, 7, 8];

describeSqliteOnly("one snapshot under the cap", () => {
	test("a write on any turn between the scans never makes the poll disagree with itself", async () => {
		expect(config.dialect).toBe("sqlite");
		for (const turn of TURNS) {
			await getDb().delete(sessions).execute();
			await getDb().insert(sessions).values(rows("base", 20)).execute();
			const pending = getStats();
			writeOnTurn(turn, `w${turn}`, 50);
			const stats = await pending;
			const states = Object.values(stats.operational).reduce((a, b) => a + b, 0);
			expect({ turn, total: stats.total, active: stats.activeSessions, states }).toEqual({
				turn,
				total: states,
				active: states,
				states,
			});
			await new Promise((r) => setTimeout(r, 20));
		}
	});

	test("the per-owner grouping agrees with itself the same way", async () => {
		for (const turn of TURNS) {
			await getDb().delete(sessions).execute();
			await getDb().insert(sessions).values(rows("base", 20)).execute();
			const pending = getStatsByOwner();
			writeOnTurn(turn, `w${turn}`, 50);
			const { groups } = await pending;
			const total = groups.reduce((a, g) => a + g.total, 0);
			const active = groups.reduce((a, g) => a + g.active, 0);
			expect({ turn, total, active }).toEqual({ turn, total: active, active });
			await new Promise((r) => setTimeout(r, 20));
		}
	});
});

/** How many turns of the event loop pass while `work` runs. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
	let turns = 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		turns += 1;
		setImmediate(tick);
	};
	setImmediate(tick);
	await work();
	running = false;
	return turns;
}

describeSqliteOnly("turns taken by a stats scan", () => {
	test("under the cap the counts and the candidates share one turn", async () => {
		await getDb().insert(sessions).values(rows("base", 8)).execute();
		expect(await turnsDuring(() => getStats())).toBe(1);
		expect(await turnsDuring(() => getStatsByOwner())).toBe(1);
	});

	// Past the cap the response is already flagged truncated and approximate, so
	// the attention and fill queries take a turn of their own after the probe
	// instead of holding the loop for the whole set.
	test("past the cap the follow-up queries take a second turn, and the response says truncated", async () => {
		await getDb().insert(sessions).values(rows("base", 8)).execute();
		_setOperationalCandidateCapForTest(3);
		let truncated: boolean | undefined;
		expect(
			await turnsDuring(async () => {
				truncated = (await getStats()).truncated;
			}),
		).toBe(2);
		expect(truncated).toBe(true);
		expect(await turnsDuring(() => getStatsByOwner())).toBe(2);
	});

	test("an operational list is one scan turn under the cap and two past it", async () => {
		await getDb().insert(sessions).values(rows("base", 8)).execute();
		expect(await turnsDuring(() => getSessions({ operational: "waiting" }))).toBe(1);
		_setOperationalCandidateCapForTest(3);
		expect(await turnsDuring(() => getSessions({ operational: "waiting" }))).toBe(2);
	});
});
