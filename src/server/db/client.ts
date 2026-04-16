import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

function createDatabase() {
	if (config.useSqlite) {
		const dbPath = config.sqlitePath;
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const sqlite = new Database(dbPath);
		sqlite.exec("PRAGMA journal_mode = WAL;");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		return drizzle(sqlite, { schema });
	}

	// PostgreSQL support can be added here with drizzle-orm/postgres-js
	// For now, fall back to SQLite
	console.warn("PostgreSQL not yet configured, falling back to SQLite");
	const dbPath = config.sqlitePath;
	const dir = dirname(dbPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	return drizzle(sqlite, { schema });
}

export const db = createDatabase();
export type Db = typeof db;

// Initialize database tables
export function initializeDatabase() {
	const sqlite = new Database(config.sqlitePath);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			display_name TEXT,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			cwd TEXT,
			transcript_path TEXT,
			model TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at TEXT,
			semantic_status TEXT,
			current_task TEXT,
			plan_summary TEXT,
			total_tool_uses INTEGER NOT NULL DEFAULT 0,
			metadata TEXT DEFAULT '{}'
		);

		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(session_id),
			event_type TEXT NOT NULL,
			tool_name TEXT,
			tool_input TEXT,
			tool_response TEXT,
			raw_payload TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_prefix TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_used_at TEXT
		);

		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
		CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON sessions(agent_type);
		CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
		CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
		CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
		CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
	`);

	// Migrations: add columns that may not exist on older databases
	const migrations = [
		"ALTER TABLE sessions ADD COLUMN display_name TEXT",
		"ALTER TABLE sessions ADD COLUMN notes TEXT DEFAULT ''",
		"ALTER TABLE sessions ADD COLUMN is_working INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE sessions ADD COLUMN git_branch TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_content TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_path TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_checksum TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_updated_at TEXT",
	];

	for (const migration of migrations) {
		try {
			sqlite.exec(migration);
			console.log(`[db] Migration applied: ${migration.slice(0, 60)}`);
		} catch {
			// Column already exists -- ignore
		}
	}

	sqlite.close();
	console.log("[db] Database initialized");
}
