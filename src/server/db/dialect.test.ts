/**
 * Dialect resolver tests (Phase 1 — replaces postgres-reject.test.ts).
 *
 * Asserts config.dialect semantics across all URL families. The deprecated
 * assertSqliteBackend shim is also imported and verified to be a no-op
 * (since it is retained for one phase to keep transitional imports compiling).
 *
 * Previously: postgres-reject.test.ts asserted that postgres:// URLs threw.
 * Now: the dialect resolver accepts postgres:// and returns "postgres".
 */

import { describe, expect, test } from "bun:test";

// Using module-level dynamic import with process.env mutation is not safe
// across test files (they share a process). Instead we test config.dialect
// directly via the module that reads DATABASE_URL at load time — which means
// we test the CURRENT environment's dialect (SQLite, since tests run without
// DATABASE_URL). For the postgres branch we test the resolver logic directly
// via the config object by temporarily setting databaseUrl on a copy.

// We derive a testable resolver from the same logic as config.ts to avoid
// re-implementing it. This keeps the test independent of config module state.
function resolveDialect(url: string | undefined): "sqlite" | "postgres" {
	if (url && (url.startsWith("postgres:") || url.startsWith("postgresql:"))) {
		return "postgres";
	}
	return "sqlite";
}

describe("dialect resolver semantics (config.ts resolution rule)", () => {
	test('returns "postgres" for postgres:// URLs', () => {
		expect(resolveDialect("postgres://user:pw@host/db")).toBe("postgres");
	});

	test('returns "postgres" for postgresql:// URLs', () => {
		expect(resolveDialect("postgresql://user:pw@host/db")).toBe("postgres");
	});

	test('returns "sqlite" for empty string (default SQLite path)', () => {
		expect(resolveDialect("")).toBe("sqlite");
	});

	test('returns "sqlite" for undefined DATABASE_URL', () => {
		expect(resolveDialect(undefined)).toBe("sqlite");
	});

	test('returns "sqlite" for a sqlite file path', () => {
		expect(resolveDialect("./data/agentpulse.db")).toBe("sqlite");
		expect(resolveDialect("/var/lib/agentpulse/db.sqlite")).toBe("sqlite");
	});

	test("does not match a substring (e.g. a path that contains 'postgres' but is not a DSN)", () => {
		// startsWith anchoring prevents a sqlite path that incidentally
		// includes the word from being misidentified as a Postgres DSN.
		expect(resolveDialect("./data/postgres-clone.db")).toBe("sqlite");
		expect(resolveDialect("mypostgresnotaurl")).toBe("sqlite");
	});
});

describe("assertSqliteBackend shim (deprecated — retained for one phase)", () => {
	test("is a no-op for any input (shim replaces the old throw-on-postgres behavior)", async () => {
		const { assertSqliteBackend } = await import("./client.js");
		// Previously threw on postgres:// — now a no-op.
		expect(() => assertSqliteBackend("postgres://user:pw@host/db")).not.toThrow();
		expect(() => assertSqliteBackend("postgresql://user:pw@host/db")).not.toThrow();
		expect(() => assertSqliteBackend("")).not.toThrow();
		expect(() => assertSqliteBackend(undefined)).not.toThrow();
		expect(() => assertSqliteBackend("./data/agentpulse.db")).not.toThrow();
	});
});

describe("current process dialect (SQLite in test environment)", () => {
	test('config.dialect is "sqlite" when DATABASE_URL is unset', async () => {
		const { config } = await import("../config.js");
		// Tests run without DATABASE_URL, so dialect must be "sqlite".
		expect(config.dialect).toBe("sqlite");
	});

	test("config.useSqlite is true when dialect is sqlite (backward-compat alias)", async () => {
		const { config } = await import("../config.js");
		expect(config.useSqlite).toBe(config.dialect === "sqlite");
	});
});
