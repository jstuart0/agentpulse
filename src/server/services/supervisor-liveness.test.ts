import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * Supervisor liveness (AGEN-76): one predicate decides "connected", and every
 * server reader agrees with it. Part (a) pins the predicate, (b) holds each
 * reader to it through its real time seam, (c) the leaf rule, (d) the drift
 * guard against reading the stored status column.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import "./ai/__test_db.js";
import { findOffendingLeafImports } from "../test-utils/leaf-imports.js";
import {
	HEARTBEAT_LEASE_MS,
	deriveSupervisorStatus,
	isSupervisorLive,
} from "./supervisor-liveness.js";
import { toDbTimestamp } from "./util/db-time.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedManagedSession, seedSupervisor } = await import("../test-utils/supervisor-fixture.js");
const { getConnectedSupervisor } = await import("./supervisor-registry.js");
const { recommendLaunch } = await import("./ai/launch-recommender.js");
// Phase 1 ships before the session-ownership readers take `nowMs` (Phase 2),
// so their post-Phase-2 signatures are declared here. Part (b) for these two
// is red until then; drop the cast when Phase 2 lands.
const ownership = (await import("./session-ownership.js")) as unknown as {
	getSessionOwnerConnections(ids: string[], nowMs: number): Promise<Map<string, boolean>>;
	listLiveOwnedManagedSessions(
		states: string[],
		nowMs: number,
	): Promise<{ sessionId: string; lastActivityAt: string }[]>;
};

const T = Date.parse("2026-10-19T12:00:00.000Z");
const SEC = 1000;
const DAY = 86_400_000;

type Case = {
	name: string;
	lease: string | null;
	enrollment?: string;
	/** The stored status column, which no reader may consult. Default "connected". */
	storedStatus?: string;
	expected: "connected" | "stale" | "offline";
};

const iso = (ms: number) => new Date(ms).toISOString();

/** The boundary table relative to instant `t`, so a clock-based `t` works too. */
function buildCases(t: number): Case[] {
	return [
		{ name: "T+1ms", lease: iso(t + 1), expected: "connected" },
		{
			name: "space-format tomorrow",
			lease: toDbTimestamp(new Date(t + DAY)),
			expected: "connected",
		},
		{
			name: "zone-less ISO future (read as UTC)",
			lease: iso(t + 3600 * SEC).replace("Z", ""),
			expected: "connected",
		},
		{
			name: "Postgres +00 future",
			lease: `${toDbTimestamp(new Date(t + 3600 * SEC))}.123+00`,
			expected: "connected",
		},
		{
			name: "stored offline, live lease",
			lease: iso(t + 60 * SEC),
			storedStatus: "offline",
			expected: "connected",
		},
		{
			name: "stored stale, live lease",
			lease: iso(t + 60 * SEC),
			storedStatus: "stale",
			expected: "connected",
		},
		{ name: "exactly T", lease: iso(t), expected: "stale" },
		{
			name: "space-format yesterday",
			lease: toDbTimestamp(new Date(t - DAY)),
			expected: "offline",
		},
		{
			name: "zone-less ISO past",
			lease: iso(t - DAY).replace("Z", ""),
			expected: "offline",
		},
		{ name: "invalid calendar", lease: "9999-99-99T99:99:99.999Z", expected: "offline" },
		{ name: "empty string", lease: "", expected: "offline" },
		{ name: "null", lease: null, expected: "offline" },
		{
			name: "revoked with lease T+60s",
			lease: iso(t + 60 * SEC),
			enrollment: "revoked",
			expected: "offline",
		},
		{ name: "T-60s (stale)", lease: iso(t - 60 * SEC), expected: "stale" },
		{
			name: "T-lease+1ms (last stale instant)",
			lease: iso(t - HEARTBEAT_LEASE_MS + 1),
			expected: "stale",
		},
		{
			name: "exactly T-lease (first offline instant)",
			lease: iso(t - HEARTBEAT_LEASE_MS),
			expected: "offline",
		},
		{ name: "T-200s (offline)", lease: iso(t - 200 * SEC), expected: "offline" },
	];
}

const CASES = buildCases(T);

