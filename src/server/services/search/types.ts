/**
 * Pluggable search backend contract.
 *
 * AgentPulse currently runs on SQLite only (see the Postgres backend
 * plan at thoughts/2026-04-24-postgres-backend-plan.md). Once Postgres
 * lands, a `PostgresTsvectorBackend` will implement this same interface
 * so the search UI and routes stay unchanged.
 *
 * Each backend indexes two "kinds" of rows:
 *
 *   - `session` — denormalized session-level text (display name, cwd,
 *     current task, notes). One row per session.
 *   - `event` — per-event text (user prompts, assistant messages,
 *     AI reports, HITL proposals). One row per meaningful event.
 *
 * Indexing is append-only from the ingest path; updates to session
 * metadata cascade via triggers (SQLite) or an explicit upsert helper
 * the route layer calls (Postgres).
 */

export type SearchRowKind = "session" | "event";

export interface SearchFilters {
	/** Full-text query. Empty string returns no results. */
	q: string;
	/** Restrict to one session. Useful for per-session "find in page". */
	sessionId?: string;
	/** cwd substring — case-insensitive. Matches `LIKE '%…%'`. */
	cwd?: string;
	/** Filter by agent type. */
	agentType?: "claude_code" | "codex_cli";
	/** Filter by session status. */
	sessionStatus?: "active" | "idle" | "completed" | "archived";
	/** Restrict to one event type (PreToolUse, UserPromptSubmit, etc.). */
	eventType?: string;
	/** ISO-8601 timestamp lower bound (inclusive). */
	since?: string;
	/** ISO-8601 timestamp upper bound (exclusive). */
	until?: string;
	/** Which kinds to return. Defaults to both. */
	kinds?: SearchRowKind[];
	/** Max results. Default 50, hard max 200. */
	limit?: number;
	/** Skip N results. Default 0. */
	offset?: number;
	/**
	 * How multi-token queries combine. `and` (default) requires every
	 * token to appear — right for a user typing in the search box, where
	 * specificity narrows results. `or` requires any token — right for
	 * programmatic callers like the Ask resolver, where a full sentence
	 * would otherwise AND together into zero hits. Both modes still
	 * phrase-quote individual tokens to dodge FTS5's special chars.
	 */
	mode?: "and" | "or";
}

export interface SearchHit {
	kind: SearchRowKind;
	sessionId: string;
	/** For `kind: event`, the events.id (integer). Null for session hits. */
	eventId: number | null;
	/** Event type — null for session hits. */
	eventType: string | null;
	/** Short snippet of the matching content with query terms highlighted
	 *  via `<mark>` tags. UI sanitizes / styles as needed. */
	snippet: string;
	/** BM25 rank (lower is better in SQLite FTS5; backends normalize to a
	 *  0..1 score where 1 is best so the UI doesn't need backend knowledge). */
	score: number;
	/** ISO-8601 — event timestamp for event hits, lastActivityAt for sessions. */
	timestamp: string;
	/** Denormalized session display name for result cards. */
	sessionDisplayName: string | null;
	/** Denormalized session cwd. */
	sessionCwd: string | null;
}

export interface SearchResult {
	hits: SearchHit[];
	total: number;
	/** Backend identifier for telemetry / debugging. */
	backend: "sqlite-fts5" | "postgres-tsvector";
}

export interface SearchBackend {
	readonly name: "sqlite-fts5" | "postgres-tsvector";

	/** Called at boot — create virtual tables / triggers / tsvector columns. Idempotent. */
	initialize(): Promise<void>;

	/** Index (or re-index) a session row. Called on session create / update. */
	indexSession(input: {
		sessionId: string;
		displayName: string | null;
		cwd: string | null;
		currentTask: string | null;
		notes: string | null;
		agentType: string;
		status: string;
		lastActivityAt: string;
	}): Promise<void>;

	/** Remove a session's rows from the index (cascades to its events). */
	removeSession(sessionId: string): Promise<void>;

	/** Index an event. Called from the event processor on ingest. */
	indexEvent(input: {
		eventId: number;
		sessionId: string;
		eventType: string;
		text: string;
		createdAt: string;
	}): Promise<void>;

	/** Remove a single event from the index. */
	removeEvent(eventId: number): Promise<void>;

	/** Backfill — used by the admin "rebuild search index" action. */
	rebuild(): Promise<{ sessionsIndexed: number; eventsIndexed: number }>;

	/** Execute a query against the index. */
	search(filters: SearchFilters): Promise<SearchResult>;
}

/** Throw from any unimplemented backend method so dev-time errors are loud. */
export class SearchBackendUnavailableError extends Error {
	constructor(feature: string) {
		super(`Search feature '${feature}' is not implemented by this backend.`);
		this.name = "SearchBackendUnavailableError";
	}
}
