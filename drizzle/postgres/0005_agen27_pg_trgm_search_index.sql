-- AGEN-27: trigram-indexed Postgres search.
--
-- Adds pg_trgm GIN indexes so PostgresSearchBackend's ILIKE '%term%' queries
-- (searchSessions / searchEvents in postgres-search-backend.ts) stop doing a
-- sequential scan of the whole `events` table on every search. No query text
-- changes: each index below targets exactly one leg of the existing
-- OR-across-columns WHERE clauses, so Postgres serves each leg from its own
-- GIN index and combines them via BitmapOr — identical match semantics to
-- today, just index-backed.
--
-- Why per-column indexes instead of one combined "searchable text" index:
-- events.content and the five raw_payload->>'x' extractions are USUALLY
-- mutually exclusive per event type (only one is non-null for a given row),
-- which would make a single COALESCE(...) expression behaviorally
-- equivalent — except for AiProposal/AiHitlRequest rows (runner.ts), where
-- `content` (the proposal/prompt text) and `raw_payload->>'why'` (the
-- decision rationale) can BOTH be non-null on the same row. COALESCE would
-- silently prefer `why` and make `content` unsearchable for those two event
-- types — a real regression the multi-column OR (and per-column indexes)
-- does not have. See CLAUDE.md's search backend note.
--
-- Events indexes are partial (WHERE event_type IN (...)), restricting
-- indexed rows to exactly the event types SQLite FTS5 indexes
-- (FTS_INDEXED_EVENT_TYPES in src/server/db/fts-ddl.ts) — same searchable
-- population on both dialects, smaller/faster-to-build indexes. If that
-- list changes, add a follow-up migration with matching partial predicates;
-- this migration's predicates are frozen at authoring time like any other
-- migration.
--
-- pg_trgm requires CREATE EXTENSION, which needs privileges some managed
-- Postgres providers restrict to superuser (or block outright). Both DO
-- blocks below catch every error from the extension/index attempt and fall
-- back to a NOTICE instead of raising — search keeps working on a
-- sequential scan (today's behavior) when pg_trgm can't be installed. This
-- graceful-degrade path is exercised by a live-PG test running as a
-- low-privilege role (see src/server/db/pg-trgm-search-index.test.ts).
--
-- drizzle-orm's postgres-js migrator runs every pending migration inside
-- ONE shared transaction (pg-core/dialect.js `migrate()`) — an uncaught
-- error here would roll back every other migration in the same boot, not
-- just this file. The EXCEPTION handlers make this file's failure mode a
-- caught NOTICE, never an uncaught error, so that shared transaction is
-- never at risk.
--
-- Large existing installs: building 10 GIN indexes takes a SHARE lock on
-- `sessions`/`events` for the duration of each build (same tradeoff as
-- migrations 0003/0004). Do the builds out-of-band with CREATE INDEX
-- CONCURRENTLY in a maintenance window first — see deploy/k8s/README.md's
-- "Upgrading to migration 0005" section for the exact statements and the
-- indisvalid verification query.
--> statement-breakpoint
DO $$
BEGIN
	BEGIN
		CREATE EXTENSION IF NOT EXISTS pg_trgm;
	EXCEPTION WHEN OTHERS THEN
		RAISE NOTICE 'AGEN-27: pg_trgm extension unavailable (%) — Postgres search continues on sequential scan (ILIKE), no trigram index built.', SQLERRM;
	END;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
		CREATE INDEX IF NOT EXISTS "idx_sessions_display_name_trgm" ON "sessions" USING gin ("display_name" gin_trgm_ops);
		CREATE INDEX IF NOT EXISTS "idx_sessions_cwd_trgm" ON "sessions" USING gin ("cwd" gin_trgm_ops);
		CREATE INDEX IF NOT EXISTS "idx_sessions_current_task_trgm" ON "sessions" USING gin ("current_task" gin_trgm_ops);
		CREATE INDEX IF NOT EXISTS "idx_sessions_notes_trgm" ON "sessions" USING gin ("notes" gin_trgm_ops);

		CREATE INDEX IF NOT EXISTS "idx_events_content_trgm" ON "events" USING gin ("content" gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
		CREATE INDEX IF NOT EXISTS "idx_events_prompt_trgm" ON "events" USING gin (("raw_payload"->>'prompt') gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
		CREATE INDEX IF NOT EXISTS "idx_events_message_trgm" ON "events" USING gin (("raw_payload"->>'message') gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
		CREATE INDEX IF NOT EXISTS "idx_events_summary_trgm" ON "events" USING gin (("raw_payload"->>'summary') gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
		CREATE INDEX IF NOT EXISTS "idx_events_why_trgm" ON "events" USING gin (("raw_payload"->>'why') gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
		CREATE INDEX IF NOT EXISTS "idx_events_title_trgm" ON "events" USING gin (("raw_payload"->>'title') gin_trgm_ops)
			WHERE "event_type" IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
	ELSE
		RAISE NOTICE 'AGEN-27: pg_trgm extension not installed — skipping trigram search indexes; Postgres search continues on sequential scan (ILIKE).';
	END IF;
END $$;
