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
| `06-middleware.yaml` | Traefik middlewares (forwardAuth, strip, HTTPS redirect, rate limit) |
| `07-ingressroute.yaml` | Traefik IngressRoute (HTTPS + HTTP→HTTPS redirect) |
| `08-limitrange.yaml` | Namespace LimitRange (default container resource envelope) |
| `09-resourcequota.yaml` | Namespace ResourceQuota (cluster guardrails) |
| `10-networkpolicy.yaml` | NetworkPolicy (ingress restricted to Traefik namespace) |
| `11-serviceaccount.yaml` | ServiceAccount with no auto-mounted token |

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
kubectl apply -f deploy/k8s/
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

# Private homelab registry
REGISTRY=192.168.10.222:30500 ./scripts/build-and-push.sh
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
   Adjust the CIDR to match your node subnet when deploying outside the homelab.

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
