/**
 * sql-helpers.ts — per-helper, per-dialect rendered-SQL assertions.
 *
 * Strategy: build a minimal dialect-agnostic toQuery config (mirrors the
 * SQLite dialect: escapeName wraps in double-quotes, escapeParam emits "?",
 * escapeString single-quotes). This lets us call `fragment.toQuery(cfg).sql`
 * to read the rendered SQL without opening a real database connection.
 *
 * Dialect branching is exercised by temporarily overriding `config.dialect`
 * via Object.defineProperty (the same technique used by dialect.test.ts).
 * Each test restores the property in a finally block.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import type { BuildQueryConfig } from "drizzle-orm/sql/sql";
import { config } from "../config.js";
import {
	intervalSecondsSql,
	jsonExtractText,
	likeContains,
	likeStartsWith,
	nowSql,
} from "./sql-helpers.js";

// ── Minimal query config for rendering SQL fragments ─────────────────────────

const QUERY_CFG: BuildQueryConfig = {
	casing: new CasingCache(),
	escapeName: (name) => `"${name}"`,
	escapeParam: (_num, _val) => "?",
	escapeString: (str) => `'${str.replace(/'/g, "''")}'`,
};

/** Render a Drizzle SQL fragment to its string form + params array. */
function renderSql(fragment: ReturnType<typeof sql>): { sql: string; params: unknown[] } {
	return fragment.toQuery(QUERY_CFG);
}

// ── Dialect override helpers ──────────────────────────────────────────────────
//
// config.dialect is an own getter on the config object with configurable:true.
// It lazily caches the result into `_dialect` (configurable:false — we cannot
// touch that). To inject a test dialect we shadow the `dialect` property with a
// plain value via Object.defineProperty; restoreDialect() reapplies the
// original getter descriptor (captured once before any test mutates it).

// Capture the original descriptor once at module load — before any test can
// shadow the property. This is the get/set descriptor of the lazy getter.
const ORIGINAL_DIALECT_DESC = Object.getOwnPropertyDescriptor(config, "dialect");

function setDialect(dialect: "sqlite" | "postgres"): void {
	Object.defineProperty(config, "dialect", {
		value: dialect,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}

function restoreDialect(): void {
	if (!ORIGINAL_DIALECT_DESC) return;
	// Re-apply the original getter descriptor, clearing the value property.
	Object.defineProperty(config, "dialect", ORIGINAL_DIALECT_DESC);
}

// ── Column fixture ────────────────────────────────────────────────────────────

// For column-accepting helpers, pass a raw SQL fragment standing in for the
// column name — this is idiomatic for fragment unit tests where we never run
// against a real DB and don't need Drizzle's full column machinery.
const colSql = sql.raw(`"sessions"."cwd"`);
const metaSql = sql.raw(`"sessions"."metadata"`);

// ── nowSql ────────────────────────────────────────────────────────────────────

describe("nowSql()", () => {
	afterEach(restoreDialect);

	test("SQLite → (datetime('now'))", () => {
		setDialect("sqlite");
		const { sql: rendered } = renderSql(nowSql());
		expect(rendered).toBe("(datetime('now'))");
	});

	test("Postgres → CURRENT_TIMESTAMP", () => {
		setDialect("postgres");
		const { sql: rendered } = renderSql(nowSql());
		expect(rendered).toBe("CURRENT_TIMESTAMP");
	});
});

// ── intervalSecondsSql ────────────────────────────────────────────────────────

describe("intervalSecondsSql()", () => {
	afterEach(restoreDialect);

	test("SQLite(60) → bound-param expression for datetime modifier", () => {
		setDialect("sqlite");
		const { sql: rendered, params } = renderSql(intervalSecondsSql(60));
		// The fragment emits: '+' || ? || ' seconds'
		// so the caller can compose: datetime('now', <fragment>)
		expect(rendered).toContain("' seconds'");
		expect(params).toContain(60);
	});

	test("Postgres(60) → (? * INTERVAL '1 second')", () => {
		setDialect("postgres");
		const { sql: rendered, params } = renderSql(intervalSecondsSql(60));
		expect(rendered).toContain("INTERVAL '1 second'");
		expect(params).toContain(60);
	});

	test("SQLite(0) → accepted (zero is valid)", () => {
		setDialect("sqlite");
		expect(() => intervalSecondsSql(0)).not.toThrow();
	});

	test("throws on negative integer (-1)", () => {
		setDialect("sqlite");
		expect(() => intervalSecondsSql(-1)).toThrow(/non-negative integer/);
	});

	test("throws on NaN", () => {
		setDialect("sqlite");
		expect(() => intervalSecondsSql(Number.NaN)).toThrow(/non-negative integer/);
	});

	test("throws on non-integer (1.5)", () => {
		setDialect("sqlite");
		expect(() => intervalSecondsSql(1.5)).toThrow(/non-negative integer/);
	});
});

// ── jsonExtractText ───────────────────────────────────────────────────────────

describe("jsonExtractText()", () => {
	afterEach(restoreDialect);

	test("SQLite → json_extract(col, '$.field') with bound path param", () => {
		setDialect("sqlite");
		const { sql: rendered, params } = renderSql(jsonExtractText(metaSql, "$.targetSupervisorId"));
		expect(rendered).toContain("json_extract(");
		expect(params).toContain("$.targetSupervisorId");
	});

	test("Postgres → (col::json)->>'field' with bound field param", () => {
		setDialect("postgres");
		const { sql: rendered, params } = renderSql(jsonExtractText(metaSql, "$.targetSupervisorId"));
		expect(rendered).toContain("::json");
		expect(rendered).toContain("->>");
		expect(params).toContain("targetSupervisorId");
	});

	test("throws on path without $. prefix", () => {
		setDialect("sqlite");
		expect(() => jsonExtractText(metaSql, "targetSupervisorId")).toThrow(/path must match/);
	});

	test("throws on nested path ($.a.b is not supported)", () => {
		setDialect("sqlite");
		expect(() => jsonExtractText(metaSql, "$.a.b")).toThrow(/path must match/);
	});
});

// ── likeStartsWith ────────────────────────────────────────────────────────────

describe("likeStartsWith()", () => {
	afterEach(restoreDialect);

	test("SQLite → col LIKE 'prefix%' (bound param)", () => {
		setDialect("sqlite");
		const { sql: rendered, params } = renderSql(likeStartsWith(colSql, "/home/user"));
		expect(rendered).toContain("LIKE");
		expect(rendered).not.toContain("ILIKE");
		expect(params).toContain("/home/user%");
	});

	test("Postgres → col ILIKE 'prefix%' (bound param)", () => {
		setDialect("postgres");
		const { sql: rendered, params } = renderSql(likeStartsWith(colSql, "/home/user"));
		expect(rendered).toContain("ILIKE");
		expect(params).toContain("/home/user%");
	});
});

// ── likeContains ─────────────────────────────────────────────────────────────

describe("likeContains()", () => {
	afterEach(restoreDialect);

	test("SQLite → col LIKE '%fragment%' (bound param)", () => {
		setDialect("sqlite");
		const { sql: rendered, params } = renderSql(likeContains(colSql, "myproject"));
		expect(rendered).toContain("LIKE");
		expect(rendered).not.toContain("ILIKE");
		expect(params).toContain("%myproject%");
	});

	test("Postgres → col ILIKE '%fragment%' (bound param)", () => {
		setDialect("postgres");
		const { sql: rendered, params } = renderSql(likeContains(colSql, "myproject"));
		expect(rendered).toContain("ILIKE");
		expect(params).toContain("%myproject%");
	});
});
