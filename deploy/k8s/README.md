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

## Storage stance and backup architecture (C3)

**SQLite stays on local block storage.** WAL mode (enabled via `PRAGMA journal_mode = WAL`) requires
shared-memory semantics that break on network filesystems (NFS, network-mounted Ceph, etc.). Relocating
the live `agentpulse.db` to an NFS-backed PVC causes silent corruption. See:
https://www.sqlite.org/wal.html#noshm

**Do NOT change `agentpulse-data` to an NFS-backed storage class.** The live DB must remain on a
local block storage class (e.g. `local-path`).

**Durability via backup sidecar.** The `agentpulse` pod includes a `backup-sidecar` container that:
- Wakes at 04:15 UTC daily and calls `sqlite3 /data/agentpulse.db ".backup /backups/agentpulse-<TS>.db"`.
- The `.backup` command is concurrent-safe — the app keeps writing during the backup.
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
before deploying, or accept periodic manual cleanup. Retention/VACUUM
automation and a PVC default-size policy are tracked as follow-ups (not yet
implemented); until then, sizing is an operator decision per deployment.

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
| `agentpulse-strip-client-authentik` | **Deprecated alias** — same spec; kept for one release so existing overlays referencing the old name continue to work. Removed next release. |
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
