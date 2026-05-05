// TODO(postgres-search-perf): replace ILIKE with tsvector + pg_trgm in a
// follow-up campaign for sub-100ms search at >100k events. The ILIKE path
// performs full table scans (~50–200ms on typical AgentPulse instances with
// 10k sessions / 100k events), which is functional but not production-grade
// at high scale.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "../../db/client.js";
import type * as schema from "../../db/schema.js";
import { extractSnippet } from "./snippet.js";
import type { SearchBackend, SearchFilters, SearchHit, SearchResult } from "./types.js";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * Postgres ILIKE search backend.
 *
 * This is a **direct-search** backend: there is no shadow index. All
 * `index*` and `remove*` methods are no-ops. `search()` executes
 * parameterized `ILIKE '%term%'` queries directly against the `sessions`
 * and `events` tables.
 *
 * Result score is a flat 1.0 — see the TODO below for the proposed
 * deterministic rank follow-up.
 *
 * Snippet generation extracts a 64-char window around the first match
 * and wraps it in `<mark>…</mark>` (matching SQLite FTS5 output so the
 * UI doesn't need backend-aware rendering).
 *
 * Security: every `%token%` value is passed as a parameterized binding,
 * never inlined into the SQL string. User-supplied query text cannot break
 * out of the parameterized binding.
 */

// TODO(postgres-search-rank): replace flat 1.0 score with a deterministic
// rank (position-of-first-match + count-of-matches + recency tiebreaker)
// so Ask-resolver ambiguity detection works correctly on multi-hit results.
// Filed in thoughts/postgres-followup-plans/postgres-search-rank-deterministic.md.

const SEARCHABLE_EVENT_TYPES = [
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

/** Row returned by the sessions ILIKE query. */
interface SessionRow {
	session_id: string;
	display_name: string | null;
	cwd: string | null;
	current_task: string | null;
	notes: string | null;
	agent_type: string;
	status: string;
	last_activity_at: string;
}

/** Row returned by the events ILIKE query. */
interface EventRow {
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
}

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
		// Build per-token ILIKE clause groups.
		// Each token: (display_name ILIKE $n OR cwd ILIKE $n OR current_task ILIKE $n OR notes ILIKE $n)
		// Tokens combined with AND (default) or OR.
		const bindings: unknown[] = [];
		const tokenClauses: string[] = [];

		for (const token of tokens) {
			const likeVal = `%${token}%`;
			const b = bindings.length + 1;
			bindings.push(likeVal);
			tokenClauses.push(
				`(display_name ILIKE $${b} OR cwd ILIKE $${b} OR current_task ILIKE $${b} OR notes ILIKE $${b})`,
			);
		}

		const tokenJoiner = mode === "or" ? " OR " : " AND ";
		let whereClause = `(${tokenClauses.join(tokenJoiner)})`;

		if (filters.sessionId) {
			bindings.push(filters.sessionId);
			whereClause += ` AND session_id = $${bindings.length}`;
		}
		if (filters.agentType) {
			bindings.push(filters.agentType);
			whereClause += ` AND agent_type = $${bindings.length}`;
		}
		if (filters.sessionStatus) {
			bindings.push(filters.sessionStatus);
			whereClause += ` AND status = $${bindings.length}`;
		}
		if (filters.cwd) {
			bindings.push(`%${filters.cwd}%`);
			whereClause += ` AND cwd ILIKE $${bindings.length}`;
		}

		bindings.push(limit, offset);
		const sql = `
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
			ORDER BY created_at DESC
			LIMIT $${bindings.length - 1} OFFSET $${bindings.length}
		`;

		const db = this.db();
		const rows = (
			await (
				db as unknown as {
					execute: (q: { sql: string; params: unknown[] }) => Promise<{ rows: SessionRow[] }>;
				}
			).execute({ sql, params: bindings })
		).rows as SessionRow[];

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
		const bindings: unknown[] = [];
		const tokenClauses: string[] = [];

		for (const token of tokens) {
			const likeVal = `%${token}%`;
			const b = bindings.length + 1;
			bindings.push(likeVal);
			tokenClauses.push(
				`(e.content ILIKE $${b}` +
					` OR (e.raw_payload->>'prompt') ILIKE $${b}` +
					` OR (e.raw_payload->>'message') ILIKE $${b}` +
					` OR (e.raw_payload->>'summary') ILIKE $${b}` +
					` OR (e.raw_payload->>'why') ILIKE $${b}` +
					` OR (e.raw_payload->>'title') ILIKE $${b})`,
			);
		}

		const tokenJoiner = mode === "or" ? " OR " : " AND ";
		let whereClause = `(${tokenClauses.join(tokenJoiner)})`;

		// Restrict to the same event types the FTS trigger indexed.
		const eventTypePlaceholders = SEARCHABLE_EVENT_TYPES.map(
			(_, i) => `$${bindings.length + i + 1}`,
		).join(",");
		for (const t of SEARCHABLE_EVENT_TYPES) bindings.push(t);
		whereClause += ` AND e.event_type IN (${eventTypePlaceholders})`;

		if (filters.sessionId) {
			bindings.push(filters.sessionId);
			whereClause += ` AND e.session_id = $${bindings.length}`;
		}
		if (filters.eventType) {
			bindings.push(filters.eventType);
			whereClause += ` AND e.event_type = $${bindings.length}`;
		}
		if (filters.since) {
			bindings.push(filters.since);
			whereClause += ` AND e.created_at >= $${bindings.length}`;
		}
		if (filters.until) {
			bindings.push(filters.until);
			whereClause += ` AND e.created_at < $${bindings.length}`;
		}
		if (filters.agentType) {
			bindings.push(filters.agentType);
			whereClause += ` AND s.agent_type = $${bindings.length}`;
		}
		if (filters.sessionStatus) {
			bindings.push(filters.sessionStatus);
			whereClause += ` AND s.status = $${bindings.length}`;
		}
		if (filters.cwd) {
			bindings.push(`%${filters.cwd}%`);
			whereClause += ` AND s.cwd ILIKE $${bindings.length}`;
		}

		bindings.push(limit, offset);
		const sql = `
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
			ORDER BY e.created_at DESC
			LIMIT $${bindings.length - 1} OFFSET $${bindings.length}
		`;

		const db = this.db();
		const rows = (
			await (
				db as unknown as {
					execute: (q: { sql: string; params: unknown[] }) => Promise<{ rows: EventRow[] }>;
				}
			).execute({ sql, params: bindings })
		).rows as EventRow[];

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
