// Slice MIGR-HARDENING-1 (H-2) regression tests.
//
// `DATABASE_URL=postgres://…` used to log a warning and silently fall back
// to SQLite while the startup banner advertised PostgreSQL — a user-hostile
// pretense. We now throw on import. Testing the throw via env-mutation +
// fresh import would corrupt the shared SQLite test DB other suites rely on,
// so we expose the check as a pure function and test it directly.

import { describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { assertSqliteBackend } = await import("./client.js");

describe("assertSqliteBackend", () => {
	test("throws on postgres:// URLs", () => {
		expect(() => assertSqliteBackend("postgres://user:pw@host/db")).toThrow(
			/PostgreSQL backend not implemented/,
		);
	});

	test("throws on postgresql:// URLs", () => {
		expect(() => assertSqliteBackend("postgresql://user:pw@host/db")).toThrow(
			/PostgreSQL backend not implemented/,
		);
	});

	test("error message points at the env var name and the fix", () => {
		try {
			assertSqliteBackend("postgres://x");
			throw new Error("expected to throw");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("DATABASE_URL");
			expect(message).toContain("sqlite");
		}
	});

	test("passes when DATABASE_URL is empty (default SQLite path)", () => {
		expect(() => assertSqliteBackend("")).not.toThrow();
		expect(() => assertSqliteBackend(undefined)).not.toThrow();
	});

	test("passes when DATABASE_URL points at a sqlite path", () => {
		expect(() => assertSqliteBackend("/var/lib/agentpulse/db.sqlite")).not.toThrow();
		expect(() => assertSqliteBackend("./data/agentpulse.db")).not.toThrow();
	});

	test("does not match a substring (e.g. a path that happens to contain 'postgres')", () => {
		// We anchor on `startsWith`, so a sqlite path that incidentally
		// includes the word should still pass.
		expect(() => assertSqliteBackend("./data/postgres-clone.db")).not.toThrow();
	});
});
