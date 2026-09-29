import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentType, SessionStatus } from "../../shared/types.js";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import { callerHasManageScope, requireOperatorScope } from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { events, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { hookRateLimit } from "../middleware/hook-rate-limit.js";
import {
	listControlActionsForSession,
	queuePromptAction,
	queueStopAction,
	retryLaunchForSession,
} from "../services/control-actions.js";
import { notifySessionUpdated } from "../services/notifier.js";
import {
	type SessionListField,
	applyNativeName,
	getSession,
	getSessionSummaries,
	getSessions,
	getStats,
	isSessionListField,
	renameSession,
	resetNameSource,
} from "../services/session-tracker.js";
import { computeChecksum } from "../util/checksum.js";

const sessionsRouter = new Hono();
sessionsRouter.use("*", requireAuth());
// Session data is operator-only. Ingest keys must not list session history,
// read event timelines, or mutate session state (rename, notes, archive).
// Relay users must use a manage-scoped key (see scripts/setup-relay.sh).
// requireOperatorScope() additionally recognizes observe-scoped keys on the
// read-only routes in OBSERVE_READ_PATHS (list, detail, timeline, event
// context, claude-md); mutating routes and control-actions stay manage-only.
sessionsRouter.use("*", requireOperatorScope());

// GET /api/v1/sessions - List sessions
sessionsRouter.get("/sessions", async (c) => {
	const status = c.req.query("status") as SessionStatus | undefined;
	const agentType = c.req.query("agent_type") as AgentType | undefined;
	const projectId = c.req.query("projectId") as string | undefined;
	const limit = Number(c.req.query("limit") || 50);
	const offset = Number(c.req.query("offset") || 0);

	// F128: opt-in narrow projection (the relay's per-tick Codex paging). An
	// unknown or empty field list is a 400, so a typo can't silently fall back
	// to the heavy full rows. Without `fields` the response is unchanged.
	const fieldsParam = c.req.query("fields");
	if (fieldsParam !== undefined) {
		const fields = fieldsParam.split(",").map((f) => f.trim());
		const invalid = fields.find((f) => !isSessionListField(f));
		if (invalid !== undefined) return c.json({ error: "invalid_field", value: invalid }, 400);
		const rows = await getSessionSummaries(
			{ status, agentType, projectId, limit, offset },
			fields as SessionListField[],
		);
		return c.json({ sessions: rows });
	}

	const result = await getSessions({ status, agentType, projectId, limit, offset });
	return c.json(result);
});

// GET /api/v1/sessions/stats - Dashboard stats
sessionsRouter.get("/sessions/stats", async (c) => {
	const stats = await getStats();
	return c.json(stats);
});

// GET /api/v1/sessions/:sessionId - Session detail
sessionsRouter.get("/sessions/:sessionId", async (c: Context) => {
	const sessionId = c.req.param("sessionId");
	const session = await getSession(sessionId);

	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	// Get timeline events for the detail page; the UI handles mode filtering.
	const sessionEvents = await getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.createdAt))
		.limit(500);

	// C1: controlActions metadata carries the injected prompt and launch.env
	// (control-actions.ts:187-194). An observe-scoped caller may read session
	// detail (it's in OBSERVE_READ_PATHS) but must not see this embed.
	const authUser = c.get("authUser") as AuthUser | undefined;
	const controlActions = callerHasManageScope(authUser)
		? await listControlActionsForSession(sessionId)
		: undefined;

	return c.json({ session, events: sessionEvents, controlActions });
});

// GET /api/v1/sessions/:sessionId/timeline - Paginated event timeline
sessionsRouter.get("/sessions/:sessionId/timeline", async (c) => {
	const sessionId = c.req.param("sessionId");
	const limit = Number(c.req.query("limit") || 50);
	const offset = Number(c.req.query("offset") || 0);

	const sessionEvents = await getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.createdAt))
		.limit(limit)
		.offset(offset);

	return c.json({ events: sessionEvents });
});

// PUT /api/v1/sessions/:sessionId/notes - Save notes for a session
sessionsRouter.put("/sessions/:sessionId/notes", async (c) => {
	const sessionId = c.req.param("sessionId");
	const { notes } = await c.req.json<{ notes: string }>();

	await getDb()
		.update(sessions)
		.set({ notes: notes ?? "" })
		.where(eq(sessions.sessionId, sessionId));

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
	const { name, source } = await c.req.json<{ name?: string; source?: string }>();

	if (source !== undefined && !ALLOWED_RENAME_SOURCES.has(source)) {
		return c.json({ error: "invalid_source", value: source }, 400);
	}

	if (source === "reset") {
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
		const result = await applyNativeName(sessionId, name);
		if (result.applied) {
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
		}
		return c.json({ ok: true });
	}

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
	hookRateLimit({ bucketPrefix: "native-name:", onLimit: "429" }),
	async (c) => {
		const sessionId = c.req.param("sessionId");
		const { name } = await c.req.json<{ name: string }>();

		if (!name?.trim()) return c.json({ error: "Name required" }, 400);

		const result = await applyNativeName(sessionId, name);
		if (result.reason === "empty_after_sanitize") {
			return c.json({ error: "Name required" }, 400);
		}
		if (!result.found) return c.json({ error: "Session not found" }, 404);

		if (result.applied) {
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

sessionsRouter.post("/sessions/:sessionId/stop", async (c) => {
	try {
		const action = await queueStopAction(c.req.param("sessionId"));
		return c.json({ action }, 202);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Unable to queue stop" }, 400);
	}
});

sessionsRouter.post("/sessions/:sessionId/prompt", async (c) => {
	try {
		const body = await c.req.json<{ prompt?: string }>();
		const action = await queuePromptAction(c.req.param("sessionId"), body.prompt || "");
		return c.json({ action }, 202);
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unable to queue prompt" },
			400,
		);
	}
});

sessionsRouter.post("/sessions/:sessionId/retry", async (c) => {
	try {
		const result = await retryLaunchForSession(c.req.param("sessionId"));
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
	const { pinned } = await c.req.json<{ pinned: boolean }>();

	await getDb().update(sessions).set({ isPinned: pinned }).where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true });
});

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

	const combined = [...before.reverse(), ...after];

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
	const body = await c.req.json<{ archived?: boolean }>().catch(() => ({ archived: true }));
	// Default to archiving (true) when the caller omits the field.
	const archived = (body as { archived?: boolean }).archived !== false;

	await getDb()
		.update(sessions)
		.set({ isArchived: archived })
		.where(eq(sessions.sessionId, sessionId));

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

	await withTransaction(async (tx) => {
		// Cascade does this; explicit for older DBs that haven't yet rebuilt FKs.
		await tx.delete(events).where(eq(events.sessionId, sessionId));
		await tx.delete(sessions).where(eq(sessions.sessionId, sessionId));
	});

	return c.json({ ok: true });
});

export { sessionsRouter };
