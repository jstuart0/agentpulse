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
import { type SQL, sql } from "drizzle-orm";
import type { HostScope } from "../../shared/machine-scope.js";
import { managedSessions, sessions } from "../db/schema/index.js";

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
