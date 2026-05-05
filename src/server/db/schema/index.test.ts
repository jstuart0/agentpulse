/**
 * Schema barrel dialect-dispatch tests.
 *
 * Migration complete (2026-05-05): the runtime barrel (index.ts) now dispatches
 * on config.dialect at module load. Both the SQLite and Postgres paths are
 * exercised by the respective test backends.
 *
 * Run with AGENTPULSE_TEST_BACKEND=postgres to test the Postgres path.
 */
import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describePostgresOnly, describeSqliteOnly } from "../../test-utils/backend.js";

const { sessions } = await import("./index.js");

describeSqliteOnly("schema/index barrel — SQLite path", () => {
	test("sessions is an SQLiteTable on the SQLite dialect", () => {
		expect(is(sessions, SQLiteTable)).toBe(true);
		expect(is(sessions, PgTable)).toBe(false);
	});
});

describePostgresOnly("schema/index barrel — Postgres path", () => {
	test("sessions is a PgTable on the Postgres dialect", () => {
		expect(is(sessions, PgTable)).toBe(true);
		expect(is(sessions, SQLiteTable)).toBe(false);
	});
});
