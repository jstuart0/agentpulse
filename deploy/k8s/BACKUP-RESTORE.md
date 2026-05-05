# AgentPulse — Backup and Restore Runbook

## Storage stance

AgentPulse uses SQLite with WAL mode enabled. SQLite's WAL index relies on
shared-memory semantics that are not available on network filesystems (NFS,
network-mounted Ceph, etc.). Placing the live database on a network filesystem
causes **silent corruption**. See: https://www.sqlite.org/wal.html#noshm

**Constraint: the live database MUST live on a local block-storage PVC
(`agentpulse-data`, storage class `local-path` or equivalent). Do NOT change
this PVC to an NFS-backed class.**

Only the *backup output* goes to the NFS-backed PVC (`agentpulse-backups`).

---

## Architecture overview

The `agentpulse` pod runs two containers:

| Container | Image | Role |
|-----------|-------|------|
| `agentpulse` | `<registry>/agentpulse:<SHA>` | Application |
| `backup-sidecar` | `<registry>/agentpulse-backup:<SHA>` | Scheduled backup |

Both containers mount the same `agentpulse-data` PVC at their respective
paths (`/app/data` for the app; `/data` for the sidecar). The sidecar also
mounts `agentpulse-backups` at `/backups`.

### Why a sidecar (not a CronJob)?

A separate CronJob pod cannot mount a `ReadWriteOnce` PVC that is already
claimed by the live pod on a different node — Kubernetes rejects the bind.
The sidecar runs inside the same pod, on the same node, so both containers
share the RWO PVC without scheduling conflict.

### Why NOT `readOnly: true` on the sidecar's data mount?

SQLite's WAL mode creates a `-wal` and `-shm` file in the same directory as
the database. If those files don't exist when the sidecar opens the database,
SQLite attempts to create them. A read-only mount prevents that creation and
causes the backup to fail. The sidecar mount is writable; the sidecar simply
does not write to `agentpulse.db` directly — it only calls `sqlite3 .backup`,
which is the safe concurrent-read API.

### Backup image

The `agentpulse-backup:<SHA>` image is built from `deploy/k8s/Dockerfile.backup`.
It bakes in `sqlite`, `rsync`, and `ca-certificates` at build time (no runtime
`apk add`). It runs as UID 1000 (`backup` user) to match the operator's NFS
export permission configuration (`all_squash,anonuid=1000`).

Scripts baked into the image:
- `/usr/local/bin/run-backup.sh` — preflight checks + online backup + integrity check
- `/usr/local/bin/retention.sh` — 30-daily / 12-monthly survivor policy

### Backup schedule

The sidecar runs a `while true` loop that wakes at 04:15 UTC daily:

```
[backup-loop] next run in <N>s ...
[backup] starting: 20260501T041500Z
... informational wal/shm ls output ...
[backup] ok: /backups/agentpulse-20260501T041500Z.db
2          ← sessions count
47         ← events count
[retention] found N backup file(s)
[retention] done
```

View live output:
```bash
kubectl logs -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar --follow
```

Trigger a manual backup immediately (without waiting for the schedule):
```bash
kubectl exec -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar \
  -- /usr/local/bin/run-backup.sh
```

### Retention policy

After each successful backup, `retention.sh` applies:
- Keep the 30 most-recent daily backups unconditionally.
- For each calendar month (up to 12 months), keep the most-recent backup for
  that month as a monthly survivor, regardless of age.
- Remove all other backups (and their `.counts.txt` / `.sha256` sidecars).

---

## Restore procedure

> **Read this section in full before starting.** The restore procedure scales
> the deployment to zero, which stops both the app and the backup-sidecar.
> Plan for a brief downtime window.

### Step 1 — Identify the backup to restore

List available backups from the running sidecar:

```bash
kubectl exec -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar \
  -- ls -lt /backups/
```

Choose a `agentpulse-<TS>.db` file. Note the `<TS>` timestamp.

### Step 2 — Verify the backup before restore

Confirm the chosen backup is intact:

```bash
kubectl exec -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar \
  -- sqlite3 /backups/agentpulse-<TS>.db "PRAGMA integrity_check;"
# Expected output: ok

# Row counts reference (compare to post-restore counts):
kubectl exec -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar \
  -- cat /backups/agentpulse-<TS>.db.counts.txt
```

### Step 3 — Scale the deployment to zero

Scaling to zero releases the `agentpulse-data` RWO PVC so the restore pod
can claim it. This stops both the app and the backup-sidecar.

```bash
# Confirm you are targeting the correct cluster before scaling anything down.
kubectl config current-context
# Expected: thor (or kubernetes-admin@kubernetes)

kubectl scale deploy agentpulse -n <agentpulse-namespace> --replicas=0
kubectl rollout status deploy/agentpulse -n <agentpulse-namespace>
# Wait until: "deployment ... successfully rolled out" (0 replicas)
```

### Step 4 — Spin up a restore pod

The restore pod mounts both PVCs. It uses the prebuilt backup image so
`sqlite3` is already present — no `apk add` needed.

