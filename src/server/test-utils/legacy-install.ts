/**
 * A pre-existing SQLite install, reduced to the one thing that routes boot to the legacy init path: a
 * `sessions` table in the shape an old install has. Not a test file; shared by the suites that run the
 * legacy init (legacy-init-parity.test.ts) and by the child process that runs the Codex approval suites on
 * a database it built.
 */
import { Database } from "bun:sqlite";

export const LEGACY_SESSIONS_DDL = `CREATE TABLE sessions (
	id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, display_name TEXT, agent_type TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active', cwd TEXT, transcript_path TEXT, model TEXT,
	started_at TEXT NOT NULL DEFAULT (datetime('now')), last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
	ended_at TEXT, semantic_status TEXT, current_task TEXT, plan_summary TEXT,
	total_tool_uses INTEGER NOT NULL DEFAULT 0, metadata TEXT DEFAULT '{}')`;

/** An in-memory pre-existing install. */
export function preexistingInstall(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	db.exec(LEGACY_SESSIONS_DDL);
	return db;
}

/** The same, as a file the server can be pointed at (SQLITE_PATH); closed again before it returns. */
export function writePreexistingInstallFile(path: string): void {
	const db = new Database(path);
	try {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec(LEGACY_SESSIONS_DDL);
	} finally {
		db.close();
	}
}
