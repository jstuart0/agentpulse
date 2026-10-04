/**
 * Centralized operator route-scope policy (AGEN-12 Phase 1, plan Decision D1).
 *
 * Replaces the per-router `requireScope("manage")` wildcard gates with a
 * single policy that additionally recognizes the read-only `observe` scope.
 * `manage` continues to satisfy every operator route (including observe-
 * eligible ones); `observe` unlocks only the routes in OBSERVE_READ_PATHS.
 *
 * C1 correction: routes whose REST DTOs carry `env`, `launchSpec`,
 * `claimToken`, or injected-prompt metadata (launches, templates, the AI
 * inbox, and the session-detail controlActions embed) are deliberately
 * EXCLUDED from OBSERVE_READ_PATHS even though their verb is GET — an
 * `observe` key must be provably secret-free at the REST boundary, not just
 * at the MCP tool layer. See the plan's D1 "Removed from observe under C1"
 * list for the audited leak inventory.
 *
 * F23 correction (codex r2, post-Phase-5 diff review): `/projects` was
 * originally observe-eligible, but `mapProject()` (routes/projects.ts)
 * returns operator-controlled arbitrary `notes`, arbitrary `metadata` (a
 * JSON blob), and `githubRepoUrl` (which accepts userinfo, e.g.
 * `https://token@github.com/org/repo`) — the same class of leak as the C1
 * launches/templates exclusion. Moved to INTENTIONALLY_MANAGE_ONLY;
 * `list_projects` is manage-scoped in
 * packages/agentpulse-mcp/src/tools/catalog.ts to match. An
 * observe-safe project DTO (id/name/cwd/defaults only, dropping
 * notes/metadata and redacting githubRepoUrl userinfo) could restore
 * observe visibility later — manage-only is the fail-safe choice for now.
 *
 * AIMR-214 Phase A: that observe-safe DTO now exists as GET /projects/summary
 * (routes/projects.ts's mapProjectSummary — id/name/defaults + a
 * redacted githubRepoUrl, dropping cwd too per the state file's scope
 * wording). /projects and /projects/:id remain manage-only unchanged.
 */
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { type InstanceMode, getMode } from "../services/instance-mode.js";
import { getAdminServiceKeyIds } from "../services/service-keys.js";
import { type Actor, type EffectiveRole, actorFromAuthUser } from "./actor.js";
import { SCOPE_ALL, SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE } from "./api-key.js";
import { type AuthUser, authenticate } from "./middleware.js";
import { isAcceptedOrigin } from "./request-origin.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Route templates reachable with an `observe`-scoped API key (GET/HEAD only).
 * Exact route patterns (Hono's resolved `c.req.routePath` shape, mount
 * prefix stripped) — never a prefix/substring set.
 */
export const OBSERVE_READ_PATHS: ReadonlySet<string> = new Set([
	"/sessions",
	"/sessions/stats",
	"/sessions/:sessionId",
	"/sessions/:sessionId/timeline",
	"/sessions/:sessionId/events/:eventId/context",
	"/sessions/:sessionId/claude-md",
	"/search",
	"/ai/digest",
	"/ai/sessions/:sessionId/intelligence",
	"/ai/spend",
	"/ai/diagnostics",
	"/ai/status",
	// AIMR-214 Phase A — the observe-safe project summary (routes/projects.ts's
	// mapProjectSummary): id/name/defaults + a redacted githubRepoUrl only.
	// /projects and /projects/:id stay INTENTIONALLY_MANAGE_ONLY below — this
	// is a deliberately narrower sibling DTO, not a reclassification of them.
	"/projects/summary",
	// Who exists (id, label, disabled) and what the instance is: counts and a
	// mode, nothing secret-bearing.
	"/users/directory",
	"/instance",
]);

