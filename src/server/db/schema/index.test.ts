/**
 * Phase 2a deliverable: schema barrel dialect-dispatch tests.
 *
 * Decision 41 deferral: the runtime barrel (index.ts) currently always
 * re-exports SQLite-typed symbols — dialect dispatch is wired once the
 * schema-importer migration (Phase 2b) is complete. Until then:
 *   - The SQLite test passes unconditionally.
 *   - The Postgres test is skipped with a TODO pending the importer migration.
 *
 * When Phase 2b lands, remove the skip and enable the Postgres assertion.
 * See thoughts/postgres-followup-plans/schema-importer-migration.md.
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

// TODO(schema-importer-migration): enable once the runtime barrel is wired
// for dialect dispatch (Phase 2b). Currently index.ts always exports the
// SQLite-typed variants, so this block will fail when AGENTPULSE_TEST_BACKEND=postgres.
describePostgresOnly(
	"schema/index barrel — Postgres path (TODO: pending importer migration)",
	() => {
		test.skip("sessions is a PgTable on the Postgres dialect", () => {
			expect(is(sessions, PgTable)).toBe(true);
			expect(is(sessions, SQLiteTable)).toBe(false);
		});
	},
);
