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
# Expected: thor
# If wrong: kubectl config use-context thor
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
# Example: postgres://agentpulse:<pw>@postgres-01.xmojo.net:5432/agentpulse?sslmode=require

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
