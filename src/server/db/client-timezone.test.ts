// AGEN-24 percy review (TB10), item 1 — Critical: on Postgres, `created_at`
// is TEXT rendered in the connection's TimeZone GUC, and the retention
// cutoff comparison is a lexicographic string compare in UTC. On a
// non-UTC-default Postgres server, that comparison is wrong by the offset.
//
// Fix under test: every postgres-js connection this app opens must pin
// `connection: { TimeZone: "UTC" }` so `CURRENT_TIMESTAMP`-derived text is
// always rendered "+00", regardless of the database's default timezone GUC.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { describePostgresOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { PG_CONNECTION_OPTIONS, initializeDatabase } = await import("./client.js");
const { toDbTimestamp } = await import("../services/util/db-time.js");

describe("PG_CONNECTION_OPTIONS", () => {
	// Dialect-agnostic: this is a plain object, checkable without a live DB.
	// Exercises the actual constant spread into every postgres-js connection
	// client.ts opens (main pool and migration client) — not a re-simulation.
	test("pins TimeZone to UTC", () => {
		expect(PG_CONNECTION_OPTIONS).toEqual({ connection: { TimeZone: "UTC" } });
	});
});

describePostgresOnly("Postgres connection TimeZone pinning (end-to-end)", () => {
	let databaseName: string;

	beforeAll(async () => {
		await initializeDatabase();
		const admin = postgres(config.databaseUrl, { max: 1 });
		try {
			const [row] = await admin`SELECT current_database() AS name`;
			databaseName = row.name as string;
			// Simulate an operator whose Postgres server/database was
			// provisioned with a non-UTC default — the exact scenario percy
			// measured. `ALTER DATABASE ... SET` only affects sessions that
			// connect *after* this runs, which is what the tests below do.
			await admin.unsafe(`ALTER DATABASE "${databaseName}" SET timezone = 'America/New_York'`);
		} finally {
			await admin.end();
		}
	});

	afterAll(async () => {
		const admin = postgres(config.databaseUrl, { max: 1 });
		try {
			await admin.unsafe(`ALTER DATABASE "${databaseName}" RESET timezone`);
		} finally {
			await admin.end();
		}
	});

	async function insertProbeEvent(client: ReturnType<typeof postgres>): Promise<string> {
		const sessionId = `tz-probe-${crypto.randomUUID()}`;
		// `id` has a Drizzle-level $defaultFn (crypto.randomUUID()), which only
		// applies through Drizzle's own insert builder — raw SQL must supply it.
		await client`INSERT INTO sessions (id, session_id, agent_type) VALUES (${crypto.randomUUID()}, ${sessionId}, ${"claude_code"})`;
		const [row] = await client`
			INSERT INTO events (session_id, event_type, raw_payload)
			VALUES (${sessionId}, ${"UserPromptSubmit"}, ${"{}"}::json)
			RETURNING created_at::text AS created_at
		`;
		return row.created_at as string;
	}

	test("a connection pinned to UTC ignores the database's non-UTC default", async () => {
		const pinned = postgres(config.databaseUrl, { max: 1, ...PG_CONNECTION_OPTIONS });
		try {
			const [{ TimeZone }] = await pinned`SHOW TimeZone`;
			expect(TimeZone).toBe("UTC");

			const createdAt = await insertProbeEvent(pinned);
			expect(createdAt.endsWith("+00")).toBe(true);

			// The regression this guards against: a lexicographic compare of
			// a row inserted "now" against a same-instant UTC-computed cutoff
			// must never find the fresh row "older".
			const cutoff = toDbTimestamp(new Date());
			expect(createdAt < cutoff).toBe(false);
		} finally {
			await pinned.end();
		}
	});

	test("negative control: an unpinned non-UTC connection reproduces the bug (proves the test is meaningful)", async () => {
		// Without our fix, a connection takes whatever TimeZone the database
		// default provides — simulated directly here rather than waiting on
		// the ALTER DATABASE default, so this test is deterministic.
		const unpinned = postgres(config.databaseUrl, {
			max: 1,
			connection: { TimeZone: "America/New_York" },
		});
		try {
			const [{ TimeZone }] = await unpinned`SHOW TimeZone`;
			expect(TimeZone).toBe("America/New_York");

			const createdAt = await insertProbeEvent(unpinned);
			expect(createdAt.endsWith("+00")).toBe(false);

			const cutoff = toDbTimestamp(new Date());
			// This is the bug: a row inserted at essentially the same instant
			// as the cutoff renders as hours "earlier" under a non-UTC session
			// timezone, so the naive lexicographic compare treats it as older.
			expect(createdAt < cutoff).toBe(true);
		} finally {
			await unpinned.end();
		}
	});
});
