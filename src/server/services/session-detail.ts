/**
 * The session detail read: the session, the key that reported it and the
 * instance mode, in one statement (plus the managed-session lookup the DTO
 * needs). The reporting key's name and owner and the stored mode are what the
 * handler needs to decide who may be told which key reported the session;
 * carrying them on the session read keeps that decision from costing a round
 * trip per request.
 */
import { type SQL, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { apiKeys, controlActions, managedSessions, sessions } from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { type InstanceMode, modeFromStoredColumn, storedModeColumn } from "./instance-mode.js";
import { getManagedSession } from "./managed-session-state.js";
import { mapSessionDto } from "./session-dto.js";
import { type SessionHostStatus, getSessionOwnerHostStates } from "./session-ownership.js";

export interface ReportingKeyRow {
	id: string;
	name: string;
	ownerUserId: string | null;
}

/** The managed states in which a fork may still have a process: the observed session shows it as "Continued as ...". */
const LIVE_FORK_STATES: ReadonlySet<string> = new Set(["pending", "managed", "degraded"]);

export interface ContinuedIn {
	sessionId: string;
	name: string | null;
	live: boolean;
}

export interface ContinuedFrom {
	sessionId: string;
	name: string | null;
	state: "available" | "archived" | "deleted";
}

export interface SessionDetailRead {
	session: ReturnType<typeof mapSessionDto> & {
		hostControl?: SessionHostStatus;
		continuedIn?: ContinuedIn;
		continuedFrom?: ContinuedFrom;
	};
	/** True when the session names an ingest key, even one that no longer exists. */
	keyRecorded: boolean;
	/** The named key's row; null when none is named or the key is gone. */
	reportingKey: ReportingKeyRow | null;
	mode: InstanceMode;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetailRead | null> {
	const [row] = await getDb()
		.select({
			session: sessions,
			keyId: apiKeys.id,
			keyName: apiKeys.name,
			keyOwnerUserId: apiKeys.ownerUserId,
			storedMode: storedModeColumn,
			newestForkId: newestForkIdOf(),
		})
		.from(sessions)
		.leftJoin(apiKeys, eq(apiKeys.id, sessions.ingestKeyId))
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return null;
	const managedSession = await getManagedSession(sessionId);
	// One more statement, and only for a managed session: whether its host can take a stop or a prompt.
	const hostControl = managedSession
		? ((await getSessionOwnerHostStates([sessionId])).get(sessionId) ?? null)
		: null;
	// One more only when the session has been continued (the first read already says so): the fork's name and state.
	const continuedIn =
		row.session.agentType === "claude_code" && !managedSession && row.newestForkId
			? await readContinuedIn(row.newestForkId)
			: null;
	const mapped = mapSessionDto(row.session, { managedSession });
	// And one primary-key read for a fork: what it was continued from, so the page can name it or say it is gone.
	const continuedFrom = mapped.forkedFromSessionId
		? await readContinuedFrom(mapped.forkedFromSessionId)
		: null;
	return {
		session: {
			...mapped,
			...(hostControl ? { hostControl } : {}),
			...(continuedIn ? { continuedIn } : {}),
			...(continuedFrom ? { continuedFrom } : {}),
		},
		keyRecorded: row.session.ingestKeyId !== null,
		reportingKey:
			row.keyId === null
				? null
				: { id: row.keyId, name: row.keyName as string, ownerUserId: row.keyOwnerUserId },
		mode: modeFromStoredColumn(row.storedMode),
	};
}

/**
 * The id of the newest fork of this session, as a scalar subquery inside the session read: the session's
 * newest succeeded fork action, by the action table's session index (`idx_control_actions_session`, migration 0021). A session nobody has continued costs no
 * extra statement; the one with a fork costs the lookup of that fork in `readContinuedIn`.
 */
function newestForkIdOf(): SQL<string | null> {
	const forkId = jsonExtractText(controlActions.metadata, "$.forkSessionId");
	// `coalesce` keeps the status test from being an index candidate: the session index is the one to seek by.
	// A fork is only ever made from a Claude Code session: for any other the CASE never reaches the lookup.
	return sql<string | null>`(case when ${sessions.agentType} = 'claude_code' then (
		select ${forkId}
		from ${controlActions}
		where ${controlActions.sessionId} = ${sessions.sessionId}
			and ${controlActions.actionType} = 'resume'
			and coalesce(${controlActions.status}, '') = 'succeeded'
			and ${forkId} is not null
		order by ${controlActions.createdAt} desc
		limit 1
	) end)`;
}

/** The fork a session was continued into: its name, and whether it may still have a process. A deleted fork has no row, so no link. */
async function readContinuedIn(forkId: string): Promise<ContinuedIn | null> {
	const [fork] = await getDb()
		.select({
			sessionId: sessions.sessionId,
			name: sessions.displayName,
			managedState: managedSessions.managedState,
		})
		.from(sessions)
		.leftJoin(managedSessions, eq(managedSessions.sessionId, sessions.sessionId))
		.where(eq(sessions.sessionId, forkId))
		.limit(1);
	if (!fork) return null;
	return {
		sessionId: fork.sessionId,
		name: fork.name,
		live: fork.managedState !== null && LIVE_FORK_STATES.has(fork.managedState),
	};
}

/** The observed session a fork was made from: its name, and whether it is still there. */
async function readContinuedFrom(sourceId: string): Promise<ContinuedFrom> {
	const [source] = await getDb()
		.select({ name: sessions.displayName, isArchived: sessions.isArchived })
		.from(sessions)
		.where(eq(sessions.sessionId, sourceId))
		.limit(1);
	if (!source) return { sessionId: sourceId, name: null, state: "deleted" };
	return {
		sessionId: sourceId,
		name: source.name,
		state: source.isArchived ? "archived" : "available",
	};
}

/**
 * The name-only read behind `GET /sessions/:id?fields=displayName` (the status
 * line's lookup, on every render): the sessions row's id and name and nothing
 * else, one statement, however long the session is. Null when there is no such
 * session.
 */
export async function getSessionName(
	sessionId: string,
): Promise<{ sessionId: string; displayName: string | null } | null> {
	const [row] = await getDb()
		.select({ sessionId: sessions.sessionId, displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ?? null;
}