Save the following as `restore-pod.yaml` (do not commit this file):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agentpulse-restore
  namespace: <agentpulse-namespace>
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  containers:
    - name: restore
      image: <registry>/agentpulse-backup:<SHA>
      command: ["sleep", "3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      volumeMounts:
        - name: data
          mountPath: /data
        - name: backups
          mountPath: /backups
          readOnly: true
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: agentpulse-data
    - name: backups
      persistentVolumeClaim:
        claimName: agentpulse-backups
    - name: tmp
      emptyDir: {}
```

Apply it:

```bash
kubectl apply -f restore-pod.yaml
kubectl wait -n <agentpulse-namespace> pod/agentpulse-restore --for=condition=Ready --timeout=60s
```

### Step 5 — Copy the backup over the live database

```bash
kubectl exec -n <agentpulse-namespace> agentpulse-restore -- sh -c '
  # Preserve the (possibly corrupt) current state before overwriting.
  mv /data/agentpulse.db "/data/agentpulse.db.preempt-$(date -u +%Y%m%dT%H%M%SZ)" || true
  mv /data/agentpulse.db-wal /data/agentpulse.db-wal.preempt 2>/dev/null || true
  mv /data/agentpulse.db-shm /data/agentpulse.db-shm.preempt 2>/dev/null || true

  # Copy the backup in. sqlite3 .backup output has no WAL/SHM — it is a
  # fully-written, self-consistent DB file.
  cp /backups/agentpulse-<TS>.db /data/agentpulse.db

  # Verify the restored file.
  sqlite3 /data/agentpulse.db "PRAGMA integrity_check;"
  sqlite3 /data/agentpulse.db "SELECT count(*) FROM sessions; SELECT count(*) FROM events;"
'
```

Expected output: `ok` from integrity_check, followed by row counts matching
the `.counts.txt` file from Step 2.

### Step 6 — Delete the restore pod

```bash
kubectl delete pod agentpulse-restore -n <agentpulse-namespace>
```

### Step 7 — Scale the deployment back to one

```bash
kubectl scale deploy agentpulse -n <agentpulse-namespace> --replicas=1
kubectl rollout status deploy/agentpulse -n <agentpulse-namespace>
```

### Step 8 — Verify

1. Open the AgentPulse dashboard and confirm the sessions list loads.
2. Confirm settings round-trip (save a setting; reload; confirm it persisted).
3. Send a test hook event and confirm a new session appears.
4. Confirm the backup-sidecar restarted:
   ```bash
   kubectl logs -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar
   # Expected: "[backup-loop] next run in <N>s ..."
   ```
5. Note the session count vs the backup's `.counts.txt`. Any activity between
   the backup timestamp and the incident is lost — this is the documented
   tradeoff for a single-node SQLite deployment. The Postgres backend epic
   eliminates this gap.

---

## Backup PV reclaim policy

After the first `kubectl apply`, patch the PV backing `agentpulse-backups`
to `Retain` so that deleting the PVC does not immediately destroy backup data:

```bash
BACKUP_PV=$(kubectl -n <agentpulse-namespace> get pvc agentpulse-backups \
  -o jsonpath='{.spec.volumeName}')
kubectl patch pv "$BACKUP_PV" \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv "$BACKUP_PV" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'
# Expected: Retain
```

---

## NFS server setup (operator step — one time)

The `agentpulse-backups` PVC binds to an NFS-backed PV provisioned by the
cluster's `nfs` storage class. Before deploying, confirm:

0. **Preflight — storage class present:**
   ```bash
   kubectl get storageclass nfs
   ```
   If missing, the `agentpulse-backups` PVC will remain in `Pending` and
   block pod scheduling. Install `nfs-subdir-external-provisioner` (or
   equivalent) before applying the manifests.

1. The NFS server (`<synology-nfs-server>`) exposes an export at
   `<backup-export-path>` with permissions `rw,sync,no_subtree_check`.
2. `all_squash,anonuid=1000,anongid=1000` is set so the backup-sidecar
   (running as UID 1000) can write. Do **not** use `no_root_squash` — it
   grants root on the pod unnecessary NFS authority and is not required
   because the sidecar runs as UID 1000.
3. The `nfs` storage class is installed in the cluster (e.g. via
   `nfs-subdir-external-provisioner` or equivalent).

Concrete values (NFS server address, export path) belong in the gitignored
homelab overlay at `deploy/k8s-homelab/backup-sidecar-patch.yaml`.

---

## Restore runbook test log

> Operators: record each live restore test here (date, operator, test scope,
> outcome). This section intentionally uses a table rather than prose so
> it is easy to scan in an incident.

| Date | Operator | Test scope | Outcome |
|------|----------|------------|---------|
| (pending first live test) | — | — | — |

The first live test should be performed against a non-production namespace
(or with accepted brief downtime) before relying on this runbook in a real
incident. Update this table after the test.

---

## Image choice rationale

| Option | Verdict | Reason |
|--------|---------|--------|
| Runtime `apk add sqlite` as UID 1000 | Rejected | `apk` requires root; fails as non-root |
| Runtime `apk add sqlite` as root (initContainer) | Rejected | Adds root surface; requires live package mirrors |
| Prebuilt `agentpulse-backup:<SHA>` image | **Chosen** | Reproducible; no runtime network dep; runs as UID 1000; matches per-SHA-tag convention |
| Separate CronJob pod | Rejected | Cannot mount RWO PVC already claimed by live pod on different node |
| In-pod sidecar | **Chosen** | Same pod = same node = RWO PVC shared without scheduling conflict; no extra pod scheduling |
