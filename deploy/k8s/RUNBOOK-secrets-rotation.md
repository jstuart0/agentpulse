# Runbook: Authentik Trust Secret Rotation

This runbook covers rotation of the `AGENTPULSE_AUTHENTIK_TRUST_SECRET` — the shared
secret used to verify that SSO headers arriving at the AgentPulse pod genuinely came
from Authentik (not a spoofed request that bypassed forwardAuth).

**Traefik holds no part of this secret.** Rotation only touches Authentik and AgentPulse.
Brief downtime (one pod restart) is expected and acceptable. Zero-downtime rotation is
out of scope for homelab deployments.

See `deploy/k8s/AUTHENTIK-FORWARDAUTH.md` for the initial setup and the full explanation
of how the header trust gate works.

---

## When to rotate

- Suspected exposure of the secret (e.g. secret appeared in logs, was committed to git)
- Routine periodic rotation (e.g. every 90 days)
- After any compromise of the Authentik admin account

---

## Steps

### 1. Generate a new secret

```bash
openssl rand -base64 32
# Example output (do not use this value):
# xK9mP2vQrLnBhJdEsWuYfGtAcOiZkXpN7R1aV4yD=
```

Copy the output. This is your new `AGENTPULSE_AUTHENTIK_TRUST_SECRET`.

### 2. Update the Authentik property mapping

The property mapping emits the secret value as the `X-Authentik-Verify` header.

1. Log in to the Authentik admin console.
2. Navigate to **Customisation → Property Mappings**.
3. Find the mapping named `agentpulse-verify-header` (or your equivalent name).
4. Update the expression to return the new secret value:
   ```python
   return "<new-secret-here>"
   ```
5. Save the mapping.
6. Navigate to **Applications → Providers → agentpulse (Proxy Provider)**.
7. Click **Update** to force the outpost to reload the mapping. If the outpost does
   not pick up the change automatically within 30 seconds, restart the Authentik
   outpost pod:
   ```bash
   kubectl -n authentik rollout restart deployment/authentik-outpost
   kubectl -n authentik rollout status deployment/authentik-outpost
   ```

### 3. Update the AgentPulse Kubernetes Secret

```bash
kubectl -n agentpulse create secret generic agentpulse-secrets \
  --from-literal=AGENTPULSE_AUTHENTIK_TRUST_SECRET="<new-secret-here>" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Verify the secret was updated:

```bash
kubectl -n agentpulse get secret agentpulse-secrets -o jsonpath='{.data.AGENTPULSE_AUTHENTIK_TRUST_SECRET}' \
  | base64 -d | wc -c
# Should print a non-zero byte count (≥ 32)
```

### 4. Restart the AgentPulse pod

```bash
kubectl -n agentpulse rollout restart deployment/agentpulse
kubectl -n agentpulse rollout status deployment/agentpulse
```

### 5. Verify

Test that SSO login still works by opening the dashboard URL in a browser. You
should be redirected to Authentik, authenticate, and land on the dashboard.

If SSO fails after rotation:

- Check AgentPulse logs for `[security] Authentik trust secret mismatch`:
  ```bash
  kubectl -n agentpulse logs deployment/agentpulse | grep -i "authentik"
  ```
- Verify the Authentik outpost reloaded the mapping (step 2 above).
- Confirm the new secret value is identical in both Authentik and the k8s Secret
  (no trailing newlines or encoding differences).

---

## Rollback

If the new secret causes problems, repeat steps 2–4 with the previous secret value.
The previous secret should be in your password manager (Vaultwarden or equivalent).

---

## Notes

- The secret is transmitted in-cluster as the `X-Authentik-Verify` HTTP header on
  the HTTP hop from Traefik to the AgentPulse pod. This is unencrypted unless
  your cluster enables mTLS between all pods (e.g. via a service mesh). The
  `deploy/k8s/10-networkpolicy.yaml` restricts ingress to the Traefik namespace,
  bounding the exposure surface to compromised sibling pods in that namespace.
- AgentPulse strips all Authentik identity headers and treats the request as
  unauthenticated when the secret is missing, wrong length, or mismatched. It
  never returns the secret or any hint of its value in responses.
- Store the active secret in your password manager. The k8s Secret is the
  runtime source of truth; the password manager is the backup.
