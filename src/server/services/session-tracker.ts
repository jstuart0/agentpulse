import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { eq, and, lt, ne, sql, desc, count } from "drizzle-orm";
import { SESSION_IDLE_TIMEOUT_MS, SESSION_END_TIMEOUT_MS } from "../../shared/constants.js";
import type { AgentType, SessionStatus } from "../../shared/types.js";
import { getManagedSession } from "./managed-session-state.js";

// Get all sessions with optional filters
export async function getSessions(filters?: {
	status?: SessionStatus;
	agentType?: AgentType;
	limit?: number;
	offset?: number;
}) {
	const limit = filters?.limit ?? 50;
	const offset = filters?.offset ?? 0;

	let query = db.select().from(sessions).orderBy(desc(sessions.lastActivityAt));

	const conditions = [];
	if (filters?.status) {
		conditions.push(eq(sessions.status, filters.status));
	}
	if (filters?.agentType) {
		conditions.push(eq(sessions.agentType, filters.agentType));
	}

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	const rows = await query.limit(limit).offset(offset);

	// Get total count
	const countQuery = db.select({ count: count() }).from(sessions);
	const [{ count: total }] = conditions.length > 0
		? await countQuery.where(and(...conditions))
		: await countQuery;

	return { sessions: rows, total };
}

// Get a single session by session_id
export async function getSession(sessionId: string) {
	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return null;
	const managedSession = await getManagedSession(sessionId);
	return { ...session, managedSession };
}

// Get dashboard stats
export async function getStats() {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

	const activeSessions = await db
		.select({ count: count() })
		.from(sessions)
		.where(eq(sessions.status, "active"));

	const todaySessions = await db
		.select({ count: count() })
		.from(sessions)
		.where(sql`${sessions.startedAt} >= ${todayStart}`);

	const todayToolUses = await db
		.select({ total: sql<number>`COALESCE(SUM(${sessions.totalToolUses}), 0)` })
		.from(sessions)
		.where(sql`${sessions.startedAt} >= ${todayStart}`);

	const byType = await db
		.select({
			agentType: sessions.agentType,
			count: count(),
		})
		.from(sessions)
		.where(eq(sessions.status, "active"))
		.groupBy(sessions.agentType);

	const byAgentType: Record<string, number> = {};
	for (const row of byType) {
		byAgentType[row.agentType] = row.count;
	}

	return {
		activeSessions: activeSessions[0]?.count ?? 0,
		totalSessionsToday: todaySessions[0]?.count ?? 0,
		totalToolUsesToday: todayToolUses[0]?.total ?? 0,
		byAgentType,
	};
}

// Mark stale sessions as idle or completed
export async function updateStaleSessions(): Promise<number> {
	const now = Date.now();
	const idleCutoff = new Date(now - SESSION_IDLE_TIMEOUT_MS).toISOString();
	const endCutoff = new Date(now - SESSION_END_TIMEOUT_MS).toISOString();

	// Mark sessions as idle if no activity for 5 minutes
	await db
		.update(sessions)
		.set({ status: "idle" })
		.where(
			and(
				eq(sessions.status, "active"),
				lt(sessions.lastActivityAt, idleCutoff),
			),
		);

	// Mark sessions as completed if no activity for 30 minutes
	const result = await db
		.update(sessions)
		.set({
			status: "completed",
			endedAt: new Date().toISOString(),
		})
		.where(
			and(
				ne(sessions.status, "completed"),
				ne(sessions.status, "failed"),
				lt(sessions.lastActivityAt, endCutoff),
			),
		)
		.returning();

	return result.length;
}
