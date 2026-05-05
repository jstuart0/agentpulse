/**
 * Dialect-aware column helpers (Decision 21).
 *
 * Helpers for column types that differ between SQLite and Postgres. Only the
 * cases where inlining would require copy-pasting divergent logic are factored
 * here.
 *
 * NOT factored (inlined per table file instead):
 *   boolean columns — SQLite `integer({mode:"boolean"})` vs Postgres `boolean()`.
 *     The `{mode:"boolean"}` option is load-bearing for TypeScript boolean inference;
 *     a factory helper loses that info without complex generics. Each table file
 *     declares these columns directly, keeping the correct inferred type.
 *   autoIncrement PK — only `events.id` uses this; factoring for one site adds
 *     more complexity than it removes.
 *
 * Factored helpers:
 *   jsonColumn — text({mode:'json'}).$type<T>() on SQLite, json().$type<T>() on
 *     Postgres. Decision 14: json() not jsonb().
 *   tsColumn   — TEXT timestamp on both. Decision 4: parity; not timestamptz.
 *     SQLite default (datetime('now')); Postgres default CURRENT_TIMESTAMP.
 */
import { sql } from "drizzle-orm";
import { json, text as pgText } from "drizzle-orm/pg-core";
import { text as sqliteText } from "drizzle-orm/sqlite-core";

// ─── jsonColumn ─────────────────────────────────────────────────────────────
//
// The <T> type parameter appears only in the implementation body via .$type<T>().
// Overload signatures don't reference T in their return types — they return the
// untyped column builder, and .$type<T>() is called internally. Callers pass T
// via the type argument (e.g. jsonColumn<string[]>(...)); TypeScript resolves it
// through the implementation signature.

export function jsonColumn<_T>(dialect: "sqlite", name: string): ReturnType<typeof sqliteText>;
export function jsonColumn<_T>(dialect: "postgres", name: string): ReturnType<typeof json>;
// biome-ignore lint/suspicious/noExplicitAny: overload implementation; concrete dialect type provided by overloads above
export function jsonColumn<T>(dialect: "sqlite" | "postgres", name: string): any {
	if (dialect === "postgres") {
		return json(name).$type<T>();
	}
	return sqliteText(name, { mode: "json" }).$type<T>();
}

// ─── tsColumn ───────────────────────────────────────────────────────────────

export function tsColumn(dialect: "sqlite", name: string): ReturnType<typeof sqliteText>;
export function tsColumn(dialect: "postgres", name: string): ReturnType<typeof pgText>;
// biome-ignore lint/suspicious/noExplicitAny: overload implementation; concrete dialect type provided by overloads above
export function tsColumn(dialect: "sqlite" | "postgres", name: string): any {
	if (dialect === "postgres") {
		return pgText(name).notNull().default(sql`CURRENT_TIMESTAMP`);
	}
	return sqliteText(name).notNull().default(sql`(datetime('now'))`);
}
