/**
 * Migration 0018 (AGEN-83): events.occurred_at (one nullable text column) and the
 * managed_delivery_receipts table. Both have to be there however a database got its
 * schema: a fresh install, an install brought up by Drizzle from the migration before,
 * and (SQLite only) an install that predates Drizzle and is brought up by the legacy
 * init. Rows that were already there keep null in the new column, and the receipts
 * table cascades with its session on every path.
 *
 * The migration is found by reading the journal (the entry whose SQL creates the
 * table), so these hold if it is regenerated under a different number.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const { initializeDatabase } = await import("./client.js");

const TABLE = "managed_delivery_receipts";
const TMP = mkdtempSync(join(tmpdir(), "ap-receipts-"));
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

function migrationOf(dialect: "sqlite" | "postgres") {
	const journal = readJournal(dialect);
	const position = journal.entries.findIndex((candidate) =>
		readFileSync(join(migrationsDir(dialect), `${candidate.tag}.sql`), "utf-8").includes(TABLE),
	);
	expect(position).toBeGreaterThan(0);
	const entry = journal.entries[position] as JournalEntry;
	const sql = readFileSync(join(migrationsDir(dialect), `${entry.tag}.sql`), "utf-8");
	return { journal, entry, position, sql };
}

function folderBeforeMigration(dialect: "sqlite" | "postgres"): string {
	const { journal, position } = migrationOf(dialect);
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

describe("migration 0018 (both dialects)", () => {
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: one migration adds the nullable occurred_at column and the receipts table, with no default and no backfill`, () => {
			const { sql } = migrationOf(dialect);
			const lower = sql.toLowerCase();
			expect(lower).toMatch(/alter table [`"]events[`"] add (column )?[`"]occurred_at[`"] text;/);
			expect(lower).not.toMatch(/\bupdate\s+["`]?\w+["`]?\s+set\b/);
			expect(lower).toContain("unique index");
			expect(sql).toContain("uq_managed_delivery_receipts_session_key");
			expect(sql).toContain("idx_managed_delivery_receipts_created_at");
			expect(lower).toContain("on delete cascade");
		});

		test(`${dialect}: the snapshot has occurred_at after dedup_key and the table's four columns`, () => {
			const { entry } = migrationOf(dialect);
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
			const pick = (name: string) => snapshot.tables[name] ?? snapshot.tables[`public.${name}`];
			const eventColumns = Object.keys(pick("events")?.columns ?? {});
			expect(eventColumns.indexOf("occurred_at")).toBeGreaterThan(
				eventColumns.indexOf("dedup_key"),
			);
			expect(pick("events")?.columns.occurred_at).toMatchObject({ type: "text", notNull: false });
			expect(Object.keys(pick(TABLE)?.columns ?? {})).toEqual([
				"id",
				"session_id",
				"receipt_key",
				"created_at",
			]);
			expect(pick(TABLE)?.columns.created_at?.notNull).toBe(true);
		});
	}
});

function columns(db: Database, table: string) {
	return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
	}>;
}

function exerciseReceiptTable(db: Database) {
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("INSERT INTO sessions (id, session_id, agent_type) VALUES ('r1', 's-r', 'claude_code')");
	db.exec(
		"INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at) VALUES ('s-r', 'k1', '2026-11-01 00:00:00')",
	);
	// a second row for the same (session, key) is refused; another key is fine
	expect(() =>
		db.exec(
			"INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at) VALUES ('s-r', 'k1', '2026-11-01 00:00:01')",
		),
	).toThrow();
	db.exec(
		"INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at) VALUES ('s-r', 'k2', '2026-11-01 00:00:01')",
	);
	// a receipt for a session that does not exist is refused
	expect(() =>
		db.exec(
			"INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at) VALUES ('nope', 'k', '2026-11-01 00:00:00')",
		),
	).toThrow();
	// deleting the session takes its receipts (cascade)
	db.exec("DELETE FROM sessions WHERE session_id = 's-r'");
	const left = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number };
	expect(left.n).toBe(0);
}

describeSqliteOnly("0018 — SQLite", () => {
	test("fresh install through Drizzle: occurred_at is nullable text with no default, and the table constrains and cascades", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		expect(columns(db, "events").find((c) => c.name === "occurred_at")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		exerciseReceiptTable(db);
		db.close();
	});

	test("Drizzle upgrade from the migration before: events keep null occurred_at and the table appears", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: folderBeforeMigration("sqlite") });
		expect(columns(db, "events").map((c) => c.name)).not.toContain("occurred_at");
		expect(columns(db, TABLE)).toEqual([]);
		db.exec(
			"INSERT INTO sessions (id, session_id, agent_type) VALUES ('o1', 'old', 'claude_code')",
		);
		db.exec(
			"INSERT INTO events (session_id, event_type, raw_payload) VALUES ('old', 'Stop', '{}')",
		);
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		const row = db
			.prepare("SELECT occurred_at AS at FROM events WHERE session_id = 'old'")
			.get() as {
			at: string | null;
		};
		expect(row.at).toBeNull();
		exerciseReceiptTable(db);
		db.close();
	});

	test("an install that predates Drizzle, through the legacy init: the column and the table appear, an existing event keeps null", async () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, display_name TEXT, agent_type TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active', cwd TEXT, transcript_path TEXT, model TEXT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')), last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
				ended_at TEXT, semantic_status TEXT, current_task TEXT, plan_summary TEXT,
				total_tool_uses INTEGER NOT NULL DEFAULT 0, metadata TEXT DEFAULT '{}'
			);
			CREATE TABLE events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(session_id),
				event_type TEXT NOT NULL,
				category TEXT,
				source TEXT NOT NULL DEFAULT 'observed_hook',
				content TEXT,
				is_noise INTEGER NOT NULL DEFAULT 0,
				provider_event_type TEXT,
				tool_name TEXT,
				tool_input TEXT,
				tool_response TEXT,
				raw_payload TEXT NOT NULL,
				dedup_key TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			INSERT INTO sessions (id, session_id, agent_type) VALUES ('l1', 'legacy', 'claude_code');
			INSERT INTO events (session_id, event_type, raw_payload) VALUES ('legacy', 'Stop', '{}');
		`);
		await initializeDatabase(db);
		expect(columns(db, "events").find((c) => c.name === "occurred_at")).toMatchObject({
			type: "TEXT",
			notnull: 0,
			dflt_value: null,
		});
		const row = db
			.prepare("SELECT occurred_at AS at FROM events WHERE session_id = 'legacy'")
			.get() as {
			at: string | null;
		};
		expect(row.at).toBeNull();
		exerciseReceiptTable(db);
		db.close();
	});

	test("the receipts table is not in the cascade-rebuild list (it is born with its FK)", () => {
		const source = readFileSync(join(import.meta.dir, "client.ts"), "utf-8");
		const list = source.slice(
			source.indexOf("const targets: ReadonlyArray<{ table: string; column: string }>"),
		);
		expect(list.slice(0, list.indexOf("];"))).not.toContain(TABLE);
	});
});

describePostgresOnly("0018 — Postgres", () => {
	async function admin() {
		const { default: postgres } = await import("postgres");
		return postgres(process.env.DATABASE_URL as string, { max: 1, idle_timeout: 5 });
	}

	test("fresh install: occurred_at is nullable text with no default, and the table has its unique index and cascade FK", async () => {
		await initializeDatabase();
		const sql = await admin();
		try {
			const column = (await sql`
				SELECT data_type, is_nullable, column_default FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'occurred_at'
			`) as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
			expect(column).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
			const indexes = (await sql`
				SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${TABLE}
			`) as Array<{ indexname: string }>;
			expect(indexes.map((r) => r.indexname).sort()).toEqual(
				[
					`${TABLE}_pkey`,
					"idx_managed_delivery_receipts_created_at",
					"uq_managed_delivery_receipts_session_key",
				].sort(),
			);
		} finally {
			await sql.end();
		}
	});

	test("Drizzle upgrade from the migration before: occurred_at appears null on an old event and the table is created", async () => {
		const { default: postgres } = await import("postgres");
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const base = new URL(process.env.DATABASE_URL as string);
		const name = `ap_receipts_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const root = await admin();
		await root.unsafe(`CREATE DATABASE "${name}"`);
		const target = new URL(base.toString());
		target.pathname = `/${name}`;
		const conn = postgres(target.toString(), { max: 1, idle_timeout: 5 });
		try {
			await migrate(drizzle(conn), { migrationsFolder: folderBeforeMigration("postgres") });
			await conn`INSERT INTO sessions (id, session_id, agent_type) VALUES ('o1', 'old', 'claude_code')`;
			await conn`INSERT INTO events (session_id, event_type, raw_payload) VALUES ('old', 'Stop', '{}')`;
			await migrate(drizzle(conn), { migrationsFolder: migrationsDir("postgres") });
			const after = (await conn.unsafe(
				"SELECT occurred_at AS at FROM events WHERE session_id = 'old'",
			)) as Array<{ at: string | null }>;
			expect(after).toEqual([{ at: null }]);
			await conn`INSERT INTO managed_delivery_receipts (session_id, receipt_key, created_at) VALUES ('old', 'k', '2026-11-01 00:00:00')`;
			await conn`DELETE FROM sessions WHERE session_id = 'old'`;
			const left = (await conn.unsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE}`)) as Array<{
				n: number;
			}>;
			expect(left[0]?.n).toBe(0);
		} finally {
			await conn.end();
			await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
			await root.end();
		}
	});
});