/**
 * Every other GET/HEAD route in the 10-router operator bundle (see the
 * plan's Pattern-parity site list). Maintained by hand so the route-drift
 * guard (route-scope-policy.test.ts) fails loudly the moment a new read
 * route is added to a swapped router without a conscious observe/manage
 * classification decision. Does NOT include routes outside the swapped
 * bundle (auth, health, ingest, internal, csp-report, the untouched
 * /v1/admin supervisors-admin router, or the edge-public supervisors-agent
 * router) — those never pass through requireOperatorScope().
 */
export const INTENTIONALLY_MANAGE_ONLY: ReadonlySet<string> = new Set([
	// C1 — leaking DTOs (env vars, launchSpec, claimToken, injected prompts)
	"/sessions/:sessionId/control-actions",
	// AGEN — a mutation (POST), already manage-only via classifyRoute's
	// method gate; listed for documentation/consistency with the rest of
	// this set, not because the route-drift guard (GET/HEAD only) needs it.
	"/sessions/:sessionId/acknowledge",
	"/templates",
	"/templates/:id",
	"/launches",
	"/launches/:id",
	"/ai/inbox",
	"/ai/action-requests",
	// F23 — leaking DTO (arbitrary notes/metadata, githubRepoUrl userinfo)
	"/projects",
	// Deliberately manage-only surfaces (settings, keys, channels, labs, etc.)
	"/settings",
	"/settings/workspace",
	"/api-keys",
	"/api-keys/:id",
	"/users",
	"/telemetry/status",
	"/projects/:id",
	"/projects/:id/sessions",
	"/labs/flags",
	"/ai/ask/threads",
	"/ai/ask/threads/:id",
	"/channels",
	"/channels/:id",
	"/channels/telegram/credentials",
	"/channels/telegram/bot-info",
	"/channels/telegram/webhook-info",
	"/channels/:id/stats",
	"/ai/providers",
	"/ai/vector-search/status",
	"/ai/sessions/:sessionId/watcher",
	"/ai/inbox/snoozes",
	"/ai/risk-classes",
	// AGEN-69 — the session summary is derived from prompts and tool data, so
	// the read is manage-only, never observe. Its POST is manage by method and
	// deliberately in no other set (not OWNER_CHECKED_ROUTES): any reader of a
	// summary can already read its source through the timeline, launching and
	// prompting are not owner-checked either, and in team mode only an admin
	// can turn the Labs flag on (D-3).
	"/ai/sessions/:sessionId/summary",
]);

/**
 * Method-qualified route templates an `ingest`-scoped API key may write to
 * (D1). Exactly one entry today: the relay/statusline's native-name pull.
 * Deliberately explicit and hand-maintained — an ingest key proxies agent-
 * reported metadata, not operator intent, so widening this list is a
 * conscious security decision, never an accident of a route-registration
 * refactor. The route-drift guard (route-scope-policy.test.ts) walks the
 * real app.routes bidirectionally against this set.
 */
export const INGEST_WRITABLE_ROUTES: ReadonlySet<string> = new Set([
	"PUT /sessions/:sessionId/native-name",
]);

function parseRouteEntry(entry: string): { method: string; segments: string[] } {
	const spaceIndex = entry.indexOf(" ");
	const method = entry.slice(0, spaceIndex);
	const path = entry.slice(spaceIndex + 1);
	return { method, segments: splitSegments(path) };
}

/**
 * True when (method, path) is a literal member of INGEST_WRITABLE_ROUTES,
 * using the same structural segment-by-segment matcher as classifyRoute
 * (never a prefix/substring test).
 */
export function isIngestWritable(method: string, path: string): boolean {
	const normalized = normalizeRoutePath(path);
	const pathSegments = splitSegments(normalized);
	const upperMethod = method.toUpperCase();
	for (const entry of INGEST_WRITABLE_ROUTES) {
		const parsed = parseRouteEntry(entry);
		if (parsed.method !== upperMethod) continue;
		if (matchesTemplate(pathSegments, parsed.segments)) return true;
	}
	return false;
}

/**
 * Routes that need an admin in BOTH modes — all new, so nothing that works
 * today changes. `humanOnly` routes refuse every API key, including an
 * admin-owned one and a kept admin service key: a key can't mint or demote
 * admins, switch the mode or hand out ownership of unassigned sessions.
 * Keyed "METHOD /template" (the mount prefix stripped).
 */
