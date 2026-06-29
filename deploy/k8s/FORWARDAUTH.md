# ForwardAuth — AgentPulse Trust Gate

AgentPulse SSO works with any forwardauth-capable identity provider. The
mechanism (strip → forwardauth → inject-verify) is provider-agnostic; only the
HTTP header names differ between IdPs, and those are configurable via
`FORWARDAUTH_HEADER_*` env vars with Authentik defaults.

This document covers:

- Generic concepts (trust-gate model, the three-middleware chain, env-var table)
- Provider-specific configuration: Authentik (default), Authelia, oauth2-proxy,
  Pomerium, Cloudflare Access

---

## Architecture

```
Browser → Traefik
  1. agentpulse-strip-client-forwardauth  (removes any client-supplied IdP headers)
  2. agentpulse-forwardauth               (IdP validates session; injects identity headers in response)
  3. agentpulse-inject-verify             (Traefik adds FORWARDAUTH_TRUST_SECRET as a verify header)
→ AgentPulse pod                          (verifies the trust header against FORWARDAUTH_TRUST_SECRET)
```

The strip middleware runs **first** so no client can forge identity headers before
forwardauth evaluates the request. The forwardauth middleware validates the session
and injects identity headers (username, email, groups, etc.) via its HTTP response.
Traefik copies those headers onto the upstream request. The inject-verify middleware
then appends a shared secret in a dedicated header. AgentPulse reads that header in
`src/server/auth/middleware.ts` and only admits the identity if the value matches
`FORWARDAUTH_TRUST_SECRET`.

### Why the verify header?

Defense-in-depth: even if a sibling pod could forge identity headers upstream of
Traefik (e.g. via a compromised CNI), it would also need to know the shared secret to
fool AgentPulse's trust gate. The verify header is not emitted by the IdP — it is
injected by the Traefik `headers` middleware **after** forwardauth passes, so it is
only present on requests that have already cleared the IdP gate.

---

## Session bridge

After a request passes the forwardauth trust gate, `bridgeForwardauthSession`
(`src/server/auth/forwardauth-bridge.ts`) mints an `ap_session` cookie so
`/api/v1/auth/me` and WebSocket upgrades — which deliberately bypass forwardauth in
the IngressRoute — can resolve the SSO identity through the existing cookie step.

Ticket: AGEN-5
Commits: c5b68e0 (schema), 801f5cc (resolver+Bearer), 7f650de (route-split), 813921c (bridge), 6e02f85 (frontend+warning)

### Why /auth/me stays off forwardauth

`/api/v1/auth/me`, `/auth/login`, `/auth/logout`, and `/auth/signup` have their own
IngressRoute rules without the forwardauth middleware chain, by design:
- The login page needs to reach `/auth/me` unauthenticated to render correctly.
- Local-auth (username/password) fallback must remain reachable for non-SSO users.

These endpoints MUST stay off forwardauth. If moved behind it, the bridge and the
auth handler would both set `ap_session` on the same request, silently breaking SSO.

### Cookie attributes

The `ap_session` cookie minted by the bridge:
- `HttpOnly`, `Secure` (production only), `SameSite=Lax`, `Path=/`
- `MaxAge` = `AGENTPULSE_SSO_SESSION_DURATION_MS / 1000` (default 28800 s = 8 h)

No sliding renewal. The expiry is fixed at mint time. After expiry, the next navigation
through the forwardauth catch-all re-mints a fresh session. Tune the TTL with
`AGENTPULSE_SSO_SESSION_DURATION_MS` (milliseconds). Shorter TTL bounds the
post-IdP-revocation window; longer TTL reduces re-mint frequency.

Mint is skipped when the existing cookie already matches the current subject and
provider (resolve-then-mint). All other cases — no cookie, expired, different subject,
different provider, local session — result in a fresh mint.

### SSO session properties

SSO sessions are non-admin. `/auth/me` returns:

```json
{ "source": "forwardauth", "provider": "<FORWARDAUTH_PROVIDER value>", "role": null }
```

No shadow `users` row is created. Identity is stored on the `auth_sessions` row via
four additive columns (`auth_source`, `sso_subject`, `sso_username`, `provider`). Local
sessions see `auth_source = "local"` and null SSO columns.

