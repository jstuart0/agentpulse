import { Hono } from "hono";
import { getSessions, getSession, getStats } from "../services/session-tracker.js";
import { db } from "../db/client.js";
import { events, sessions } from "../db/schema.js";
import { eq, desc, inArray, sql, like } from "drizzle-orm";
import type { AgentType, SessionStatus } from "../../shared/types.js";

// Only show user prompts in the timeline
const TIMELINE_EVENT_TYPES = ["UserPromptSubmit"];

const sessionsRouter = new Hono();

// GET /api/v1/sessions - List sessions
sessionsRouter.get("/sessions", async (c) => {
	const status = c.req.query("status") as SessionStatus | undefined;
	const agentType = c.req.query("agent_type") as AgentType | undefined;
	const limit = Number(c.req.query("limit") || 50);
	const offset = Number(c.req.query("offset") || 0);

	const result = await getSessions({ status, agentType, limit, offset });
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

	// Get timeline events (only prompts + system events, not tool calls)
	const sessionEvents = await db
		.select()
		.from(events)
		.where(
			eq(events.sessionId, sessionId),
		)
		.orderBy(desc(events.createdAt))
		.limit(500);

	// Filter to timeline-worthy events server-side
	const timelineEvents = sessionEvents.filter((e) =>
		TIMELINE_EVENT_TYPES.includes(e.eventType),
	);

	return c.json({ session, events: timelineEvents });
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

	return c.json({ ok: true });
});

// PUT /api/v1/sessions/:sessionId/pin - Toggle pin
sessionsRouter.put("/sessions/:sessionId/pin", async (c) => {
	const sessionId = c.req.param("sessionId");
	const { pinned } = await c.req.json<{ pinned: boolean }>();

	await db
		.update(sessions)
		.set({ isPinned: pinned })
		.where(eq(sessions.sessionId, sessionId));

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
	const sessionIds = new Set([
		...matchingSessions.map((s) => s.sessionId),
		...matchingEvents.map((e) => e.sessionId),
	]);

	// Fetch full session objects for event matches
	const additionalIds = matchingEvents
		.map((e) => e.sessionId)
		.filter((id) => !matchingSessions.some((s) => s.sessionId === id));

	let allResults = [...matchingSessions];
	if (additionalIds.length > 0) {
		for (const id of additionalIds) {
			const [s] = await db.select().from(sessions).where(eq(sessions.sessionId, id)).limit(1);
			if (s) allResults.push(s);
		}
	}

	return c.json({ sessions: allResults, total: allResults.length });
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
