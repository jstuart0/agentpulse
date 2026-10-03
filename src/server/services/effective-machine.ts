/**
 * The machine a session is on, as one SQL expression, for the dashboard's
 * filter, its per-machine counts and the `machine` field on list rows.
 *
 * A supervisor-launched session is on its supervisor's host (the managed row's
 * host name); any other session is on the machine its relay or the Codex
 * observer reported; a blank name counts as none. This is what the dashboard
 * shows, so a card, a header and a filter always agree about a session.
 *
 * Display and filtering only. The reported name is self-declared by whatever
 * sent the events, so nothing that decides who may see or change a session, or
 * where a command is routed, may read it (a test fails when another file does).
 *
 * The same definition is written three ways, each the cheapest for what it does,
 * and a test keeps them equal on awkward data (padding, blanks, case):
 *  - EFFECTIVE_MACHINE, a correlated lookup on the managed table's primary key,
 *    for the rows of one page of the list (a hundred lookups at most);
 *  - hostScopeCondition, for the filter, as two uncorrelated membership tests the
 *    database evaluates once instead of once per session (on Postgres, about a
 *    tenth of the cost of the correlated form over a large table);
 *  - MACHINE_JOINED with joinSupervisorHost, for the per-machine grouping, which
 *    needs the value of every row anyway.
 * None of them changes the row shape the statements around them return.
 */
import { type SQL, eq, isNotNull, sql } from "drizzle-orm";
import type { HostScope } from "../../shared/machine-scope.js";
import type { Session } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema/index.js";
import { cleanMachineName } from "./machine-name.js";

const SUPERVISOR_HOST = sql`(SELECT NULLIF(TRIM(ms.host_name), '') FROM ${managedSessions} AS ms WHERE ms.session_id = ${sessions.sessionId})`;

/** The effective machine of the row, or NULL when it has none. Correlated: use it for a page of rows, never to scan the table. */
export const EFFECTIVE_MACHINE = sql<
	string | null
>`COALESCE(${SUPERVISOR_HOST}, NULLIF(TRIM(${sessions.reportedHost}), ''))`;

/** Sessions whose supervisor recorded a (non-blank) host name: their reported name does not count. */
const SUPERVISED_SESSION_IDS = sql`SELECT ms.session_id FROM ${managedSessions} AS ms WHERE NULLIF(TRIM(ms.host_name), '') IS NOT NULL`;

const REPORTED_HOST = sql`NULLIF(TRIM(${sessions.reportedHost}), '')`;

/** A machine scope as a predicate: an exact name, or no machine at all. */
export function hostScopeCondition(host: HostScope | undefined): SQL | undefined {
	if (!host) return undefined;
	if (host.kind === "unknown") {
		return sql`(${REPORTED_HOST} IS NULL AND ${sessions.sessionId} NOT IN (${SUPERVISED_SESSION_IDS}))`;
	}
	const supervisedHere = sql`SELECT ms.session_id FROM ${managedSessions} AS ms WHERE NULLIF(TRIM(ms.host_name), '') = ${host.host}`;
	return sql`(${sessions.sessionId} IN (${supervisedHere}) OR (${REPORTED_HOST} = ${host.host} AND ${sessions.sessionId} NOT IN (${SUPERVISED_SESSION_IDS})))`;
}

/** The managed table joined on, for statements that read the machine of every row they scan. */
export const SUPERVISOR_JOIN = sql`LEFT JOIN ${managedSessions} ON ${managedSessions.sessionId} = ${sessions.sessionId}`;

/** The effective machine of a row of a statement that has joined {@link SUPERVISOR_JOIN}. */
export const MACHINE_JOINED = sql<
	string | null
>`COALESCE(NULLIF(TRIM(${managedSessions.hostName}), ''), ${REPORTED_HOST})`;

/**
 * A session about to be pushed over the socket, with its effective machine read
 * the way the list reads it: a pushed row never joins the managed table, so
 * without this a supervisor-launched session's host would be invisible to the
 * dashboard's live filter. A session that is no longer stored is returned as it
 * came, unstamped (the receiver treats "no machine field" as "can't tell").
 */
export async function stampMachine(session: Session): Promise<Session> {
	const [row] = await getDb()
		.select({ machine: EFFECTIVE_MACHINE })
		.from(sessions)
		.where(eq(sessions.sessionId, session.sessionId))
		.limit(1);
	return row ? { ...session, machine: row.machine } : session;
}

/**
 * Cleans the host names stored before names were cleaned on the way in: every
 * distinct supervisor host name and managed-session host name that isn't already
 * what cleaning would give is rewritten (to nothing, for a managed session's
 * name with nothing left, which makes the reported name stand). Idempotent, and
 * run at every boot so a name written by an older server is covered too.
 */
export async function normalizeStoredMachineNames(): Promise<void> {
	const db = getDb();
	const managed = await db
		.selectDistinct({ name: managedSessions.hostName })
		.from(managedSessions)
		.where(isNotNull(managedSessions.hostName));
	for (const { name } of managed) {
		if (name === null) continue;
		const cleaned = cleanMachineName(name);
		if (cleaned === name) continue;
		await db
			.update(managedSessions)
			.set({ hostName: cleaned })
			.where(eq(managedSessions.hostName, name));
	}
	const hosts = await db.selectDistinct({ name: supervisors.hostName }).from(supervisors);
	for (const { name } of hosts) {
		const cleaned = cleanMachineName(name);
		if (cleaned === null || cleaned === name) continue;
		await db.update(supervisors).set({ hostName: cleaned }).where(eq(supervisors.hostName, name));
	}
}
