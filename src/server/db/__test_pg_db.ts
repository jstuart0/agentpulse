/**
 * PostgreSQL test-DB helper (Phase 4 stub — wired into CI in Phase 7).
 *
 * When AGENTPULSE_TEST_BACKEND=postgres is set this helper:
 *   1. Connects to AGENTPULSE_TEST_PG_URL.
 *   2. Creates a uniquely-named schema per test file (CREATE SCHEMA IF NOT
 *      EXISTS <hash-of-import.meta.url>), sets search_path to that schema.
 *   3. Runs Drizzle migrations into that schema.
 *   4. Registers an afterAll cleanup that drops the schema CASCADE.
 *
 * For Phase 4 the helper throws "not yet wired into CI" if
 * AGENTPULSE_TEST_BACKEND !== "postgres" — callers should use the
 * backend.ts helpers (describePostgresOnly / itPostgresOnly) to guard
 * invocations so this path is only reached when a Postgres URL is
 * actually available.
 */

export function getTestPgDb(): never {
	throw new Error(
		"__test_pg_db: Postgres test harness not yet wired into CI (Phase 7). " +
			"Set AGENTPULSE_TEST_BACKEND=sqlite or wait for Phase 7.",
	);
}