describe("deriveSupervisorStatus boundary table (a)", () => {
	for (const c of CASES) {
		test(`${c.name} -> ${c.expected}`, () => {
			expect(deriveSupervisorStatus(c.lease, c.enrollment ?? "active", T)).toBe(c.expected);
			expect(isSupervisorLive(c.lease, c.enrollment ?? "active", T)).toBe(
				c.expected === "connected",
			);
		});
	}

	test("undefined lease and undefined enrollment state are offline / active-neutral", () => {
		expect(deriveSupervisorStatus(undefined, undefined, T)).toBe("offline");
		expect(deriveSupervisorStatus(iso(T + 1), undefined, T)).toBe("connected");
	});

	test("the table covers each side of the live boundary", () => {
		expect(CASES.filter((c) => c.expected === "connected").length).toBeGreaterThanOrEqual(4);
		expect(CASES.filter((c) => c.expected !== "connected").length).toBeGreaterThanOrEqual(8);
	});
});

describe("reader agreement (b)", () => {
	beforeAll(() => initializeDatabase());

	beforeEach(async () => {
		await getDb().delete(managedSessions).execute();
		await getDb().delete(launchRequests).execute();
		await getDb().delete(sessions).execute();
		await getDb().delete(supervisors).execute();
	});

	/**
	 * One supervisor per boundary row plus a DDL-default row, each owning one
	 * managed session. Anchored to the real clock (not the fixed T), because the
	 * DDL default is stored relative to the database's clock: its classification
	 * is derived from the stored value at this `t`, not assumed.
	 */
	async function seedPopulation() {
		const t = Date.now();
		const cases = buildCases(t);
		const ids: string[] = [];
		for (const [i, c] of cases.entries()) {
			if (c.lease === null) continue;
			const id = `sup-${i}`;
			await seedSupervisor(id, {
				rawLease: c.lease,
				enrollmentState: c.enrollment,
				storedStatus: c.storedStatus,
			});
			await seedManagedSession({
				sessionId: `sess-${i}`,
				supervisorId: id,
				managedState: "interactive_terminal",
			});
			ids.push(id);
		}
		await seedSupervisor("sup-ddl", { rawLease: null });
		await seedManagedSession({
			sessionId: "sess-ddl",
			supervisorId: "sup-ddl",
			managedState: "interactive_terminal",
		});
		ids.push("sup-ddl");

		const rows = await getDb().select().from(supervisors);
		const liveIds = new Set(
			rows
				.filter((r) => isSupervisorLive(r.heartbeatLeaseExpiresAt, r.enrollmentState, t))
				.map((r) => r.id),
		);
		expect(ids.length).toBeGreaterThanOrEqual(10);
		expect(liveIds.has("sup-0")).toBe(true); // T+1ms
		expect(liveIds.has("sup-ddl")).toBe(true); // DDL default is now+90s
		expect(liveIds.has(`sup-${cases.findIndex((c) => c.name === "exactly T")}`)).toBe(false);
		return { t, ids, liveIds };
	}

	const sessionOf = (supervisorId: string) => supervisorId.replace("sup-", "sess-");

	test("getConnectedSupervisor(id, t)", async () => {
		const { t, ids, liveIds } = await seedPopulation();
		const seen = new Set<string>();
		for (const id of ids) {
			if (await getConnectedSupervisor(id, t)) seen.add(id);
		}
		expect(seen).toEqual(liveIds);
	});

	test("getConnectedSupervisor() with no id returns the live host, not the newer expired one", async () => {
		const t = Date.now();
		await seedSupervisor("old-live", {
			leaseOffsetMs: 60 * SEC,
			leaseBaseMs: t,
			updatedAt: iso(t - 2 * 3600 * SEC),
		});
		await seedSupervisor("new-expired", {
			leaseOffsetMs: -200 * SEC,
			leaseBaseMs: t,
			updatedAt: iso(t - 1000),
		});
		expect((await getConnectedSupervisor(undefined, t))?.id).toBe("old-live");
	});

	test("getConnectedSupervisor() with no id prefers the most recently updated live host", async () => {
		const t = Date.now();
		await seedSupervisor("older", {
			leaseOffsetMs: 60 * SEC,
			leaseBaseMs: t,
			updatedAt: iso(t - 3600 * SEC),
		});
		await seedSupervisor("newer", {
			leaseOffsetMs: 60 * SEC,
			leaseBaseMs: t,
			updatedAt: iso(t - 1000),
		});
		expect((await getConnectedSupervisor(undefined, t))?.id).toBe("newer");
	});

	test("getConnectedSupervisor() with no id is null when nothing is live", async () => {
		const t = Date.now();
		await seedSupervisor("dead", { leaseOffsetMs: -200 * SEC, leaseBaseMs: t });
		await seedSupervisor("revoked", {
			leaseOffsetMs: 60 * SEC,
			leaseBaseMs: t,
			enrollmentState: "revoked",
		});
		expect(await getConnectedSupervisor(undefined, t)).toBeNull();
	});

	test("getSessionOwnerConnections(ids, T)", async () => {
		const { t, ids, liveIds } = await seedPopulation();
		const result = await ownership.getSessionOwnerConnections(ids.map(sessionOf), t);
		const seen = new Set(ids.filter((id) => result.get(sessionOf(id)) === true));
		expect(seen).toEqual(liveIds);
	});

	// Red until Phase 2 for a missing API (listLiveOwnedManagedSessions doesn't
	// exist yet), not for a wrong answer.
	test("listLiveOwnedManagedSessions(states, T)", async () => {
		const { t, ids, liveIds } = await seedPopulation();
		const rows = await ownership.listLiveOwnedManagedSessions(["interactive_terminal"], t);
		const liveSessions = new Set(rows.map((r) => r.sessionId));
		const seen = new Set(ids.filter((id) => liveSessions.has(sessionOf(id))));
		expect(seen).toEqual(liveIds);
	});

	test("recommendLaunch({ now, preferredSupervisorId })", async () => {
		const { t, ids, liveIds } = await seedPopulation();
		const seen = new Set<string>();
		for (const id of ids) {
			const rec = await recommendLaunch({
				template: {
					name: "t",
					agentType: "claude_code",
					cwd: "/p",
					baseInstructions: "",
					taskPrompt: "",
				},
				preferredSupervisorId: id,
				now: new Date(t),
			});
			const warned = rec.warnings.some((w) => w.includes("not connected"));
			if (rec.suggestedSupervisorId === id && !warned) seen.add(id);
		}
		expect(seen).toEqual(liveIds);
	});
});

