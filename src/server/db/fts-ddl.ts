/**
 * SQLite FTS5 virtual tables + sync triggers — the single source of DDL
 * shared by `client.ts`'s `runFtsBootstrap` (legacy + fresh-install boot
 * paths) and `search/sqlite-fts-backend.ts`'s `SqliteFtsBackend.initialize()`
 * (Pattern parity P-6; Decision 20).
 *
 * `search_events_fts` is keyed by `rowid = events.id`, not just the
 * UNINDEXED `event_id` column: every insert sets `rowid` explicitly and
 * every delete goes `WHERE rowid = ?`, which is a constrained lookup
 * instead of a full FTS5 table scan per deleted event (F74). `event_id` is
 * kept as a plain column because search reads it directly.
 *
 * Constants only — importing this from `db/client.ts` creates no circular
 * dependency (the concern noted historically at that call site).
 */

export const FTS_INDEXED_EVENT_TYPES = [
	"UserPromptSubmit",
	"AssistantMessage",
	"Stop",
	"TaskCreated",
	"TaskCompleted",
	"SubagentStop",
	"SessionEnd",
	"AiProposal",
	"AiReport",
	"AiHitlRequest",
] as const;

export const FTS_INDEXED_EVENT_TYPES_SQL_LIST = FTS_INDEXED_EVENT_TYPES.map((t) => `'${t}'`).join(
	",",
);

const EVENT_TEXT_COALESCE_NEW = `COALESCE(
			json_extract(NEW.raw_payload, '$.prompt'),
			json_extract(NEW.raw_payload, '$.message'),
			json_extract(NEW.raw_payload, '$.summary'),
			json_extract(NEW.raw_payload, '$.why'),
			json_extract(NEW.raw_payload, '$.title'),
			NEW.content, ''
		)`;

/** The SELECT-side COALESCE used by the rowid re-key and generic backfill. */
export const EVENT_TEXT_COALESCE_SELECT = `COALESCE(
			json_extract(raw_payload, '$.prompt'),
			json_extract(raw_payload, '$.message'),
			json_extract(raw_payload, '$.summary'),
			json_extract(raw_payload, '$.why'),
			json_extract(raw_payload, '$.title'),
			content, ''
		)`;

/**
 * The events-table half of the FTS bootstrap: the virtual table plus its two
 * sync triggers. Split out from FTS_BOOTSTRAP_SQL (codex r2 F129/F130) so the
 * one-time rowid re-key in `db/client.ts` can `exec()` exactly this DDL
 * inside the same transaction as the DROP + rebuild, instead of depending on
 * a second, later, unguarded `sqlite.exec(FTS_BOOTSTRAP_SQL)` call to put the
 * triggers back.
 *
 * F130: `trg_events_ad_fts` carries the same `WHEN OLD.event_type IN (...)`
 * guard as the insert trigger, so a delete of a non-indexed event (the large
 * majority — tool/permission events) never touches `search_events_fts` at
 * all, rather than firing a no-op rowid delete on every single event row.
 */
export const EVENTS_FTS_DDL = `
	CREATE VIRTUAL TABLE IF NOT EXISTS search_events_fts USING fts5(
		event_id UNINDEXED,
		session_id UNINDEXED,
		event_type UNINDEXED,
		text,
		created_at UNINDEXED,
		tokenize = 'porter unicode61 remove_diacritics 1'
	);

	CREATE TRIGGER IF NOT EXISTS trg_events_ai_fts AFTER INSERT ON events
	WHEN NEW.event_type IN (${FTS_INDEXED_EVENT_TYPES_SQL_LIST})
	BEGIN
		INSERT INTO search_events_fts(rowid, event_id, session_id, event_type, text, created_at)
		VALUES (
			NEW.id,
			NEW.id,
			NEW.session_id,
			NEW.event_type,
			${EVENT_TEXT_COALESCE_NEW},
			NEW.created_at
		);
	END;

	CREATE TRIGGER IF NOT EXISTS trg_events_ad_fts AFTER DELETE ON events
	WHEN OLD.event_type IN (${FTS_INDEXED_EVENT_TYPES_SQL_LIST})
	BEGIN
		DELETE FROM search_events_fts WHERE rowid = OLD.id;
	END;
`;

export const FTS_BOOTSTRAP_SQL = `
	CREATE VIRTUAL TABLE IF NOT EXISTS search_sessions_fts USING fts5(
		session_id UNINDEXED,
		display_name,
		cwd,
		current_task,
		notes,
		agent_type UNINDEXED,
		status UNINDEXED,
		last_activity_at UNINDEXED,
		tokenize = 'porter unicode61 remove_diacritics 1'
	);

	CREATE TRIGGER IF NOT EXISTS trg_sessions_ai_fts AFTER INSERT ON sessions
	BEGIN
		INSERT INTO search_sessions_fts(session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at)
		VALUES (NEW.session_id, NEW.display_name, NEW.cwd, NEW.current_task, NEW.notes, NEW.agent_type, NEW.status, NEW.last_activity_at);
	END;

	CREATE TRIGGER IF NOT EXISTS trg_sessions_au_fts AFTER UPDATE ON sessions
	BEGIN
		DELETE FROM search_sessions_fts WHERE session_id = OLD.session_id;
		INSERT INTO search_sessions_fts(session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at)
		VALUES (NEW.session_id, NEW.display_name, NEW.cwd, NEW.current_task, NEW.notes, NEW.agent_type, NEW.status, NEW.last_activity_at);
	END;

	CREATE TRIGGER IF NOT EXISTS trg_sessions_ad_fts AFTER DELETE ON sessions
	BEGIN
		DELETE FROM search_sessions_fts WHERE session_id = OLD.session_id;
		DELETE FROM search_events_fts WHERE session_id = OLD.session_id;
	END;

	${EVENTS_FTS_DDL}
`;