export const ALWAYS_ADMIN_ROUTES: ReadonlyMap<string, { humanOnly: boolean }> = new Map([
	["GET /users", { humanOnly: false }],
	["POST /users", { humanOnly: true }],
	["PATCH /users/:id", { humanOnly: true }],
	["POST /users/:id/disable", { humanOnly: true }],
	["POST /users/:id/enable", { humanOnly: true }],
	["POST /users/:id/reset-password", { humanOnly: true }],
	["PUT /instance/mode", { humanOnly: true }],
	["POST /instance/claim-unassigned", { humanOnly: true }],
	// A PATCH that sets adminService also needs a human admin; the handler
	// checks that on top of this route-level gate.
	["PATCH /api-keys/:id", { humanOnly: false }],
	["PATCH /admin/supervisors/:id", { humanOnly: false }],
	["PATCH /sessions/:sessionId/owner", { humanOnly: false }],
]);

/**
 * Existing routes that need an admin in TEAM mode only; in solo they behave
 * exactly as they always have. PUT /settings (the three non-theme keys) is
 * checked per key in its handler, not here.
 */
export const TEAM_ADMIN_ROUTES: ReadonlySet<string> = new Set([
	"PUT /settings/workspace",
	"POST /ai/providers",
	"POST /ai/providers/probe-models",
	"PUT /ai/providers/:id",
	"DELETE /ai/providers/:id",
	"PUT /ai/status",
	"PUT /ai/risk-classes",
	"PUT /ai/vector-search/status",
	"POST /ai/vector-search/rebuild",
	"POST /search/rebuild",
	"PUT /labs/flags/:flag",
	"POST /channels",
	"DELETE /channels/:id",
	"PATCH /channels/:id/config",
	"POST /channels/:id/test",
	"POST /channels/telegram/credentials",
	"DELETE /channels/telegram/credentials",
	"POST /channels/telegram/setup-webhook",
	"POST /channels/telegram/teardown-webhook",
	"POST /projects/:id/cleanup-workarea",
]);

export type { EffectiveRole };

/**
 * The caller's effective role under the given mode.
 *
 *  - DISABLE_AUTH: the operator is an admin.
 *  - A host credential: `none`. It is never an admin and never a member.
 *  - A cookie or SSO user: their current role.
 *  - A key owned by a user: that user's CURRENT role, read with the key on
 *    every request, so demoting an admin takes admin power from their keys
 *    at once.
 *  - An ownerless key with manage (or the wildcard): admin-equivalent in solo,
 *    as today; in team only when it is on the kept admin service key list.
 *    An ownerless key without manage is a member.
 */
/**
 * Routes whose decision needs the resource itself (who owns this session, this
 * key, this host), so it is made in the handler through the authorization
 * service (services/authorization.ts) or an explicit role check, not by the
 * middleware above. Listed here so every route that decides who may do what is
 * classified in one module; in solo the owner-or-admin ones behave exactly as
 * they always have.
 */
export const OWNER_CHECKED_ROUTES: ReadonlySet<string> = new Set([
	"POST /sessions/:sessionId/acknowledge",
	"DELETE /sessions/:sessionId/acknowledge",
	"PUT /sessions/:sessionId/archive",
	"PUT /sessions/:sessionId/rename",
	"PUT /sessions/:sessionId/pin",
	"PUT /sessions/:sessionId/notes",
	"PUT /sessions/:sessionId/claude-md",
	"DELETE /sessions/:sessionId",
	"PUT /sessions/:sessionId/native-name",
	"GET /api-keys/:id",
	"DELETE /api-keys/:id",
	"POST /api-keys",
	"PUT /settings",
	"POST /admin/supervisors/:id/rotate",
	"POST /admin/supervisors/:id/revoke",
	"POST /ai/action-requests/:id/decide",
]);

