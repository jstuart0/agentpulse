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
 * The lookup is a correlated subquery on the managed table's primary key rather
 * than a join: it can be dropped into any statement that reads the sessions
 * table (the list, the counts, the raw candidate scan) without changing the
 * row shape those statements return, and it is only evaluated by statements
 * that name a machine, or that ask for it as a column.
 */
import { type SQL, sql } from "drizzle-orm";
import type { HostScope } from "../../shared/machine-scope.js";
import { managedSessions, sessions } from "../db/schema/index.js";

const SUPERVISOR_HOST = sql`(SELECT NULLIF(TRIM(ms.host_name), '') FROM ${managedSessions} AS ms WHERE ms.session_id = ${sessions.sessionId})`;

/** The effective machine, or NULL when the session has none. */
export const EFFECTIVE_MACHINE = sql<
	string | null
>`COALESCE(${SUPERVISOR_HOST}, NULLIF(TRIM(${sessions.reportedHost}), ''))`;

/** A machine scope as a predicate: an exact name, or no machine at all. */
export function hostScopeCondition(host: HostScope | undefined): SQL | undefined {
	if (!host) return undefined;
	return host.kind === "host"
		? sql`${EFFECTIVE_MACHINE} = ${host.host}`
		: sql`${EFFECTIVE_MACHINE} IS NULL`;
}