### Supervisor endpoint split

Management endpoints (list, get, enroll, rotate, revoke) are at
`/api/v1/admin/supervisors/*`. This prefix is not in the IngressRoute exemption list,
so it falls through to the forwardauth catch-all: SSO browser requests carry live IdP
headers, giving immediate revocation effect.

Machine-agent endpoints (register, heartbeat, launch/claim, control-actions) remain at
edge-public `/api/v1/supervisors/*` with supervisor-credential auth. Remote machines
cannot hold an SSO session cookie; they must never be behind forwardauth.

### Bearer API key precedence

When a request presents `Authorization: Bearer ap_*`, that credential is the only one
consulted:
- Valid key → `{ source: "api_key" }`
- Invalid or unknown key → **401; the cookie is not consulted**

This prevents a stale or bridged `ap_session` cookie from authorizing a request that
passed Traefik's edge Bearer-bypass rule with an invalid key.

### WebSocket limitation

WS upgrades use the `ap_session` cookie minted during the prior SPA document load. The
bridge does not run on WS upgrades (no HTML response to set the cookie on). If the SSO
cookie expires while a WS session is open, the WS session continues until disconnect;
it is not re-validated mid-stream.

### Trust secret requirement

The bridge only mints when the trust gate passes. If `agentpulse-inject-verify` is
deployed with the base placeholder (`X-Authentik-Verify: ""`), Traefik interprets the
empty string as "delete this header" — AgentPulse never receives the verify header, the
trust gate rejects every request, and no cookie is minted. SSO is non-functional
regardless of any code changes. See Step 3 in the Authentik section below for the
private overlay injection pattern.

---

## Env vars

Configure these in `agentpulse-secrets` (for the trust secret) and `agentpulse-config`
(for the header names and provider label). All have Authentik defaults; operators
upgrading without env changes see identical behaviour.

| Variable | Default | Description |
|---|---|---|
| `FORWARDAUTH_TRUST_SECRET` | _(empty)_ | Shared secret for the header trust gate. Generate with `openssl rand -hex 32`. Also accepts the deprecated alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` for one release. |
| `FORWARDAUTH_PROVIDER` | `authentik` | Provider label (used in `/auth/me` response and dashboard UI). Free-form string; only `"authentik"` triggers the Authentik sign-out URL. |
| `FORWARDAUTH_HEADER_USERNAME` | `X-Authentik-Username` | Header carrying the authenticated username. |
| `FORWARDAUTH_HEADER_EMAIL` | `X-Authentik-Email` | Header carrying the authenticated email address. |
| `FORWARDAUTH_HEADER_GROUPS` | `X-Authentik-Groups` | Header carrying group memberships. |
| `FORWARDAUTH_HEADER_NAME` | `X-Authentik-Name` | Header carrying the user's display name. |
| `FORWARDAUTH_HEADER_UID` | `X-Authentik-Uid` | Header carrying the unique user identifier. |
| `FORWARDAUTH_HEADER_VERIFY` | `X-Authentik-Verify` | Header used to carry the trust secret from Traefik to AgentPulse. Set this to match the header name you inject in `agentpulse-inject-verify`. |
| `FORWARDAUTH_HEADER_STRIP_PREFIX` | `X-Authentik-` | Prefix of headers stripped before forwardauth runs. Set to the common prefix of your IdP's identity headers. |

The deployment manifest (`04-deployment.yaml`) also binds the deprecated
`AGENTPULSE_AUTHENTIK_TRUST_SECRET` env var to the same secret key as
`FORWARDAUTH_TRUST_SECRET` for one release. Operators rotating their secret update
one Kubernetes Secret field; both env vars receive the new value.

The `agentpulse-config` ConfigMap (`02-configmap.yaml`) includes all eight
`FORWARDAUTH_HEADER_*` and `FORWARDAUTH_PROVIDER` keys as commented-out
reference entries. Uncomment and set the values to override the defaults.

---

## Provider: Authentik (default homelab setup)

Authentik is the documented default. With no env overrides, AgentPulse reads the
Authentik identity headers (`X-Authentik-*`) with no configuration needed.

### Step 1 — Generate the shared secret

```bash
openssl rand -hex 32
# Example: a3f1c2d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

