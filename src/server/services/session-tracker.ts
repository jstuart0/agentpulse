import { and, count, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { SESSION_END_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from "../../shared/constants.js";
import type { AgentType, ManagedState, SessionStatus } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { getManagedSession } from "./managed-session-state.js";

/**
 * Rename a session atomically across `sessions` and (when present)
 * `managed_sessions`. Both writes happen in a single transaction so a
 * failure on the second statement rolls back the first.
 *
 * The caller is expected to have already validated `name` (non-empty,
 * trimmed). This function performs the trim once more defensively.
 *
 * `options.source` (F5 / Decision 6, contract revised per codex r2 Medium #1)
 * records who initiated the rename via `sessions.metadata.renameSource` —
 * the flag `applyNativeName` below checks to decide whether a native-name
 * pull is allowed to overwrite the display name. Only an **explicit**
 * `source: "user"` stamps the flag. Every other case — an omitted
 * `source`, or an explicit non-"user" value like `"sync"` — is
 * LEGACY-NEUTRAL: the rename happens, but `renameSource` is left
 * untouched. This is deliberate: an old (pre-campaign) relay sends
 * `{ name }` with no `source` field at all, and if omission defaulted to
 * `"user"` that mixed-version relay would misclassify every Codex
 * name-sync pull as a manual rename, permanently blocking future
 * native-name pulls for that session. Callers that need the manual-rename
 * guarantee (dashboard rename UI, the Ask "rename X to Y" command) must
 * pass `{ source: "user" }` explicitly. Metadata is read-modify-written so
 * unrelated keys (e.g. `permissionWait`, `nativeName`) survive.
 */
export async function renameSession(
	sessionId: string,
	name: string,
	options: { source?: string } = {},
): Promise<void> {
	const trimmed = name.trim();
	await withTransaction(async (tx) => {
		const [row] = await tx
			.select({ metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);

		const metadata = { ...(row?.metadata ?? {}) } as Record<string, unknown>;
		if (options.source === "user") {
			metadata.renameSource = "user";
		}

		await tx
			.update(sessions)
			.set({ displayName: trimmed, metadata })
			.where(eq(sessions.sessionId, sessionId));

		const managed = await tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1);

		if (managed.length > 0) {
			await tx
				.update(managedSessions)
				.set({
					desiredThreadTitle: trimmed,
					providerSyncState: "pending",
					providerSyncError: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(managedSessions.sessionId, sessionId));
		}
	});
}

/**
 * Pull-only sync (F5, Decision 5/6) of Claude Code's native `session_name`
 * into `displayName`. Net-new precedence logic (not mirrored from the
 * Codex relay's push/pull sync, which has no manual-rename guard on its
 * pull direction — see Decision 6): a native name overwrites the
 * AgentPulse auto-generated name, but a manual dashboard rename
 * (`metadata.renameSource === "user"`) always wins.
 *
 * `metadata.nativeName` records the most recently *seen* native name from
 * Claude, updated on every call regardless of outcome — this is what makes
 * repeat calls with the same name idempotent (a second call recognizes the
 * name was already seen and no-ops). `metadata.lastAppliedNativeName`
 * records the value actually *applied* to `displayName`; it is left
 * untouched when the write is refused, since nothing was applied.
 *
 * Returns `{ found: false }` for an unknown session so the route can 404 —
 * deliberately different from `renameSession`'s silent no-op-on-missing-row
 * behavior, because the statusline caller needs to distinguish "session not
 * yet ingested — retry next render" from a successful call.
 */
export async function applyNativeName(
	sessionId: string,
	nativeName: string,
): Promise<{ found: boolean; applied: boolean }> {
	const trimmed = nativeName.trim();
	return withTransaction(async (tx) => {
		const [row] = await tx
			.select({ displayName: sessions.displayName, metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!row) return { found: false, applied: false };

		const metadata = { ...(row.metadata ?? {}) } as Record<string, unknown>;
		const alreadySeen = metadata.nativeName === trimmed;

		if (metadata.renameSource === "user") {
			// Manual rename wins. Record that we saw this native name (for
			// idempotency and so later state-diff logic isn't confused about
			// whether it was observed), but refuse to apply it.
			if (alreadySeen) return { found: true, applied: false };
			metadata.nativeName = trimmed;
			await tx.update(sessions).set({ metadata }).where(eq(sessions.sessionId, sessionId));
			return { found: true, applied: false };
		}

		if (alreadySeen && row.displayName === trimmed) {
			// No-op: already applied on a prior call, nothing changed.
			return { found: true, applied: true };
		}

		metadata.nativeName = trimmed;
		metadata.lastAppliedNativeName = trimmed;
		await tx
			.update(sessions)
			.set({ displayName: trimmed, metadata })
			.where(eq(sessions.sessionId, sessionId));
		return { found: true, applied: true };
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

	let query = getDb().select().from(sessions).orderBy(desc(sessions.lastActivityAt));

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
	const countQuery = getDb().select({ count: count() }).from(sessions);
	const [{ count: total }] =
		conditions.length > 0 ? await countQuery.where(and(...conditions)) : await countQuery;

	// One batched membership query for the returned page — NOT a join (a
	// join would nest the row shape to {sessions:{...}, managed_sessions:
	// {...}} and break every flat-row consumer: useSessions.ts, relay.ts's
	// name-sync + CLAUDE.md-sync, and the MCP compactSessionRow mapper), and
	// NOT one getManagedSession() call per row (N+1 over up to 100 rows
	// polled every 30s). A single indexed IN-query regardless of page size,
	// merged onto the existing flat rows as a boolean.
	const pageSessionIds = rows.map((row) => row.sessionId);
	const managedRows =
		pageSessionIds.length > 0
			? await getDb()
					.select({ sessionId: managedSessions.sessionId })
					.from(managedSessions)
					.where(inArray(managedSessions.sessionId, pageSessionIds))
			: [];
	const managedIds = new Set(managedRows.map((row) => row.sessionId));
	const rowsWithManaged = rows.map((row) => ({ ...row, managed: managedIds.has(row.sessionId) }));

	return { sessions: rowsWithManaged, total };
}

// Get a single session by session_id
export async function getSession(sessionId: string) {
	const [session] = await getDb()
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

	const activeSessions = await getDb()
		.select({ count: count() })
		.from(sessions)
		.where(eq(sessions.status, "active"));

	const todaySessions = await getDb()
		.select({ count: count() })
		.from(sessions)
		.where(sql`${sessions.startedAt} >= ${todayStart}`);

	const todayToolUses = await getDb()
		.select({ total: sql<number>`COALESCE(SUM(${sessions.totalToolUses}), 0)` })
		.from(sessions)
		.where(sql`${sessions.startedAt} >= ${todayStart}`);

	const byType = await getDb()
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

	const liveManagedRows = await getDb()
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
	await getDb()
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
	await getDb()
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
	const result = await getDb()
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
