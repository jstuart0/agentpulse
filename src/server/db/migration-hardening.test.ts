// Slice MIGR-HARDENING-1 (M-1) regression tests.
//
// The migration loop in `initializeDatabase` used to swallow every non-lock
// error and break the retry loop with a comment claiming "expected idempotent
// path." That made truly broken migrations (syntax errors, type mismatches,
// failed CREATE TABLE) silently no-op while the running code expected the
// schema to be in place. We now whitelist only the idempotent-replay error
// shapes and re-throw everything else.
//
// We test the predicate function (`isIdempotentMigrationError`) directly
// rather than trying to inject a bad migration into the live boot path,
// because the predicate IS the contract — the loop is a thin wrapper that
// either rethrows when the predicate returns false or breaks when it
// returns true. We also drive the predicate against real SQLite errors
// generated on a fresh in-memory DB so we know the regex actually matches
// what bun:sqlite emits in 2026, not what it emitted when the regexes were
// hand-written.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { isIdempotentMigrationError } = await import("./client.js");

function captureExecError(db: Database, sql: string): string {
	try {
		db.exec(sql);
		throw new Error("expected exec to throw, but it succeeded");
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

describe("isIdempotentMigrationError", () => {
	test("treats duplicate-column ALTER TABLE as idempotent", () => {
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE t (a TEXT, b TEXT);");
			const message = captureExecError(db, "ALTER TABLE t ADD COLUMN a TEXT");
			expect(isIdempotentMigrationError(message)).toBe(true);
		} finally {
			db.close();
		}
	});

	test("treats duplicate CREATE TABLE (without IF NOT EXISTS) as idempotent", () => {
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE t (a TEXT);");
			const message = captureExecError(db, "CREATE TABLE t (a TEXT)");
			expect(isIdempotentMigrationError(message)).toBe(true);
		} finally {
			db.close();
		}
	});

	test("treats duplicate CREATE INDEX (without IF NOT EXISTS) as idempotent", () => {
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE t (a TEXT); CREATE INDEX idx_t_a ON t(a);");
			const message = captureExecError(db, "CREATE INDEX idx_t_a ON t(a)");
			expect(isIdempotentMigrationError(message)).toBe(true);
		} finally {
			db.close();
		}
	});

	test("re-throws on a syntax error", () => {
		const db = new Database(":memory:");
		try {
			const message = captureExecError(db, "ALTER TABLE_TYPO t ADD COLUMN x TEXT");
			expect(isIdempotentMigrationError(message)).toBe(false);
		} finally {
			db.close();
		}
	});

	test("re-throws on a missing-table reference", () => {
		const db = new Database(":memory:");
		try {
			const message = captureExecError(
				db,
				"ALTER TABLE table_that_does_not_exist ADD COLUMN x TEXT",
			);
			expect(isIdempotentMigrationError(message)).toBe(false);
		} finally {
			db.close();
		}
	});

	test("re-throws on bogus column type / constraint", () => {
		const db = new Database(":memory:");
		try {
			// Deliberately malformed CREATE TABLE — duplicate primary key.
			const message = captureExecError(
				db,
				"CREATE TABLE bogus (a TEXT PRIMARY KEY, b TEXT PRIMARY KEY)",
			);
			expect(isIdempotentMigrationError(message)).toBe(false);
		} finally {
			db.close();
		}
	});
});

describe("migration loop integration (idempotent replay)", () => {
	test("re-running initializeDatabase does not throw (existing-column ALTERs are tolerated)", async () => {
		// The shared __test_db helper has already pointed config.sqlitePath at
		// a temp DB, and other test files run initializeDatabase against it.
		// Calling it again here exercises every ALTER TABLE ADD COLUMN line in
		// the migrations array against a DB where every column already exists
		// — i.e. exactly the duplicate-column path the predicate must
		// tolerate. If the predicate were too narrow, this would throw.
		const { initializeDatabase } = await import("./client.js");
		expect(() => initializeDatabase()).not.toThrow();
	});
});
