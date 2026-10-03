import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AGENT_TYPES } from "../../shared/constants.js";
import {
	type OwnerScope,
	type OwnerScopeEcho,
	ownerScopeEcho,
	parseOwnerParam,
	resolveOwnerScope,
} from "../../shared/owner-scope.js";
import {
	ACTIVE_OPERATIONAL_STATUSES,
	type ActiveOperationalStatus,
	SESSION_LIST_TABS,
	type SessionListTab,
} from "../../shared/session-state.js";
import type { SessionStatus } from "../../shared/types.js";
import { actorFromAuthUser } from "../auth/actor.js";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import { OwnerDisabledError, OwnerNotFoundError } from "../auth/owner-state.js";
import {
	callerHasManageScope,
	getRequestActor,
	getRequestMode,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { events, sessions, users } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { hookRateLimit } from "../middleware/hook-rate-limit.js";
import { logAdminAction } from "../services/audit-log.js";
import {
	NotOwnerError,
	assertCanArchiveSession,
	assertCanDeleteSession,
	assertCanPinSession,
	assertCanRenameSession,
	bindIngestKey,
	judgeForeignKeyWrite,
} from "../services/authorization.js";
import {
	listControlActionsForSession,
	queuePromptAction,
	queueStopAction,
	retryLaunchForSession,
} from "../services/control-actions.js";
import { toSessionEventDtos } from "../services/event-dto.js";
import { notifySessionUpdated } from "../services/notifier.js";
import { readServiceKeyLists } from "../services/service-key-lists.js";
import { isServiceKeyRow } from "../services/service-keys.js";
import { type SessionDetailRead, getSessionDetail } from "../services/session-detail.js";
import { changeSessionOwner } from "../services/session-owner-admin.js";
import {
	type SessionListField,
	acknowledgeSession,
	applyNativeName,
	emptyStats,
	emptyStatsByOwner,
	getSession,
	getSessionSummaries,
	getSessions,
	getStats,
	getStatsByOwner,
	isSessionListField,
	renameSession,
	resetNameSource,
	unacknowledgeSession,
} from "../services/session-tracker.js";
import { computeChecksum } from "../util/checksum.js";
import { OwnTurnBusyError } from "../util/own-turn.js";
import { InvalidAgentTypeQueryError, parseAgentTypeQuery } from "./agent-type-query.js";
import { incrementIngestForeignKeyDropped } from "./ingest-counters.js";

// AGEN: a generous cap for a human-typed search term — long enough that no
// legitimate dashboard search ever hits it, short enough that a caller
// can't force an arbitrarily large pattern through the LIKE/ILIKE planner.
const SESSIONS_QUERY_MAX_LENGTH = 200;

// A page is at most as many rows as the operational candidate scan holds, and an
// offset past a million is not a page anyone reads.
const MAX_LIST_LIMIT = 5000;
const MAX_LIST_OFFSET = 1_000_000;
const DEFAULT_LIST_LIMIT = 50;
// A refusal echoes the offending value, but never more than a short prefix of it.
const MAX_ECHOED_VALUE_LENGTH = 64;

const echoed = (value: string | undefined): string | undefined =>
	value === undefined ? undefined : value.slice(0, MAX_ECHOED_VALUE_LENGTH);

/** A non-negative integer query value within bounds; absent or empty is the default, anything else null. */
function parseBoundedInt(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number | null {
	if (raw === undefined || raw === "") return fallback;
	if (!/^[0-9]{1,9}$/.test(raw)) return null;
	const value = Number(raw);
	return value >= min && value <= max ? value : null;
}

const sessionsRouter = new Hono();
sessionsRouter.use("*", requireAuth());
// Session data is operator-only. Ingest keys must not list session history,
// read event timelines, or mutate session state (rename, notes, archive).
// Relay users must use a manage-scoped key (see scripts/setup-relay.sh).
// requireOperatorScope() additionally recognizes observe-scoped keys on the
// read-only routes in OBSERVE_READ_PATHS (list, detail, timeline, event
// context, claude-md); mutating routes and control-actions stay manage-only.
sessionsRouter.use("*", requireOperatorScope());

type SessionAssertion = typeof assertCanDeleteSession;

/**
 * Team mode: archive, rename, pin and delete need the session's owner or an
 * admin (an unowned session is open to any member). Returns the 403
 * not_owner response when refused, null to carry on. Solo never refuses.
 */
async function refuseUnlessOwnerOrAdmin(
	c: Context,
	sessionId: string,
	assertAllowed: SessionAssertion,
): Promise<Response | null> {
	try {
		await assertAllowed(await getRequestActor(c), sessionId);
		return null;
	} catch (err) {
		if (err instanceof NotOwnerError) return c.json({ error: "not_owner" }, 403);
		throw err;
	}
}

/**
 * What an agent-reported write needs to do once it knows it applied: bind the
 * posting service key as the session's ingest key, when the hook rule accepted
 * it only on that condition.
 */
type AgentNameAdmission = { refusal: Response } | { refusal: null; bindKeyId: string | null };

/**
 * An agent-reported name (native-name, or a rename with source "sync") follows
 * the hook path's rule in team mode. A key that is foreign to an owned session
 * is dropped with a 200 and counted, same as a hook event; a signed-in human
 * can't use the agent route to rename a session they couldn't rename directly
 * (owner or admin). A refusal is the response to send; otherwise carry on, and
 * bind `bindKeyId` (if any) only when the name was actually applied.
 */
async function admitAgentName(
	c: Context,
	sessionId: string,
	droppedBody: Record<string, unknown>,
): Promise<AgentNameAdmission> {
	const authUser = c.get("authUser") as AuthUser;
	const isKey = authUser.source === "api_key" && authUser.keyId !== null;
	if (!isKey) {
		const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanRenameSession);
		return refusal ? { refusal } : { refusal: null, bindKeyId: null };
	}

	if ((await getRequestMode(c)) === "solo") return { refusal: null, bindKeyId: null };
	const [row] = await getDb()
		.select({
			sessionId: sessions.sessionId,
			ownerUserId: sessions.ownerUserId,
			ingestKeyId: sessions.ingestKeyId,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return { refusal: null, bindKeyId: null };
	const posting = { ownerUserId: authUser.userId, ingestKeyId: authUser.keyId };
	const verdict = await judgeForeignKeyWrite(row, posting);
	if (!verdict.drop) return { refusal: null, bindKeyId: verdict.bindKeyId };
	incrementIngestForeignKeyDropped();
	return { refusal: c.json(droppedBody) };
}

/**
 * A signed-in caller's rate-limit bucket is keyed by session id, which the
 * caller chooses, so an id that doesn't exist answers 404 here, before the
 * limiter creates a bucket for it. An API key's bucket is keyed by the key, not
 * the session, so a key skips the lookup.
 */
async function requireKnownSessionForDashboardCaller(c: Context, next: Next) {
	const authUser = c.get("authUser") as AuthUser | undefined;
	if (authUser?.source === "api_key") return next();
	const [row] = await getDb()
		.select({ sessionId: sessions.sessionId })
		.from(sessions)
		.where(eq(sessions.sessionId, c.req.param("sessionId") ?? ""))
		.limit(1);
	if (!row) return c.json({ error: "Session not found" }, 404);
	return next();
}

/**
 * `?owner=` for the list and the stats poll: the scope to filter on, or the
 * 400 to send. `me` is the signed-in user, or the owner of the key in use; a
 * caller with neither (an ownerless key, auth disabled) gets a refusal instead
 * of silently seeing everyone.
 */
function ownerScopeFromQuery(
	c: Context,
): { scope: OwnerScope | undefined; echo: OwnerScopeEcho } | { refusal: Response } {
	const raw = c.req.query("owner");
	const parsed = parseOwnerParam(raw);
	if (!parsed) return { refusal: c.json({ error: "invalid_owner", value: echoed(raw) }, 400) };
	const authUser = c.get("authUser") as AuthUser | undefined;
	const scope = resolveOwnerScope(parsed, authUser?.userId);
	if (scope === null) return { refusal: c.json({ error: "owner_me_unavailable" }, 400) };
	return { scope, echo: ownerScopeEcho(parsed, scope) };
}

/**
 * Which key reported the session (its name and whether it is a service key,
 * never its id), for the callers who may know: on a solo instance everyone who
 * is in, in a team an admin, the session's owner and the key's owner (a key's
 * label can name a person's machine). Anyone else gets the field omitted, so it
 * doesn't even say whether a key reported the session.
 */
async function reportedByKeyFor(
	c: Context,
	detail: SessionDetailRead,
): Promise<{ name: string; serviceKey: boolean } | null | undefined> {
	const { reportingKey, mode } = detail;
	// The lists are read only to say whether an ownerless key is a service key.
	const lists =
		reportingKey && reportingKey.ownerUserId === null ? await readServiceKeyLists() : null;
	const actor = await getRequestActor(c, {
		mode,
		keptAdminServiceKeyIds: lists?.admin,
	});
	const mayKnow =
		actor.mode === "solo" ||
		actor.role === "admin" ||
		(actor.userId !== null &&
			(actor.userId === (detail.session.ownerUserId ?? null) ||
				actor.userId === reportingKey?.ownerUserId));
	if (!mayKnow) return undefined;
	if (!reportingKey) return null;
	return {
		name: reportingKey.name,
		serviceKey: lists ? isServiceKeyRow(reportingKey, lists) : false,
	};
}

/**
 * True when the request named a user id (not `me`) that is no user: its list and
 * counts are empty by definition, so the route answers without a scan. One
 * primary-key read, and the answer is the same shape a user with no sessions
 * gets, so it says nothing about which ids exist.
 */
async function namesNoSuchUser(echo: OwnerScopeEcho): Promise<boolean> {
	if (echo.kind !== "user" || !echo.userId) return false;
	const [row] = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, echo.userId))
		.limit(1);
	return !row;
}

/**
 * Runs a handler that scans: when the scan queue is full the answer is a 503
 * `busy` with a one second Retry-After rather than a request that waits behind
 * hundreds of others.
 */
async function orBusy(c: Context, handle: () => Promise<Response>): Promise<Response> {
	try {
		return await handle();
	} catch (err) {
		if (!(err instanceof OwnTurnBusyError)) throw err;
		c.header("Retry-After", "1");
		return c.json({ error: "busy" }, 503);
	}
}

/**
 * Tell every open dashboard the session changed, in the shape every other
 * session update takes (owner fields included, the recorded key never). A
 * session that no longer exists broadcasts nothing.
 */
async function broadcastSession(sessionId: string): Promise<void> {
	const session = await getSession(sessionId);
	if (session) notifySessionUpdated(session);
}

/**
 * The request body as a plain JSON object, or null when it is not valid JSON or
 * is not an object (an array, a bare value). Callers answer null with 400
 * invalid_body rather than letting a bad body reach the database.
 */
async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
	const body: unknown = await c.req.json().catch(() => null);
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

function invalidBody(c: Context): Response {
	return c.json({ error: "invalid_body" }, 400);
}

// GET /api/v1/sessions - List sessions
sessionsRouter.get("/sessions", async (c) => {
	const status = c.req.query("status") as SessionStatus | undefined;
	let agentType: ReturnType<typeof parseAgentTypeQuery>;
	try {
		agentType = parseAgentTypeQuery(c.req.query("agent_type"));
	} catch (err) {
		if (err instanceof InvalidAgentTypeQueryError) {
			return c.json(
				{ error: "invalid_agent_type", value: echoed(err.value), allowed: AGENT_TYPES },
				400,
			);
		}
		throw err;
	}
	const projectId = c.req.query("projectId") as string | undefined;
	const limit = parseBoundedInt(c.req.query("limit"), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
	if (limit === null) {
		return c.json(
			{ error: "invalid_limit", value: echoed(c.req.query("limit")), max: MAX_LIST_LIMIT },
			400,
		);
	}
	const offset = parseBoundedInt(c.req.query("offset"), 0, 0, MAX_LIST_OFFSET);
	if (offset === null) {
		return c.json(
			{ error: "invalid_offset", value: echoed(c.req.query("offset")), max: MAX_LIST_OFFSET },
			400,
		);
	}

	// AGEN: filter by the computed operational state (waiting/working/idle/
	// error) rather than the raw lifecycle status. Validated the same way
	// agent_type is — an unrecognized value 400s instead of silently
	// matching zero rows.
	const operationalParam = c.req.query("operational");
	let operational: ActiveOperationalStatus | undefined;
	if (operationalParam) {
		if (!(ACTIVE_OPERATIONAL_STATUSES as readonly string[]).includes(operationalParam)) {
			return c.json(
				{
					error: "invalid_operational",
					value: echoed(operationalParam),
					allowed: ACTIVE_OPERATIONAL_STATUSES,
				},
				400,
			);
		}
		operational = operationalParam as ActiveOperationalStatus;
	}

	// The dashboard's tabs: exactly what the matching stats count describes. They
	// are their own question, so combining one with a status or an operational
	// filter is refused rather than half-honoured.
	const tabParam = c.req.query("tab");
	let tab: SessionListTab | undefined;
	if (tabParam !== undefined) {
		if (!(SESSION_LIST_TABS as readonly string[]).includes(tabParam)) {
			return c.json(
				{ error: "invalid_tab", value: echoed(tabParam), allowed: SESSION_LIST_TABS },
				400,
			);
		}
		tab = tabParam as SessionListTab;
		const conflicting = status !== undefined ? "status" : operational ? "operational" : undefined;
		if (conflicting) {
			return c.json({ error: "unsupported_combination", params: ["tab", conflicting] }, 400);
		}
	}

	// AGEN: server-side search (displayName/cwd/gitBranch), composes with
	// operational= and status= — see searchCondition in session-tracker.ts.
	// Capped the same way the other query params are validated: an
	// unbounded `q` is forwarded straight into a LIKE/ILIKE pattern.
	const q = c.req.query("q");
	if (q !== undefined && q.length > SESSIONS_QUERY_MAX_LENGTH) {
		return c.json({ error: "query_too_long", value: q.length }, 400);
	}

	// AGEN: mirrors the dashboard's "Show scratch workspaces" toggle
	// server-side — see excludeScratch in session-tracker.ts.
	const excludeScratch = c.req.query("excludeScratch") === "true";

	// AGEN: whose sessions — one scope for the rows, the total and (via the
	// stats route) the counts. See ownerScopeFromQuery.
	const ownerResult = ownerScopeFromQuery(c);
	if ("refusal" in ownerResult) return ownerResult.refusal;
	const owner = ownerResult.scope;
	const ownerScope = ownerResult.echo;

	// F128: opt-in narrow projection (the relay's per-tick Codex paging). An
	// unknown or empty field list is a 400, so a typo can't silently fall back
	// to the heavy full rows. Without `fields` the response is unchanged.
	const fieldsParam = c.req.query("fields");
	if (fieldsParam !== undefined && operational !== undefined) {
		// The projection pages by recency and has no classifier; honouring one and
		// silently dropping the other would answer a question nobody asked.
		return c.json({ error: "unsupported_combination", params: ["fields", "operational"] }, 400);
	}
	if (fieldsParam !== undefined) {
		const fields = fieldsParam.split(",").map((f) => f.trim());
		const invalid = fields.find((f) => !isSessionListField(f));
		if (invalid !== undefined)
			return c.json({ error: "invalid_field", value: echoed(invalid) }, 400);
		if (await namesNoSuchUser(ownerScope)) return c.json({ sessions: [], ownerScope });
		const rows = await getSessionSummaries(
			{ status, tab, agentType, projectId, q, excludeScratch, owner, limit, offset },
			fields as SessionListField[],
		);
		return c.json({ sessions: rows, ownerScope });
	}

	if (await namesNoSuchUser(ownerScope)) return c.json({ sessions: [], total: 0, ownerScope });

	return orBusy(c, async () => {
		const result = await getSessions({
			status,
			tab,
			agentType,
			projectId,
			operational,
			q,
			excludeScratch,
			owner,
			limit,
			offset,
		});
		return c.json({ ...result, ownerScope });
	});
});

// GET /api/v1/sessions/stats - Dashboard stats
sessionsRouter.get("/sessions/stats", async (c) => {
	const excludeScratch = c.req.query("excludeScratch") === "true";
	const ownerResult = ownerScopeFromQuery(c);
	if ("refusal" in ownerResult) return ownerResult.refusal;
	const owner = ownerResult.scope;
	const ownerScope = ownerResult.echo;

	// AGEN: `group_by=owner` answers the whole team in one grouped pass. The
	// response shape differs from the plain poll, so it is opt-in.
	const groupBy = c.req.query("group_by");
	if (groupBy !== undefined && groupBy !== "owner") {
		return c.json({ error: "invalid_group_by", value: echoed(groupBy) }, 400);
	}
	if (await namesNoSuchUser(ownerScope)) {
		return c.json({ ownerScope, ...(groupBy ? emptyStatsByOwner() : emptyStats()) });
	}
	return orBusy(c, async () =>
		groupBy
			? c.json({ ownerScope, ...(await getStatsByOwner({ excludeScratch, owner })) })
			: c.json({ ownerScope, ...(await getStats({ excludeScratch, owner })) }),
	);
});

// GET /api/v1/sessions/:sessionId - Session detail
sessionsRouter.get("/sessions/:sessionId", async (c: Context) => {
	const sessionId = c.req.param("sessionId");
	const detail = await getSessionDetail(sessionId);

	if (!detail) {
		return c.json({ error: "Session not found" }, 404);
	}
	const { session } = detail;

	// Get timeline events for the detail page; the UI handles mode filtering.
	const sessionEvents = toSessionEventDtos(
		await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId))
			.orderBy(desc(events.id))
			.limit(500),
	);

	// C1: controlActions metadata carries the injected prompt and launch.env
	// (control-actions.ts:187-194). An observe-scoped caller may read session
	// detail (it's in OBSERVE_READ_PATHS) but must not see this embed.
	const authUser = c.get("authUser") as AuthUser | undefined;
	const operator = callerHasManageScope(authUser);
	const controlActions = operator ? await listControlActionsForSession(sessionId) : undefined;
	const reportedByKey = operator ? await reportedByKeyFor(c, detail) : undefined;

	return c.json({ session, events: sessionEvents, controlActions, reportedByKey });
});

