# Runbook: Forwardauth Trust Secret Rotation

This runbook covers rotation of `FORWARDAUTH_TRUST_SECRET` — the shared secret
used to verify that SSO headers arriving at the AgentPulse pod genuinely came
from the upstream forwardauth IdP (not a spoofed request that bypassed forwardAuth).

The deprecated alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` is accepted for one
release and is bound to the same Kubernetes Secret field. Operators using the
legacy name do not need to rename their secret — but doing so now avoids confusion.

**Traefik holds this secret** via the `agentpulse-inject-verify` middleware, patched
into your private overlay (`deploy/k8s-homelab/middleware-patch.yaml`). Rotation must
update BOTH the `agentpulse-secrets` Kubernetes Secret AND the `agentpulse-inject-verify`
overlay patch with identical values — if they diverge, the trust gate rejects every
forwardauth request and SSO breaks. Brief downtime (one pod restart) is expected and
acceptable. Zero-downtime rotation is out of scope for homelab deployments.

See `deploy/k8s/FORWARDAUTH.md` for the initial setup and the full explanation
of how the header trust gate works.

---

## When to rotate

- Suspected exposure of the secret (e.g. secret appeared in logs, was committed to git)
- Routine periodic rotation (e.g. every 90 days)
- After any compromise of the upstream IdP admin account

---

## Steps

### 1. Generate a new secret

```bash
openssl rand -base64 32
# Example output (do not use this value):
# xK9mP2vQrLnBhJdEsWuYfGtAcOiZkXpN7R1aV4yD=
```

Copy the output. This is your new `FORWARDAUTH_TRUST_SECRET`.

### 2. Update the Traefik inject-verify middleware

The `agentpulse-inject-verify` Traefik middleware injects the secret as a header
on every request that has cleared forwardauth. Update the value in your private
overlay and apply it.

```yaml
# deploy/k8s-homelab/middleware-patch.yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: agentpulse-inject-verify
  namespace: agentpulse
spec:
  headers:
    customRequestHeaders:
      X-Authentik-Verify: "<new-secret-here>"
```

Apply:

```bash
kubectl apply -k deploy/k8s-homelab/
```

#### Provider: Authentik

If you use Authentik and previously configured a property mapping to emit the
secret (an approach that does not work — see the appendix in `FORWARDAUTH.md`),
you do **not** need to touch Authentik for rotation. The secret is injected by
the Traefik `headers` middleware, not by the IdP.

If your Authentik outpost was emitting a verify header via some other mechanism,
update it now to emit the new secret value:

1. Log in to the Authentik admin console.
2. Navigate to **Customisation → Property Mappings**.
3. Find the mapping named `agentpulse-verify-header` (or your equivalent).
4. Update the expression to return the new secret value:
   ```python
   return "<new-secret-here>"
   ```
5. Save the mapping.
6. Navigate to **Applications → Providers → agentpulse (Proxy Provider)**.
7. Click **Update** to force the outpost to reload the mapping. If the outpost does
   not pick up the change automatically within 30 seconds, restart it:
   ```bash
   kubectl -n authentik rollout restart deployment/authentik-outpost
   kubectl -n authentik rollout status deployment/authentik-outpost
   ```

### 3. Update the AgentPulse Kubernetes Secret

```bash
kubectl -n agentpulse create secret generic agentpulse-secrets \
  --from-literal=FORWARDAUTH_TRUST_SECRET="<new-secret-here>" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Verify the secret was updated:

```bash
kubectl -n agentpulse get secret agentpulse-secrets \
  -o jsonpath='{.data.FORWARDAUTH_TRUST_SECRET}' \
  | base64 -d | wc -c
# Should print a non-zero byte count (>= 32)
```

Both env vars (`FORWARDAUTH_TRUST_SECRET` and the deprecated
`AGENTPULSE_AUTHENTIK_TRUST_SECRET`) are bound to the same secret key, so
updating the key once updates both env vars in the pod.

### 4. Restart the AgentPulse pod

```bash
kubectl -n agentpulse rollout restart deployment/agentpulse
kubectl -n agentpulse rollout status deployment/agentpulse
```

### 5. Verify

Test that SSO login still works by opening the dashboard URL in a browser. You
should be redirected to the IdP, authenticate, and land on the dashboard.

If SSO fails after rotation:

- Check AgentPulse logs for trust gate events:
  ```bash
  kubectl -n agentpulse logs deployment/agentpulse | grep -i "trust_gate"
  ```
- Verify the inject-verify middleware was updated and the overlay applied.
- Confirm the new secret value is identical in both the middleware overlay and
  the k8s Secret (no trailing newlines or encoding differences).

---

## Rollback

If the new secret causes problems, repeat steps 2–4 with the previous secret value.
The previous secret should be in your password manager (Vaultwarden or equivalent).

---

## Notes

- The secret is transmitted in-cluster as an HTTP header on the hop from Traefik to
  the AgentPulse pod. This is unencrypted unless your cluster enables mTLS between
  all pods (e.g. via a service mesh). The `deploy/k8s/10-networkpolicy.yaml`
  restricts ingress to the Traefik namespace, bounding the exposure surface to
  compromised sibling pods in that namespace.
- AgentPulse strips all IdP identity headers and treats the request as unauthenticated
  when the secret is missing, wrong length, or mismatched. It never returns the secret
  or any hint of its value in responses.
- Store the active secret in your password manager. The k8s Secret is the runtime
  source of truth; the password manager is the backup.
