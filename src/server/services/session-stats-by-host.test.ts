/**
 * The per-machine grouping past the candidate cap: one machine's flood of
 * attention rows never changes another machine's row, a supervisor's host is
 * the machine that counts (not what its session reported), sessions with no
 * machine are a group of their own, and a machine filter narrows the capped
 * scan itself, so the cap is spent on that machine's sessions only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions, managedSessions } = await import("../db/schema/index.js");
const { getStatsByHost, getStats, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

let counter = 0;
/** A session on `machine`: reported by its relay, or, with `via: "supervisor"`, launched by that host's supervisor. */
async function mk(
	machine: string | null,
	overrides: Record<string, unknown> = {},
	via: "relay" | "supervisor" = "relay",
) {
	counter += 1;
	const sessionId = `host-grp-${counter}`;
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			reportedHost: via === "relay" ? machine : "ignored-reported-name",
			lastActivityAt: iso(counter * 10),
			...overrides,
		} as never)
		.execute();
	if (via === "supervisor") {
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: `launch-${sessionId}`,
				supervisorId: "supervisor-1",
				hostName: machine,
			});
	}
}

const waiting = (ago = 0) => ({ lastAgentTurnCompletedAt: iso(ago) });
const groupOf = (result: Awaited<ReturnType<typeof getStatsByHost>>, host: string | null) =>
	result.groups.find((g) => g.host === host);

describe("one machine's flood does not change another machine's row", () => {
	test("a machine with more than the cap of waiting rows, another with two old waiting rows", async () => {
		_setOperationalCandidateCapForTest(5);
		for (let i = 0; i < 6; i++) await mk("idle-box");
		for (let i = 0; i < 8; i++) await mk("flood-box", waiting());
		await mk("quiet-box", { ...waiting(10 * HOUR), lastActivityAt: iso(10 * HOUR) });
		await mk("quiet-box", { ...waiting(11 * HOUR), lastActivityAt: iso(11 * HOUR) });
		const result = await getStatsByHost();
		expect(result.truncated).toBe(true);
		expect(groupOf(result, "quiet-box")?.waiting).toBe(2);
		expect(groupOf(result, "flood-box")?.waiting).toBe(5);
		expect(groupOf(result, "flood-box")?.total).toBe(8);
	});

	test("the same holds when the flooding machine is a supervisor's host and its sessions reported another name", async () => {
		_setOperationalCandidateCapForTest(4);
		for (let i = 0; i < 7; i++) await mk("sup-box", waiting(), "supervisor");
		await mk("quiet-box", { ...waiting(10 * HOUR), lastActivityAt: iso(10 * HOUR) });
		const result = await getStatsByHost();
		expect(result.truncated).toBe(true);
		expect(groupOf(result, "ignored-reported-name")).toBeUndefined();
		expect(groupOf(result, "sup-box")).toMatchObject({ total: 7, waiting: 4 });
		expect(groupOf(result, "quiet-box")?.waiting).toBe(1);
	});

	test("an old failure behind another machine's flood, and the sessions with no machine, still show on their own rows", async () => {
		_setOperationalCandidateCapForTest(4);
		for (let i = 0; i < 6; i++) await mk("flood-box", waiting());
		await mk("quiet-box", {
			status: "failed",
			endedAt: iso(20 * HOUR),
			lastActivityAt: iso(20 * HOUR),
		});
		await mk(null, { ...waiting(30 * HOUR), lastActivityAt: iso(30 * HOUR) });
		const result = await getStatsByHost();
		expect(groupOf(result, "quiet-box")?.error).toBe(1);
		expect(groupOf(result, null)?.waiting).toBe(1);
		expect(result.groups.at(-1)?.host).toBeNull();
	});

	test("capped, the grouping issues the same statements however many machines there are", async () => {
		_setOperationalCandidateCapForTest(5);
		for (const machine of ["a-box", "b-box", "c-box"]) {
			for (let i = 0; i < 4; i++) await mk(machine, waiting());
		}
		const calls = await countDbCalls(async () => {
			await getStatsByHost();
		});
		// the totals (nested subqueries and the outer select: three builders, one statement),
		// the probe, the per-machine attention tier and the fill
		expect(calls).toBe(6);
	});

	test("nothing capped: not truncated, every column exact", async () => {
		await mk("a-box", waiting());
		await mk("b-box", waiting());
		const result = await getStatsByHost();
		expect(result.truncated).toBe(false);
		expect(groupOf(result, "a-box")?.waiting).toBe(1);
		expect(groupOf(result, "b-box")?.waiting).toBe(1);
	});
});

