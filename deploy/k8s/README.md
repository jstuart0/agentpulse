# AgentPulse — Kubernetes manifests

## Manifest index

| File | Purpose |
|------|---------|
| `00-namespace.yaml` | `agentpulse` namespace |
| `01-secret-template.yaml` | Secret shape reference (no real values) |
| `02-configmap.yaml` | Non-sensitive config (PORT, PUBLIC_URL placeholder) |
| `03-pvc.yaml` | Persistent volume claim for SQLite data |
| `04-deployment.yaml` | Main deployment (non-root, read-only FS, probes) |
| `05-service.yaml` | ClusterIP service |
| `06-middleware.yaml` | Traefik middlewares (strip, forwardAuth, inject-verify, HTTPS redirect, rate limit) |
| `07-ingressroute.yaml` | Traefik IngressRoute (HTTPS + HTTP→HTTPS redirect) |
| `08-limitrange.yaml` | Namespace LimitRange (default container resource envelope) |
| `09-resourcequota.yaml` | Namespace ResourceQuota (cluster guardrails) |
| `10-networkpolicy.yaml` | NetworkPolicy (ingress restricted to Traefik namespace) |
| `11-serviceaccount.yaml` | ServiceAccount with no auto-mounted token |
| `12-backup-pvc.yaml` | Backup output PVC (NFS-backed, RWX, 100Gi) |

`PUBLIC_URL` (in `02-configmap.yaml`) is load-bearing: `/setup-relay.sh` takes the server address it installs from it, and answers 503 without it. Relay keys need the Hook ingest + Observe scopes.

## Storage stance and backup architecture (C3)

**SQLite stays on local block storage.** WAL mode (enabled via `PRAGMA journal_mode = WAL`) requires
shared-memory semantics that break on network filesystems (NFS, network-mounted Ceph, etc.). Relocating
the live `agentpulse.db` to an NFS-backed PVC causes silent corruption. See:
https://www.sqlite.org/wal.html#noshm

**Do NOT change `agentpulse-data` to an NFS-backed storage class.** The live DB must remain on a
local block storage class (e.g. `local-path`).

**Durability via backup sidecar.** The `agentpulse` pod includes a `backup-sidecar` container that:
- Wakes at 04:15 UTC daily and calls `sqlite3 /data/agentpulse.db "VACUUM INTO '/backups/agentpulse-<TS>.db.tmp'"`, then verifies with `PRAGMA integrity_check` before an atomic rename to the final name (AGEN-54).
- `VACUUM INTO` is a read-only, concurrent-safe snapshot — the app keeps writing during the backup — and completes in one bounded pass, unlike the earlier `.backup`-based approach which could livelock under sustained write load.
- Output lands on the `agentpulse-backups` PVC, which IS NFS-backed (only backup files, never the live DB).
- Applies retention (30 daily + 12 monthly survivors) after each successful backup.
- Failures surface in `kubectl logs deploy/agentpulse -c backup-sidecar`.

**Postgres is available now.** As of v0.4.0, AgentPulse supports a full PostgreSQL backend.
See the Postgres overlay section below and `deploy/overlays/postgres/README.md` for the
deployment runbook. The backup sidecar is a Medium-severity mitigation for single-instance
SQLite deployments; it is removed automatically by the Postgres overlay.

**Restore runbook**: see `deploy/k8s/BACKUP-RESTORE.md`.

---

## Data volume sizing

AGEN-16 changed event storage to keep every distinct tool call instead of
silently dropping most of them under the old content-window dedup — growth
is real and higher than a pre-AGEN-16 install would suggest. After the
growth mitigations in this release (raw `tool_response` capped at 4,096
chars in `rawPayload`, `tool_input` no longer duplicated into `rawPayload`),
a 30-day replay of a real workload measured:

- ~840 MB / 30 days on SQLite
- 28 MB/day average, up to ~137 MB/day at peak
- a storage class that **enforces** the PVC's `storage` request fills in
  roughly **37 days** at that rate

`storageClassName: local-path` (the default in `03-pvc.yaml`) does **not**
enforce the request — it's bound by node disk instead, so it won't reject
writes at 1Gi. On a storage class that does enforce size, raise the request
before deploying, or configure retention (below). A PVC default-size policy
is still a follow-up (not yet implemented).

### Event retention (AGEN-24)

`eventsRetentionDays` (Settings → Session Configuration → Event Retention,
or `PUT /api/v1/settings {"key":"eventsRetentionDays","value":<days>}`) is
**disabled by default** — unset, `0`, or negative all mean "never delete."
Set it to a positive integer to enable a background pass (every
`AGENTPULSE_RETENTION_INTERVAL_MS`, default 1 hour, clamped to [60s, 24h] —
an out-of-range or non-integer value falls back to the 1-hour default with
a warning) that deletes `events` rows older than that many days, in
batches of 1,000 (percy TB10 review: 5,000-row batches held the event loop
148–202ms each on SQLite), without blocking ingest. The `sessions` row and
its denormalized state are never touched — only the `events` history ages
out. `GET /api/v1/health`'s `retention` field reports the last pass
(`rowsDeleted`, `durationMs`, `disabled`) and, separately, `lastSkip` when
a pass was skipped (`already_running`, or on Postgres `lock_held_elsewhere`
— another replica already held the per-batch advisory lock), plus the next
scheduled tick.

