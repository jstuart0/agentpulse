# Postgres overlay

Kustomize overlay that configures AgentPulse to use a PostgreSQL database
instead of the default SQLite backend.

## What this overlay does

- Switches `DATABASE_URL` from empty (SQLite) to a Postgres connection string.
- Removes the `backup-sidecar` container (SQLite-only; Postgres uses native backup).
- Switches the deployment strategy to `RollingUpdate` (safe with Postgres due to
  advisory-lock migration serialization).
- Does NOT delete the SQLite `agentpulse-data` PVC — operator removes it manually
  after verifying data has been migrated or is no longer needed.

## Pre-flight checklist

1. Create the Postgres database and user:
   ```bash
   psql -h your-postgres-host -U psadmin \
     -c "CREATE USER agentpulse WITH PASSWORD '<password>';"
   psql -h your-postgres-host -U psadmin \
     -c "CREATE DATABASE agentpulse OWNER agentpulse ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"
   ```

2. Edit `secret-patch.yaml` — replace `<PASSWORD>` and `your-postgres-host` with
   your real values. This file is a template; do not commit real credentials.

3. Apply the secret separately (recommended — keeps credentials out of kustomize
   history) or via your secrets manager:
   ```bash
   kubectl apply -f deploy/k8s/overlays/postgres/secret-patch.yaml
   ```

4. Verify the overlay renders cleanly:
   ```bash
   kubectl kustomize deploy/k8s/overlays/postgres/
   ```

## Apply

```bash
kubectl apply -k deploy/overlays/postgres/
```

The app runs Drizzle migrations on boot. Check logs:
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
