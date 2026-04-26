import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
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

// GET /api/v1/sessions/search - Search sessions by prompt text or project
sessionsRouter.get("/sessions/search", async (c) => {
	const q = c.req.query("q") || "";
	if (!q.trim()) return c.json({ sessions: [], total: 0 });

	const searchTerm = `%${q.trim()}%`;

	// Search in session cwd/displayName and in prompt events
	const matchingSessions = await db
		.select()
		.from(sessions)
		.where(
			sql`${sessions.cwd} LIKE ${searchTerm} OR ${sessions.displayName} LIKE ${searchTerm} OR ${sessions.currentTask} LIKE ${searchTerm} OR ${sessions.notes} LIKE ${searchTerm}`,
		)
		.orderBy(desc(sessions.lastActivityAt))
		.limit(50);

	// Also search in prompts
	const matchingEvents = await db
		.select({ sessionId: events.sessionId })
		.from(events)
		.where(
			sql`${events.eventType} = 'UserPromptSubmit' AND ${events.rawPayload} LIKE ${searchTerm}`,
		)
		.groupBy(events.sessionId)
		.limit(50);

	// Merge results
	const _sessionIds = new Set([
		...matchingSessions.map((s) => s.sessionId),
		...matchingEvents.map((e) => e.sessionId),
	]);

	// Fetch full session objects for event matches
	const additionalIds = matchingEvents
		.map((e) => e.sessionId)
		.filter((id) => !matchingSessions.some((s) => s.sessionId === id));

	const allResults = [...matchingSessions];
	if (additionalIds.length > 0) {
		for (const id of additionalIds) {
			const [s] = await db.select().from(sessions).where(eq(sessions.sessionId, id)).limit(1);
			if (s) allResults.push(s);
		}
	}

	return c.json({ sessions: allResults, total: allResults.length });
});

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

// PUT /api/v1/sessions/:sessionId/archive - Archive a session
sessionsRouter.put("/sessions/:sessionId/archive", async (c) => {
	const sessionId = c.req.param("sessionId");

	await db
		.update(sessions)
		.set({ status: "archived", endedAt: new Date().toISOString() })
		.where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true });
});

// DELETE /api/v1/sessions/:sessionId - Delete a session and its events
sessionsRouter.delete("/sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");

	// Delete events first (foreign key)
	await db.delete(events).where(eq(events.sessionId, sessionId));
	await db.delete(sessions).where(eq(sessions.sessionId, sessionId));

	return c.json({ ok: true });
});

export { sessionsRouter };
