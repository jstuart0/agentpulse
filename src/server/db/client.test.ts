// Slice DB-1 regression tests:
//   - initializeDatabase is idempotent
//   - cascade FKs are in place on every child of sessions(session_id)
//   - rebuilds preserved indexes on rebuilt tables
import { beforeAll, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Database } = await import("bun:sqlite");
const { config } = await import("../config.js");
const { initializeDatabase } = await import("./client.js");

beforeAll(() => {
	initializeDatabase();
});

describe("initializeDatabase", () => {
	test("is idempotent (calling twice does not throw)", () => {
		// Already called once in beforeAll; calling again must be a no-op.
		expect(() => initializeDatabase()).not.toThrow();
		expect(() => initializeDatabase()).not.toThrow();
	});

	test("session children reference sessions ON DELETE CASCADE", () => {
		// Open a fresh raw handle to read PRAGMA results without going
		// through drizzle. Same path as the module-level handle, so the
		// schema is whatever the running test process has applied.
		const raw = new Database(config.sqlitePath, { readonly: true });
		try {
			const childTables = [
				"events",
				"managed_sessions",
				"control_actions",
				"watcher_proposals",
				"ai_hitl_requests",
				"ai_watcher_runs",
				"watcher_configs",
			];
			for (const table of childTables) {
				const fkRows = raw.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
					table: string;
					from: string;
					to: string;
					on_delete: string;
				}>;
				const sessionFk = fkRows.find(
					(r) => r.table === "sessions" && r.from === "session_id" && r.to === "session_id",
				);
				expect(sessionFk, `${table} should reference sessions(session_id)`).toBeTruthy();
				expect(sessionFk?.on_delete, `${table}.session_id should ON DELETE CASCADE`).toBe(
					"CASCADE",
				);
			}
		} finally {
			raw.close();
		}
	});

	test("rebuild preserves indexes on the events table", () => {
		const raw = new Database(config.sqlitePath, { readonly: true });
		try {
			const idxs = raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events' AND name LIKE 'idx_%'",
				)
				.all() as Array<{ name: string }>;
			const names = idxs.map((r) => r.name).sort();
			expect(names).toContain("idx_events_session_id");
			expect(names).toContain("idx_events_created_at");
			expect(names).toContain("idx_events_event_type");
		} finally {
			raw.close();
		}
	});

	test("rebuild preserves the unique partial index on ai_watcher_runs", () => {
		const raw = new Database(config.sqlitePath, { readonly: true });
		try {
			const idxs = raw
				.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_watcher_runs'")
				.all() as Array<{ name: string }>;
			const names = idxs.map((r) => r.name);
			expect(names).toContain("idx_ai_watcher_runs_open_per_session");
			expect(names).toContain("idx_ai_watcher_runs_status_lease");
			expect(names).toContain("idx_ai_watcher_runs_session_created");
		} finally {
			raw.close();
		}
	});
});