**Postgres time zone (percy TB10 review, item 1 — critical):** `created_at`
is TEXT rendered in the connection's `TimeZone` GUC. Every postgres-js
connection this app opens now pins `connection: { TimeZone: "UTC" }`
(`src/server/db/client.ts`'s `PG_CONNECTION_OPTIONS`), so new rows always
render "+00" regardless of the server/database's default timezone. **This
does not retroactively fix existing rows**: if your Postgres server's
default timezone was not UTC before upgrading to this release, rows
written before the upgrade keep their local-time-with-offset text and are
compared against the retention cutoff using that historical offset (they
age out correctly once they're unambiguously past the cutoff by more than
the offset; only rows within one offset-width of the cutoff at upgrade
time are affected, and only until they naturally age out).

**Reclaiming space after enabling retention (SQLite):** deleting rows frees
pages inside the SQLite file but does not shrink it on disk unless the
database was created with `PRAGMA auto_vacuum = INCREMENTAL` — the
retention pass runs `PRAGMA incremental_vacuum` automatically in that case.
Every install prior to this release (and any fresh install using the
default PRAGMAs) has `auto_vacuum = NONE`, so the file will not shrink on
its own; reclaim the space with a one-time, **blocking** `VACUUM` during a
maintenance window (stop write traffic first — `VACUUM` rewrites the whole
file and briefly holds an exclusive lock):

```bash
kubectl -n <namespace> exec -it deploy/agentpulse -- sqlite3 /app/data/agentpulse.db 'VACUUM;'
```

This is never run automatically by the server. On the Postgres overlay,
`autovacuum` already reclaims space from deleted rows — no manual step
needed.

---

## Upgrading to migration 0003 (AGEN-16: event dedup)

Migration `0003` adds a `dedup_key` column and two indexes
(`idx_events_session_id_id`, `uq_events_session_dedup_key`) to the `events`
table. It runs automatically on boot, on both SQLite and Postgres, but the
two backends have different operational implications.

**SQLite**

- **Back up `agentpulse.db` before upgrading.** See `BACKUP-RESTORE.md` for
  the restore runbook; the backup sidecar already does this daily, but take
  a fresh manual backup immediately before the upgrade regardless.
- The migration itself (the column add plus both indexes) is synchronous at
  boot and fast at realistic database sizes. This release also does a
  one-time rebuild of the SQLite full-text-search index (search deletes
  move from a full-table scan to a row-id lookup); that rebuild runs inside
  the same boot transaction, is idempotent, and is proportional to the
  number of indexed (searchable) events — seconds, not minutes, at typical
  database sizes. `/health` returns `503` (`dbReady: false`) until boot
  finishes, so the `startupProbe` won't route traffic mid-migration.

**Postgres**

- Building `uq_events_session_dedup_key` (a unique index) takes a `SHARE`
  lock on `events` for the duration of the build. On a small-to-moderate
  `events` table this is milliseconds to low hundreds of milliseconds and
  safe to let run inline at boot. On a large table, do the index builds
  out-of-band, in a maintenance window, before rolling out this version:

  ```sql
  -- Run against the Postgres database directly, before deploying the new image.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_session_id_id
    ON events (session_id, id);
  CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_events_session_dedup_key
    ON events (session_id, dedup_key);
  ```

  `CONCURRENTLY` avoids the `SHARE` lock (it takes longer, and doesn't run
  inside a transaction, but doesn't block writes to `events` while it
  builds). A `CONCURRENTLY` build can fail partway through and leave an
  **invalid** index behind — Postgres will not use an invalid index, and a
  plain `CREATE INDEX IF NOT EXISTS` afterwards silently skips it instead of
  fixing it. Verify both indexes are valid before considering the upgrade
  complete:

  ```sql
  SELECT indexrelid::regclass AS index_name, indisvalid
    FROM pg_index
    WHERE indexrelid IN (
      'idx_events_session_id_id'::regclass,
      'uq_events_session_dedup_key'::regclass
    );
  ```

  If either row shows `indisvalid = false`, drop and rebuild that index
  before deploying:

  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS <index_name>;
  -- then re-run the matching CREATE INDEX CONCURRENTLY statement above
  ```

  Once both indexes are `indisvalid = true` out-of-band, the app's own
  migration runner sees them already present (`IF NOT EXISTS`) and does no
  further work for them at boot.

See `deploy/overlays/postgres/README.md` for the general Postgres overlay
setup this applies on top of.

---

## Upgrading to migration 0004 (agent-type filter index)

Migration `0004` adds one index, `idx_sessions_agent_type_last_activity`,
on `sessions (agent_type, last_activity_at)`. It runs automatically on
boot, on both SQLite and Postgres, and is idempotent (`IF NOT EXISTS`) on
both — a pre-created index under the same name doesn't break boot.

**Postgres**

- Building this index takes a `SHARE` lock on `sessions` for the duration
  of the build, the same tradeoff `0003`'s indexes make on `events`. On a
  small-to-moderate `sessions` table this is milliseconds and safe to run
  inline at boot. On a large table, pre-create it out-of-band, in a
  maintenance window, before rolling out this version:

  ```sql
  -- Run against the Postgres database directly, before deploying the new image.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_agent_type_last_activity
    ON sessions (agent_type, last_activity_at);
  ```

  `CONCURRENTLY` avoids the `SHARE` lock (it takes longer, and doesn't run
  inside a transaction, but doesn't block writes to `sessions` while it
  builds). A `CONCURRENTLY` build can fail partway through and leave an
  **invalid** index behind — Postgres will not use an invalid index, and a
  plain `CREATE INDEX IF NOT EXISTS` afterwards silently skips it instead of
  fixing it. Verify it's valid before considering the upgrade complete:

  ```sql
  SELECT indexrelid::regclass AS index_name, indisvalid
    FROM pg_index
    WHERE indexrelid = 'idx_sessions_agent_type_last_activity'::regclass;
  ```

  If that row shows `indisvalid = false`, drop and rebuild it before
  deploying:

  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_agent_type_last_activity;
  -- then re-run the CREATE INDEX CONCURRENTLY statement above
  ```

  Once the index is `indisvalid = true` out-of-band, the app's own
  migration runner sees it already present (`IF NOT EXISTS`) and does no
  further work for it at boot.

---

## Upgrading to migration 0005 (AGEN-24 percy review: event retention index)

Migration `0005` adds one index, `idx_events_created_at_id`, on
`events (created_at, id)` — it backs the event-retention pass's batch
`SELECT ... WHERE created_at < ? ORDER BY created_at, id LIMIT ...` (percy
measured 48ms → 0.04ms per idle tick on Postgres; SQLite already had an
equally-capable single-column index — see below). It runs automatically
on boot, on both SQLite and Postgres, and is idempotent (`IF NOT EXISTS`)
on both.

**SQLite**: no action needed. SQLite appends the rowid (which is `events.id`
for this table) to every non-unique index's key internally, so the
pre-existing `idx_events_created_at` (added before AGEN-24) already behaves
like a `(created_at, id)` composite for this query — `EXPLAIN QUERY PLAN`
shows either index used depending on install history, and both are
equally non-scanning.

**Postgres**

- Building this index takes a `SHARE` lock on `events` for the duration of
  the build, the same tradeoff `0003`'s indexes make. On a small-to-moderate
  `events` table this is milliseconds and safe to run inline at boot. On a
  large table (which is exactly the AGEN-16 growth scenario this feature
  exists to bound), pre-create it out-of-band, in a maintenance window,
  before rolling out this version:

  ```sql
  -- Run against the Postgres database directly, before deploying the new image.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_created_at_id
    ON events (created_at, id);
  ```

  `CONCURRENTLY` avoids the `SHARE` lock (it takes longer, and doesn't run
  inside a transaction, but doesn't block writes to `events` while it
  builds). A `CONCURRENTLY` build can fail partway through and leave an
  **invalid** index behind — Postgres will not use an invalid index, and a
  plain `CREATE INDEX IF NOT EXISTS` afterwards silently skips it instead of
  fixing it. Verify it's valid before considering the upgrade complete:

  ```sql
  SELECT indexrelid::regclass AS index_name, indisvalid
    FROM pg_index
    WHERE indexrelid = 'idx_events_created_at_id'::regclass;
  ```

  If that row shows `indisvalid = false`, drop and rebuild it before
  deploying:

  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS idx_events_created_at_id;
  -- then re-run the CREATE INDEX CONCURRENTLY statement above
  ```

  Once the index is `indisvalid = true` out-of-band, the app's own
  migration runner sees it already present (`IF NOT EXISTS`) and does no
  further work for it at boot.

---

## Upgrading to migration 0006 (AGEN-27: pg_trgm search index)

Migration `0006` adds `pg_trgm` GIN indexes so Postgres `ILIKE '%term%'`
event/session search stops doing a sequential scan of the whole `events`
table on every query — 4 indexes on `sessions`, 6 partial indexes on
`events` (restricted to the same event types SQLite's FTS5 indexes). SQLite
is unaffected — this migration is Postgres-only.

**Extension availability**

`pg_trgm` requires `CREATE EXTENSION`, which some managed Postgres
providers restrict to superuser. The migration feature-detects this: if
`CREATE EXTENSION pg_trgm` fails for any reason, it logs a `WARNING` and
skips all 10 indexes — search keeps working via the pre-existing
sequential-scan ILIKE path, just without the speedup. Nothing else in the
app changes behavior; there is no manual recovery step required if this
happens, only degraded search latency at scale. If your provider supports
installing `pg_trgm` after the fact (e.g. by granting the role
`rds_superuser` on RDS, or running `CREATE EXTENSION pg_trgm;` yourself as
an admin), do so and re-run the migration (or re-run the two `DO` blocks
in the `drizzle/postgres/0006_*.sql` migration file directly) to
pick up the indexes on the next boot.

**Automatic build is skipped above 100,000 rows (percy AGEN-27 review,
High 3)** — building 10 GIN indexes takes a `SHARE` lock on
`sessions`/`events` for the duration of each build; measured ~22s at
1,000,000 events, blocking ingest for that whole window. To avoid that on
an existing install with meaningful data, the migration runs `ANALYZE
events` and then checks `pg_class.reltuples`: above 100,000 (estimated
rows — an autovacuum-maintained statistic, not exact, which is fine for a
threshold this coarse) it **skips the automatic build entirely** and logs
a `WARNING` pointing at the `CREATE INDEX CONCURRENTLY` recipe below. A
never-analyzed table reports `reltuples = -1` ("unknown"), not `0` —
running `ANALYZE` first before the check is load-bearing (percy AGEN-27
review, TB22): without it, a large-but-never-analyzed `events` table would
read as "unknown" and the migration treats that the same as "too large to
risk" — it **skips and warns** rather than assuming small and building
inline. A genuinely fresh, empty install reports `reltuples = 0` after
that same `ANALYZE` and always gets the automatic build — the skip only
applies to installs that already have (or might have) real data. A
skipped or partially-completed build (see the next paragraph) is visible
without reading logs: `GET /api/v1/health`'s `searchIndexes` field reports
`{ present: boolean, missing: string[] }`, checked once at boot
(`src/server/services/search/search-index-status.ts`) by querying
`pg_index`/`pg_class` directly and requiring `indisvalid` — an index left
behind in an unusable state by a failed `CONCURRENTLY` build does not
count as present.

**After a bulk import or restore, run `ANALYZE events;`** — Postgres's
planner relies on up-to-date statistics to pick a good query plan, and a
bulk-loaded table (a restored backup, a data migration) can otherwise sit
with stale or empty statistics until autovacuum catches up on its own
schedule. This matters beyond the reltuples gate above: `searchEvents`'
adaptive two-plan strategy (percy AGEN-27 review, TB26 — see CLAUDE.md's
search backend note) leans on the planner picking a reasonable default
plan for the common case, falling back to a forced trigram scan only when
that default plan is canceled by its own 150ms timeout. Stale statistics
don't break correctness (the fallback still catches a slow plan and
completes it correctly), but they can make Plan A fall back more often
than necessary. `VACUUM (ANALYZE) events;` is safe to run at any time,
including against a live database.

**A build failure never blocks boot (percy AGEN-27 review, Critical 2)** —
the index-build step is wrapped in its own exception handler: a transient
failure partway through (disk full, lock timeout, OOM, whatever) logs a
`WARNING` with the underlying error — it never aborts the migration
transaction or crash-loops boot. Note the rollback granularity: PL/pgSQL's
`EXCEPTION` block rolls back to an implicit savepoint at block entry, so a
failure undoes every `CREATE INDEX` already run in *that same attempt*,
not just the one that failed (`IF NOT EXISTS` still makes the next boot's
retry attempt idempotent). Re-run the `CREATE INDEX` statements from the
migration file (or the `CONCURRENTLY` recipe below) once the underlying
issue is resolved.

**Index size** — per percy's measurements, expect each trigram GIN index
to run roughly 55-112% of the `events` table's own heap size (varies by
which column/expression it covers and how much of it is non-null across
the partial index's event-type population). Building all 6 events indexes
on a large table is therefore a meaningful, multi-index storage cost, not
just a locking one — budget disk headroom accordingly before running the
`CONCURRENTLY` recipe on a large existing install.

**Postgres**

- Building 10 GIN indexes takes a `SHARE` lock on `sessions`/`events` for
  the duration of each build, the same tradeoff `0003`'s and `0004`'s
  indexes make. On a small-to-moderate database (below the 100,000-row
  automatic-skip threshold above) this is milliseconds to low seconds per
  index and safe to let run inline at boot. On a large table (whether the
  migration skipped automatically, or a build attempt failed partway and
  logged a `WARNING`), do the index builds out-of-band, in a maintenance
  window, before rolling out this version:

  ```sql
  -- Run against the Postgres database directly, before deploying the new image.
  -- Requires pg_trgm; installing the extension itself does NOT need CONCURRENTLY.
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_display_name_trgm
    ON sessions USING gin (display_name gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_cwd_trgm
    ON sessions USING gin (cwd gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_current_task_trgm
    ON sessions USING gin (current_task gin_trgm_ops);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_notes_trgm
    ON sessions USING gin (notes gin_trgm_ops);

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_content_trgm
    ON events USING gin (content gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_prompt_trgm
    ON events USING gin ((raw_payload->>'prompt') gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_message_trgm
    ON events USING gin ((raw_payload->>'message') gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_summary_trgm
    ON events USING gin ((raw_payload->>'summary') gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_why_trgm
    ON events USING gin ((raw_payload->>'why') gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_title_trgm
    ON events USING gin ((raw_payload->>'title') gin_trgm_ops)
    WHERE event_type IN ('UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted','SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest');
  ```

  `CONCURRENTLY` avoids the `SHARE` lock (it takes longer, and doesn't run
  inside a transaction, but doesn't block writes to `sessions`/`events`
  while it builds). A `CONCURRENTLY` build can fail partway through and
  leave an **invalid** index behind — Postgres will not use an invalid
  index, and the app's own migration (a plain `CREATE INDEX IF NOT
  EXISTS`, no `CONCURRENTLY`) silently skips a same-named invalid index
  instead of fixing it. Verify all 10 are valid before considering the
  upgrade complete:

  ```sql
  SELECT indexrelid::regclass AS index_name, indisvalid
    FROM pg_index
    WHERE indexrelid IN (
      'idx_sessions_display_name_trgm'::regclass,
      'idx_sessions_cwd_trgm'::regclass,
      'idx_sessions_current_task_trgm'::regclass,
      'idx_sessions_notes_trgm'::regclass,
      'idx_events_content_trgm'::regclass,
      'idx_events_prompt_trgm'::regclass,
      'idx_events_message_trgm'::regclass,
      'idx_events_summary_trgm'::regclass,
      'idx_events_why_trgm'::regclass,
      'idx_events_title_trgm'::regclass
    );
  ```

  If any row shows `indisvalid = false`, drop and rebuild that index
  before deploying:

  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS <index_name>;
  -- then re-run the matching CREATE INDEX CONCURRENTLY statement above
  ```

  Once all 10 indexes are `indisvalid = true` out-of-band, the app's own
  migration runner sees them already present (`IF NOT EXISTS`) and does no
  further work for them at boot.

---

## Upgrading to Postgres migrations 0007 and 0009 (user ownership, exclude flag)

Three Postgres migrations arrive with team mode and the exclude rule; `0008`
(acknowledgement timestamps) is described in the next section. SQLite has the
same schema under different numbers (`0006`, `0007`, `0008`), applied by the
same boot path; the lock discussion below is Postgres-only. All three run
in-band at boot, under the existing advisory lock, and need no manual step on
a small install.

**`0007_user_ownership.sql`** adds 15 columns, all with
`ADD COLUMN IF NOT EXISTS`: nullable `text` ownership columns on `sessions`
(`owner_user_id`, `ingest_key_id`), `api_keys` (`owner_user_id`,
`created_by_user_id`), `supervisors` (`owner_user_id`),
`supervisor_enrollment_tokens` (`created_by_user_id`), `control_actions` and
`launch_requests` (`requested_by_user_id`) and `ai_action_requests`
(`resolved_by_user_id`); and six on `users` (`auth_source` `NOT NULL DEFAULT
'local'`, `provider`, `subject`, `subject_source`, `display_name`,
`must_change_password` `NOT NULL DEFAULT false`). Adding a column with a
constant default doesn't rewrite the table on Postgres 11 or later. It also
creates three indexes, **none of them `CONCURRENTLY`**:

| Index | On | Note |
|---|---|---|
| `idx_sessions_owner_last_activity` | `sessions (owner_user_id, last_activity_at)` | Takes a `SHARE` lock on `sessions` while it builds: hook writes (which update `sessions`) wait until it finishes. |
| `idx_api_keys_owner` | `api_keys (owner_user_id)` | Small table. |
| `idx_users_provider_subject` (unique) | `users (provider, subject)` | Small table. |

On a large `sessions` table, pre-create the big one out-of-band, in a
maintenance window, before rolling out this version. The migration uses
`CREATE INDEX IF NOT EXISTS`, so it then skips the build:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_owner_last_activity
  ON sessions (owner_user_id, last_activity_at);
```

Then verify the index is valid; a failed concurrent build leaves an invalid
index behind that has to be dropped and recreated:

```sql
SELECT indisvalid FROM pg_index
 WHERE indexrelid = 'idx_sessions_owner_last_activity'::regclass;
```

**`0009_supervisor_exclude_rules_state.sql`** adds one nullable `text` column,
`supervisors.exclude_rules_state`, with `ADD COLUMN IF NOT EXISTS`. Instant at
any size. It holds only `invalid` (a host whose exclude file has an error) or
null; see the README's "Excluding directories" section.

Existing SQLite installs on the legacy `initializeDatabase()` path get the
same columns through its additive ALTER list.

Nothing about team mode changes at upgrade: the instance stays in solo mode
until an admin switches it, or you set `AGENTPULSE_MODE` (commented
placeholders are in `02-configmap.yaml`).

**Several limits are per replica.** Rolling updates on the Postgres overlay are
safe for migrations only. These live in each process's memory and reset on
restart, so with N replicas they are N times looser, and they briefly double
while a rolling deploy runs two generations: the hook rate limiter, the
per-owner session-creation limit (`AGENTPULSE_SESSION_CREATE_LIMIT`, default
120 a minute, team mode), the API-key mint limit (10 a minute), the
password-change failure limit (5 per 15 minutes per account), and the stats
scan queue and in-flight coalescing. The instance mode and every ownership
fact are read from the database on each request (no cache), so they are
consistent across replicas. Keep a single replica until the process-local
state is externalised; see "Detecting a split SQLite deployment" below for
what happens with more than one SQLite instance.

## Upgrading to migration 0007 (SQLite) / 0008 (Postgres): acknowledgement timestamps

These two migrations (`drizzle/sqlite/0007_session_ack_timestamps.sql`,
`drizzle/postgres/0008_session_ack_timestamps.sql` — the numbers differ
because Postgres carries an extra Postgres-only migration (`0006`,
AGEN-27's pg_trgm indexes) that SQLite never got, and user ownership
(sqlite `0006` / postgres `0007`) landed before this one) add two
nullable text columns to `sessions`:
`last_agent_turn_completed_at` (stamped on Stop) and
`last_user_acknowledged_at` (stamped on UserPromptSubmit and on the
synthetic `UserAcknowledge` hook). They back the dashboard's
WAITING-vs-IDLE distinction. Both are plain `ALTER TABLE ... ADD COLUMN`
with no default, no backfill and no index: instant on both dialects at any
table size, no lock window worth planning around, nothing to pre-create
out-of-band. Existing SQLite installs on the legacy `initializeDatabase()`
path get the same columns through its additive ALTER list. The Postgres
migration uses `ADD COLUMN IF NOT EXISTS` so an operator who already added
the columns by hand does not fail the in-band migration.

Rows that predate the columns stay `NULL`; the dashboard shows such a
session (active, not working) as IDLE until its next Stop or prompt
stamps one of the timestamps — nothing has finished yet, so nothing is
awaiting the user. No action is required; no backfill.

## Homelab overlay

```
deploy/k8s-homelab/
├── kustomization.yaml         — patches base with real registry / hostname
├── deployment-patch.yaml      — private registry image + resource overrides
├── configmap-patch.yaml       — real PUBLIC_URL (replaces example.com)
├── ingressroute-https-patch.yaml — real hostname + wildcard TLS secret
└── ingressroute-http-patch.yaml  — real hostname
```

Apply base (OSS/example values):
```bash
kubectl apply -k deploy/k8s/
```

Apply homelab overlay (real values):
```bash
kubectl apply -k deploy/k8s-homelab/
```

---

## Build-and-push workflow (S-23)

agentpulse uses `imagePullPolicy: IfNotPresent` with SHA-pinned tags. The
`scripts/build-and-push.sh` script handles the build:

```bash
# Default: ghcr.io/jstuart0
./scripts/build-and-push.sh

# Private homelab registry (replace with your registry host and port)
REGISTRY=<your-registry-host>:<port> ./scripts/build-and-push.sh
```

After pushing, update the `image:` field in `deploy/k8s/04-deployment.yaml`
(or `deploy/k8s-homelab/deployment-patch.yaml` for the homelab overlay) to
the printed SHA tag, then apply:

```bash
kubectl apply -k deploy/k8s-homelab/
kubectl -n agentpulse rollout status deployment/agentpulse
```

**Private / insecure registries**: if your registry requires authentication,
create an `imagePullSecret` in the `agentpulse` namespace and reference it in
the deployment. For insecure (HTTP) registries, add the registry address to
the Docker daemon's `insecure-registries` list.

---

## PV reclaim policy runbook (B-4)

> **Why**: `persistentVolumeReclaimPolicy` is a **PersistentVolume** field.
> Setting it on a PVC manifest for a dynamically-provisioned volume is silently
> ignored. The only way to change the reclaim policy is to patch the PV directly.

After first deployment, patch the backing PV to `Retain` so that deleting the
PVC (e.g. during a namespace teardown or storage-class migration) does not
immediately delete the data volume:

```bash
# Find the PV name bound to the agentpulse-data PVC
PV_NAME=$(kubectl -n agentpulse get pvc agentpulse-data -o jsonpath='{.spec.volumeName}')

# Patch reclaim policy
kubectl patch pv "$PV_NAME" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# Verify
kubectl get pv "$PV_NAME" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'
# Expected output: Retain
```

Do this once, immediately after the first `kubectl apply`. The PVC manifest
carries an annotation as a reminder; the annotation has no runtime effect.

---

## NetworkPolicy rationale (I-M3)

`10-networkpolicy.yaml` restricts **ingress** on port 3000 to three sources:

1. **Traefik namespace** — the sole external ingress point. Traffic from any
   other namespace or external IP that is not in the node CIDR is blocked.

2. **Node CIDR (`192.168.10.0/24`)** — kubelet liveness, readiness, and startup
   probes originate from the node IP, not from any namespace. On strict CNIs
   (Cilium with `host-firewall` enabled, Calico with `doNotTrack`) the
   NetworkPolicy is evaluated against node-sourced traffic. Without this
   `ipBlock` rule, probes are silently dropped, causing `CrashLoopBackOff`.
   **REPLACE `192.168.10.0/24` with your cluster's node CIDR** when deploying
   outside this homelab (edit `10-networkpolicy.yaml` before applying).

3. **Same-namespace `app: agentpulse` pods** — defense-in-depth for CNI plugins
   that enforce policy on loopback-bound traffic; preserves the preStop drain
   call to `localhost:3000`.

**Egress is intentionally unrestricted** (S-21, option a). agentpulse needs
to reach:

- Kubernetes DNS (`kube-dns` in `kube-system`)
- Authentik OIDC endpoints (in-cluster: `authentik` namespace)
- Anthropic API (`api.anthropic.com`)
- Telegram API (`api.telegram.org`)
- Synology NFS (P11, LAN IP)
- User-configured notification webhooks (arbitrary HTTPS)

Enumerating these as static CIDR/port egress rules is brittle — endpoints
rotate IPs and differ per deployment. Revisit with FQDN-based egress policy
(requires a CNI plugin that supports it, e.g. Cilium) if a stricter posture
is needed.

---

## IngressRoute rate-limit audit

The `agentpulse-ratelimit-public` middleware (100 req/min average, 200 burst)
is applied to exactly these 6 paths:

| Path | Middleware |
|------|-----------|
| `/api/v1/channels/telegram/webhook` | `agentpulse-ratelimit-public` |
| `/setup.sh` | `agentpulse-ratelimit-public` |
| `/setup-relay.sh` | `agentpulse-ratelimit-public` |
| `/install-local.sh` | `agentpulse-ratelimit-public` |
| `/install-local.ps1` | `agentpulse-ratelimit-public` |
| `/api/v1/csp-report` | `agentpulse-ratelimit-public` |

**Explicitly excluded** from rate limiting:
- `/api/v1/hooks` — in-process per-key limiter (P7); always-200 contract
- `/api/v1/hooks/status` — same

**Also without an edge rate limit**: `/api/v1/auth/change-password` and
`/app-api/v1/auth/change-password`, exempt from forwardauth for the reason
in `FORWARDAUTH.md` ("Why change-password stays off forwardauth"), the same way
login and signup are today. The handler requires a valid session and limits
failed current-password attempts to 5 per account per 15 minutes, in memory per
replica.

**Explicitly blocked** (no rate limit, returns 503 via non-existent service):
- `/api/v1/internal/*` — loopback-only endpoint; Traefik deny rule is defense-in-depth

Audit command (run after `kubectl apply`):
```bash
kubectl get ingressroute -n agentpulse -o yaml \
  | yq '.items[].spec.routes[] | {match: .match, middlewares: [.middlewares[].name]}'
```

Expected: each of the 6 paths above shows `agentpulse-ratelimit-public`; hook
paths show no middleware; `/api/v1/internal` has no IngressRoute match (only
the deny-service rule).

---

## DB-ready gate (S-24)

`GET /api/v1/health` returns `503` with `{"status":"starting","dbReady":false}`
until `initializeDatabase()` completes all migrations. The k8s `startupProbe`
polls this endpoint with a 150-second budget (30 attempts × 5s). Only after
`markDbReady()` fires does the endpoint return `200`. This prevents the
`livenessProbe` from passing early and SIGKILLing the pod mid-migration.

---

## Detecting a split SQLite deployment (hosts-visibility fix)

The base manifest here is `replicas: 1` / `strategy: Recreate` precisely
because SQLite is a local file with no cross-instance coordination (see the
repo CLAUDE.md "Single-replica constraint"). If that constraint is ever
violated outside this repo's own manifests (e.g. a hand-edited `replicas: 2`,
or an equivalent ECS/Compose scale-out), each instance gets its own
independent local database file, and state written against one instance
(a registered supervisor, a session, a setting) is invisible from another.

`GET /api/v1/health` now reports `instance: { dbFingerprint, dialect }` — a
short, non-reversible fingerprint of the backing database derived from its
`installation_id` (never the raw id itself, and derived with a different
salt than telemetry.ts uses, so it can't be correlated against a telemetry
ping). On Postgres every replica shares one database, so this is always a
single stable value — correct by construction, no replica-count detection
needed. On SQLite, two instances report two different fingerprints. The
dashboard polls this on an interval and raises a persistent warning banner
the moment it observes more than one. The server also logs a best-effort
boot-time warning when it detects it's running on SQLite under an
orchestrator that commonly scales to >1 replica (`ECS_CONTAINER_METADATA_URI`
or `KUBERNETES_SERVICE_HOST` set).

---

## Why we pin Hono to a minor version

`package.json` pins Hono with a tilde (`~4.7.0`) rather than a caret (`^4.7.0`).
This pins to the `4.7.x` patch series and blocks silent minor-version upgrades.

Hono's root-route mount behavior has shifted across minor versions in the past —
a `^` bump can change how nested router prefixes are resolved, breaking the API
mount point at `/api/v1/`. The `~` pin ensures that `bun install` only pulls in
patch-level security/bug fixes. Upgrade to a new minor intentionally by bumping
the version string and running `bun run typecheck` + the full test suite.

`react-markdown` is pinned (`~10.1.0`) for the same reason: the v10 series
removed `rehype-raw` and changed how raw HTML is handled. A silent upgrade to a
hypothetical v11 that reintroduces raw-HTML processing would reopen the XSS
surface that the `~10.x` pin closes.

---

## Postgres overlay

A Kustomize overlay that switches AgentPulse from SQLite to PostgreSQL is in
`deploy/overlays/postgres/` (one directory above `deploy/k8s/`; placed there to
avoid a kustomize cycle-detection error when the overlay references the base).

What the overlay does:

- Sets `DATABASE_URL` from a filled-in `secret-patch.yaml` (gitignored; never commit real values).
- Adds `AGENTPULSE_PG_POOL_MAX` to the deployment (default 10; tune for your Postgres `max_connections` and replica count).
- Removes the `backup-sidecar` container and the `agentpulse-backups` PVC (SQLite-only).
- Switches the deployment strategy to `RollingUpdate` (safe with Postgres because migration
  serialization uses a session-level `pg_advisory_lock` on the migration client's own connection).

**Pre-flight**:

```bash
# 1. Verify context
kubectl config current-context   # should be your target cluster

# 2. Create database and user (on your Postgres host)
psql -h your-postgres-host -U psadmin \
  -c "CREATE USER agentpulse WITH PASSWORD '<password>';"
psql -h your-postgres-host -U psadmin \
  -c "CREATE DATABASE agentpulse OWNER agentpulse ENCODING 'UTF8' \
      LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"

# 3. Fill in credentials (DO NOT COMMIT)
cp deploy/overlays/postgres/secret-patch.yaml.example \
   deploy/overlays/postgres/secret-patch.yaml
# Edit: set DATABASE_URL to postgres://agentpulse:<pw>@host:5432/agentpulse?sslmode=require
kubectl apply -f deploy/overlays/postgres/secret-patch.yaml -n agentpulse

# 4. Render and verify
kubectl kustomize deploy/overlays/postgres/

# 5. Apply
kubectl apply -k deploy/overlays/postgres/
```

**Rolling deploy semantics**: AgentPulse acquires `pg_advisory_lock(2850603287)` (session-level, on
the dedicated migration connection) before running Drizzle migrations. Two replicas booting
simultaneously serialize on this lock; the second waits until the first finishes migrating and
releases the lock. No external coordination is needed.

**Not everything is safe to roll**: the advisory lock covers migrations only. The
hook rate limiter, the per-owner session-creation limit, the key-mint limit, the
password-change failure limit and the stats scan queue are per-process memory
(N replicas make each N times looser; a rolling deploy briefly doubles them). See
"Upgrading to Postgres migrations 0007 and 0009" above.

**Connection pool tuning**: `AGENTPULSE_PG_POOL_MAX` (integer [1, 100], default 10). For a single
replica: `max_connections / 2` is a safe starting point. Scale down proportionally for multiple
replicas sharing the same Postgres instance.

See `deploy/overlays/postgres/README.md` for the full checklist, post-switch cleanup steps, and
notes on the SQLite PVC lifecycle.

---

## Forwardauth SSO setup

AgentPulse SSO works with any forwardauth-capable identity provider — Authentik
(default), Authelia, oauth2-proxy, Pomerium, or Cloudflare Access.

The base manifests include four Traefik middlewares for SSO in `06-middleware.yaml`:

| Middleware | Role |
|---|---|
| `agentpulse-strip-client-forwardauth` | Strips any client-supplied IdP headers before forwardauth runs |
| `agentpulse-strip-client-authentik` | **Deprecated alias** — same spec; kept until v0.7.0 so existing overlays referencing the old name continue to work. Removed next release. |
| `agentpulse-forwardauth` | IdP validates the session and injects identity headers |
| `agentpulse-inject-verify` | Traefik adds the `FORWARDAUTH_TRUST_SECRET` as a verify header after forwardauth passes |

The protected catch-all route in `07-ingressroute.yaml` applies the new-named middleware
(and `agentpulse-forwardauth` and `agentpulse-inject-verify`) in order. AgentPulse's trust
gate (`src/server/auth/middleware.ts`) verifies the trust header against
`FORWARDAUTH_TRUST_SECRET` before admitting the forwardauth-asserted identity.

**Quick setup**:

1. Generate a shared secret: `openssl rand -hex 32`
2. Add it to `agentpulse-secrets` as `FORWARDAUTH_TRUST_SECRET`.
3. Inject the same value into the `agentpulse-inject-verify` Middleware via a private overlay
   (do not commit it to the base manifests — the base uses an empty placeholder).
4. Apply your overlay and restart agentpulse.

See `deploy/k8s/FORWARDAUTH.md` for the full setup steps, provider-specific header
configuration, middleware ordering rationale, and secret rotation procedure.

**Public routes that bypass forwardauth**: the IngressRoute defines unprotected rules for paths that
must be reachable without an SSO session: `/api/v1/health`, `/api/v1/ready`, `/api/v1/hooks`,
`/api/v1/hooks/status`, `/assets/*`, `/api/v1/auth/{me,login,logout,signup}`, Telegram webhook,
setup scripts, and `/api/v1/supervisors/*`. The supervisor surface bypasses SSO because
supervisor agents run on remote machines and cannot hold an SSO session — per-endpoint
`requireSupervisorAuth()` is the auth boundary there.

---

## Known limitations

**Image signing (cosign)**: container images are not signed with cosign.
Acceptable for homelab use where the image registry (`ghcr.io/jstuart0`) is
controlled by the operator. Admission-time signature verification via Sigstore
policy-controller is a future hardening item if the deployment posture requires it.

**503 during boot**: monitoring systems will observe a brief 503 window (up to
150 s) while the `startupProbe` runs and DB migrations complete. This is
intentional — the health gate prevents premature traffic routing before the DB
is ready. Alert thresholds should account for this boot window (e.g. alert only
after sustained 503 beyond 180 s, or suppress alerts during the first 3 min
post-deploy).

**SHA-pinned image must be updated before `kubectl apply`**: `04-deployment.yaml`
pins the image to a specific commit SHA (`image: ghcr.io/jstuart0/agentpulse:<sha>`).
This SHA is a placeholder showing the convention. Before applying, run
`./scripts/build-and-push.sh` and update the `image:` field to the printed SHA,
or apply via the homelab overlay which overrides this field per deployment.