export async function resolveEffectiveRole(
	authUser: AuthUser,
	mode: InstanceMode,
	/** The kept admin-service key ids, when the caller has already read them. */
	keptAdminServiceKeyIds?: readonly string[],
): Promise<EffectiveRole> {
	if (config.disableAuth) return "admin";
	if (authUser.isSupervisorCredential) return "none";
	if (authUser.source !== "api_key") return authUser.role === "admin" ? "admin" : "member";
	if (authUser.userId) return authUser.ownerRole === "admin" ? "admin" : "member";
	if (!callerHasManageScope(authUser)) return "member";
	if (mode === "solo") return "admin";
	const kept = keptAdminServiceKeyIds ?? (await getAdminServiceKeyIds());
	return authUser.keyId !== null && kept.includes(authUser.keyId) ? "admin" : "member";
}

/**
 * A "human admin": the DISABLE_AUTH operator, or a cookie or SSO caller with a
 * user id whose role is admin. Never an API key, whoever owns it.
 */
export function isHumanAdmin(authUser: AuthUser): boolean {
	if (config.disableAuth) return true;
	return authUser.source !== "api_key" && authUser.userId !== null && authUser.role === "admin";
}

const MODE_KEY = "instanceModePromise";
const POLICY_APPLIED_KEY = "rolePolicyApplied";

/** The instance mode, read at most once per request and only when something asks. */
export function getRequestMode(c: Context): Promise<InstanceMode> {
	let mode = c.get(MODE_KEY) as Promise<InstanceMode> | undefined;
	if (!mode) {
		mode = getMode();
		c.set(MODE_KEY, mode);
	}
	return mode;
}

/**
 * The actor for this request, with its effective role and the mode that role
 * was resolved under. For handlers that hand an actor to an owner-or-admin
 * check; the mode and role are looked up lazily, here, not on every request.
 */
export async function getRequestActor(
	c: Context,
	/** What the handler has already read, so resolving the actor doesn't read it again. */
	known: { mode?: InstanceMode; keptAdminServiceKeyIds?: readonly string[] } = {},
): Promise<Actor> {
	const authUser = c.get("authUser") as AuthUser | undefined;
	const actor = actorFromAuthUser(authUser);
	if (!authUser) return actor;
	const mode = known.mode ?? (await getRequestMode(c));
	return {
		...actor,
		mode,
		role: await resolveEffectiveRole(authUser, mode, known.keptAdminServiceKeyIds),
	};
}

interface PolicyEntry {
	method: string;
	segments: string[];
	humanOnly: boolean;
}

function parsePolicyEntries(entries: Iterable<[string, { humanOnly: boolean }]>): PolicyEntry[] {
	return [...entries].map(([entry, { humanOnly }]) => ({
		...parseRouteEntry(entry),
		humanOnly,
	}));
}

const ALWAYS_ADMIN_ENTRIES = parsePolicyEntries(ALWAYS_ADMIN_ROUTES);
const TEAM_ADMIN_ENTRIES = parsePolicyEntries(
	[...TEAM_ADMIN_ROUTES].map(
		(entry) => [entry, { humanOnly: false }] as [string, { humanOnly: boolean }],
	),
);

function findPolicyEntry(entries: PolicyEntry[], method: string, path: string): PolicyEntry | null {
	const pathSegments = splitSegments(normalizeRoutePath(path));
	// HEAD is judged as the GET it stands in for, so it isn't a way around a read gate.
	const judgedAs = method === "HEAD" ? "GET" : method;
	return (
		entries.find(
			(entry) => entry.method === judgedAs && matchesTemplate(pathSegments, entry.segments),
		) ?? null
	);
}

/**
 * Refuses a mutating request whose Origin is neither configured (the list the
 * WebSocket upgrade uses) nor the request's own. No Origin header at all
 * (curl, scripts, MCP) passes: those are judged by authentication alone.
 */
export function refuseBadOrigin(c: Context): Response | null {
	const origin = c.req.header("Origin");
	if (origin === undefined || isAcceptedOrigin(origin, c.req.header("Host"))) return null;
	return c.json({ error: "bad_origin" }, 403);
}