// GET /api/v1/sessions/:sessionId/timeline - Paginated event timeline
sessionsRouter.get("/sessions/:sessionId/timeline", async (c) => {
	const sessionId = c.req.param("sessionId");
	const limit = parseBoundedInt(c.req.query("limit"), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
	if (limit === null) {
		return c.json(
			{ error: "invalid_limit", value: echoed(c.req.query("limit")), max: MAX_LIST_LIMIT },
			400,
		);
	}
	const offset = parseBoundedInt(c.req.query("offset"), 0, 0, MAX_LIST_OFFSET);
	if (offset === null) {
		return c.json(
			{ error: "invalid_offset", value: echoed(c.req.query("offset")), max: MAX_LIST_OFFSET },
			400,
		);
	}

	const sessionEvents = toSessionEventDtos(
		await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId))
			.orderBy(desc(events.id))
			.limit(limit)
			.offset(offset),
	);

	return c.json({ events: sessionEvents });
});

// PUT /api/v1/sessions/:sessionId/notes - Save notes for a session
sessionsRouter.put("/sessions/:sessionId/notes", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await readJsonObject(c);
	// null clears the notes; a missing or non-string value is a malformed call.
	if (!body || !(typeof body.notes === "string" || body.notes === null)) return invalidBody(c);

	await getDb()
		.update(sessions)
		.set({ notes: body.notes ?? "" })
		.where(eq(sessions.sessionId, sessionId));
	await broadcastSession(sessionId);

	return c.json({ ok: true });
});

