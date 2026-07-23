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
import { SCOPE_ALL, SCOPE_MANAGE, SCOPE_OBSERVE } from "./api-key.js";
import type { AuthUser } from "./middleware.js";

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
]);

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

		return c.json({ error: "insufficient_scope", required: SCOPE_MANAGE }, 403);
	};
}
