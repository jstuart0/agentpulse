/**
 * The legacy SQLite init's statements for fork_tool_calls (migration 0022, AGEN-123). The table is born
 * with its cascade FK, so it is not in rebuildSessionChildFks. Same columns, index names and column order as
 * the Drizzle schema and the migration; legacy-init-parity.test.ts fails when they drift.
 */
export const FORK_TOOL_CALLS_DDL_SQLITE: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS fork_tool_calls (
		id TEXT PRIMARY KEY NOT NULL,
		session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
		turn_action_id TEXT,
		tool_use_id TEXT NOT NULL,
		tool TEXT NOT NULL,
		outcome TEXT NOT NULL,
		from_subagent INTEGER NOT NULL DEFAULT 0,
		input_cipher TEXT,
		input_truncated INTEGER NOT NULL DEFAULT 0,
		output_cipher TEXT,
		output_truncated INTEGER NOT NULL DEFAULT 0,
		redacted INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	"CREATE UNIQUE INDEX IF NOT EXISTS uq_fork_tool_calls_session_tool_use ON fork_tool_calls(session_id, tool_use_id)",
	"CREATE INDEX IF NOT EXISTS idx_fork_tool_calls_created_at ON fork_tool_calls(created_at)",
	"CREATE INDEX IF NOT EXISTS idx_fork_tool_calls_session_created ON fork_tool_calls(session_id, created_at)",
];