/**
 * Middleware: the role policy. Mounted once on the api bundle (and, as a
 * harmless repeat, on the supervisors admin router): it authenticates the
 * request itself, so the identity is judged before any router's own checks,
 * and later requireAuth calls find it already resolved.
 *
 *  - ALWAYS_ADMIN_ROUTES, both modes: 403 admin_required unless the caller's
 *    effective role is admin; humanOnly entries add 403 human_admin_required
 *    for an admin who is an API key. Mutating ones also refuse a request
 *    whose Origin header is present and not one of config.allowedOrigins
 *    (403 bad_origin); a request with no Origin passes this check and is
 *    judged by authentication alone.
 *  - TEAM_ADMIN_ROUTES, team mode only: 403 admin_required unless admin.
 *  - Every other route: untouched, and the mode is not even read.
 */
export function requireRolePolicy() {
	return async (c: Context, next: Next) => {
		if (c.get(POLICY_APPLIED_KEY)) return next();
		c.set(POLICY_APPLIED_KEY, true);

		let authUser = c.get("authUser") as AuthUser | undefined;
		if (!authUser) {
			const refusal = await authenticate(c);
			if (refusal) return refusal;
			authUser = c.get("authUser") as AuthUser;
		}

		const method = c.req.method.toUpperCase();
		const alwaysAdmin = findPolicyEntry(ALWAYS_ADMIN_ENTRIES, method, c.req.path);
		const teamAdmin = alwaysAdmin ? null : findPolicyEntry(TEAM_ADMIN_ENTRIES, method, c.req.path);
		if (!alwaysAdmin && !teamAdmin) return next();

		if (alwaysAdmin && !READ_METHODS.has(method)) {
			const refusal = refuseBadOrigin(c);
			if (refusal) return refusal;
		}

		const mode = await getRequestMode(c);
		if (teamAdmin && mode === "solo") return next();

		const role = await resolveEffectiveRole(authUser, mode);
		if (role !== "admin") return c.json({ error: "admin_required" }, 403);
		if (alwaysAdmin?.humanOnly && !isHumanAdmin(authUser)) {
			return c.json({ error: "human_admin_required" }, 403);
		}
		return next();
	};
}

const MOUNT_PREFIXES = ["/api/v1", "/app-api/v1"];

function normalizeRoutePath(path: string): string {
	for (const prefix of MOUNT_PREFIXES) {
		if (path.startsWith(prefix)) {
			return path.slice(prefix.length) || "/";
		}
	}
	return path;
}

function splitSegments(path: string): string[] {
	return path.split("/").filter((segment) => segment.length > 0);
}

function matchesTemplate(pathSegments: string[], templateSegments: string[]): boolean {
	if (pathSegments.length !== templateSegments.length) return false;
	return templateSegments.every(
		(segment, i) => segment.startsWith(":") || segment === pathSegments[i],
	);
}

function matchesAnyTemplate(path: string, templates: ReadonlySet<string>): boolean {
	const pathSegments = splitSegments(path);
	for (const template of templates) {
		if (matchesTemplate(pathSegments, splitSegments(template))) return true;
	}
	return false;
}

/**
 * Classify a (method, path) pair as `observe`-eligible or `manage`-only.
 *
 * Structural, segment-by-segment matching against OBSERVE_READ_PATHS — never
 * a prefix/substring test, so a future sibling route (e.g. /sessions-admin)
 * or a path-traversal-shaped string cannot spuriously match (H4). A template
 * segment starting with `:` matches any single raw segment at that position,
 * including a literal `:param`-shaped segment compared against itself — so
 * `path` may be either a raw resolved path ("/sessions/abc123") or a route
 * template ("/sessions/:sessionId", e.g. Hono's `c.req.routePath` read from
 * inside a terminal route handler).
 *
 * Implementation note (deviates from the plan's literal "use c.req.routePath"
 * wording, verified empirically): `c.req.routePath` only resolves to the
 * final matched route pattern once Hono has dispatched into the terminal
 * handler. Inside `.use("*", middleware)` — which is how requireOperatorScope
 * is wired on every swapped router — `c.req.routePath` still reports the
 * middleware's own wildcard registration path (e.g. "/api/v1/*"), not the
 * route that will ultimately match. requireOperatorScope therefore classifies
 * against `c.req.path` (the resolved, already-dispatched raw request path)
 * instead. This satisfies the D1 security property the plan is actually
 * protecting — structural, route-aware matching, never prefix/substring —
 * while working correctly from middleware position; classifyRoute's segment
 * matcher treats both inputs identically.
 */