// PUT /api/v1/sessions/:sessionId/rename - Rename a session
//
// Slice DELETE-RENAME-1: business logic lives in `renameSession`, which
// wraps the `sessions` + (optional) `managed_sessions` updates in a
// transaction. The route handler only validates input.
//
// `source` (F5 / Decision 6, optional; contract revised per codex r2
// Medium #1) records who initiated the rename. Only an explicit
// `source: "user"` stamps `metadata.renameSource = "user"`, which
// `applyNativeName` below checks to refuse a later native-name pull. An
// omitted `source` is legacy-neutral: the rename happens and the flag is
// left untouched, so a mixed-version old relay sending `{ name }` can't be
// misclassified as a manual rename. `source: "sync"` (pre-Phase-3 relays'
// Codex name sync) is not a plain rename: it takes the native-name path,
// so a manual pin wins and only `metadata.nativeName` is recorded (F121,
// below). The dashboard (src/web/lib/api.ts) and the Ask "rename X to Y"
// command both send `source: "user"` explicitly.
//
// D14: `source: "reset"` is a distinct branch — it clears the manual-rename
// pin (and applies any already-observed native name immediately) instead of
// setting a new display name, so `name` is optional ONLY in this branch
// (F47: the carve-out must not leak into the plain-rename 400-on-missing-name
// check). Stays manage-only; it is deliberately NOT in
// INGEST_WRITABLE_ROUTES.
// xander (Low, optional): the only three values anything ever sends are
// "user" (dashboard/Ask), "sync" (relay Codex name-sync) and "reset" (D14) —
// reject anything else outright instead of silently legacy-neutral no-op'ing
// on a typo'd or unexpected value.
const ALLOWED_RENAME_SOURCES = new Set(["user", "sync", "reset"]);

