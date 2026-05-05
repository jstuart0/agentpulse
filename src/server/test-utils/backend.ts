/**
 * Centralized test-backend helpers (Decision 23).
 *
 * Reads AGENTPULSE_TEST_BACKEND from the environment (default: "sqlite").
 * CI sets this env var to target a specific backend; test files never mutate
 * process.env directly — they use these helpers to conditionally skip tests
 * that only apply to one backend.
 *
 * Usage:
 *   import { describeSqliteOnly, itSqliteOnly } from "../../test-utils/backend.js";
 *
 *   describeSqliteOnly("trigger rollback", () => {
 *     test("installs trigger and verifies cascade", () => { ... });
 *   });
 *
 *   itSqliteOnly("FTS row count", () => { ... });
 */

import { describe, test } from "bun:test";

export type TestBackend = "sqlite" | "postgres";

/** Which backend is active for this test run. Defaults to "sqlite". */
export const TEST_BACKEND: TestBackend =
	(process.env.AGENTPULSE_TEST_BACKEND as TestBackend | undefined) ?? "sqlite";

/** True when running against SQLite. */
export const isSqliteTest = TEST_BACKEND === "sqlite";

/** True when running against Postgres. */
export const isPostgresTest = TEST_BACKEND === "postgres";

// ── describe helpers ──────────────────────────────────────────────────────────

/**
 * Run this describe block only when the active backend is SQLite.
 * When Postgres is active the block is registered but all tests are skipped,
 * keeping them visible in the suite output.
 */
export function describeSqliteOnly(name: string, fn: () => void): void {
	describe.skipIf(!isSqliteTest)(name, fn);
}

/**
 * Run this describe block only when the active backend is Postgres.
 * When SQLite is active the block is registered but all tests are skipped.
 */
export function describePostgresOnly(name: string, fn: () => void): void {
	describe.skipIf(!isPostgresTest)(name, fn);
}

// ── test/it helpers ───────────────────────────────────────────────────────────

/**
 * Run this test only when the active backend is SQLite.
 * Uses test.skipIf so the test name appears (as skipped) when Postgres is active.
 */
export function itSqliteOnly(name: string, fn: () => void | Promise<void>): void {
	test.skipIf(!isSqliteTest)(name, fn);
}

/**
 * Run this test only when the active backend is Postgres.
 * Uses test.skipIf so the test name appears (as skipped) when SQLite is active.
 */
export function itPostgresOnly(name: string, fn: () => void | Promise<void>): void {
	test.skipIf(!isPostgresTest)(name, fn);
}
