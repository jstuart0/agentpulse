/**
 * The tables whose `session_id` is rebuilt to `REFERENCES sessions(session_id) ON DELETE CASCADE` after
 * every SQLite boot (client.ts `rebuildSessionChildFks`). The migration ledger reconcile
 * (sqlite-migration-ledger.ts) accepts a cascade on exactly these columns where the shipped migrations
 * declare none, so both read this one list and can't drift.
 */
export const SESSION_CHILD_FK_TARGETS: ReadonlyArray<{ table: string; column: string }> = [
	{ table: "events", column: "session_id" },
	{ table: "managed_sessions", column: "session_id" },
	{ table: "control_actions", column: "session_id" },
	{ table: "watcher_proposals", column: "session_id" },
	{ table: "ai_hitl_requests", column: "session_id" },
	{ table: "ai_watcher_runs", column: "session_id" },
	{ table: "watcher_configs", column: "session_id" },
];