sessionsRouter.put("/sessions/:sessionId/rename", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await readJsonObject(c);
	if (!body || !(body.name === undefined || typeof body.name === "string")) return invalidBody(c);
	if (body.source !== undefined && typeof body.source !== "string") return invalidBody(c);
	const { name, source } = body as { name?: string; source?: string };

	if (source !== undefined && !ALLOWED_RENAME_SOURCES.has(source)) {
		return c.json({ error: "invalid_source", value: echoed(source) }, 400);
	}

	if (source === "reset") {
		const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanRenameSession);
		if (refusal) return refusal;
		const result = await resetNameSource(sessionId);
		if (!result.found) return c.json({ error: "Session not found" }, 404);
		const session = await getSession(sessionId);
		if (session) notifySessionUpdated(session);
		return c.json({ ok: true });
	}

	if (!name?.trim()) return c.json({ error: "Name required" }, 400);

	// ian F121: pre-Phase-3 relays push Codex thread titles here with
	// source:"sync" (and a manage key). That's an agent-reported name, so it
	// takes the native-name path: a manual pin wins, nativeName is recorded,
	// and the response stays 200 (an unknown session is still a silent no-op).
	if (source === "sync") {
		const admission = await admitAgentName(c, sessionId, { ok: true });
		if (admission.refusal) return admission.refusal;
		const result = await applyNativeName(sessionId, name);
		if (result.applied) {
			if (admission.bindKeyId) await bindIngestKey(sessionId, admission.bindKeyId);
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
		}
		return c.json({ ok: true });
	}

	const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanRenameSession);
	if (refusal) return refusal;
	await renameSession(sessionId, name, { source });
	const session = await getSession(sessionId);
	if (session) notifySessionUpdated(session);
	return c.json({ ok: true });
});

