/**
 * sessions.reported_host: one nullable text column holding the machine name a
 * relay or the Codex observer reported (display only). It has to be there
 * however a database got its schema: a fresh install, an install brought up by
 * Drizzle from the migration before it, and (SQLite only: Postgres has no such
 * path) an install that predates Drizzle and is brought up by the legacy init.
 * Sessions that were already there keep null.
 *
 * Which migration adds it is found by reading the journal (the entry whose SQL
 * names the column), so these hold when the migration is regenerated with a
 * different number or later migrations are added after it.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const { initializeDatabase } = await import("./client.js");

const COLUMN = "reported_host";
const TMP = mkdtempSync(join(tmpdir(), "ap-reported-host-column-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

type JournalEntry = {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
};

const migrationsDir = (dialect: "sqlite" | "postgres") =>
	join(import.meta.dir, "..", "..", "..", "drizzle", dialect);

function readJournal(dialect: "sqlite" | "postgres") {
	const file = join(migrationsDir(dialect), "meta", "_journal.json");
	return JSON.parse(readFileSync(file, "utf-8")) as { entries: JournalEntry[] } & Record<
		string,
		unknown
	>;
}

/** The migration that adds the column: the journal entry whose SQL names it. */
function columnMigration(dialect: "sqlite" | "postgres") {
	const journal = readJournal(dialect);
	const position = journal.entries.findIndex((candidate) =>
		readFileSync(join(migrationsDir(dialect), `${candidate.tag}.sql`), "utf-8").includes(COLUMN),
	);
	expect(position).toBeGreaterThan(0);
	const entry = journal.entries[position] as JournalEntry;
	const sql = readFileSync(join(migrationsDir(dialect), `${entry.tag}.sql`), "utf-8");
	return { journal, entry, position, sql };
}

/** A copy of the migrations folder as it was before the column's migration (it and every later one removed). */
function folderBeforeColumn(dialect: "sqlite" | "postgres"): string {
	const { journal, position } = columnMigration(dialect);
	const dest = join(TMP, `${dialect}-before-${crypto.randomUUID()}`);
	cpSync(migrationsDir(dialect), dest, { recursive: true });
	for (const removed of journal.entries.slice(position)) {
		rmSync(join(dest, `${removed.tag}.sql`));
		rmSync(join(dest, "meta", `${String(removed.idx).padStart(4, "0")}_snapshot.json`), {
			force: true,
		});
	}
	writeFileSync(
		join(dest, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2),
	);
	return dest;
}

describe("the migration that adds the column (both dialects)", () => {
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: the migration adds exactly this nullable text column to sessions, with no default and no backfill`, () => {
			const { sql } = columnMigration(dialect);
			expect(sql).toContain(COLUMN);
			expect(sql.toLowerCase()).toContain("alter table");
			expect(sql.toLowerCase()).not.toContain("not null");
			expect(sql.toLowerCase()).not.toContain("default");
			expect(sql.toLowerCase()).not.toContain("update ");
		});

		test(`${dialect}: the migration's snapshot has the column as nullable text`, () => {
			const { entry } = columnMigration(dialect);
			const snapshot = JSON.parse(
				readFileSync(
					join(
						migrationsDir(dialect),
						"meta",
						`${String(entry.idx).padStart(4, "0")}_snapshot.json`,
					),
					"utf-8",
				),
			) as {
				tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
			};
			const table = snapshot.tables.sessions ?? snapshot.tables["public.sessions"];
			const column = table?.columns[COLUMN];
			expect(column?.type).toBe("text");
			expect(column?.notNull).toBe(false);
		});
	}
});

function tableInfo(db: Database) {
	return db.prepare("PRAGMA table_info(sessions)").all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
	}>;
}

const OLD_SESSION =
	"INSERT INTO sessions (id, session_id, agent_type) VALUES ('old-row', 'old-session', 'claude_code')";

describeSqliteOnly("sessions.reported_host — SQLite", () => {
	test("fresh install through Drizzle: the column is there, nullable text, no default", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		const column = tableInfo(db).find((c) => c.name === COLUMN);
		expect(column).toMatchObject({ name: COLUMN, type: "TEXT", notnull: 0, dflt_value: null });
		db.close();
	});

	test("Drizzle upgrade from the migration before: the column appears and a session that was there keeps null", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: folderBeforeColumn("sqlite") });
		expect(tableInfo(db).map((c) => c.name)).not.toContain(COLUMN);
		db.exec(OLD_SESSION);
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		expect(tableInfo(db).map((c) => c.name)).toContain(COLUMN);
		const row = db.prepare(`SELECT ${COLUMN} AS host FROM sessions WHERE id = 'old-row'`).get() as {
			host: string | null;
		};
		expect(row.host).toBeNull();
		db.close();
	});

	test("an install that predates Drizzle, through the legacy init: the column is added, a session that was there keeps null", async () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL UNIQUE,
				agent_type TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
				total_tool_uses INTEGER NOT NULL DEFAULT 0,
				metadata TEXT DEFAULT '{}'
			);
		`);
		db.exec(OLD_SESSION);
		expect(tableInfo(db).map((c) => c.name)).not.toContain(COLUMN);
		await initializeDatabase(db);
		expect(tableInfo(db).find((c) => c.name === COLUMN)).toMatchObject({
			type: "TEXT",
			notnull: 0,
		});
		const row = db.prepare(`SELECT ${COLUMN} AS host FROM sessions WHERE id = 'old-row'`).get() as {
			host: string | null;
		};
		expect(row.host).toBeNull();
		db.close();
	});
});

describePostgresOnly("sessions.reported_host — Postgres", () => {
	async function admin() {
		const { default: postgres } = await import("postgres");
		return postgres(process.env.DATABASE_URL as string, { max: 1, idle_timeout: 5 });
	}

	test("fresh install: the column is there, nullable text, no default", async () => {
		await initializeDatabase();
		const sql = await admin();
		try {
			const rows = (await sql`
				SELECT data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = ${COLUMN}
			`) as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
			expect(rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
		} finally {
			await sql.end();
		}
	});

	test("Drizzle upgrade from the migration before: the column appears and a session that was there keeps null", async () => {
		const { default: postgres } = await import("postgres");
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const base = new URL(process.env.DATABASE_URL as string);
		const name = `ap_reported_host_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const root = await admin();
		await root.unsafe(`CREATE DATABASE "${name}"`);
		const target = new URL(base.toString());
		target.pathname = `/${name}`;
		const conn = postgres(target.toString(), { max: 1, idle_timeout: 5 });
		try {
			await migrate(drizzle(conn), { migrationsFolder: folderBeforeColumn("postgres") });
			const before = (await conn`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sessions'
			`) as Array<{ column_name: string }>;
			expect(before.map((r) => r.column_name)).not.toContain(COLUMN);
			await conn`INSERT INTO sessions (id, session_id, agent_type) VALUES ('old-row', 'old-session', 'claude_code')`;
			await migrate(drizzle(conn), { migrationsFolder: migrationsDir("postgres") });
			const after = (await conn.unsafe(
				`SELECT ${COLUMN} AS host FROM sessions WHERE id = 'old-row'`,
			)) as Array<{ host: string | null }>;
			expect(after).toEqual([{ host: null }]);
		} finally {
			await conn.end();
			await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
			await root.end();
		}
	});
});
