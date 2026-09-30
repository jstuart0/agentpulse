// AGEN-27: ILIKE queries are unchanged, but as of migration 0006 they are
// index-backed when pg_trgm is available (GIN trgm indexes on every column/
// expression these queries OR together — see drizzle/postgres/
// 0006_agen27_pg_trgm_search_index.sql for the index list and the reasoning
// against a single coalesced-text index). When pg_trgm can't be installed
// (some managed Postgres providers restrict CREATE EXTENSION), the migration
// degrades to a WARNING and these queries fall back to a sequential scan —
// still correct, just not index-accelerated. See CLAUDE.md's search backend
// note for the full writeup.
//
// percy AGEN-27 review (TB22 re-verify): searchEvents/searchSessions run
// with server-side prepared statements explicitly disabled (see
// executeUnprepared() below) — NOT wrapped in a MATERIALIZED CTE, which an
// earlier revision of this file used and TB22 removed. The CTE forced
// Postgres to fully materialize every WHERE-matching row before applying
// ORDER BY/LIMIT, which is correct for a *rare* term but catastrophic for a
// *common* one: a term matching 50% of a 1M-row table regressed 0.18ms ->
// 1.8s (10,000x+) and spilled ~50MB of temp per query, because early-LIMIT
// short-circuiting (walk the rows in the query's sort order, stop the
// instant 50 matches are found) never gets a chance to kick in when
// everything is materialized first. Disabling prepared statements instead
// keeps the planner looking at the real bound ILIKE pattern and the real
// session_id on every single execution (no prepared-statement plan ever
// gets cached and reused with stale, value-oblivious cost estimates), so
// rare terms use the trigram indexes and common terms benefit from
// early-LIMIT the same way an ad hoc, never-prepared query always would.

