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

The agent router is root-mounted (AGEN-17) — mounted directly on the app, ahead of the
operator route bundle, at both `/api/v1` and `/app-api/v1` — not inside the bundle that
carries the dashboard's `requireAuth()`/`requireOperatorScope()` wildcards. No operator
API key is required or checked on agent routes; each handler carries its own
supervisor-credential (or, for `register`, enrollment-token) check. Session ownership
on top of that — which supervisor may write state for, append events to, or claim
control actions on a given session — is enforced separately in
`src/server/services/session-ownership.ts` (owner of record: the launch claimant, else
the managed row, launch status ignored). Under `DISABLE_AUTH`, the ownership check
still runs, keyed on the route's `:id`, but it's a **correctness guard, not a security
boundary**: with no credential required, any local caller can name any supervisor id
in the path and act as it.

`src/server/app.public-surface.test.ts` is the regression guard for the mount itself:
it fails if an agent route is ever shadowed by an operator gate again, or if a
duplicate in-bundle mount is added alongside the root mount.

#### Supervisor client behavior on a rejected in-session report

The agent routes above return `403 { "error": "session_not_owned" }` when a supervisor
tries to write state for a session it doesn't own, and `401` when its credential has
been revoked or rotated. The supervisor client (`src/supervisor/`) treats these
differently depending on which call hit the rejection:

- **In-session reports** — the ongoing `reportState`/`reportEvents` calls a managed
  Codex session (`codex-managed.ts`) or a headless Claude run (`claude-headless.ts`)
  makes while already running: a `403` or any `5xx` is logged and the supervisor keeps
  running (it stops updating the server for that session, but doesn't crash). A `401`
  is **fatal**: the supervisor logs
  `credential rejected (401) — supervisor credential revoked or rotated; exiting`,
  kills every child process it's holding for that provider (SIGTERM, then SIGKILL
  after a short grace if the child doesn't exit — `disposeAllManagedCodexRuntimes`/
  `disposeAllHeadlessRuntimes`), and exits non-zero. The service manager
  (launchd/systemd/Scheduled Task) then shows the failure and, on the usual restart
  policy, respawns the supervisor — which re-registers (see below), gets a fresh `401`
  if the credential is genuinely gone, and stays running while it retries registration
  forever rather than exiting again. That's loud (every retry is logged) and correct:
  the operator revoked the credential and should either re-enroll the host (keeping
  its id via `/admin/supervisors/:id/rotate`, see below) or uninstall it.
