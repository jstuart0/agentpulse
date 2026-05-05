# Authentik ForwardAuth — AgentPulse Trust Gate

This document describes how to configure the shared-secret trust gate between
Authentik and AgentPulse. The gate ensures that only requests that have cleared
Authentik forwardauth — not forged client requests or compromised sibling pods —
can assert an authenticated identity via `X-authentik-username`.

## Architecture

```
Browser → Traefik
  1. agentpulse-strip-client-authentik  (removes any client-supplied X-Authentik-* headers)
  2. agentpulse-forwardauth             (Authentik validates session; injects X-authentik-* in response)
  3. agentpulse-inject-verify           (Traefik adds X-Authentik-Verify shared secret)
→ AgentPulse pod                        (verifies X-Authentik-Verify against AGENTPULSE_AUTHENTIK_TRUST_SECRET)
```

Authentik injects identity headers (`X-authentik-username`, `X-authentik-email`, etc.) via the
forwardauth response. Traefik copies them onto the upstream request. The `agentpulse-inject-verify`
Traefik middleware then appends the shared secret as `X-Authentik-Verify`. AgentPulse reads that
header in `auth/middleware.ts` and only admits the identity if the value matches
`AGENTPULSE_AUTHENTIK_TRUST_SECRET`.

The strip middleware runs first so no client can forge any of these headers before forwardauth
evaluates the request.

## Step 1 — Generate the shared secret

```bash
openssl rand -hex 32
# Example: a3f1c2d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

You will use this value in two places: the Traefik middleware manifest and the agentpulse Secret.

## Step 2 — Store the secret in the agentpulse Kubernetes Secret

Add `AGENTPULSE_AUTHENTIK_TRUST_SECRET` to the `agentpulse-secrets` Secret with the generated value:

```bash
kubectl -n agentpulse patch secret agentpulse-secrets \
  --type='json' \
  -p='[{"op":"add","path":"/data/AGENTPULSE_AUTHENTIK_TRUST_SECRET","value":"'"$(echo -n '<your-secret>' | base64)"'"}]'
```

Or render a new Secret manifest and `kubectl apply` it.

The env var binding in `04-deployment.yaml` picks this up automatically (marked `optional: true`
so existing installs without the key configured continue to boot — the trust gate is simply not active
until the secret is present).

## Step 3 — Inject the secret into the Traefik middleware

The `agentpulse-inject-verify` Middleware in `06-middleware.yaml` has a placeholder empty value for
`X-Authentik-Verify`. **Do not commit a real secret to the base manifest.** Use a Kustomize patch in
your private overlay (e.g. `deploy/k8s-homelab/`) to override the value at apply time:

```yaml
# deploy/k8s-homelab/middleware-patch.yaml (gitignored)
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: agentpulse-inject-verify
  namespace: agentpulse
spec:
  headers:
    customRequestHeaders:
      X-Authentik-Verify: "<your-generated-secret>"
```

Add this patch to your `kustomization.yaml`:

```yaml
patches:
  - path: middleware-patch.yaml
    target:
      kind: Middleware
      name: agentpulse-inject-verify
```

Then apply via your overlay:

```bash
kubectl apply -k deploy/k8s-homelab/
```

## Step 4 — Verify the IngressRoute middleware chain

The `07-ingressroute.yaml` protected catch-all route must use this three-middleware chain in order:

```yaml
middlewares:
  - name: agentpulse-strip-client-authentik   # 1st — strips client-forged X-Authentik-* headers
    namespace: agentpulse
  - name: agentpulse-forwardauth              # 2nd — Authentik validates session; injects identity headers
    namespace: agentpulse
  - name: agentpulse-inject-verify            # 3rd — Traefik adds X-Authentik-Verify shared secret
    namespace: agentpulse
```

This is already wired in the base `07-ingressroute.yaml` as of `dc94356`. No changes to this file
are needed unless you are customizing the IngressRoute via a private overlay.

## Step 5 — Restart agentpulse

```bash
kubectl -n agentpulse rollout restart deployment/agentpulse
kubectl -n agentpulse rollout status deployment/agentpulse
```

## Verification

```bash
# 1. Confirm /api/v1/auth/me returns JSON (not a 302 or 401) — login page depends on this.
curl -s https://agentpulse.example.com/api/v1/auth/me
# Expected: {"authenticated":false,...} (or the current user if already signed in)

# 2. Forged X-Authentik-Verify should be stripped before forwardauth evaluates the request.
#    Unauthenticated requests redirect to Authentik.
curl -I -H "X-Authentik-Verify: anything" https://agentpulse.example.com/
# Expected: 302 to Authentik login

# 3. Direct-to-pod bypass attempt (no Traefik inject-verify, no forwardauth):
kubectl -n agentpulse port-forward svc/agentpulse 9999:3000 &
curl -H "X-authentik-username: attacker" http://localhost:9999/api/v1/sessions
# Expected: 401 (no X-Authentik-Verify; agentpulse strips X-Authentik-* and falls through)

# 4. Check logs for trust gate events:
kubectl -n agentpulse logs -l app=agentpulse | grep authentik_trust_gate
```

## Secret rotation

Rotation touches only the Traefik middleware (via your private overlay) and the agentpulse Secret.
No changes to Authentik are needed.

1. Generate a new secret: `openssl rand -hex 32`
2. Update the `agentpulse-inject-verify` Middleware in your private overlay with the new value.
3. Update `AGENTPULSE_AUTHENTIK_TRUST_SECRET` in `agentpulse-secrets`.
4. Apply the overlay: `kubectl apply -k deploy/k8s-homelab/`
5. Restart agentpulse: `kubectl -n agentpulse rollout restart deployment/agentpulse`

During the brief window between manifest apply and pod restart, requests authenticated via the
Authentik forwardauth path are treated as unauthenticated (trust gate rejects the old secret).
Session cookie and API key auth are unaffected.

---

## Appendix — Why not an Authentik property mapping?

The obvious alternative — configuring Authentik to emit `X-Authentik-Verify` via a Proxy Property
Mapping — does not work for this use case. Authentik's Proxy Property Mappings populate the OAuth2
JWT (`id_token` claims), not the forwardauth response headers that Traefik reads and copies upstream.

Concretely: setting a property mapping with `{"X-Authentik-Verify": "<secret>"}` causes Authentik to
include the value in the OIDC id_token JWT. It does **not** cause Authentik to emit an
`X-Authentik-Verify` header in the forwardauth (`/outpost.goauthentik.io/auth/traefik`) response.
The `authResponseHeaders` list in the forwardauth Middleware tells Traefik which headers to copy from
Authentik's response onto the upstream request — but if Authentik never emits the header, there is
nothing to copy.

The Traefik `headers` middleware approach is the straightforward path: it runs after forwardauth
passes (blocking unauthenticated requests), and the strip middleware prevents clients from forging
the header before forwardauth runs. The shared secret remains defense-in-depth: even if a sibling
pod could reach AgentPulse upstream of Traefik, it would also need to know the secret.

References: `dc94356`, `b0f16ea`
