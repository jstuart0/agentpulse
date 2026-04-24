import type { Database } from "bun:sqlite";
import { sqlite as sharedSqlite } from "../../db/client.js";
import type { SearchBackend, SearchFilters, SearchHit, SearchResult } from "./types.js";

/**
 * SQLite FTS5 search backend.
 *
 * Maintains two virtual tables:
 *   - `search_sessions_fts`: session-level text (displayName, cwd, currentTask, notes)
 *   - `search_events_fts`: per-event text (prompts, messages, reports, proposals)
 *
 * Both use BM25 ranking by default. The snippet() function produces
 * 64-char windows around the matching term with `<mark>…</mark>` tags
 * we render as highlights in the UI (the UI strips tags and wraps in a
 * styled span; we don't trust bare HTML from the DB).
 *
 * Indexing is driven two ways:
 *   1. At boot (`initialize`) we ensure the virtual tables exist AND
 *      install triggers on `sessions` + `events` that keep the indexes
 *      in sync automatically going forward.
 *   2. For back-population of rows that existed before triggers were
 *      installed, `rebuild()` does a one-shot full re-index.
 *
 * All writes happen through raw sqlite.exec because FTS5 virtual tables
 * don't work through Drizzle (Drizzle's schema inference doesn't
 * understand virtual tables). The interface is backend-agnostic so
 * when the Postgres backend lands (see Postgres backend plan) callers
 * won't change.
 */

const FTS_BOOTSTRAP_SQL = `
	-- Session-level index. content='' makes this a "contentless" table —
	-- we push rows in explicitly via triggers below rather than mirroring
	-- the whole sessions table (which would double storage).
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

	-- Per-event index. We store the event id + a normalized 'text' column
	-- that the ingest path extracts from raw_payload / content for each
	-- event type (UserPromptSubmit, AssistantMessage, AiReport, …).
	CREATE VIRTUAL TABLE IF NOT EXISTS search_events_fts USING fts5(
		event_id UNINDEXED,
		session_id UNINDEXED,
		event_type UNINDEXED,
		text,
		created_at UNINDEXED,
		tokenize = 'porter unicode61 remove_diacritics 1'
	);

	-- Keep-in-sync triggers on sessions. We re-insert on update because
	-- FTS5 doesn't have a clean partial-update path for changed columns.
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

	-- Event insert trigger — extracts searchable text from raw_payload.
	-- We search: UserPromptSubmit prompt, AssistantMessage content,
	-- Stop.summary, TaskCreated/TaskCompleted titles, AiReport summary,
	-- AiProposal.why+nextPrompt, AiHitlRequest.why. Other event types
	-- get their 'content' column (already a normalized summary).
	-- The COALESCE chain prefers explicit extracted fields, falls back
	-- to the 'content' column, and finally to a JSON blob string.
	CREATE TRIGGER IF NOT EXISTS trg_events_ai_fts AFTER INSERT ON events
	WHEN NEW.event_type IN (
		'UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted',
		'SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest'
	)
	BEGIN
		INSERT INTO search_events_fts(event_id, session_id, event_type, text, created_at)
		VALUES (
			NEW.id,
			NEW.session_id,
			NEW.event_type,
			COALESCE(
				json_extract(NEW.raw_payload, '$.prompt'),
				json_extract(NEW.raw_payload, '$.message'),
				json_extract(NEW.raw_payload, '$.summary'),
				json_extract(NEW.raw_payload, '$.why'),
				json_extract(NEW.raw_payload, '$.title'),
				NEW.content,
				''
			),
			NEW.created_at
		);
	END;

	CREATE TRIGGER IF NOT EXISTS trg_events_ad_fts AFTER DELETE ON events
	BEGIN
		DELETE FROM search_events_fts WHERE event_id = OLD.id;
	END;
`;

/**
 * Convert SQLite FTS5's BM25 score (lower = better, unbounded) into a
 * 0..1 normalized score the UI can treat backend-agnostically. We use a
 * simple monotonic transform — FTS5's raw score is typically -0.1 (best)
 * to -10 (worst) for realistic queries, so `1 / (1 + -score)` maps that
 * into roughly 0.1..1 with ordering preserved.
 */
function normalizeBm25(rank: number): number {
	return 1 / (1 + Math.max(0, -rank));
}

export class SqliteFtsBackend implements SearchBackend {
	readonly name = "sqlite-fts5" as const;
	private readonly db: Database;