Use this value in two places: the Traefik middleware manifest and the agentpulse Secret.

### Step 2 — Store the secret in the agentpulse Kubernetes Secret

Add `FORWARDAUTH_TRUST_SECRET` to the `agentpulse-secrets` Secret:

```bash
kubectl -n agentpulse patch secret agentpulse-secrets \
  --type='json' \
  -p='[{"op":"add","path":"/data/FORWARDAUTH_TRUST_SECRET","value":"'"$(echo -n '<your-secret>' | base64)"'"}]'
```

The env var binding in `04-deployment.yaml` picks this up automatically
(`optional: true` so existing installs without the key configured continue to boot
— the trust gate is simply not active until the secret is present).

The deprecated key name `AGENTPULSE_AUTHENTIK_TRUST_SECRET` also works for one
release and is bound to the same secret field in `04-deployment.yaml`.

### Step 3 — Inject the secret into the Traefik middleware

The `agentpulse-inject-verify` Middleware in `06-middleware.yaml` has a placeholder
empty value for `X-Authentik-Verify`. **Do not commit a real secret to the base
manifest.** Use a Kustomize patch in your private overlay:

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

### Step 4 — Verify the IngressRoute middleware chain

The `07-ingressroute.yaml` protected catch-all route uses this three-middleware chain
in order:

```yaml
middlewares:
  - name: agentpulse-strip-client-forwardauth   # 1st — strips client-forged IdP headers
    namespace: agentpulse
  - name: agentpulse-forwardauth                # 2nd — Authentik validates session; injects identity headers
    namespace: agentpulse
  - name: agentpulse-inject-verify              # 3rd — Traefik adds X-Authentik-Verify shared secret
    namespace: agentpulse
```

This is already wired in the base `07-ingressroute.yaml`. No changes to this file
are needed unless you are customising the IngressRoute via a private overlay.

### Step 5 — Restart agentpulse

```bash
kubectl -n agentpulse rollout restart deployment/agentpulse
kubectl -n agentpulse rollout status deployment/agentpulse
```

### Appendix — Why not an Authentik property mapping?

The obvious alternative — configuring Authentik to emit `X-Authentik-Verify` via a
Proxy Property Mapping — does not work for this use case. Authentik's Proxy Property
Mappings populate the OAuth2 JWT (`id_token` claims), not the forwardauth response
headers that Traefik reads and copies upstream.

Concretely: setting a property mapping with `{"X-Authentik-Verify": "<secret>"}` causes
Authentik to include the value in the OIDC id_token JWT. It does **not** cause Authentik
to emit an `X-Authentik-Verify` header in the forwardauth
(`/outpost.goauthentik.io/auth/traefik`) response. The `authResponseHeaders` list in the
forwardauth Middleware tells Traefik which headers to copy from Authentik's response onto
the upstream request — but if Authentik never emits the header, there is nothing to copy.

The Traefik `headers` middleware approach is the straightforward path: it runs after
forwardauth passes (blocking unauthenticated requests), and the strip middleware prevents
clients from forging the header before forwardauth runs. The shared secret remains
defense-in-depth: even if a sibling pod could reach AgentPulse upstream of Traefik, it
would also need to know the secret.

References: `dc94356`, `b0f16ea`

---

## Provider: Authelia

Authelia uses `Remote-*` headers for identity. The verify header is the operator's
choice — Authelia does not emit a built-in verify header, so you create one via the
`agentpulse-inject-verify` Traefik middleware (same mechanism as Authentik).

Override these env vars in your `agentpulse-config` ConfigMap (uncomment the entries):

```yaml
FORWARDAUTH_PROVIDER: "authelia"
FORWARDAUTH_HEADER_USERNAME: "Remote-User"
FORWARDAUTH_HEADER_EMAIL: "Remote-Email"
FORWARDAUTH_HEADER_GROUPS: "Remote-Groups"
FORWARDAUTH_HEADER_NAME: "Remote-Name"
FORWARDAUTH_HEADER_UID: "Remote-User"    # Authelia has no dedicated UID header; use username
FORWARDAUTH_HEADER_VERIFY: "X-AgentPulse-Verify"   # your chosen verify header name
FORWARDAUTH_HEADER_STRIP_PREFIX: "Remote-"
```

