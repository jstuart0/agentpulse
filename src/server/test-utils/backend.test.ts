/**
 * Sanity tests for the centralized test-backend harness (Decision 23).
 * No real DB is needed — these verify the helper composition.
 */

import { describe, expect, test } from "bun:test";
import {
	TEST_BACKEND,
	describePostgresOnly,
	describeSqliteOnly,
	isPostgresTest,
	isSqliteTest,
	itPostgresOnly,
	itSqliteOnly,
} from "./backend.js";

describe("backend harness constants", () => {
	test("TEST_BACKEND is 'sqlite' or 'postgres'", () => {
		expect(["sqlite", "postgres"]).toContain(TEST_BACKEND);
	});

	test("isSqliteTest and isPostgresTest are mutually exclusive", () => {
		expect(isSqliteTest).toBe(!isPostgresTest);
	});

	test("isSqliteTest matches TEST_BACKEND", () => {
		expect(isSqliteTest).toBe(TEST_BACKEND === "sqlite");
	});

	test("isPostgresTest matches TEST_BACKEND", () => {
		expect(isPostgresTest).toBe(TEST_BACKEND === "postgres");
	});
});

describe("backend harness helper functions", () => {
	test("describeSqliteOnly and describePostgresOnly are functions", () => {
		expect(typeof describeSqliteOnly).toBe("function");
		expect(typeof describePostgresOnly).toBe("function");
	});

	test("itSqliteOnly and itPostgresOnly are functions", () => {
		expect(typeof itSqliteOnly).toBe("function");
		expect(typeof itPostgresOnly).toBe("function");
	});
});

// Self-demonstrating gates: these show that the helpers work correctly in the
// current backend context. In the default (sqlite) run, the sqlite gate runs
// and the postgres gate is skipped.
describeSqliteOnly("SQLite-specific block (runs only on sqlite backend)", () => {
	test("isSqliteTest is true", () => {
		expect(isSqliteTest).toBe(true);
	});
});

describePostgresOnly("Postgres-specific block (runs only on postgres backend)", () => {
	test("isPostgresTest is true", () => {
		expect(isPostgresTest).toBe(true);
	});
});

itSqliteOnly("itSqliteOnly: isSqliteTest is true (skipped on postgres)", () => {
	expect(isSqliteTest).toBe(true);
});

itPostgresOnly("itPostgresOnly: isPostgresTest is true (skipped on sqlite)", () => {
	expect(isPostgresTest).toBe(true);
});
