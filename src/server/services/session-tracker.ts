import { and, count, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { SESSION_END_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from "../../shared/constants.js";
import type { AgentType, ManagedState, SessionStatus } from "../../shared/types.js";
import { db } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema.js";
import { getManagedSession } from "./managed-session-state.js";

/**
 * Rename a session atomically across `sessions` and (when present)
 * `managed_sessions`. Both writes happen in a single SQLite transaction
 * so a failure on the second statement rolls back the first.
 *
 * IMPORTANT: drizzle's bun-sqlite `db.transaction()` is SYNCHRONOUS. Passing
 * an async callback silently disables rollback because COMMIT fires before
 * any awaited statement settles. We use a sync callback with `.run()` here.
 *
 * The caller is expected to have already validated `name` (non-empty,
 * trimmed). This function performs the trim once more defensively.
 */
export function renameSession(sessionId: string, name: string): void {
	const trimmed = name.trim();
	db.transaction((tx) => {
		tx.update(sessions)
			.set({ displayName: trimmed })
			.where(eq(sessions.sessionId, sessionId))
			.run();

		const managed = tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1)
			.all();

		if (managed.length > 0) {
			tx.update(managedSessions)
				.set({
					desiredThreadTitle: trimmed,
					providerSyncState: "pending",
					providerSyncError: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(managedSessions.sessionId, sessionId))
				.run();
		}
	});
}

// Managed states that indicate an agent process is still running under a live
// supervisor. Sessions in these states must not be auto-completed by staleness
// checks — the supervisor will report terminal state when the process exits.
// Order is preserved from the original slice (interactive/headless/managed
// first, pending last) — the slice TYPE-2b promotion narrows the element type
// to ManagedState so adding a new live state requires picking it from the
// canonical union.
const LIVE_MANAGED_STATES = [
	"interactive_terminal",
	"headless",
	"managed",
	"pending",
] as const satisfies readonly ManagedState[];

// Get all sessions with optional filters
export async function getSessions(filters?: {
	status?: SessionStatus;
	agentType?: AgentType;
	projectId?: string;
	limit?: number;
	offset?: number;
}) {
	const limit = filters?.limit ?? 50;
	const offset = filters?.offset ?? 0;

	let query = db.select().from(sessions).orderBy(desc(sessions.lastActivityAt));

	const conditions = [];
	if (filters?.status) {
		// TODO(slice-h): translate status=archived param to isArchived=true filter;
		// status field no longer carries 'archived' for new rows after Slice G.
		// GET /sessions?status=archived returns empty until this is wired up.
		conditions.push(eq(sessions.status, filters.status));
	}
	if (filters?.agentType) {
		conditions.push(eq(sessions.agentType, filters.agentType));
	}
	if (filters?.projectId) {
		conditions.push(eq(sessions.projectId, filters.projectId));
	}

	if (conditions.length > 0) {
		query = query.where(and(...conditions)) as typeof query;
	}

	const rows = await query.limit(limit).offset(offset);

	// Get total count
	const countQuery = db.select({ count: count() }).from(sessions);
	const [{ count: total }] =
		conditions.length > 0 ? await countQuery.where(and(...conditions)) : await countQuery;

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

// Recovery cutoff for sessions stuck with isWorking=true. If an agent
// crashed without sending Stop, the working flag can stay latched
// forever. After this many ms with no activity we clear the flag so
// the regular active → idle → completed flow can resume.
const STUCK_WORKING_RECOVERY_MS = 2 * SESSION_END_TIMEOUT_MS;

/**
 * Advance stale sessions through the lifecycle:
 *   active  → idle       when !isWorking and no activity for idle timeout
 *   idle    → completed  when no activity for end timeout
 *
 * Working sessions never transition automatically — the user rule is
 * that isWorking=true must block idle/completed until Stop arrives.
 * Sessions whose managed process is still running under a connected
 * supervisor are skipped entirely; those flip to terminal state when
 * the supervisor reports the process exited.
 *
 * Stuck-working recovery: if isWorking=true but there has been no
 * activity for 2× the end timeout, we assume the agent crashed and
 * clear the flag so the normal flow can run on the next tick.
 */
export async function updateStaleSessions(): Promise<number> {
	const now = Date.now();
	const idleCutoff = new Date(now - SESSION_IDLE_TIMEOUT_MS).toISOString();
	const endCutoff = new Date(now - SESSION_END_TIMEOUT_MS).toISOString();
	const stuckWorkingCutoff = new Date(now - STUCK_WORKING_RECOVERY_MS).toISOString();

	const liveManagedRows = await db
		.select({ sessionId: managedSessions.sessionId })
		.from(managedSessions)
		.innerJoin(supervisors, eq(managedSessions.supervisorId, supervisors.id))
		.where(
			and(
				inArray(managedSessions.managedState, LIVE_MANAGED_STATES as unknown as string[]),
				eq(supervisors.status, "connected"),
			),
		);
	const liveSessionIds = liveManagedRows.map((r) => r.sessionId);

	const excludeLive =
		liveSessionIds.length > 0 ? notInArray(sessions.sessionId, liveSessionIds) : undefined;

	// Stuck-working recovery: clear isWorking on sessions that have been
	// silent for far too long. Runs first so the idle transition below
	// can pick them up on the same tick.
	await db
		.update(sessions)
		.set({ isWorking: false })
		.where(
			and(
				eq(sessions.isWorking, true),
				lt(sessions.lastActivityAt, stuckWorkingCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		);

	// active → idle: only when the session is NOT currently working.
	await db
		.update(sessions)
		.set({ status: "idle" })
		.where(
			and(
				eq(sessions.status, "active"),
				eq(sessions.isWorking, false),
				lt(sessions.lastActivityAt, idleCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		);

	// idle → completed: requires the session to have already moved to
	// idle, which by the rule above means it was not working when it
	// went idle. This enforces the user-visible progression
	//   working → not-working → idle → completed
	// rather than letting an active session skip straight to completed.
	const result = await db
		.update(sessions)
		.set({
			status: "completed",
			endedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(sessions.status, "idle"),
				lt(sessions.lastActivityAt, endCutoff),
				...(excludeLive ? [excludeLive] : []),
			),
		)
		.returning();

	return result.length;
}
