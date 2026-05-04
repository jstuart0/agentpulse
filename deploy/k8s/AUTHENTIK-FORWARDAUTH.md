# Authentik ForwardAuth — AgentPulse Trust Gate

This document describes how to configure the shared-secret trust gate between
Authentik and AgentPulse. The gate ensures that only Authentik — not a forged
client request or a compromised sibling pod — can assert an authenticated
identity via `X-Authentik-Username`.

## Architecture

```
Browser → Traefik → strip-client-authentik middleware (removes all X-Authentik-* from request)
       → forwardAuth middleware (Authentik validates session, re-injects X-Authentik-* in response)
       → AgentPulse pod (verifies X-Authentik-Verify against AGENTPULSE_AUTHENTIK_TRUST_SECRET)
```

Traefik holds no secret. It only strips incoming client headers and copies
Authentik's response headers onto the upstream request. The trust verification
is purely between Authentik and the AgentPulse process.

## Step 1 — Generate the shared secret

```bash
openssl rand -hex 32
# Example output: a3f1c2d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

Keep this value — you will use it in both Authentik and the agentpulse Secret.

## Step 2 — Configure Authentik property mapping

1. Log into Authentik Admin at `https://<authentik-host>/if/admin/`.
2. Navigate to **Customisation → Property Mappings**.
3. Click **Create** and select **Proxy Property Mapping**.
4. Fill in:
   - **Name**: `agentpulse-verify-header`
   - **Property name**: `X-Authentik-Verify`
   - **Expression**:
     ```python
     return "<your-generated-secret>"
     ```
     Replace `<your-generated-secret>` with the value from Step 1.
5. Click **Save**.

> Authentik 2024.x documents outbound proxy header injection via property
> mappings at https://goauthentik.io/docs/providers/proxy/header-authentication

## Step 3 — Bind the property mapping to the AgentPulse proxy provider

1. In Authentik Admin, navigate to **Applications → Providers**.
2. Open the provider bound to the agentpulse application (likely named
   `agentpulse` or `agentpulse-proxy`).
3. Under **Advanced protocol settings → Property mappings**, add the
   `agentpulse-verify-header` mapping you created in Step 2.
4. Click **Save**.

Authentik will now include `X-Authentik-Verify: <secret>` in every
forwardAuth response for authenticated sessions.

## Step 4 — Store the secret in the agentpulse Kubernetes Secret

Update the agentpulse Secret (`deploy/k8s/01-secret-template.yaml`) with the
generated value and re-apply it:

```bash
kubectl -n agentpulse edit secret agentpulse-secrets
# Set AGENTPULSE_AUTHENTIK_TRUST_SECRET to your generated secret
```

Or apply a re-rendered Secret manifest.

## Step 5 — Verify Traefik middleware order

The `07-ingressroute.yaml` middleware chain for the protected dashboard route
must be:

```yaml
middlewares:
  - name: agentpulse-strip-client-authentik   # runs FIRST — strips client-forged headers
    namespace: agentpulse
  - name: agentpulse-forwardauth              # runs SECOND — Authentik re-injects trusted headers
    namespace: agentpulse
```

The strip middleware is defined in `06-middleware.yaml`. No changes to Traefik
itself are required beyond applying the updated manifests.

## Step 6 — Restart agentpulse

```bash
kubectl -n agentpulse rollout restart deployment/agentpulse
kubectl -n agentpulse rollout status deployment/agentpulse
```

## Verification

```bash
# From outside the cluster — forged header should be rejected (or stripped before reach)
curl -H "X-Authentik-Verify: anything" \
     -H "X-authentik-username: attacker" \
     https://agentpulse.example.com/api/v1/sessions
# Expected: 401 Unauthorized (Traefik strips both headers before forwardAuth;
#           forwardAuth redirects to login)

# Direct-to-pod (bypassing Traefik) — trust gate in agentpulse middleware fires
kubectl -n agentpulse port-forward svc/agentpulse 9999:3000 &
curl -H "X-authentik-username: attacker" http://localhost:9999/api/v1/sessions
# Expected: 401 (no X-Authentik-Verify; agentpulse strips X-Authentik-* and falls through)

# Check agentpulse logs for the structured warning on mismatch
kubectl -n agentpulse logs -l app=agentpulse | grep authentik_trust_gate_rejected
```

## Secret rotation

Rotation touches only Authentik and the agentpulse Secret. Traefik is not
restarted and holds no copy of the secret.

1. Generate a new secret: `openssl rand -hex 32`
2. **Update Authentik**: open Admin → Customisation → Property Mappings →
   `agentpulse-verify-header` and replace the expression value. Save.
3. **Update agentpulse Secret**: set `AGENTPULSE_AUTHENTIK_TRUST_SECRET` to
   the new value.
4. **Restart agentpulse**: `kubectl -n agentpulse rollout restart deployment/agentpulse`
5. **(Optional)** If the Authentik property mapping change does not take effect
   immediately in your version, restart the Authentik outpost deployment:
   `kubectl -n authentik rollout restart deployment/<authentik-outpost>`
   Recent Authentik releases reload property mappings live without a restart.
6. **Traefik is unchanged.** Do NOT restart Traefik. It holds no secret.

During the brief window between Authentik update and agentpulse restart,
requests authenticated via the header trust path are treated as unauthenticated
(headers stripped). Session cookie and API key auth are unaffected.

## Appendix A — Fallback: signing sidecar (if property mappings are unavailable)

If your Authentik version does not support outbound property-mapping headers,
a thin signing sidecar can be added to the agentpulse pod. The sidecar runs on
localhost, reads the Secret-mounted value, and rewrites the request before it
reaches the bun process. This approach is not pre-built — document it here as
Plan B and implement only if the Authentik-native option (Option 1 above) is
unavailable on your version.
