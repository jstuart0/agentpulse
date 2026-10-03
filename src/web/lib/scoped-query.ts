import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import { type DashboardScope, type ScopeQuery, scopeQuery } from "./owner-scope.js";

/**
 * The only value the session and stats calls accept. It can be made in exactly
 * one place, from the dashboard's live scope, so a request that forgets whose
 * sessions it is asking about (or builds the answer by hand) does not compile.
 * A plain object is not assignable: the brand's key is private to this module.
 *
 * Two questions are deliberately not about the dashboard's scope and have
 * named functions on the client instead of a way around this type:
 * `getEveryoneStats` (the "N more active across the team" line) and
 * `getCodexProbeSessions` (the Setup page's "has Codex reported yet" check).
 */
declare const scopedBrand: unique symbol;

/** What a list request may add to the scope: the same filters the endpoint takes, minus the scope itself. */
export interface SessionFilters {
	status?: string;
	agent_type?: string;
	projectId?: string;
	operational?: ActiveOperationalStatus;
	/** The dashboard's Active, Completed or Archived tab, listed by the server. */
	tab?: "active" | "completed" | "archived";
	q?: string;
	limit?: number;
	offset?: number;
}

export type ScopedQuery = SessionFilters &
	ScopeQuery & {
		readonly [scopedBrand]: true;
	};

/**
 * Every value scopedQuery() has made. The brand is only a compile-time check (a
 * spread copy keeps it and can still have its owner swapped), so the client
 * also asks this registry: a query that was not made here is not sent.
 */
const made = new WeakSet<object>();

/** The scope's request parameters plus any filters; the one constructor of {@link ScopedQuery}. */
export function scopedQuery(scope: DashboardScope, filters: SessionFilters = {}): ScopedQuery {
	const query = { ...filters, ...scopeQuery(scope) } as ScopedQuery;
	made.add(query);
	return query;
}

/** A session or stats call was handed a query that scopedQuery() did not make. */
export class UnscopedQueryError extends Error {
	constructor() {
		super("The request was not built from the dashboard's scope, so it was not sent.");
		this.name = "UnscopedQueryError";
	}
}

/** Throws {@link UnscopedQueryError} unless `query` is a value scopedQuery() returned. */
export function assertScopedQuery(query: unknown): asserts query is ScopedQuery {
	if (typeof query !== "object" || query === null || !made.has(query)) {
		throw new UnscopedQueryError();
	}
}
