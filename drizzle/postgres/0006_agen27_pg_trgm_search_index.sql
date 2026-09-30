-- AGEN-27: trigram-indexed Postgres search.
--
-- Adds pg_trgm GIN indexes so PostgresSearchBackend's ILIKE '%term%' queries
-- (searchSessions / searchEvents in postgres-search-backend.ts) stop doing a
-- sequential scan of the whole `events` table on every search. No query text
-- changes: each index below targets exactly one leg of the existing
-- OR-across-columns WHERE clauses, so Postgres serves each leg from its own
-- GIN index and combines them via BitmapOr — identical match semantics to
-- today, just index-backed. (The event_type IN (...) restriction itself is
-- rendered as literal SQL text in postgres-search-backend.ts, not a bound
-- parameter — see that file's SEARCHABLE_EVENT_TYPES_SQL_LIST comment for
-- why a bound IN list defeats these same indexes once Postgres's planner
-- switches to a generic plan; percy AGEN-27 review, Critical 1.)
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
-- Postgres providers restrict to superuser (or block outright). The
-- extension-install DO block below catches every error from that attempt
-- and falls back to a WARNING instead of raising — search keeps working on
-- a sequential scan (today's behavior) when pg_trgm can't be installed.
--
-- The index-build DO block (percy AGEN-27 review, Critical 2) is likewise
-- wrapped in its own BEGIN...EXCEPTION WHEN OTHERS block: a transient
-- failure partway through the 10 CREATE INDEX statements (disk full, lock
-- timeout, OOM, whatever) degrades to a WARNING instead of propagating an
-- uncaught error. PL/pgSQL implements EXCEPTION via an implicit SAVEPOINT
-- taken at BEGIN — a failure rolls back to it, undoing every CREATE INDEX
-- already run in *that same attempt*, not just the one that failed (IF NOT
-- EXISTS makes a retry on the next boot idempotent regardless). This
-- graceful-degrade path is exercised by a live-PG test running as a
-- low-privilege role, and separately by a test injecting a build failure
-- (see src/server/db/pg-trgm-search-index.test.ts).
--
-- drizzle-orm's postgres-js migrator runs every pending migration inside
-- ONE shared transaction (pg-core/dialect.js `migrate()`) — an uncaught
-- error here would roll back every other migration in the same boot and
-- crash-loop it (the failing migration is never recorded as applied, so
-- the next boot retries the same failure), not just fail this one file.
-- Both DO blocks' EXCEPTION handlers make every failure mode here a caught
-- WARNING, never an uncaught error, so that shared transaction — and boot
-- itself — is never at risk.
--
-- Large existing installs (percy AGEN-27 review, High 3): building 10 GIN
-- indexes takes a SHARE lock on `sessions`/`events` for the duration of
-- each build — measured ~22s at 1,000,000 events, blocking ingest for that
-- whole window. The index-build DO block runs `EXECUTE 'ANALYZE events'`
-- first (percy re-verify, TB22 Critical: a never-analyzed table — e.g. a
-- restored backup, or a lagging autovacuum — reports pg_class.reltuples =
-- -1, a sentinel meaning "unknown," NOT zero; checking the threshold
-- without analyzing first would silently skip the size guard entirely and
-- let the ~22s lock through uncontested), then checks pg_class.reltuples
-- for `events`: above 100,000 (an ANALYZE-maintained estimate, not exact,
-- which is fine for a threshold this coarse) it SKIPS the automatic build
-- entirely and RAISEs a WARNING pointing at the CREATE INDEX CONCURRENTLY
-- recipe instead; NULL or still negative after the ANALYZE (shouldn't
-- happen, but the table might not exist, or stats might not have
-- propagated for some other reason) is treated the same way — unknown row
-- count fails safe to "skip and warn," never "assume small and build." A
-- fresh install's `events` table reports reltuples = 0 once analyzed (an
-- empty table is a known, not unknown, row count) and always gets the
-- automatic build. Do the CONCURRENTLY builds out-of-band, in a
-- maintenance window, for any install that skips — see
-- deploy/k8s/README.md's "Upgrading to migration 0006" section for the
-- exact statements, the indisvalid verification query, and the index-size
-- note (roughly 55-112% of the events heap size, per percy's
-- measurements).
--> statement-breakpoint
DO $$
BEGIN
	BEGIN
		CREATE EXTENSION IF NOT EXISTS pg_trgm;
	EXCEPTION WHEN OTHERS THEN
		RAISE WARNING 'AGEN-27: pg_trgm extension unavailable (%) — Postgres search continues on sequential scan (ILIKE), no trigram index built.', SQLERRM;
	END;
END $$;
--> statement-breakpoint
DO $$
DECLARE
	events_reltuples real;
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
		-- A never-analyzed table reports reltuples = -1 ("unknown"), not 0 —
		-- analyze first so the threshold check below sees a real estimate.
		EXECUTE 'ANALYZE events';
		SELECT reltuples INTO events_reltuples FROM pg_class WHERE oid = to_regclass('events');

		IF events_reltuples IS NULL OR events_reltuples < 0 THEN
			RAISE WARNING 'AGEN-27: events row count is unknown (reltuples=%) even after ANALYZE — skipping the automatic trigram index build as a precaution against an unbounded SHARE-lock window over sessions/events during boot. Build the indexes out-of-band with CREATE INDEX CONCURRENTLY instead — see deploy/k8s/README.md''s "Upgrading to migration 0006" section for the exact statements.', events_reltuples;
		ELSIF events_reltuples > 100000 THEN
			RAISE WARNING 'AGEN-27: events has ~% estimated rows (over the 100,000-row automatic-build threshold) — skipping the automatic trigram index build to avoid a ~SHARE-lock window over sessions/events during boot. Build the indexes out-of-band with CREATE INDEX CONCURRENTLY instead — see deploy/k8s/README.md''s "Upgrading to migration 0006" section for the exact statements.', events_reltuples;
		ELSE
			BEGIN
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
			EXCEPTION WHEN OTHERS THEN
				RAISE WARNING 'AGEN-27: trigram index build failed (%) — Postgres search continues on sequential scan (ILIKE) for any index that did not complete; re-run the CREATE INDEX statements in deploy/k8s/README.md''s "Upgrading to migration 0006" section once the underlying issue is resolved (IF NOT EXISTS makes this idempotent).', SQLERRM;
			END;
		END IF;
	ELSE
		RAISE WARNING 'AGEN-27: pg_trgm extension not installed — skipping trigram search indexes; Postgres search continues on sequential scan (ILIKE).';
	END IF;
END $$;
