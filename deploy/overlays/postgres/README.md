# Postgres overlay

Kustomize overlay that configures AgentPulse to use a PostgreSQL database
instead of the default SQLite backend.

## What this overlay does

- Switches `DATABASE_URL` from empty (SQLite) to a Postgres connection string.
- Removes the `backup-sidecar` container (SQLite-only; Postgres uses native backup).
- Switches the deployment strategy to `RollingUpdate` (safe with Postgres due to
  session-level advisory-lock migration serialization via a dedicated single-connection
  migration client).
- Does NOT delete the SQLite `agentpulse-data` PVC — operator removes it manually
  after verifying data has been migrated or is no longer needed.

## Pre-flight checklist

### 1. Verify kubectl context

```bash
kubectl config current-context
# Expected: your target cluster context
# If wrong: kubectl config use-context <your-context>
```

### 2. Create the Postgres database and user

```bash
psql -h your-postgres-host -U psadmin \
  -c "CREATE USER agentpulse WITH PASSWORD '<password>';"
psql -h your-postgres-host -U psadmin \
  -c "CREATE DATABASE agentpulse OWNER agentpulse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"
```

### 3. Create the credentials file (DO NOT COMMIT)

`secret-patch.yaml.example` is a **template** committed to the repo. Copy it,
fill in real values, and apply it out-of-band. The real file is gitignored.

```bash
# From the repo root:
cp deploy/overlays/postgres/secret-patch.yaml.example \
   deploy/overlays/postgres/secret-patch.yaml

# Edit secret-patch.yaml — replace <PASSWORD> and your-postgres-host.
# Add sslmode=require (or stronger) for non-loopback connections.
# Example: postgres://agentpulse:<pw>@your-postgres-host:5432/agentpulse?sslmode=require

# Apply credentials out-of-band (keeps them out of kustomize render history):
kubectl apply -f deploy/overlays/postgres/secret-patch.yaml -n agentpulse
```

⚠️ **NEVER** run `git add deploy/overlays/postgres/secret-patch.yaml` or
`git commit -a` after filling in real values. Git history is public. The file
is in `.gitignore` as a safety net, but the best practice is to discard or
keep it only locally untracked.

### 4. Verify the overlay renders cleanly

```bash
kubectl kustomize deploy/overlays/postgres/
```

## Apply

```bash
kubectl apply -k deploy/overlays/postgres/
```

The app runs Drizzle migrations on boot via a dedicated single-connection
migration client with session-level advisory locking (safe for rolling deploys).
Check logs:

```bash
kubectl -n agentpulse logs -f deployment/agentpulse | grep '\[db\]'
```

## After switching to Postgres

Once Postgres is confirmed working and data has been migrated (if any):

```bash
# Remove the unused SQLite PVC (IRREVERSIBLE — verify backup first)
kubectl -n agentpulse delete pvc agentpulse-data

# Remove the backup PVC (no longer populated by the sidecar)
kubectl -n agentpulse delete pvc agentpulse-backups
```

See `BACKUP-RESTORE.md` for the SQLite backup runbook before deleting.

## Upgrading an existing Postgres-backed install

A schema migration that adds an index (for example migration `0003`, which adds a unique
index used for hook-event deduplication) can take a `SHARE` lock on a large `events` table
while building inline at boot. See `deploy/k8s/README.md` → "Upgrading to migration 0003"
for the out-of-band `CREATE INDEX CONCURRENTLY` procedure and the required
`pg_index.indisvalid` verification step.

### Migrations 0007, 0008 and 0009

The next three Postgres migrations run in-band at boot, under the same advisory
lock, with `IF NOT EXISTS` guards:

- `0007_user_ownership.sql` (team mode): 15 `ADD COLUMN IF NOT EXISTS` and three
  indexes, **none built `CONCURRENTLY`**: `idx_sessions_owner_last_activity`
  (takes a `SHARE` lock on `sessions`, so hook writes wait while it builds),
  `idx_api_keys_owner` and the unique `idx_users_provider_subject`. On a large
  `sessions` table, pre-create the first with
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_owner_last_activity ON sessions (owner_user_id, last_activity_at);`
  in a maintenance window and check `pg_index.indisvalid`; the migration then
  skips it.
- `0008_session_ack_timestamps.sql`: two nullable columns on `sessions`, instant.
- `0009_supervisor_exclude_rules_state.sql`: one nullable column on `supervisors`,
  instant.

The full write-up, with the verification query, is in `deploy/k8s/README.md` under
"Upgrading to Postgres migrations 0007 and 0009".

### Rolling updates are safe for migrations only

`RollingUpdate` is safe because migrations serialize on the advisory lock. It does
not make the rest of the process replica-safe. The hook rate limiter, the per-owner
session-creation limit (`AGENTPULSE_SESSION_CREATE_LIMIT`, default 120 a minute, in
team mode), the API-key mint limit, the password-change failure limit (5 per 15
minutes per account) and the stats scan queue live in each replica's memory and
reset on restart: with N replicas each is N times looser, and during a rolling
deploy two generations run at once. The instance mode and ownership are read from
the database on every request, so those are consistent across replicas. Until that
process-local state is externalised, run one replica.