// PUT /api/v1/sessions/:sessionId/native-name - Pull-only sync (F5) of
// Claude Code's native session_name into displayName. Called by
// scripts/statusline.sh through the local relay on every render where the
// native name changed. Deliberately 404s on an unknown session — a
// departure from /rename's silent no-op-on-missing-row behavior — so the
// statusline caller can distinguish "not yet ingested, retry next render"
// from a successful call. See Decision 6 and applyNativeName for the
// manual-rename precedence rule.
//
// D1/D20: this is the one INGEST_WRITABLE_ROUTES entry — an ingest-scoped
// relay/statusline key may call it directly. hookRateLimit here opts into a
// real 429 (unlike /hooks' always-200 contract) since this is a dashboard-
// adjacent write path, not the ingest firehose.
// xander F92: a native name is at most 200 code points after sanitizing; 16
// KiB is generous and keeps an ingest key from making the server buffer and
// parse arbitrarily large bodies.
const NATIVE_NAME_BODY_LIMIT_BYTES = 16 * 1024;

sessionsRouter.put(
	"/sessions/:sessionId/native-name",
	bodyLimit({
		maxSize: NATIVE_NAME_BODY_LIMIT_BYTES,
		onError: (c) => c.json({ error: "payload_too_large" }, 413),
	}),
	requireKnownSessionForDashboardCaller,
	hookRateLimit({ bucketPrefix: "native-name:", onLimit: "429" }),
	async (c) => {
		const sessionId = c.req.param("sessionId");
		const { name } = await c.req.json<{ name: string }>();

		if (!name?.trim()) return c.json({ error: "Name required" }, 400);

		const admission = await admitAgentName(c, sessionId, { ok: true, applied: false });
		if (admission.refusal) return admission.refusal;
		const result = await applyNativeName(sessionId, name);
		if (result.reason === "empty_after_sanitize") {
			return c.json({ error: "Name required" }, 400);
		}
		if (!result.found) return c.json({ error: "Session not found" }, 404);

		if (result.applied) {
			if (admission.bindKeyId) await bindIngestKey(sessionId, admission.bindKeyId);
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
		}

		return c.json({ ok: true, applied: result.applied });
	},
);

