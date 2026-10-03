import type { Database } from "bun:sqlite";
import { getSqlite } from "../../db/client.js";
import {
	EVENT_TEXT_COALESCE_SELECT,
	FTS_BOOTSTRAP_SQL,
	FTS_INDEXED_EVENT_TYPES_SQL_LIST,
} from "../../db/fts-ddl.js";
import { deriveOwnerKind } from "../session-dto.js";
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
		this.db = db ?? getSqlite();
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
		// Decision 20 (F74): keyed by rowid = events.id, a constrained lookup
		// instead of a full FTS5 table scan on the UNINDEXED event_id column.
		this.db.prepare("DELETE FROM search_events_fts WHERE rowid = ?").run(input.eventId);
		this.db
			.prepare(
				`INSERT INTO search_events_fts (rowid, event_id, session_id, event_type, text, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.eventId,
				input.eventId,
				input.sessionId,
				input.eventType,
				input.text,
				input.createdAt,
			);
	}

	async removeEvent(eventId: number): Promise<void> {
		this.db.prepare("DELETE FROM search_events_fts WHERE rowid = ?").run(eventId);
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
				`INSERT INTO search_events_fts (rowid, event_id, session_id, event_type, text, created_at)
				 SELECT
				   id,
				   id,
				   session_id,
				   event_type,
				   ${EVENT_TEXT_COALESCE_SELECT},
				   created_at
				 FROM events
				 WHERE event_type IN (${FTS_INDEXED_EVENT_TYPES_SQL_LIST})`,
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
		// phrase (doubling any embedded `"`), then join by the configured
		// operator. Default AND mirrors what a user typing in the search
		// box expects; OR is for programmatic callers (Ask resolver) that
		// hand us a full sentence where requiring every token narrows to
		// zero hits.
		const tokens = q
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean)
			.map((t) => `"${t.replace(/"/g, '""')}"`);
		if (tokens.length === 0) return { hits: [], total: 0, backend: this.name };
		const joiner = filters.mode === "or" ? " OR " : " ";
		const ftsQuery = tokens.join(joiner);

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
					s.owner_user_id AS owner_user_id,
					s.ingest_key_id AS ingest_key_id,
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
			// TODO(slice-h): add is_archived to the FTS virtual table schema and
			// the INSERT trigger, then replace the sessionStatus='archived' path
			// above with an AND s.is_archived = 1 predicate. Until then,
			// sessionStatus='archived' filters against status (a dead value post-Slice G)
			// and returns zero rows — see clarity-slice-h-archive-status-removal.md.
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
				owner_user_id: string | null;
				ingest_key_id: string | null;
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
					ownerUserId: row.owner_user_id,
					ownerKind: deriveOwnerKind({
						ownerUserId: row.owner_user_id,
						ingestKeyId: row.ingest_key_id,
					}),
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