Override the forwardauth address in `06-middleware.yaml` via your overlay:

```yaml
# deploy/k8s-homelab/middleware-patch.yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: agentpulse-forwardauth
  namespace: agentpulse
spec:
  forwardAuth:
    address: http://authelia.authelia.svc.cluster.local/api/verify?rd=https://your-authelia.example.com
    trustForwardHeader: true
    authResponseHeaders:
      - Remote-User
      - Remote-Email
      - Remote-Groups
      - Remote-Name
      - X-AgentPulse-Verify    # must match FORWARDAUTH_HEADER_VERIFY
```

Also patch `agentpulse-strip-client-forwardauth` to strip `Remote-*` headers instead of
`X-Authentik-*` (since `customRequestHeaders` strips by exact name, not prefix — set each
header to `""`).

See the [Authelia documentation](https://www.authelia.com/integration/proxies/traefik/)
for the complete Traefik integration guide.

---

## Provider: oauth2-proxy

oauth2-proxy injects `X-Auth-Request-*` headers. The verify mechanism is the same
`agentpulse-inject-verify` approach.

```yaml
FORWARDAUTH_PROVIDER: "oauth2-proxy"
FORWARDAUTH_HEADER_USERNAME: "X-Auth-Request-User"
FORWARDAUTH_HEADER_EMAIL: "X-Auth-Request-Email"
FORWARDAUTH_HEADER_GROUPS: "X-Auth-Request-Groups"
FORWARDAUTH_HEADER_NAME: "X-Auth-Request-User"    # oauth2-proxy has no display-name header by default
FORWARDAUTH_HEADER_UID: "X-Auth-Request-User"
FORWARDAUTH_HEADER_VERIFY: "X-AgentPulse-Verify"
FORWARDAUTH_HEADER_STRIP_PREFIX: "X-Auth-Request-"
```

Override `agentpulse-forwardauth` middleware address to your oauth2-proxy service and
set `authResponseHeaders` accordingly. The strip middleware requires exact header names
(set each `X-Auth-Request-*` you use to `""`).

See the [oauth2-proxy documentation](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview)
for the upstream service URL and header configuration options.

---

## Provider: Pomerium

Pomerium passes identity via JWT claims in the `X-Pomerium-Jwt-Assertion` header, but
also emits plain headers for common claims when configured with `pass_identity_headers`.

```yaml
FORWARDAUTH_PROVIDER: "pomerium"
FORWARDAUTH_HEADER_USERNAME: "X-Pomerium-Claim-Email"    # Pomerium uses email as the primary identity
FORWARDAUTH_HEADER_EMAIL: "X-Pomerium-Claim-Email"
FORWARDAUTH_HEADER_GROUPS: "X-Pomerium-Claim-Groups"
FORWARDAUTH_HEADER_NAME: "X-Pomerium-Claim-Name"
FORWARDAUTH_HEADER_UID: "X-Pomerium-Claim-Sub"
FORWARDAUTH_HEADER_VERIFY: "X-AgentPulse-Verify"
FORWARDAUTH_HEADER_STRIP_PREFIX: "X-Pomerium-"
```

Pomerium requires `pass_identity_headers: true` in the policy route definition to emit
plain `X-Pomerium-Claim-*` headers. Without it, identity is only available in the JWT.

Override `agentpulse-forwardauth` address to your Pomerium authenticate service.
Pomerium's forwardauth endpoint is typically
`https://authenticate.your-domain.com/.pomerium/verify/<encoded-url>`.

See the [Pomerium documentation](https://www.pomerium.com/docs/guides/traefik) for
Traefik integration.

---

## Provider: Cloudflare Access

Cloudflare Access uses a different model: identity is carried in a signed JWT in the
`Cf-Access-Jwt-Assertion` header rather than separate plain-text headers. Cloudflare
does emit `Cf-Access-Authenticated-User-Email`, but no separate groups, name, or UID
headers.

**Known constraint**: Cloudflare Access does not provide a forwardauth-style endpoint
that Traefik can proxy to — the integration works via JWT verification rather than the
standard forwardauth pattern. Operators need an adapter (e.g.
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/))
or a sidecar that verifies the JWT and emits plain headers.

If you run cloudflared or a JWT-verification sidecar that emits plain headers:

```yaml
FORWARDAUTH_PROVIDER: "cloudflare"
FORWARDAUTH_HEADER_USERNAME: "Cf-Access-Authenticated-User-Email"
FORWARDAUTH_HEADER_EMAIL: "Cf-Access-Authenticated-User-Email"
FORWARDAUTH_HEADER_GROUPS: ""      # Cloudflare Access does not emit a groups header
FORWARDAUTH_HEADER_NAME: "Cf-Access-Authenticated-User-Email"
FORWARDAUTH_HEADER_UID: "Cf-Access-Authenticated-User-Email"
FORWARDAUTH_HEADER_VERIFY: "X-AgentPulse-Verify"
FORWARDAUTH_HEADER_STRIP_PREFIX: "Cf-Access-"
```

The verify header mechanism (`agentpulse-inject-verify`) works the same way as with
other providers — you inject the shared secret after forwardauth passes.

Sign-out for Cloudflare Access: `FORWARDAUTH_PROVIDER` is not `"authentik"`, so
AgentPulse returns `signOutUrl: null`. Wire your Cloudflare logout URL via a custom UI
configuration or have users visit `https://your-team.cloudflareaccess.com/cdn-cgi/access/logout`.

---

## Verification

```bash
# 1. Confirm /api/v1/auth/me returns JSON (not a 302 or 401)
curl -s https://agentpulse.example.com/api/v1/auth/me
# Expected: {"authenticated":false,...} (or user object if already signed in)

# 2. Forged verify header should be stripped before forwardauth evaluates the request
curl -I -H "X-Authentik-Verify: anything" https://agentpulse.example.com/
# Expected: 302 to IdP login

# 3. Direct-to-pod bypass attempt (no Traefik inject-verify):
kubectl -n agentpulse port-forward svc/agentpulse 9999:3000 &
curl -H "X-authentik-username: attacker" http://localhost:9999/api/v1/sessions
# Expected: 401 (no verify header; AgentPulse strips identity headers and falls through)

# 4. Check logs for trust gate events:
kubectl -n agentpulse logs -l app=agentpulse | grep forwardauth_trust_gate
```

---

## Secret rotation

See `deploy/k8s/RUNBOOK-secrets-rotation.md` for the step-by-step rotation procedure.

Rotation touches only the Traefik middleware (via your private overlay) and the
agentpulse Secret. Brief downtime (one pod restart) is expected and acceptable for
homelab deployments.

---

## Troubleshooting

**Trust gate rejects all requests (401 on dashboard)**

- Confirm `FORWARDAUTH_TRUST_SECRET` is set in the `agentpulse-secrets` Secret.
- Confirm the `agentpulse-inject-verify` middleware injects the same value in the
  verify header (`FORWARDAUTH_HEADER_VERIFY`).
- Confirm the IngressRoute middleware chain order: strip → forwardauth → inject-verify.
- Check logs: `kubectl -n agentpulse logs -l app=agentpulse | grep trust_gate`

**Identity headers missing (user shows as unauthenticated after forwardauth passes)**

- Confirm `authResponseHeaders` in `agentpulse-forwardauth` lists the headers your
  IdP emits (e.g. `X-Authentik-Username`, `Remote-User`).
- Confirm `FORWARDAUTH_HEADER_USERNAME` matches the header name your IdP emits.
- Confirm the strip prefix (`FORWARDAUTH_HEADER_STRIP_PREFIX`) matches the prefix of
  your IdP's headers, not a broader prefix that accidentally strips the verify header.

**Dashboard shows "SSO" instead of provider name**

- Set `FORWARDAUTH_PROVIDER` in `agentpulse-config` to your IdP name (e.g.
  `"authelia"`, `"pomerium"`).
- Restart agentpulse after changing the ConfigMap.
