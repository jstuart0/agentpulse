/**
 * Migration 0022 (AGEN-123): fork_tool_calls on both dialects. The journal entry is the next one and newer
 * than every earlier one (Drizzle skips a migration whose `when` is not newer), the SQL makes the table with
 * its cascade, and the legacy SQLite init's statements build the same columns and indexes.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import "./__test_db.js";
import { describePostgresOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("./client.js");
const { executeRows } = await import("./sql-helpers.js");
const { FORK_TOOL_CALLS_DDL_SQLITE } = await import("./fork-tool-calls-ddl.js");

const ROOT = resolve(import.meta.dir, "../../../drizzle");
const TMP = mkdtempSync(join(tmpdir(), "ap-fork-tool-calls-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const TAG = "0022_fork_tool_calls";
type Journal = { entries: Array<{ idx: number; when: number; tag: string }> };

describe("the journal and the files, on both dialects", () => {
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: 0022 follows 0021, is newer than every earlier entry, and has its file and snapshot`, () => {
			const journal = JSON.parse(
				readFileSync(join(ROOT, dialect, "meta/_journal.json"), "utf8"),
			) as Journal;
			const entry = journal.entries.find((e) => e.tag === TAG);
			expect(entry?.idx).toBe(22);
			const earlier = journal.entries.filter((e) => e.idx < 22);
			expect(earlier.length).toBe(22);
			expect(Math.max(...earlier.map((e) => e.when))).toBeLessThan(entry?.when ?? 0);
			expect(existsSync(join(ROOT, dialect, `${TAG}.sql`))).toBe(true);
			expect(existsSync(join(ROOT, dialect, "meta/0022_snapshot.json"))).toBe(true);
			// Exactly one migration with this number.
			expect(journal.entries.filter((e) => e.tag.startsWith("0022_"))).toHaveLength(1);
		});

		test(`${dialect}: the SQL creates the table with its cascade, its unique key and its two indexes`, () => {
			const sqlText = readFileSync(join(ROOT, dialect, `${TAG}.sql`), "utf8");
			expect(sqlText).toMatch(/CREATE TABLE [`"]fork_tool_calls[`"]/);
			expect(sqlText).toMatch(/REFERENCES [`"](?:public[`"]\.[`"])?sessions[`"]/);
			expect(sqlText).toMatch(/ON DELETE cascade/);
			expect(sqlText).toMatch(/CREATE UNIQUE INDEX [`"]uq_fork_tool_calls_session_tool_use[`"]/);
			expect(sqlText).toMatch(/idx_fork_tool_calls_created_at/);
			expect(sqlText).toMatch(/idx_fork_tool_calls_session_created/);
			// Ciphertext columns exist; no plaintext column does.
			expect(sqlText).toMatch(/input_cipher/);
			expect(sqlText).toMatch(/output_cipher/);
			expect(sqlText).not.toMatch(/[`"](input|output)[`"] text/);
		});
	}
});

describe("SQLite: the Drizzle migration and the legacy init build the same table", () => {
	function shape(db: Database) {
		const columns = db
			.prepare(
				"SELECT name, type, \"notnull\" AS nn, dflt_value AS dflt FROM pragma_table_info('fork_tool_calls') ORDER BY cid",
			)
			.all() as Array<Record<string, unknown>>;
		const indexes = db
			.prepare(
				"SELECT name, \"unique\" AS u FROM pragma_index_list('fork_tool_calls') WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all();
		const fks = db
			.prepare(
				'SELECT "table" AS t, "from" AS f, on_delete AS d FROM pragma_foreign_key_list(\'fork_tool_calls\')',
			)
			.all();
		return { columns, indexes, fks };
	}

	test("columns (order, type, nullability), indexes and the cascade are identical", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const born = new Database(join(TMP, "born.db"));
		born.exec("PRAGMA foreign_keys = ON;");
		migrate(drizzle(born), { migrationsFolder: join(ROOT, "sqlite") });

		const legacy = new Database(join(TMP, "legacy.db"));
		legacy.exec("PRAGMA foreign_keys = ON; CREATE TABLE sessions (session_id TEXT PRIMARY KEY);");
		for (const statement of FORK_TOOL_CALLS_DDL_SQLITE) legacy.exec(statement);
		// Safe to run again: the init runs on every boot.
		for (const statement of FORK_TOOL_CALLS_DDL_SQLITE) legacy.exec(statement);

		const a = shape(born);
		const b = shape(legacy);
		const norm = (rows: Array<Record<string, unknown>>) =>
			rows.map((r) => ({
				...r,
				dflt: r.dflt === "false" ? "0" : r.dflt === "true" ? "1" : r.dflt,
			}));
		expect(norm(b.columns)).toEqual(norm(a.columns));
		expect(b.indexes).toEqual(a.indexes);
		expect(b.fks).toEqual(a.fks);
		expect(a.fks).toEqual([{ t: "sessions", f: "session_id", d: "CASCADE" }]);

		// The cascade works on the migrated database.
		born.exec(
			"INSERT INTO sessions (id, session_id, agent_type) VALUES ('sid', 's', 'claude_code')",
		);
		born.exec(
			"INSERT INTO fork_tool_calls (id, session_id, tool_use_id, tool, outcome, created_at) VALUES ('i', 's', 't', 'Bash', 'unasked', 'x')",
		);
		born.exec("DELETE FROM sessions WHERE session_id = 's'");
		expect(born.prepare("SELECT count(*) AS n FROM fork_tool_calls").get()).toEqual({ n: 0 });
		born.close();
		legacy.close();
	});
});

describe("the process database has the table, on whichever dialect it runs", () => {
	test("it exists and can be read", async () => {
		await initializeDatabase();
		const db = getDb();
		const rows = await executeRows<{ n: number }>(
			db,
			sql`select count(*) as n from fork_tool_calls`,
		);
		expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(0);
	});
});

describePostgresOnly("Postgres: the table matches the migration", () => {
	test("the unique key, both indexes and the cascade are present", async () => {
		await initializeDatabase();
		const idx = await executeRows<{ indexname: string }>(
			getDb(),
			sql`select indexname from pg_indexes where tablename = 'fork_tool_calls'`,
		);
		const names = idx.map((r) => r.indexname);
		expect(names).toContain("uq_fork_tool_calls_session_tool_use");
		expect(names).toContain("idx_fork_tool_calls_created_at");
		expect(names).toContain("idx_fork_tool_calls_session_created");
		const fk = await executeRows<{ confdeltype: string }>(
			getDb(),
			sql`select confdeltype from pg_constraint where conrelid = 'fork_tool_calls'::regclass and contype = 'f'`,
		);
		expect(fk.map((r) => r.confdeltype)).toEqual(["c"]);
	});
});
