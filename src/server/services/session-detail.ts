/**
 * The session detail read: the session, the key that reported it and the
 * instance mode, in one statement (plus the managed-session lookup the DTO
 * needs). The reporting key's name and owner and the stored mode are what the
 * handler needs to decide who may be told which key reported the session;
 * carrying them on the session read keeps that decision from costing a round
 * trip per request.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { apiKeys, sessions } from "../db/schema/index.js";
import { type InstanceMode, modeFromStoredColumn, storedModeColumn } from "./instance-mode.js";
import { getManagedSession } from "./managed-session-state.js";
import { mapSessionDto } from "./session-dto.js";

export interface ReportingKeyRow {
	id: string;
	name: string;
	ownerUserId: string | null;
}

export interface SessionDetailRead {
	session: ReturnType<typeof mapSessionDto>;
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
		})
		.from(sessions)
		.leftJoin(apiKeys, eq(apiKeys.id, sessions.ingestKeyId))
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return null;
	const managedSession = await getManagedSession(sessionId);
	return {
		session: mapSessionDto(row.session, { managedSession }),
		keyRecorded: row.session.ingestKeyId !== null,
		reportingKey:
			row.keyId === null
				? null
				: { id: row.keyId, name: row.keyName as string, ownerUserId: row.keyOwnerUserId },
		mode: modeFromStoredColumn(row.storedMode),
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