sessionsRouter.get("/sessions/:sessionId/control-actions", async (c) => {
	const actions = await listControlActionsForSession(c.req.param("sessionId"));
	return c.json({ controlActions: actions });
});

sessionsRouter.post("/sessions/:sessionId/stop", async (c: Context) => {
	try {
		const authUser = c.get("authUser") as AuthUser | undefined;
		const action = await queueStopAction(c.req.param("sessionId"), actorFromAuthUser(authUser));
		return c.json({ action }, 202);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Unable to queue stop" }, 400);
	}
});

sessionsRouter.post("/sessions/:sessionId/prompt", async (c: Context) => {
	try {
		const body = await c.req.json<{ prompt?: string }>();
		const authUser = c.get("authUser") as AuthUser | undefined;
		const action = await queuePromptAction(
			c.req.param("sessionId"),
			body.prompt || "",
			actorFromAuthUser(authUser),
		);
		return c.json({ action }, 202);
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unable to queue prompt" },
			400,
		);
	}
});

sessionsRouter.post("/sessions/:sessionId/retry", async (c: Context) => {
	try {
		const authUser = c.get("authUser") as AuthUser | undefined;
		const result = await retryLaunchForSession(
			c.req.param("sessionId"),
			actorFromAuthUser(authUser),
		);
		return c.json(result, 201);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Unable to retry" }, 400);
	}
});

sessionsRouter.post("/sessions/:sessionId/fork", async (c) => {
	return c.json({ error: "Fork is not implemented yet for this provider." }, 501);
});

sessionsRouter.post("/sessions/:sessionId/resume", async (c) => {
	return c.json({ error: "Resume is not implemented yet for this provider." }, 501);
});

// PUT /api/v1/sessions/:sessionId/pin - Toggle pin
sessionsRouter.put("/sessions/:sessionId/pin", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await readJsonObject(c);
	if (!body || typeof body.pinned !== "boolean") return invalidBody(c);
	const { pinned } = body;
	const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanPinSession);
	if (refusal) return refusal;

	await getDb().update(sessions).set({ isPinned: pinned }).where(eq(sessions.sessionId, sessionId));
	await broadcastSession(sessionId);

	return c.json({ ok: true });
});