import { type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "../../db/client.js";
import { FTS_INDEXED_EVENT_TYPES } from "../../db/fts-ddl.js";
import type * as schema from "../../db/schema/index.js";
import { extractSnippet } from "./snippet.js";
import type { SearchBackend, SearchFilters, SearchHit, SearchResult } from "./types.js";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Postgres ILIKE search backend.
 *
 * This is a **direct-search** backend: there is no shadow index. All
 * `index*` and `remove*` methods are no-ops. `search()` executes
 * parameterized `ILIKE '%term%'` queries directly against the `sessions`
 * and `events` tables — optionally served from the pg_trgm GIN indexes
 * migration 0006 creates (see the file header above).
 *
 * Result score is a flat 1.0 — see the TODO below for the proposed
 * deterministic rank follow-up.
 *
 * Snippet generation extracts a 64-char window around the first match
 * and wraps it in `<mark>…</mark>` (matching SQLite FTS5 output so the
 * UI doesn't need backend-aware rendering).
 *
 * Security: every `%token%` value is passed as a parameterized binding via
 * the Drizzle `sql` template tag — never inlined into the SQL string.
 * User-supplied query text cannot break out of the parameterized binding.
 *
 * Implementation note: both queries are built with Drizzle's `sql` template
 * tag (for the composable, safely-bound filter-clause construction) but
 * executed via this class's own `executeUnprepared()`, not the shared
 * `executeRows()` helper (sql-helpers.ts) other backends use — see
 * `executeUnprepared()`'s own doc comment for why (percy AGEN-27 review,
 * TB22: server-side prepared statements must stay disabled for these two
 * queries specifically). Do NOT call `db.execute({ sql, params })` directly
 * — the postgres-js Drizzle adapter does not accept that shape and does not
 * return `{ rows: T[] }`; it accepts a Drizzle SQL template and returns T[]
 * directly.
 */

// TODO(postgres-search-rank): replace flat 1.0 score with a deterministic
// rank (position-of-first-match + count-of-matches + recency tiebreaker)
// so Ask-resolver ambiguity detection works correctly on multi-hit results.
// Filed in thoughts/postgres-followup-plans/postgres-search-rank-deterministic.md.

// Single source of truth is FTS_INDEXED_EVENT_TYPES (db/fts-ddl.ts) — the
// same list SQLite's FTS5 triggers index and migration 0006's partial GIN
// indexes restrict to. Previously duplicated locally here; AGEN-27 removed
// the duplicate so the two dialects cannot drift.
const SEARCHABLE_EVENT_TYPES = FTS_INDEXED_EVENT_TYPES;

// percy AGEN-27 review, Critical 1: event_type IN (...) must be rendered as
// literal SQL text, not bound parameters. postgres-js prepares statements by
// default; once Postgres's planner switches a repeatedly-executed prepared
// statement from a per-call "custom" plan to a cached "generic" one (its
// default heuristic, typically within the first ~5-10 executions), a
// *bound-parameter* IN list is opaque at plan time — the planner cannot
// prove the query's event_type predicate satisfies the six events trigram
// indexes' partial WHERE clause, so all six get silently dropped in favor
// of a sequential scan (measured: 617ms vs 1.17ms at 1M rows). A *literal*
// IN list is visible in the query text at plan time regardless of custom vs.
// generic planning, so the partial-index match is provable either way.
// SEARCHABLE_EVENT_TYPES is a hardcoded constant, never user input — the
// assertion below is a structural guarantee that stays true, not a runtime
// input-validation gate. The user's own query text remains a bound
// parameter throughout; only this fixed, compile-time-known list is
// rendered as literal text.
const EVENT_TYPE_LITERAL_RE = /^[A-Za-z]+$/;
for (const eventType of SEARCHABLE_EVENT_TYPES) {
	if (!EVENT_TYPE_LITERAL_RE.test(eventType)) {
		throw new Error(
			`SEARCHABLE_EVENT_TYPES contains a value unsafe to inline as literal SQL: ${JSON.stringify(eventType)}`,
		);
	}
}
const SEARCHABLE_EVENT_TYPES_SQL_LIST = SEARCHABLE_EVENT_TYPES.map((t) => `'${t}'`).join(",");

/** Row returned by the sessions ILIKE query. */
type SessionRow = {
	session_id: string;
	display_name: string | null;
	cwd: string | null;
	current_task: string | null;
	notes: string | null;
	agent_type: string;
	status: string;
	last_activity_at: string;
	[key: string]: unknown;
};

/** Row returned by the events ILIKE query. */
type EventRow = {
	id: number;
	session_id: string;
	event_type: string;
	created_at: string;
	// raw_payload is a Postgres `json` column (Decision 14); ->> extracts text.
	raw_payload_prompt: string | null;
	raw_payload_message: string | null;
	raw_payload_summary: string | null;
	raw_payload_why: string | null;
	raw_payload_title: string | null;
	content: string | null;
	session_display_name: string | null;
	session_cwd: string | null;
	[key: string]: unknown;
};

export class PostgresSearchBackend implements SearchBackend {
	readonly name = "postgres-ilike" as const;

	// Optional injected handle; falls back to the shared Drizzle singleton.
	// Mirrors the SqliteFtsBackend constructor pattern so tests can inject.
	private readonly _db: Db | null;

	constructor(db?: Db) {
		this._db = db ?? null;
	}

	private db(): Db {
		return this._db ?? (getDb() as unknown as Db);
	}

	/**
	 * Execute a Drizzle `SQL` template with server-side prepared statements
	 * disabled for this one call — see the file header (percy AGEN-27
	 * review, TB22) for why. `executeRows()` (sql-helpers.ts) can't do this:
	 * it always goes through Drizzle's own `db.execute()`, which builds a
	 * `PostgresJsPreparedQuery` and always calls `client.unsafe(query,
	 * params)` with no options — postgres-js's own default for that 2-arg
	 * form is `prepare: false` already, but relying on an unstated default
	 * is fragile; this makes the choice explicit and local to these two
	 * queries only. `db.$client` is postgres-js's own documented escape
	 * hatch for the underlying client (same instance the app's pool already
	 * uses — this does not open a second connection or bypass pooling), and
	 * `db.dialect.sqlToQuery()` is the same call Drizzle's own `db.execute()`
	 * uses internally to turn a `sql` template into `{ sql, params }`.
	 * Global client config (`createDatabase()`'s `prepare` option, unset —
	 * postgres-js's own global default) is untouched.
	 */
	private async executeUnprepared<T>(query: SQL): Promise<T[]> {
		const db = this.db() as unknown as {
			dialect: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } };
			$client: {
				unsafe: (text: string, params: unknown[], opts: { prepare: boolean }) => Promise<T[]>;
			};
		};
		const { sql: text, params } = db.dialect.sqlToQuery(query);
		return db.$client.unsafe(text, params, { prepare: false });
	}

	// ── no-op index methods (direct-search family) ────────────────────────────

	/** No-op. Direct-search backends do not maintain a shadow index. */
	async initialize(): Promise<void> {}

	/** No-op. Session text is queried live from `sessions`. */
	async indexSession(_input: {
		sessionId: string;
		displayName: string | null;
		cwd: string | null;
		currentTask: string | null;
		notes: string | null;
		agentType: string;
		status: string;
		lastActivityAt: string;
	}): Promise<void> {}

	/** No-op. Nothing to remove from a non-existent shadow index. */
	async removeSession(_sessionId: string): Promise<void> {}

	/** No-op. Event text is queried live from `events`. */
	async indexEvent(_input: {
		eventId: number;
		sessionId: string;
		eventType: string;
		text: string;
		createdAt: string;
	}): Promise<void> {}

	/** No-op. Nothing to remove from a non-existent shadow index. */
	async removeEvent(_eventId: number): Promise<void> {}

	/**
	 * No-op rebuild. Returns explicit zero counts with an explanatory note
	 * so callers can distinguish "nothing to rebuild" from "rebuild failed".
	 */
	async rebuild(): Promise<{ sessionsIndexed: number; eventsIndexed: number; note: string }> {
		return {
			sessionsIndexed: 0,
			eventsIndexed: 0,
			note: "Direct-search backend; no shadow index.",
		};
	}

	// ── search ────────────────────────────────────────────────────────────────

	async search(filters: SearchFilters): Promise<SearchResult> {
		const q = filters.q.trim();
		if (!q) return { hits: [], total: 0, backend: this.name };

		// Tokenize on whitespace; drop empty tokens. Each token becomes a
		// `%token%` ILIKE binding — never inlined into SQL.
		const tokens = q
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean);
		if (tokens.length === 0) return { hits: [], total: 0, backend: this.name };

		const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
		const offset = Math.max(0, filters.offset ?? 0);
		const kinds = filters.kinds ?? ["session", "event"];
		const mode = filters.mode ?? "and";

		const hits: SearchHit[] = [];
		let total = 0;

		// ── session search ──────────────────────────────────────────────────

		if (kinds.includes("session")) {
			const sessionHits = await this.searchSessions(tokens, mode, filters, limit, offset);
			hits.push(...sessionHits);
			total += sessionHits.length;
		}

		// ── event search ────────────────────────────────────────────────────

		if (kinds.includes("event")) {
			const eventHits = await this.searchEvents(tokens, mode, filters, limit, offset);
			hits.push(...eventHits);
			total += eventHits.length;
		}

		// Sort by score (all flat 1.0 today, so stable by insertion order
		// which is already created_at DESC from both queries), then cap.
		hits.sort((a, b) => b.score - a.score);

		return {
			hits: hits.slice(0, limit),
			total,
			backend: this.name,
		};
	}

	// ── private query helpers ─────────────────────────────────────────────────

	private async searchSessions(
		tokens: string[],
		mode: "and" | "or",
		filters: SearchFilters,
		limit: number,
		offset: number,
	): Promise<SearchHit[]> {
		// Build per-token ILIKE clauses using the Drizzle sql template tag.
		// Each token matches any of the four searchable session columns (OR).
		// The token clauses are then combined with AND (default) or OR (mode=or).
		//
		// Using sql template tag — values are bound parameters, never inlined.
		const tokenClauses: SQL[] = tokens.map((token) => {
			const likeVal = `%${token}%`;
			return sql`(display_name ILIKE ${likeVal} OR cwd ILIKE ${likeVal} OR current_task ILIKE ${likeVal} OR notes ILIKE ${likeVal})`;
		});

		const tokenWhere =
			mode === "or" ? sql.join(tokenClauses, sql` OR `) : sql.join(tokenClauses, sql` AND `);

		// Build optional filter clauses appended as AND conditions.
		const filterClauses: SQL[] = [sql`(${tokenWhere})`];

		if (filters.sessionId) {
			filterClauses.push(sql`session_id = ${filters.sessionId}`);
		}
		if (filters.agentType) {
			filterClauses.push(sql`agent_type = ${filters.agentType}`);
		}
		if (filters.sessionStatus) {
			filterClauses.push(sql`status = ${filters.sessionStatus}`);
		}
		if (filters.cwd) {
			filterClauses.push(sql`cwd ILIKE ${`%${filters.cwd}%`}`);
		}

		const whereClause = sql.join(filterClauses, sql` AND `);

		const query = sql<SessionRow>`
			SELECT
				session_id,
				display_name,
				cwd,
				current_task,
				notes,
				agent_type,
				status,
				last_activity_at
			FROM sessions
			WHERE ${whereClause}
			ORDER BY started_at DESC
			LIMIT ${limit} OFFSET ${offset}
		`;

		const rows = await this.executeUnprepared<SessionRow>(query);

		return rows.map((row) => ({
			kind: "session" as const,
			sessionId: row.session_id,
			eventId: null,
			eventType: null,
			snippet: this.buildSessionSnippet(row, tokens[0] ?? ""),
			score: 1.0,
			timestamp: row.last_activity_at,
			sessionDisplayName: row.display_name,
			sessionCwd: row.cwd,
		}));
	}

	private async searchEvents(
		tokens: string[],
		mode: "and" | "or",
		filters: SearchFilters,
		limit: number,
		offset: number,
	): Promise<SearchHit[]> {
		// For events, ILIKE across: content column and five raw_payload JSON fields.
		// raw_payload is Postgres `json` (Decision 14); ->> extracts text directly.
		//
		// Using sql template tag — values are bound parameters, never inlined.
		const tokenClauses: SQL[] = tokens.map((token) => {
			const likeVal = `%${token}%`;
			return sql`(e.content ILIKE ${likeVal} OR (e.raw_payload->>'prompt') ILIKE ${likeVal} OR (e.raw_payload->>'message') ILIKE ${likeVal} OR (e.raw_payload->>'summary') ILIKE ${likeVal} OR (e.raw_payload->>'why') ILIKE ${likeVal} OR (e.raw_payload->>'title') ILIKE ${likeVal})`;
		});

		const tokenWhere =
			mode === "or" ? sql.join(tokenClauses, sql` OR `) : sql.join(tokenClauses, sql` AND `);

		const filterClauses: SQL[] = [sql`(${tokenWhere})`];

		// Restrict to the same event types the FTS trigger indexed. Rendered
		// as literal SQL text (sql.raw), not bound params — see
		// SEARCHABLE_EVENT_TYPES_SQL_LIST's definition above for why a bound
		// IN list defeats the partial trigram indexes once Postgres switches
		// to a generic query plan.
		filterClauses.push(sql`e.event_type IN (${sql.raw(SEARCHABLE_EVENT_TYPES_SQL_LIST)})`);

		if (filters.sessionId) {
			filterClauses.push(sql`e.session_id = ${filters.sessionId}`);
		}
		if (filters.eventType) {
			filterClauses.push(sql`e.event_type = ${filters.eventType}`);
		}
		if (filters.since) {
			filterClauses.push(sql`e.created_at >= ${filters.since}`);
		}
		if (filters.until) {
			filterClauses.push(sql`e.created_at < ${filters.until}`);
		}
		if (filters.agentType) {
			filterClauses.push(sql`s.agent_type = ${filters.agentType}`);
		}
		if (filters.sessionStatus) {
			filterClauses.push(sql`s.status = ${filters.sessionStatus}`);
		}
		if (filters.cwd) {
			filterClauses.push(sql`s.cwd ILIKE ${`%${filters.cwd}%`}`);
		}

		const whereClause = sql.join(filterClauses, sql` AND `);

		const query = sql<EventRow>`
			SELECT
				e.id,
				e.session_id,
				e.event_type,
				e.created_at,
				e.raw_payload->>'prompt'   AS raw_payload_prompt,
				e.raw_payload->>'message'  AS raw_payload_message,
				e.raw_payload->>'summary'  AS raw_payload_summary,
				e.raw_payload->>'why'      AS raw_payload_why,
				e.raw_payload->>'title'    AS raw_payload_title,
				e.content,
				s.display_name             AS session_display_name,
				s.cwd                      AS session_cwd
			FROM events e
			JOIN sessions s ON s.session_id = e.session_id
			WHERE ${whereClause}
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT ${limit} OFFSET ${offset}
		`;

		const rows = await this.executeUnprepared<EventRow>(query);

		return rows.map((row) => {
			const text =
				row.raw_payload_prompt ??
				row.raw_payload_message ??
				row.raw_payload_summary ??
				row.raw_payload_why ??
				row.raw_payload_title ??
				row.content ??
				"";

			return {
				kind: "event" as const,
				sessionId: row.session_id,
				eventId: row.id,
				eventType: row.event_type,
				snippet: extractSnippet(text, tokens[0] ?? ""),
				score: 1.0,
				timestamp: row.created_at,
				sessionDisplayName: row.session_display_name,
				sessionCwd: row.session_cwd,
			};
		});
	}

	/** Build a snippet from whichever session field first matches the token. */
	private buildSessionSnippet(row: SessionRow, token: string): string {
		for (const field of [row.display_name, row.cwd, row.current_task, row.notes]) {
			if (field) {
				const s = extractSnippet(field, token);
				if (s) return s;
			}
		}
		return "";
	}
}