describe("supervisor-liveness.ts is a leaf module (c)", () => {
	// Pure by design: only the timestamp reader may be value-imported.
	const SUPERVISOR_LIVENESS_LEAF_ALLOWED = new Set(["./util/db-time.js"]);

	test("value imports are only ./util/db-time.js", () => {
		const source = readFileSync(join(import.meta.dir, "supervisor-liveness.ts"), "utf-8");
		expect(findOffendingLeafImports(source, SUPERVISOR_LIVENESS_LEAF_ALLOWED)).toEqual([]);
	});

	const scan = (source: string) =>
		findOffendingLeafImports(source, SUPERVISOR_LIVENESS_LEAF_ALLOWED);

	test.each([
		["single-line import", 'import { getDb } from "../db/client.js";'],
		["multi-line import", 'import {\n\tgetDb,\n\tother,\n} from "../db/client.js";'],
		["side-effect import", 'import "../db/client.js";'],
		["export-from", 'export { getDb } from "../db/client.js";'],
		["multi-line export-from", 'export {\n\tgetDb,\n} from "../db/client.js";'],
		["export-star", 'export * from "../db/client.js";'],
		["dynamic import()", 'const m = await import("../db/client.js");'],
		["require(", 'const m = require("../db/client.js");'],
		["trailing comment", 'import { getDb } from "../db/client.js"; // sneaky'],
	])("a disallowed %s is caught", (_name, source) => {
		expect(scan(source)).toHaveLength(1);
	});

	test.each([
		["allowed import", 'import { parseDbTimestamp } from "./util/db-time.js";'],
		["allowed multi-line import", 'import {\n\ta,\n\tb,\n} from "./util/db-time.js";'],
		["type-only import", 'import type { X } from "../db/client.js";'],
		["multi-line type-only import", 'import type {\n\tX,\n} from "../db/client.js";'],
		["type-only re-export", 'export type { X } from "../db/client.js";'],
		["export of a string constant", 'export const NAME = "../db/client.js";'],
	])("an %s is not flagged", (_name, source) => {
		expect(scan(source)).toEqual([]);
	});
});

describe("no reader consults the stored supervisors.status column (drift guard)", () => {
	const RAW_STATUS_READ = /supervisors\.status\b/;
	const SERVER_ROOT = join(import.meta.dir, "..");

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) return sourceFiles(full);
			return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
		});
	}

	test("the pattern flags the raw read it exists to catch", () => {
		expect(RAW_STATUS_READ.test('eq(supervisors.status, "connected")')).toBe(true);
	});

	test("no non-test file under src/server matches", () => {
		const files = sourceFiles(SERVER_ROOT);
		expect(files.length).toBeGreaterThanOrEqual(100);
		const offenders = files
			.filter((f) => RAW_STATUS_READ.test(readFileSync(f, "utf-8")))
			.map((f) => f.slice(SERVER_ROOT.length + 1));
		expect(offenders).toEqual([]);
	});
});