describe("the per-machine attention fetch has a global ceiling", () => {
	test("many machines with more waiting rows than the cap: at most four caps' worth of rows are read, shared fairly, and it says truncated", async () => {
		const cap = 3;
		_setOperationalCandidateCapForTest(cap);
		const rows = Array.from({ length: 30 }, (_, m) =>
			Array.from({ length: 5 }, (_, i) => ({
				sessionId: `many-${m}-${i}`,
				displayName: `many-${m}-${i}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				reportedHost: `box-${String(m).padStart(2, "0")}`,
				lastAgentTurnCompletedAt: iso(HOUR),
				lastActivityAt: iso((m * 5 + i) * 10),
			})),
		).flat();
		await getDb()
			.insert(sessions)
			.values(rows as never)
			.execute();
		const result = await getStatsByHost();
		const read = result.groups.reduce((sum, g) => sum + g.active, 0);
		expect(result.truncated).toBe(true);
		expect(read).toBeLessThanOrEqual(4 * cap);
		expect(read).toBeGreaterThan(0);
		expect(Math.max(...result.groups.map((g) => g.waiting))).toBeLessThanOrEqual(1);
	});
});

describe("a machine filter narrows the capped scan itself", () => {
	test("another machine's flood cannot use up the cap of the machine asked about", async () => {
		_setOperationalCandidateCapForTest(5);
		for (let i = 0; i < 9; i++) await mk("flood-box", waiting());
		await mk("quiet-box", { ...waiting(10 * HOUR), lastActivityAt: iso(10 * HOUR) });
		await mk("quiet-box", {
			status: "failed",
			endedAt: iso(12 * HOUR),
			lastActivityAt: iso(12 * HOUR),
		});
		const host = { kind: "host", host: "quiet-box" } as const;
		const poll = await getStats({ host });
		expect(poll.operational).toMatchObject({ waiting: 1, error: 1 });
		expect(poll.total).toBe(2);
		const grouped = await getStatsByHost({ host });
		expect(grouped.truncated).toBe(false);
		expect(grouped.groups.map((g) => g.host)).toEqual(["quiet-box"]);
		expect(grouped.groups[0]).toMatchObject({ total: 2, waiting: 1, error: 1 });
	});

	test("the machine asked about can itself be capped, and then says so for its own sessions only", async () => {
		_setOperationalCandidateCapForTest(3);
		for (let i = 0; i < 6; i++) await mk("flood-box", waiting());
		for (let i = 0; i < 2; i++) await mk("other-box", waiting());
		const grouped = await getStatsByHost({ host: { kind: "host", host: "flood-box" } });
		expect(grouped.truncated).toBe(true);
		expect(grouped.groups.map((g) => g.host)).toEqual(["flood-box"]);
		expect(grouped.groups[0]).toMatchObject({ total: 6, waiting: 3 });
	});

	test("unknown is a machine filter too: sessions with none, whoever else floods", async () => {
		_setOperationalCandidateCapForTest(3);
		for (let i = 0; i < 6; i++) await mk("flood-box", waiting());
		await mk(null, waiting(10 * HOUR));
		await mk("   ", waiting(11 * HOUR));
		const grouped = await getStatsByHost({ host: { kind: "unknown" } });
		expect(grouped.truncated).toBe(false);
		expect(grouped.groups).toHaveLength(1);
		expect(grouped.groups[0]).toMatchObject({ host: null, total: 2, waiting: 2 });
	});
});