// PATCH /api/v1/sessions/:sessionId/owner - { ownerUserId | null }. An admin (or an
// admin-equivalent key) hands a session to a user or clears its owner. The
// audit line below is the only record; nothing is stored on the row.
sessionsRouter.patch("/sessions/:sessionId/owner", async (c: Context) => {
	const sessionId = c.req.param("sessionId") ?? "";
	const body = (await c.req.json().catch(() => null)) as { ownerUserId?: unknown } | null;
	const owner = body?.ownerUserId;
	if (body === null || !("ownerUserId" in body) || (owner !== null && typeof owner !== "string")) {
		return c.json({ error: "invalid_patch" }, 400);
	}
	try {
		const result = await changeSessionOwner(sessionId, owner);
		if (!result.found) return c.json({ error: "Session not found" }, 404);
		logAdminAction("session_owner_changed", await getRequestActor(c), {
			sessionId,
			from: result.from,
			to: result.to,
		});
		const session = await getSession(sessionId);
		if (session) notifySessionUpdated(session);
		return c.json({ ok: true, session });
	} catch (err) {
		if (err instanceof OwnerNotFoundError) return c.json({ error: "user_not_found" }, 404);
		if (err instanceof OwnerDisabledError) return c.json({ error: "user_disabled" }, 409);
		throw err;
	}
});

// POST /api/v1/sessions/:sessionId/acknowledge - Dashboard "mark as seen"
// (AGEN). Stamps lastUserAcknowledgedAt only; see acknowledgeSession for the
// ownership rule. Idempotent; 404 for an unknown session; a non-owner caller
// gets 200 { acknowledged: false, reason: "not_owner" }, never an error.
// Rate-limited the same way /native-name is: a dashboard-adjacent write
// path, not the ingest firehose, so a real 429 rather than /hooks'
// always-200 contract.
sessionsRouter.post(
	"/sessions/:sessionId/acknowledge",
	requireKnownSessionForDashboardCaller,
	hookRateLimit({ bucketPrefix: "acknowledge:", onLimit: "429" }),
	async (c: Context) => {
		const sessionId = c.req.param("sessionId");
		// Optional body: { source } labels the timeline row (e.g.
		// "dismiss-error" for the explicit Dismiss-error action vs the
		// default "dashboard" for Mark-as-seen). Unparseable/absent body is
		// fine — this route has never required one.
		const body = await c.req.json<{ source?: string }>().catch(() => ({}) as { source?: string });
		const result = await acknowledgeSession(
			sessionId,
			await getRequestActor(c),
			typeof body.source === "string" && body.source ? body.source : undefined,
		);

		if (!result.found) return c.json({ error: "Session not found" }, 404);
		if (!result.acknowledged) {
			return c.json({ acknowledged: false, reason: result.reason });
		}

		// AGEN: no broadcast for an idempotent no-op — nothing changed.
		if (result.changed) {
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
		}
		return c.json({ acknowledged: true });
	},
);

// DELETE /api/v1/sessions/:sessionId/acknowledge - Dashboard "mark as
// unseen" (AGEN). Clears lastUserAcknowledgedAt; see unacknowledgeSession
// for the ownership rule and classifier effects (a dismissed failure goes
// back to ERROR). Idempotent and rate-limited the same way POST is.
sessionsRouter.delete(
	"/sessions/:sessionId/acknowledge",
	requireKnownSessionForDashboardCaller,
	hookRateLimit({ bucketPrefix: "acknowledge:", onLimit: "429" }),
	async (c: Context) => {
		const sessionId = c.req.param("sessionId");
		const body = await c.req.json<{ source?: string }>().catch(() => ({}) as { source?: string });
		const result = await unacknowledgeSession(
			sessionId,
			await getRequestActor(c),
			typeof body.source === "string" && body.source ? body.source : undefined,
		);

		if (!result.found) return c.json({ error: "Session not found" }, 404);
		if (!result.unacknowledged) {
			return c.json({ unacknowledged: false, reason: result.reason });
		}

		if (result.changed) {
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
		}
		return c.json({ unacknowledged: true });
	},
);

// Slice SEARCH-1: legacy GET /sessions/search was removed. The FTS5-backed
// `/api/v1/search?kinds=session&q=...` endpoint (see routes/search.ts) is the
// only supported session-search path now. Requests to the old URL fall
// through to `/sessions/:sessionId` with sessionId="search" and 404 with
// "Session not found", which is the expected behavior for the dead route.

