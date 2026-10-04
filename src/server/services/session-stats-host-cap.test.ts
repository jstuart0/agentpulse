/**
 * group_by=host is bounded: an ingest key can mint any number of distinct
 * machine names, and every viewer's poll asks for this. The busiest machines are
 * listed (the sessions with no machine always are), the rest are rolled into one
 * explicit figure, and the response says it was cut.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions, managedSessions, supervisors } = await import("../db/schema/index.js");
const { enrollSupervisor, revokeSupervisor } = await import("./supervisor-registry.js");
const { eq } = await import("drizzle-orm");
const { getStatsByHost, MAX_MACHINE_GROUPS, MAX_REGISTERED_MACHINE_GROUPS } = await import(
	"./session-tracker.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

/** machine i has `size(i)` sessions; a null name is a session with none. */
async function seedMachines(count: number, size: (i: number) => number, noMachine = 0) {
	const rows: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) {
		for (let k = 0; k < size(i); k++) {
			rows.push({
				sessionId: `cap-${i}-${k}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				reportedHost: `box-${String(i).padStart(3, "0")}`,
			});
		}
	}
	for (let k = 0; k < noMachine; k++) {
		rows.push({
			sessionId: `cap-none-${k}`,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			reportedHost: null,
		});
	}
	for (let i = 0; i < rows.length; i += 200) {
		await getDb()
			.insert(sessions)
			.values(rows.slice(i, i + 200) as never)
			.execute();
	}
}

const register = async (hostName: string) =>
	(
		await enrollSupervisor(
			{
				hostName,
				platform: "darwin",
				arch: "arm64",
				version: "1",
				capabilities: {},
				trustedRoots: [],
			} as never,
			null,
		)
	).supervisor;

describe("a registered machine can't be pushed out of the listing by invented busy names", () => {
	test("50+ busier invented names and one quiet supervisor machine: the supervisor machine is listed with its own total, and everything still adds up", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, () => 4);
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "quiet-1",
				agentType: "claude_code",
				status: "active",
				metadata: {},
				reportedHost: "quiet-sup",
			} as never)
			.execute();
		await register("quiet-sup");
		const result = await getStatsByHost();
		const names = result.groups.map((g) => g.host);
		expect(names).toContain("quiet-sup");
		expect(result.groups.find((g) => g.host === "quiet-sup")?.total).toBe(1);
		expect(result.groupsTruncated).toBe(true);
		expect(result.groups).toHaveLength(MAX_MACHINE_GROUPS + 1);
		expect(result.otherMachines).toBe(5);
		const everything = (MAX_MACHINE_GROUPS + 5) * 4 + 1;
		expect(result.groups.reduce((a, g) => a + g.total, 0) + result.otherTotal).toBe(everything);
	});

	test("a revoked supervisor's machine has no such protection", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, () => 4);
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "quiet-1",
				agentType: "claude_code",
				status: "active",
				metadata: {},
				reportedHost: "quiet-sup",
			} as never)
			.execute();
		const sup = await register("quiet-sup");
		await revokeSupervisor(sup.id);
		const result = await getStatsByHost();
		expect(result.groups.map((g) => g.host)).not.toContain("quiet-sup");
	});

	test("the registered machines are bounded too, so the listing can't be inflated by registering many", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, () => 4);
		for (let i = 0; i < 3; i++) {
			await getDb()
				.insert(sessions)
				.values({
					sessionId: `reg-${i}`,
					agentType: "claude_code",
					status: "active",
					metadata: {},
					reportedHost: `reg-${i}`,
				} as never)
				.execute();
			await register(`reg-${i}`);
		}
		const result = await getStatsByHost();
		expect(result.groups.length).toBe(MAX_MACHINE_GROUPS + 3);
		expect(MAX_REGISTERED_MACHINE_GROUPS).toBeGreaterThanOrEqual(50);
	});

	test("past the registered bound, the quietest registered machines roll up like any other, and the totals still add up", async () => {
		const template = await register("template-box");
		const [row] = await getDb().select().from(supervisors);
		const extra = MAX_REGISTERED_MACHINE_GROUPS + 4;
		const hosts = Array.from({ length: extra }, (_, i) => `reg-${String(i).padStart(3, "0")}`);
		await getDb()
			.insert(supervisors)
			.values(hosts.map((hostName, i) => ({ ...row, id: `clone-${i}`, hostName })) as never)
			.execute();
		await getDb().delete(supervisors).where(eq(supervisors.id, template.id));
		await getDb()
			.insert(sessions)
			.values(
				hosts.map((reportedHost, i) => ({
					sessionId: `many-${i}`,
					agentType: "claude_code",
					status: "active",
					metadata: {},
					reportedHost,
				})) as never,
			)
			.execute();
		const result = await getStatsByHost();
		expect(result.groups).toHaveLength(MAX_REGISTERED_MACHINE_GROUPS);
		expect(result.otherMachines).toBe(4);
		expect(result.groups.reduce((a, g) => a + g.total, 0) + result.otherTotal).toBe(extra);
	});

	test("a machine named in the supervisor's registration is selectable by name, with its own total", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, () => 4);
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "quiet-1",
				agentType: "claude_code",
				status: "active",
				metadata: {},
				reportedHost: "quiet-sup",
			} as never)
			.execute();
		await register("quiet-sup");
		const filtered = await getStatsByHost({ host: { kind: "host", host: "quiet-sup" } });
		expect(filtered.groups.map((g) => [g.host, g.total])).toEqual([["quiet-sup", 1]]);
	});
});

describe("the per-machine grouping is bounded", () => {
	test("the cap is a documented constant and is not tiny", () => {
		expect(MAX_MACHINE_GROUPS).toBeGreaterThanOrEqual(20);
	});

	test("fewer machines than the cap: everything listed, nothing rolled up, not cut", async () => {
		await seedMachines(5, () => 2, 1);
		const result = await getStatsByHost();
		expect(result.groups).toHaveLength(6);
		expect(result.groupsTruncated).toBe(false);
		expect(result.otherMachines).toBe(0);
		expect(result.otherTotal).toBe(0);
	});

	test("more machines than the cap: the busiest are listed by name, the rest are one explicit figure, and the totals still add up", async () => {
		const machines = MAX_MACHINE_GROUPS + 15;
		// machine i has (i % 7) + 1 sessions, so totals tie a lot: ties break by name
		await seedMachines(machines, (i) => (i % 7) + 1);
		const everything = Array.from({ length: machines }, (_, i) => (i % 7) + 1).reduce(
			(a, b) => a + b,
			0,
		);
		const result = await getStatsByHost();
		expect(result.groupsTruncated).toBe(true);
		expect(result.groups).toHaveLength(MAX_MACHINE_GROUPS);
		expect(result.otherMachines).toBe(15);
		const listed = result.groups.reduce((sum, g) => sum + g.total, 0);
		expect(listed + result.otherTotal).toBe(everything);
		const smallestListed = Math.min(...result.groups.map((g) => g.total));
		expect(result.otherTotal / result.otherMachines).toBeLessThanOrEqual(smallestListed);
		const names = result.groups.map((g) => g.host as string);
		expect([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))).toEqual(
			names,
		);
	});

	test("sessions with no machine reported are always listed on top of the cap, however few they are", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, () => 3, 1);
		const result = await getStatsByHost();
		expect(result.groups).toHaveLength(MAX_MACHINE_GROUPS + 1);
		expect(result.groups.at(-1)).toMatchObject({ host: null, total: 1 });
		expect(result.otherMachines).toBe(5);
	});

	test("asking for one machine outside the top gives that machine's own group, whole, and is not cut", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 5, (i) => (i === 0 ? 1 : 4));
		const result = await getStatsByHost({ host: { kind: "host", host: "box-000" } });
		expect(result.groups.map((g) => g.host)).toEqual(["box-000"]);
		expect(result.groups[0].total).toBe(1);
		expect(result.groupsTruncated).toBe(false);
		expect(result.otherMachines).toBe(0);
	});

	test("the statements issued don't depend on how many machines there are", async () => {
		await seedMachines(MAX_MACHINE_GROUPS + 20, () => 1);
		const many = await countDbCalls(async () => void (await getStatsByHost()));
		await getDb().delete(sessions).execute();
		await seedMachines(3, () => 1);
		const few = await countDbCalls(async () => void (await getStatsByHost()));
		expect(many).toBe(few);
	});

	test("machines are ordered by name without regard to case, ties by spelling (the order the dashboard shows)", async () => {
		const rows = ["b-box", "A-box", "a-box", "C-box", "B-box"].map((reportedHost, i) => ({
			sessionId: `case-${i}`,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			reportedHost,
		}));
		await getDb()
			.insert(sessions)
			.values(rows as never)
			.execute();
		const result = await getStatsByHost();
		expect(result.groups.map((g) => g.host)).toEqual(["A-box", "a-box", "B-box", "b-box", "C-box"]);
	});

	test("an empty instance is not cut", async () => {
		const result = await getStatsByHost();
		expect(result).toMatchObject({
			groups: [],
			groupsTruncated: false,
			otherMachines: 0,
			otherTotal: 0,
		});
	});
});