	constructor(db?: Database) {
		// Share the drizzle-owned connection by default. Opening a second
		// connection to the same WAL file works but causes intermittent
		// SQLITE_BUSY / snapshot-misses under concurrent writes; reusing
		// the primary connection eliminates the race entirely. Tests
		// pass their own in-memory/file-backed Database explicitly.
		this.db = db ?? sharedSqlite;
	}

	async initialize(): Promise<void> {
		this.db.exec(FTS_BOOTSTRAP_SQL);
	}

	async indexSession(input: {
		sessionId: string;
		displayName: string | null;
		cwd: string | null;
		currentTask: string | null;
		notes: string | null;
		agentType: string;
		status: string;
		lastActivityAt: string;
	}): Promise<void> {
		this.db.prepare("DELETE FROM search_sessions_fts WHERE session_id = ?").run(input.sessionId);
		this.db
			.prepare(
				`INSERT INTO search_sessions_fts (session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.sessionId,
				input.displayName ?? "",
				input.cwd ?? "",
				input.currentTask ?? "",
				input.notes ?? "",
				input.agentType,
				input.status,
				input.lastActivityAt,
			);
	}

	async removeSession(sessionId: string): Promise<void> {
		this.db.prepare("DELETE FROM search_sessions_fts WHERE session_id = ?").run(sessionId);
		this.db.prepare("DELETE FROM search_events_fts WHERE session_id = ?").run(sessionId);
	}

	async indexEvent(input: {
		eventId: number;
		sessionId: string;
		eventType: string;
		text: string;
		createdAt: string;
	}): Promise<void> {
		this.db.prepare("DELETE FROM search_events_fts WHERE event_id = ?").run(input.eventId);
		this.db
			.prepare(
				`INSERT INTO search_events_fts (event_id, session_id, event_type, text, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(input.eventId, input.sessionId, input.eventType, input.text, input.createdAt);
	}

	async removeEvent(eventId: number): Promise<void> {
		this.db.prepare("DELETE FROM search_events_fts WHERE event_id = ?").run(eventId);
	}

	async rebuild(): Promise<{ sessionsIndexed: number; eventsIndexed: number }> {
		this.db.exec("DELETE FROM search_sessions_fts");
		this.db.exec("DELETE FROM search_events_fts");

		const sessionsRes = this.db
			.prepare(
				`INSERT INTO search_sessions_fts (session_id, display_name, cwd, current_task, notes, agent_type, status, last_activity_at)
				 SELECT session_id, COALESCE(display_name,''), COALESCE(cwd,''), COALESCE(current_task,''), COALESCE(notes,''), agent_type, status, last_activity_at
				 FROM sessions`,
			)
			.run();

		const eventsRes = this.db
			.prepare(
				`INSERT INTO search_events_fts (event_id, session_id, event_type, text, created_at)
				 SELECT
				   id,
				   session_id,
				   event_type,
				   COALESCE(
				     json_extract(raw_payload, '$.prompt'),
				     json_extract(raw_payload, '$.message'),
				     json_extract(raw_payload, '$.summary'),
				     json_extract(raw_payload, '$.why'),
				     json_extract(raw_payload, '$.title'),
				     content,
				     ''
				   ),
				   created_at
				 FROM events
				 WHERE event_type IN (
				   'UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted',
				   'SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest'
				 )`,
			)
			.run();

		return {
			sessionsIndexed: Number(sessionsRes.changes ?? 0),
			eventsIndexed: Number(eventsRes.changes ?? 0),
		};
	}

	async search(filters: SearchFilters): Promise<SearchResult> {
		const q = filters.q.trim();
		if (!q) return { hits: [], total: 0, backend: this.name };

		const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
		const offset = Math.max(0, filters.offset ?? 0);
		const kinds = filters.kinds ?? ["session", "event"];

		// Build the FTS5 MATCH expression defensively. FTS5's query language
		// reserves a handful of special characters (`-`, `+`, `*`, `^`, `:`,
		// `(`, `)`, `"`, `AND`/`OR`/`NOT` at the top level) and a raw user
		// query like `pre-index` or `auth:refactor` would otherwise be parsed
		// as a column filter or a NOT clause, throwing `no such column: …`.
		// Strategy: split on whitespace, wrap each token as a double-quoted
		// phrase (doubling any embedded `"`), then AND them together. Users
		// who want OR semantics can issue multiple searches.
		const tokens = q
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => `"${t.replace(/"/g, '""')}"`);
		if (tokens.length === 0) return { hits: [], total: 0, backend: this.name };
		const ftsQuery = tokens.join(" ");

		const hits: SearchHit[] = [];
		let total = 0;

		if (kinds.includes("event")) {
			const eventSql = `
				SELECT
					f.event_id,
					f.session_id,
					f.event_type,
					f.created_at,
					s.display_name AS session_display_name,
					s.cwd AS session_cwd,
					snippet(search_events_fts, 3, '<mark>', '</mark>', '…', 32) AS snippet,
					rank
				FROM search_events_fts f
				JOIN sessions s ON s.session_id = f.session_id
				WHERE search_events_fts MATCH ?
				  ${filters.sessionId ? "AND f.session_id = ?" : ""}
				  ${filters.eventType ? "AND f.event_type = ?" : ""}
				  ${filters.since ? "AND f.created_at >= ?" : ""}
				  ${filters.until ? "AND f.created_at < ?" : ""}
				  ${filters.agentType ? "AND s.agent_type = ?" : ""}
				  ${filters.sessionStatus ? "AND s.status = ?" : ""}
				  ${filters.cwd ? "AND s.cwd LIKE ?" : ""}
				ORDER BY rank
				LIMIT ? OFFSET ?
			`;
			const bindings: unknown[] = [ftsQuery];
			if (filters.sessionId) bindings.push(filters.sessionId);
			if (filters.eventType) bindings.push(filters.eventType);
			if (filters.since) bindings.push(filters.since);
			if (filters.until) bindings.push(filters.until);
			if (filters.agentType) bindings.push(filters.agentType);
			if (filters.sessionStatus) bindings.push(filters.sessionStatus);
			if (filters.cwd) bindings.push(`%${filters.cwd}%`);
			bindings.push(limit, offset);

			const rows = this.db.prepare(eventSql).all(...(bindings as [])) as Array<{
				event_id: number;
				session_id: string;
				event_type: string;
				created_at: string;
				session_display_name: string | null;
				session_cwd: string | null;
				snippet: string;
				rank: number;
			}>;

			for (const row of rows) {
				hits.push({
					kind: "event",
					sessionId: row.session_id,
					eventId: row.event_id,
					eventType: row.event_type,
					snippet: row.snippet,
					score: normalizeBm25(row.rank),
					timestamp: row.created_at,
					sessionDisplayName: row.session_display_name,
					sessionCwd: row.session_cwd,
				});
			}
			total += rows.length;
		}

		if (kinds.includes("session")) {
			const sessionSql = `
				SELECT
					f.session_id,
					f.last_activity_at,
					s.display_name AS session_display_name,
					s.cwd AS session_cwd,
					snippet(search_sessions_fts, -1, '<mark>', '</mark>', '…', 32) AS snippet,
					rank
				FROM search_sessions_fts f
				JOIN sessions s ON s.session_id = f.session_id
				WHERE search_sessions_fts MATCH ?
				  ${filters.sessionId ? "AND f.session_id = ?" : ""}
				  ${filters.agentType ? "AND f.agent_type = ?" : ""}
				  ${filters.sessionStatus ? "AND f.status = ?" : ""}
				  ${filters.cwd ? "AND f.cwd LIKE ?" : ""}
				ORDER BY rank
				LIMIT ? OFFSET ?
			`;
			const bindings: unknown[] = [ftsQuery];
			if (filters.sessionId) bindings.push(filters.sessionId);
			if (filters.agentType) bindings.push(filters.agentType);
			if (filters.sessionStatus) bindings.push(filters.sessionStatus);
			if (filters.cwd) bindings.push(`%${filters.cwd}%`);
			bindings.push(limit, offset);

			const rows = this.db.prepare(sessionSql).all(...(bindings as [])) as Array<{
				session_id: string;
				last_activity_at: string;
				session_display_name: string | null;
				session_cwd: string | null;
				snippet: string;
				rank: number;
			}>;

			for (const row of rows) {
				hits.push({
					kind: "session",
					sessionId: row.session_id,
					eventId: null,
					eventType: null,
					snippet: row.snippet,
					score: normalizeBm25(row.rank),
					timestamp: row.last_activity_at,
					sessionDisplayName: row.session_display_name,
					sessionCwd: row.session_cwd,
				});
			}
			total += rows.length;
		}

		// Merge + re-sort by score. Cap at the overall limit after merge.
		hits.sort((a, b) => b.score - a.score);
		return {
			hits: hits.slice(0, limit),
			total,
			backend: this.name,
		};
	}
}
