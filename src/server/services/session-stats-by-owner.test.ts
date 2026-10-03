/**
 * The per-owner grouping: owners that hold both key-reported and hand-created
 * sessions are one row, it composes with an owner scope, and one owner's flood
 * of attention rows never changes what another owner's row says.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getStatsByOwner, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

const A = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const B = "9a1c2d3e-4f5a-4b6f-8a7e-0c1d2e3f4a5b";
const C = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const D = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const E = "2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

let counter = 0;
async function mk(owner: string | null, overrides: Record<string, unknown> = {}) {
	counter += 1;
	await getDb()
		.insert(sessions)
		.values({
			sessionId: `grp-${counter}`,
			displayName: `grp-${counter}`,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			ownerUserId: owner,
			lastActivityAt: iso(counter * 10),
			...overrides,
		} as never)
		.execute();
}

const waiting = (ago = 0) => ({ lastAgentTurnCompletedAt: iso(ago) });

function groupOf(
	result: Awaited<ReturnType<typeof getStatsByOwner>>,
	ownerUserId: string | null,
	ownerKind?: string,
) {
	return result.groups.find(
		(g) => g.ownerUserId === ownerUserId && (ownerKind === undefined || g.ownerKind === ownerKind),
	);
}

describe("one row per owner", () => {
	test("an owner with both key-reported and hand-created sessions is one row whose columns sum", async () => {
		await mk(A, { ingestKeyId: "key-1", ...waiting() });
		await mk(A, { ingestKeyId: "key-1", isWorking: true });
		await mk(A, waiting());
		await mk(A, {});
		await mk(A, { status: "completed", endedAt: iso(HOUR), ingestKeyId: "key-1" });
		await mk(A, { status: "completed", endedAt: iso(HOUR) });
		const result = await getStatsByOwner();
		const rows = result.groups.filter((g) => g.ownerUserId === A);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			ownerKind: "user",
			total: 6,
			completed: 2,
			active: 4,
			waiting: 2,
			working: 1,
			idle: 1,
			error: 0,
		});
	});

	test("ownerless sessions split by whether a key reported them", async () => {
		await mk(null, { ingestKeyId: "key-1" });
		await mk(null, { ingestKeyId: "key-2" });
		await mk(null, {});
		const result = await getStatsByOwner();
		expect(groupOf(result, null, "service")?.total).toBe(2);
		expect(groupOf(result, null, "unassigned")?.total).toBe(1);
	});
});

describe("composed with an owner scope", () => {
	test("a user scope leaves that user's row only, and the numbers are theirs", async () => {
		await mk(A, waiting());
		await mk(B, waiting());
		await mk(B, waiting());
		const result = await getStatsByOwner({ owner: { kind: "user", userId: B } });
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]).toMatchObject({ ownerUserId: B, total: 2, waiting: 2 });
	});

	test("the unassigned and service scopes each leave their own row", async () => {
		await mk(A, waiting());
		await mk(null, { ingestKeyId: "key-1", ...waiting() });
		await mk(null, waiting());
		const unassigned = await getStatsByOwner({ owner: { kind: "unassigned" } });
		expect(unassigned.groups.map((g) => g.ownerKind)).toEqual(["unassigned"]);
		const service = await getStatsByOwner({ owner: { kind: "service" } });
		expect(service.groups.map((g) => g.ownerKind)).toEqual(["service"]);
	});
});

describe("one owner's flood does not change another owner's row", () => {
	test("an owner with more than the cap of waiting rows, another with two old waiting rows", async () => {
		_setOperationalCandidateCapForTest(5);
		for (let i = 0; i < 6; i++) await mk(C, {});
		for (let i = 0; i < 8; i++) await mk(A, waiting());
		await mk(B, { ...waiting(10 * HOUR), lastActivityAt: iso(10 * HOUR) });
		await mk(B, { ...waiting(11 * HOUR), lastActivityAt: iso(11 * HOUR) });
		const result = await getStatsByOwner();
		expect(result.truncated).toBe(true);
		expect(groupOf(result, B)?.waiting).toBe(2);
		expect(groupOf(result, A)?.waiting).toBe(5);
		expect(groupOf(result, A)?.total).toBe(8);
	});

	test("an old failure behind another owner's flood still shows on its owner's row", async () => {
		_setOperationalCandidateCapForTest(4);
		for (let i = 0; i < 6; i++) await mk(A, waiting());
		await mk(B, { status: "failed", endedAt: iso(20 * HOUR), lastActivityAt: iso(20 * HOUR) });
		const result = await getStatsByOwner();
		expect(groupOf(result, B)?.error).toBe(1);
	});

	test("capped, the grouping issues the same statements however many owners there are", async () => {
		_setOperationalCandidateCapForTest(5);
		for (const owner of [A, B, C]) {
			for (let i = 0; i < 4; i++) await mk(owner, waiting());
		}
		const calls = await countDbCalls(async () => {
			await getStatsByOwner();
		});
		// the totals, the probe, the per-owner attention tier and the fill
		expect(calls).toBe(4);
	});

	test("nothing capped: not truncated, every column exact", async () => {
		await mk(A, waiting());
		await mk(B, waiting());
		const result = await getStatsByOwner();
		expect(result.truncated).toBe(false);
		expect(groupOf(result, A)?.waiting).toBe(1);
		expect(groupOf(result, B)?.waiting).toBe(1);
	});
});

describe("inside one owner's window", () => {
	test("failures are kept before newer waiting rows when the owner has more attention rows than the cap", async () => {
		_setOperationalCandidateCapForTest(3);
		for (let i = 0; i < 5; i++) await mk(A, waiting());
		for (let i = 0; i < 2; i++) {
			await mk(A, { status: "failed", endedAt: iso(20 * HOUR), lastActivityAt: iso(20 * HOUR) });
		}
		const result = await getStatsByOwner();
		expect(result.truncated).toBe(true);
		expect(groupOf(result, A)).toMatchObject({ total: 7, error: 2, waiting: 1 });
	});
});

describe("the per-owner fill is bounded by what the attention tier left of the ceiling", () => {
	const cap = 3;
	async function seedAttentionOwners(owners: string[]) {
		for (const owner of owners) {
			for (let i = 0; i < 5; i++) await mk(owner, waiting());
		}
		for (let i = 0; i < 10; i++) await mk(C, {});
	}
	const read = (result: Awaited<ReturnType<typeof getStatsByOwner>>) =>
		result.groups.reduce((sum, g) => sum + g.active, 0);

	test("attention rows that use the whole ceiling leave no room for idle rows", async () => {
		_setOperationalCandidateCapForTest(cap);
		await seedAttentionOwners([A, B, D, E]);
		const result = await getStatsByOwner();
		expect(read(result)).toBe(4 * cap);
		expect(groupOf(result, C)).toMatchObject({ total: 10, idle: 0 });
	});

	test("attention rows that leave room let the fill take up to one cap of idle rows", async () => {
		_setOperationalCandidateCapForTest(cap);
		await seedAttentionOwners([A, B, D]);
		const result = await getStatsByOwner();
		expect(read(result)).toBe(4 * cap);
		expect(groupOf(result, C)).toMatchObject({ total: 10, idle: cap });
	});
});

describe("the per-owner attention fetch has a global ceiling", () => {
	test("many owners with more waiting rows than the cap: at most four caps' worth of rows are read, and it says truncated", async () => {
		const cap = 3;
		_setOperationalCandidateCapForTest(cap);
		const owners = Array.from(
			{ length: 30 },
			(_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
		);
		const rows = owners.flatMap((owner, o) =>
			Array.from({ length: 5 }, (_, i) => ({
				sessionId: `many-${o}-${i}`,
				displayName: `many-${o}-${i}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				ownerUserId: owner,
				lastAgentTurnCompletedAt: iso(HOUR),
				lastActivityAt: iso((o * 5 + i) * 10),
			})),
		);
		await getDb()
			.insert(sessions)
			.values(rows as never)
			.execute();
		const result = await getStatsByOwner();
		const read = result.groups.reduce((sum, g) => sum + g.active, 0);
		expect(result.truncated).toBe(true);
		expect(read).toBeLessThanOrEqual(4 * cap);
		expect(read).toBeGreaterThan(0);
		// Each owner's first row comes before any owner's second: the ceiling is
		// shared fairly, not spent on whoever sorts first.
		expect(Math.max(...result.groups.map((g) => g.waiting))).toBeLessThanOrEqual(1);
	});
});
