import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType, SessionStatus } from "../../shared/types.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { events, managedSessions, sessions } from "../db/schema.js";
import {
	listControlActionsForSession,
	queuePromptAction,
	queueStopAction,
	retryLaunchForSession,
} from "../services/control-actions.js";
import { getSession, getSessions, getStats } from "../services/session-tracker.js";

const sessionsRouter = new Hono();
sessionsRouter.use("*", requireAuth());

// GET /api/v1/sessions - List sessions
sessionsRouter.get("/sessions", async (c) => {
	const status = c.req.query("status") as SessionStatus | undefined;
	const agentType = c.req.query("agent_type") as AgentType | undefined;
	const projectId = c.req.query("projectId") as string | undefined;
	const limit = Number(c.req.query("limit") || 50);
	const offset = Number(c.req.query("offset") || 0);

	const result = await getSessions({ status, agentType, projectId, limit, offset });
	return c.json(result);
});

// GET /api/v1/sessions/stats - Dashboard stats
sessionsRouter.get("/sessions/stats", async (c) => {
	const stats = await getStats();
	return c.json(stats);
});

// GET /api/v1/sessions/:sessionId - Session detail
sessionsRouter.get("/sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");
	const session = await getSession(sessionId);

	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	// Get timeline events for the detail page; the UI handles mode filtering.
	const sessionEvents = await db
		.select()
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.createdAt))
		.limit(500);

	const controlActions = await listControlActionsForSession(sessionId);

	return c.json({ session, events: sessionEvents, controlActions });
});

// GET /api/v1/sessions/:sessionId/timeline - Paginated event timeline
sessionsRouter.get("/sessions/:sessionId/timeline", async (c) => {
	const sessionId = c.req.param("sessionId");
	const limit = Number(c.req.query("limit") || 50);
	const offset = Number(c.req.query("offset") || 0);

	const sessionEvents = await db
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

	await db
		.update(sessions)
		.set({ notes: notes ?? "" })
		.where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true });
});

// PUT /api/v1/sessions/:sessionId/rename - Rename a session
sessionsRouter.put("/sessions/:sessionId/rename", async (c) => {
	const sessionId = c.req.param("sessionId");
	const { name } = await c.req.json<{ name: string }>();

	if (!name?.trim()) return c.json({ error: "Name required" }, 400);

	await db
		.update(sessions)
		.set({ displayName: name.trim() })
		.where(eq(sessions.sessionId, sessionId));

	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);

	if (managed) {
		await db
			.update(managedSessions)
			.set({
				desiredThreadTitle: name.trim(),
				providerSyncState: "pending",
				providerSyncError: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(managedSessions.sessionId, sessionId));
	}

	return c.json({ ok: true });
});

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

	await db.update(sessions).set({ isPinned: pinned }).where(eq(sessions.sessionId, sessionId));

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
	const [target] = await db
		.select()
		.from(events)
		.where(and(eq(events.id, eventId), eq(events.sessionId, sessionId)))
		.limit(1);

	if (!target) {
		return c.json({ error: "Event not found" }, 404);
	}

	// Events at or before the target (includes target itself), newest first.
	const before = await db
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), lte(events.id, eventId)))
		.orderBy(desc(events.id))
		.limit(around + 1);

	// Events strictly after the target, oldest first.
	const after = await db
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), gt(events.id, eventId)))
		.orderBy(asc(events.id))
		.limit(around);

	const combined = [...before.reverse(), ...after];

	return c.json({ events: combined, target: { id: eventId } });
});

// Compute a simple hash for sync detection
async function computeChecksum(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

// GET /api/v1/sessions/:sessionId/claude-md - Get CLAUDE.md content from DB
sessionsRouter.get("/sessions/:sessionId/claude-md", async (c) => {
	const sessionId = c.req.param("sessionId");
	const [session] = await db
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

	await db.update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true, checksum });
});

// PUT /api/v1/sessions/:sessionId/archive - Toggle archive flag (is_archived boolean)
sessionsRouter.put("/sessions/:sessionId/archive", async (c) => {
	const sessionId = c.req.param("sessionId");
	const body = await c.req.json<{ archived?: boolean }>().catch(() => ({ archived: true }));
	// Default to archiving (true) when the caller omits the field.
	const archived = (body as { archived?: boolean }).archived !== false;

	await db.update(sessions).set({ isArchived: archived }).where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true });
});

// DELETE /api/v1/sessions/:sessionId - Delete a session and its events
//
// Slice DB-1: child tables (events, managed_sessions, control_actions,
// watcher_proposals, ai_hitl_requests, ai_watcher_runs, watcher_configs)
// now reference sessions(session_id) ON DELETE CASCADE, so the single
// `delete(sessions)` is sufficient — SQLite drops the children atomically
// in the same transaction.
//
// We wrap the deletes in `db.transaction(...)` so any failure (FK
// violation, etc.) leaves the row in place rather than partially deleted.
// IMPORTANT: drizzle's bun-sqlite transaction wraps a SYNC native
// transaction; passing an async callback silently disables rollback
// because the COMMIT runs before any awaited statement settles. We use
// a sync callback with `.run()` instead. The explicit `events` delete
// is kept inside the same transaction as belt-and-braces for older DBs
// that haven't yet rebuilt FKs.
sessionsRouter.delete("/sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");

	db.transaction((tx) => {
		// Cascade does this; explicit for older DBs that haven't yet rebuilt FKs.
		tx.delete(events).where(eq(events.sessionId, sessionId)).run();
		tx.delete(sessions).where(eq(sessions.sessionId, sessionId)).run();
	});

	return c.json({ ok: true });
});

export { sessionsRouter };
