# Kubernetes deployment

The `k8s/` directory is an **OSS-clean Kustomize base**. Every value
that's environment-specific is a placeholder:

| Placeholder | Where | What it stands for |
|-------------|-------|--------------------|
| `ghcr.io/YOUR_ORG/agentpulse:latest` | `04-deployment.yaml` | Your container registry |
| `agentpulse.example.com` | `07-ingressroute.yaml` | Your public hostname |
| `your-postgres-host` | `01-secret-template.yaml` | Your Postgres host (only if you use Postgres) |
| `agentpulse-tls` | `07-ingressroute.yaml` | The `kubernetes.io/tls` Secret Traefik should use |

Applying the base directly (`kubectl apply -k deploy/k8s/`) **will not
work** — the placeholder image isn't pullable. Write a thin overlay
instead.

## Overlay pattern

```
deploy/
├── k8s/                     # OSS base (committed)
│   ├── kustomization.yaml
│   ├── 00-namespace.yaml
│   └── …
└── k8s-<name>/              # Your overlay (gitignored — see .gitignore)
    ├── kustomization.yaml
    ├── deployment-patch.yaml
    └── ingressroute-patch.yaml
```

### `kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: agentpulse

resources:
  - ../k8s

patches:
  - path: deployment-patch.yaml
    target:
      kind: Deployment
      name: agentpulse
  - path: ingressroute-patch.yaml
    target:
      kind: IngressRoute
      name: agentpulse-https
```

### `deployment-patch.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentpulse
spec:
  template:
    spec:
      containers:
        - name: agentpulse
          image: registry.mycompany.internal/agentpulse:latest
```

### `ingressroute-patch.yaml`

Replace the full `spec` so the hostname rewrites apply to every rule.

Apply:

```bash
kubectl apply -k deploy/k8s-<name>/
```

## Secrets

`01-secret-template.yaml` is **excluded** from the base kustomization
on purpose — otherwise `kubectl apply -k` would stomp a real Secret
with dummy values. Create the Secret out-of-band, or generate it from
your overlay via `secretGenerator`.

## Why `deploy/k8s-*/` is gitignored

The overlay is exactly the place private values (image registry,
cluster DNS, TLS secret name) need to live. Keeping the pattern
gitignored makes it structurally impossible to commit them by
accident — including all leakage paths `grep` wouldn't catch.