export function classifyRoute(
	method: string,
	path: string,
): typeof SCOPE_OBSERVE | typeof SCOPE_MANAGE {
	if (!READ_METHODS.has(method.toUpperCase())) return SCOPE_MANAGE;
	const normalized = normalizeRoutePath(path);
	return matchesAnyTemplate(normalized, OBSERVE_READ_PATHS) ? SCOPE_OBSERVE : SCOPE_MANAGE;
}

/**
 * True when the caller's identity satisfies the `manage` scope: any
 * non-api_key caller (forwardauth/local — never scope-limited, matching
 * requireScope()'s existing behavior), or an api_key caller holding `manage`
 * or the DB-only `*` wildcard (DISABLE_AUTH synthesizes `["*"]`).
 *
 * Used by the session-detail handler to gate the controlActions embed (C1) —
 * a route that stays in OBSERVE_READ_PATHS overall but must still redact one
 * secret-bearing field for observe-only callers.
 */
export function callerHasManageScope(authUser: AuthUser | undefined): boolean {
	if (!authUser) return false;
	if (authUser.source !== "api_key") return true;
	const scopes = authUser.scopes ?? [];
	return scopes.includes(SCOPE_ALL) || scopes.includes(SCOPE_MANAGE);
}

/**
 * Middleware: centralized operator-route scope policy (D1). Replaces the
 * per-router requireScope("manage") wildcard gates. Behavior:
 *  - DISABLE_AUTH=true → always passes (exact requireScope() parity, M1).
 *  - forwardauth/local callers → always pass (never scope-limited).
 *  - api_key callers holding `manage` or `*` → always pass.
 *  - api_key callers holding `observe` → pass only on GET/HEAD routes in
 *    OBSERVE_READ_PATHS (classifyRoute keyed on the resolved request path;
 *    see the implementation note on classifyRoute for why c.req.path is
 *    used here rather than c.req.routePath).
 *  - api_key callers holding `ingest` → pass only on (method, path) pairs
 *    in INGEST_WRITABLE_ROUTES (D1) — today just PUT .../native-name.
 *  - Otherwise → 403 { error: "insufficient_scope", required: "manage" }.
 *    `required` is always "manage": the message names the scope that
 *    unconditionally unlocks every operator route, not the (possibly lower)
 *    minimal scope for the one route that was hit — an ingest-only key
 *    rejected on an observe-eligible route is still told "manage" since
 *    that's the scope guaranteed to work everywhere.
 *
 * Must be chained AFTER requireAuth() so authUser is already set in context.
 */
export function requireOperatorScope() {
	return async (c: Context, next: Next) => {
		if (config.disableAuth) {
			return next();
		}

		const authUser = c.get("authUser") as AuthUser | undefined;
		if (!authUser) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		if (authUser.source !== "api_key") {
			return next();
		}

		const scopes = authUser.scopes ?? [];
		if (scopes.includes(SCOPE_ALL) || scopes.includes(SCOPE_MANAGE)) {
			return next();
		}

		if (
			scopes.includes(SCOPE_OBSERVE) &&
			classifyRoute(c.req.method, c.req.path) === SCOPE_OBSERVE
		) {
			return next();
		}

		if (scopes.includes(SCOPE_INGEST) && isIngestWritable(c.req.method, c.req.path)) {
			return next();
		}

		return c.json({ error: "insufficient_scope", required: SCOPE_MANAGE }, 403);
	};
}