// GET /api/v1/sessions/:sessionId/events/:eventId/context - Event context window
sessionsRouter.get("/sessions/:sessionId/events/:eventId/context", async (c) => {
	const sessionId = c.req.param("sessionId");
	const eventId = Number(c.req.param("eventId"));
	const rawAround = Number(c.req.query("around") ?? 20);
	const around = Math.max(1, Math.min(100, Number.isFinite(rawAround) ? rawAround : 20));

	if (!Number.isInteger(eventId) || eventId <= 0) {
		return c.json({ error: "Invalid eventId" }, 404);
	}

	// Verify the target event exists and belongs to this session.
	const [target] = await getDb()
		.select()
		.from(events)
		.where(and(eq(events.id, eventId), eq(events.sessionId, sessionId)))
		.limit(1);

	if (!target) {
		return c.json({ error: "Event not found" }, 404);
	}

	// Events at or before the target (includes target itself), newest first.
	const before = await getDb()
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), lte(events.id, eventId)))
		.orderBy(desc(events.id))
		.limit(around + 1);

	// Events strictly after the target, oldest first.
	const after = await getDb()
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), gt(events.id, eventId)))
		.orderBy(asc(events.id))
		.limit(around);

	const combined = toSessionEventDtos([...before.reverse(), ...after]);

	return c.json({ events: combined, target: { id: eventId } });
});

// GET /api/v1/sessions/:sessionId/claude-md - Get CLAUDE.md content from DB
sessionsRouter.get("/sessions/:sessionId/claude-md", async (c) => {
	const sessionId = c.req.param("sessionId");
	const [session] = await getDb()
		.select({
			claudeMdContent: sessions.claudeMdContent,
			claudeMdPath: sessions.claudeMdPath,
			claudeMdChecksum: sessions.claudeMdChecksum,
			claudeMdUpdatedAt: sessions.claudeMdUpdatedAt,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	if (!session) return c.json({ error: "Session not found" }, 404);

	return c.json({
		content: session.claudeMdContent || "",
		path: session.claudeMdPath || "",
		checksum: session.claudeMdChecksum || "",
		updatedAt: session.claudeMdUpdatedAt || null,
	});
});

// PUT /api/v1/sessions/:sessionId/claude-md - Save CLAUDE.md content to DB
sessionsRouter.put("/sessions/:sessionId/claude-md", async (c) => {
	const sessionId = c.req.param("sessionId");
	const { content, path } = await c.req.json<{ content: string; path?: string }>();

	const now = new Date().toISOString();
	const checksum = await computeChecksum(content);
	const updates: Record<string, unknown> = {
		claudeMdContent: content,
		claudeMdChecksum: checksum,
		claudeMdUpdatedAt: now,
	};
	if (path) updates.claudeMdPath = path;

	await getDb().update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true, checksum });
});

// PUT /api/v1/sessions/:sessionId/archive - Toggle archive flag (is_archived boolean)
sessionsRouter.put("/sessions/:sessionId/archive", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = (await readJsonObject(c)) ?? {};
	// Default to archiving (true) when the caller omits the field; a field that
	// is present but not a boolean is a malformed call.
	if (body.archived !== undefined && typeof body.archived !== "boolean") return invalidBody(c);
	const archived = body.archived !== false;
	const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanArchiveSession);
	if (refusal) return refusal;

	await getDb()
		.update(sessions)
		.set({ isArchived: archived })
		.where(eq(sessions.sessionId, sessionId));
	await broadcastSession(sessionId);

	return c.json({ ok: true });
});

// DELETE /api/v1/sessions/:sessionId - Delete a session and its events
//
// Slice DB-1: child tables (events, managed_sessions, control_actions,
// watcher_proposals, ai_hitl_requests, ai_watcher_runs, watcher_configs)
// now reference sessions(session_id) ON DELETE CASCADE, so the single
// `delete(sessions)` is sufficient — both dialects drop children atomically
// via the cascade FK. The explicit `events` delete is belt-and-braces for
// older SQLite installs that haven't yet rebuilt FKs.
//
// We wrap the deletes in withTransaction() so any failure leaves the row
// in place rather than partially deleted.
sessionsRouter.delete("/sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");
	const refusal = await refuseUnlessOwnerOrAdmin(c, sessionId, assertCanDeleteSession);
	if (refusal) return refusal;

	await withTransaction(async (tx) => {
		// Cascade does this; explicit for older DBs that haven't yet rebuilt FKs.
		await tx.delete(events).where(eq(events.sessionId, sessionId));
		await tx.delete(sessions).where(eq(sessions.sessionId, sessionId));
	});

	return c.json({ ok: true });
});

export { sessionsRouter };