- **Initial registration** (`POST /supervisors/register`, the first call `main()`
  makes on every start) **never exits on an HTTP failure**, of any status. A
  brand-new supervisor talking to a server that hasn't been upgraded yet gets the
  AGEN-17 operator-gate shadow's `401`/`403` on every call, register included;
  exiting there would recreate the same crash loop, just moved one call earlier.
  Instead registration retries forever with exponential backoff and jitter
  (starting around 5s, capped at 5
  minutes), logging the HTTP status, status text and the server's own `error` body
  field on every attempt. Only a local failure — the config file failing to load, or
  a malformed success response — is fatal at this step; an HTTP failure never is,
  including a **genuine** `401` from a revoked credential. That's deliberate: a slow,
  loud retry loop is a quieter failure mode than a launchd/systemd crash loop, and
  gives the operator the same diagnostic signal (the log line names the status and
  the server's error) without flapping the process.
- **Heartbeat, launch claim, provider-sync and the control-action claim loop** — these
  are **not** made fatal by a 401, for the same mixed-version-rollout reason as
  registration: making them fatal would recreate the crash loop whenever a fixed
  supervisor talks to an unfixed server. Instead these loops log the failure and
  retry on their normal interval (unlike registration, they don't currently back off).
  The heartbeat watchdog (`src/supervisor/index.ts`) independently exits the process
  if no heartbeat has succeeded in at least 90 seconds, regardless of the reason, so a
  genuinely dead credential is still caught — just on the watchdog's schedule rather
  than immediately.
- **Interactive Claude sessions** (`claude-interactive.ts`) degrade safely: a rejected
  report there is caught by the existing control-action error handling and the action
  is marked `failed`, with no crash and no process exit.

**Production recommendation**: point the supervisor's `serverUrl` at an `https://`
endpoint. A network-position attacker who can intercept or inject responses on an
unencrypted `http://` path could forge a `401` to any in-session report and force a
managed supervisor to exit (a low-severity denial-of-service — it needs network
position on the supervisor→server path, and a restart re-registers successfully if the
credential is still valid, but there's no reason to accept it). `https://` closes that
lever entirely.

**Follow-ups** (tracked in AGEN, not part of this fix):
- Make the heartbeat/claim/provider-sync loops fatal-on-401 too, once a minimum
  supported server version can be guaranteed for every deployed supervisor (so the
  mixed-version crash loop described above can no longer happen).
- Wrap `claude-interactive.ts`'s report calls in `reportInSessionSafely` for
  consistency with the other two providers, even though its current handling is
  already safe.
- `supervisor.json` is currently written `0644` (world-readable) and should be
  `chmod 600` at install time — this matters most while a stopgap `manage`-scoped API
  key is in use (see the upgrade notes below).
- The supervisor-posted event content (tool output, assistant messages) feeding the AI
  watcher and classifier is not currently trust-checked against prompt injection from
  the agent process itself. Content trust is a separate hardening effort.

### Upgrading from a crash-looping supervisor (AGEN-17)

If your supervisors have been crash-looping since AGEN-9 (every agent-route call
returning `403 insufficient_scope` or `401 Unauthorized`), upgrading the server to
include this fix is enough — no client update, config change, or manual restart is
required. The client already sends the same credential; the server simply answers it
correctly again. Recovery time is bounded by your service manager's restart policy
(macOS: `ThrottleInterval 10`; Linux: `RestartSec=3`; Windows: no auto-restart — the
scheduled task needs `Start-ScheduledTask AgentPulseSupervisor` or a re-logon).

Before deploying, walk through this checklist:

1. **Inventory stale `validated` launches.** A launch that was `validated` but never
   claimed during the outage will dispatch on the first `launches/claim` after
   recovery, oldest first. The query below lists them; cancel any that are no longer
   wanted before the supervisor comes back.
2. **Revoke any stopgap `manage`-scoped API key.** If you worked around the crash loop
   by putting an operator key with `manage` scope into `supervisor.json`, revoke it
   once the server is upgraded and the supervisor is back to using its own credential
   for agent routes. That file is `0644` by default — treat a `manage` key placed
   there as compromised the moment it's written, and revoke it promptly rather than
   "eventually" (mint a replacement `ingest`-only key first if the codex observer still
   needs one for `/hooks`; there's no scope-edit endpoint, only mint-new/revoke-old).
3. **Re-key a re-enrolled host via `/admin/supervisors/:id/rotate`, never a fresh
   enrollment.** Rotate keeps the supervisor's id, so every session it already owns
   stays owned. A brand-new enrollment mints a new id that owns none of the host's
   prior sessions — a dashboard retry can't recover them either, since a retry still
   targets the launch's original `requested_supervisor_id`. If a host's identity was
   genuinely lost, launch fresh sessions instead of trying to reclaim the old ones.
4. **Optionally run the ownership audit below** to find any session rows left with a
   stale recorded owner. Owner-of-record routing already makes claim/liveness reads
   correct for any row with a claimed launch, with no migration needed — the audit
   and repair below are for the rarer launch-less legacy rows and for verification.
5. **Archive the local supervisor log** (`~/.agentpulse/logs/supervisor.err.log`) if it
   grew large during the outage — the upgrade doesn't truncate it.

The SQL below is portable across SQLite and Postgres. Placeholders are literal tokens —
replace `<session_id>`, `<new_supervisor_id>`, `<now ISO>` and `<cutoff ISO>` with real
values before running.

**Audit** — lists sessions whose recorded owner (`managed_sessions.supervisor_id`)
disagrees with the launch claimant, or whose `launch_request_id` doesn't resolve.
Read-only.

<!-- ownership-audit-sql:start -->
```sql
SELECT ms.session_id, ms.supervisor_id AS recorded_owner,
       lr.claimed_by_supervisor_id AS launch_owner, ms.launch_request_id,
       CASE WHEN lr.id IS NULL THEN 'no_launch'
            WHEN lr.claimed_by_supervisor_id IS NOT NULL
                 AND lr.claimed_by_supervisor_id <> ms.supervisor_id THEN 'owner_mismatch'
            WHEN lp.id IS NULL THEN 'launch_pointer_missing'
            ELSE 'launch_pointer_mismatch' END AS finding
FROM managed_sessions ms
LEFT JOIN launch_requests lr ON lr.launch_correlation_id = ms.session_id
LEFT JOIN launch_requests lp ON lp.id = ms.launch_request_id
WHERE lr.id IS NULL
   OR (lr.claimed_by_supervisor_id IS NOT NULL AND lr.claimed_by_supervisor_id <> ms.supervisor_id)
   OR (lp.id IS NOT NULL AND lp.launch_correlation_id <> ms.session_id)
   -- dangling pointer; launch_request_id = session_id is the legacy fallback
   -- (managed-session-state.ts:131-132), deliberately not flagged
   OR (lp.id IS NULL AND ms.launch_request_id <> ms.session_id)
ORDER BY ms.session_id;
```
<!-- ownership-audit-sql:end -->

Findings, in precedence order: `no_launch` (no launch at all names this session) >
`owner_mismatch` (a claimed launch disagrees with the recorded owner — a hijacked-row
shape, already self-healed by routing, but worth knowing about) >
`launch_pointer_missing` (`launch_request_id` names no launch that exists) >
`launch_pointer_mismatch` (`launch_request_id` resolves, but to a different session's
launch).

**Repair** — realigns `managed_sessions.supervisor_id` with the launch claimant for
every `owner_mismatch` row. It does **not** touch launch-less or dangling-pointer rows
— those need human judgment (a launch-less row has no claimant to realign to).

<!-- ownership-repair-sql:start -->
```sql
UPDATE managed_sessions
SET supervisor_id = (SELECT lr.claimed_by_supervisor_id FROM launch_requests lr
                     WHERE lr.launch_correlation_id = managed_sessions.session_id)
WHERE EXISTS (SELECT 1 FROM launch_requests lr
              WHERE lr.launch_correlation_id = managed_sessions.session_id
                AND lr.claimed_by_supervisor_id IS NOT NULL
                AND lr.claimed_by_supervisor_id <> managed_sessions.supervisor_id);
```
<!-- ownership-repair-sql:end -->

**Reassign host** — moves *one* session to another supervisor. There is no dashboard
flow for this; it's a manual escape hatch for a host that was re-enrolled under a new
id, or a session deliberately handed to a different host. Updating
`managed_sessions` alone has **no effect** — the launch claimant outranks it, so
both statements must run together. Run them as a pair, inside a transaction, in one
session:

**Stop the old supervisor first.** The ownership check and this write aren't one
transaction from the *old* supervisor's point of view: if it's still running and a
state report from it is already in flight when you run the pair below, that report
can land right after your `COMMIT`. For a session with no launch to reassign (the
first `UPDATE` below is a no-op), that in-flight write only touches
`managed_sessions.supervisor_id` — handing ownership straight back to the old host.
Stop the old supervisor's process, or revoke it via
`POST /admin/supervisors/:id/revoke`, before running this pair, and recheck the row
afterward to confirm the reassignment stuck:

```sql
SELECT session_id, supervisor_id FROM managed_sessions WHERE session_id = '<session_id>';
```

If it still names the old supervisor, the old process won the race — stop it and
repeat the pair.

```sql
BEGIN;
```
<!-- ownership-reassign-sql:start -->
```sql
UPDATE launch_requests SET claimed_by_supervisor_id = '<new_supervisor_id>'
WHERE launch_correlation_id = '<session_id>' AND claimed_by_supervisor_id IS NOT NULL;
UPDATE managed_sessions SET supervisor_id = '<new_supervisor_id>',
       host_name = (SELECT host_name FROM supervisors WHERE id = '<new_supervisor_id>')
WHERE session_id = '<session_id>';
```
<!-- ownership-reassign-sql:end -->
```sql
COMMIT;
```

**Stale-launch inventory** — run before deploying the upgrade. Lists every `validated`
launch that would dispatch to the first supervisor that claims it once recovery
begins; `retry_of_launch_request_id` tells you whether a row is a dashboard retry of
already-cancelled work.

<!-- stale-launch-sql:start -->
```sql
SELECT lr.id, lr.created_at, lr.agent_type, lr.cwd, lr.requested_by,
       lr.retry_of_launch_request_id, s.host_name
FROM launch_requests lr LEFT JOIN supervisors s ON s.id = lr.requested_supervisor_id
WHERE lr.status = 'validated' ORDER BY lr.created_at;
```
<!-- stale-launch-sql:end -->

To cancel launches you don't want dispatched on recovery:

```sql
UPDATE launch_requests SET status = 'cancelled',
  error = 'Cancelled before supervisor recovery', updated_at = '<now ISO>'
WHERE status = 'validated' AND created_at < '<cutoff ISO>';
```

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
| `FORWARDAUTH_TRUST_SECRET` | _(empty)_ | Shared secret for the header trust gate. Generate with `openssl rand -hex 32`. Also accepts the deprecated alias `AGENTPULSE_AUTHENTIK_TRUST_SECRET` until v0.7.0. |
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
`FORWARDAUTH_TRUST_SECRET` until v0.7.0. Operators rotating their secret update
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

The deprecated key name `AGENTPULSE_AUTHENTIK_TRUST_SECRET` also works until v0.7.0 and is bound to the same secret field in `04-deployment.yaml`.

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
