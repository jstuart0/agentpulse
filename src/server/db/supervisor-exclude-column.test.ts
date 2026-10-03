/**
 * supervisors.exclude_rules_state: one nullable text column the heartbeat writes
 * ("none" | "ok" | "invalid"; null = unknown). It has to be there however a
 * database got its schema: a fresh install, an install brought up by Drizzle from
 * the migration before it, and (SQLite only: Postgres has no such path) an
 * install that predates Drizzle and is brought up by the legacy init. Rows that
 * were already there keep null.
 *
 * Which migration adds it is found by reading the journal (the newest entry is
 * the one whose SQL names the column), so these hold when the migration is
 * regenerated with a different number.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const { initializeDatabase } = await import("./client.js");

const COLUMN = "exclude_rules_state";
const TMP = mkdtempSync(join(tmpdir(), "ap-exclude-column-"));
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

/** The migration that adds the column is the newest one, and says so in its SQL. */
function newestMigration(dialect: "sqlite" | "postgres") {
	const journal = readJournal(dialect);
	const entry = journal.entries.at(-1) as JournalEntry;
	const sql = readFileSync(join(migrationsDir(dialect), `${entry.tag}.sql`), "utf-8");
	return { journal, entry, sql };
}

/** A copy of the migrations folder as it was before the newest migration. */
function folderWithoutNewest(dialect: "sqlite" | "postgres"): string {
	const { journal, entry } = newestMigration(dialect);
	const dest = join(TMP, `${dialect}-before-${crypto.randomUUID()}`);
	cpSync(migrationsDir(dialect), dest, { recursive: true });
	rmSync(join(dest, `${entry.tag}.sql`));
	rmSync(join(dest, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`), {
		force: true,
	});
	writeFileSync(
		join(dest, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }, null, 2),
	);
	return dest;
}

describe("the migration that adds the column (both dialects)", () => {
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: the newest migration adds exactly this nullable text column, with no default and no backfill`, () => {
			const { sql } = newestMigration(dialect);
			expect(sql).toContain(COLUMN);
			expect(sql.toLowerCase()).toContain("alter table");
			expect(sql.toLowerCase()).not.toContain("not null");
			expect(sql.toLowerCase()).not.toContain("default");
			expect(sql.toLowerCase()).not.toContain("update ");
		});

		test(`${dialect}: the newest snapshot has the column, right after enrollment_state`, () => {
			const { entry } = newestMigration(dialect);
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
			// SQLite snapshots key tables by name, Postgres ones by schema-qualified name.
			const table = snapshot.tables.supervisors ?? snapshot.tables["public.supervisors"];
			const columns = Object.keys(table?.columns ?? {});
			expect(columns).toContain(COLUMN);
			expect(columns.indexOf(COLUMN)).toBe(columns.indexOf("enrollment_state") + 1);
			const column = table?.columns[COLUMN];
			expect(column?.type).toBe("text");
			expect(column?.notNull).toBe(false);
		});
	}
});

function tableInfo(db: Database) {
	return db.prepare("PRAGMA table_info(supervisors)").all() as Array<{
		name: string;
		type: string;
		notnull: number;
		dflt_value: string | null;
	}>;
}

describeSqliteOnly("supervisors.exclude_rules_state — SQLite", () => {
	test("fresh install through Drizzle: the column is there, nullable text, no default", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		const column = tableInfo(db).find((c) => c.name === COLUMN);
		expect(column).toMatchObject({ name: COLUMN, type: "TEXT", notnull: 0, dflt_value: null });
		db.close();
	});

	test("Drizzle upgrade from the migration before: the column appears and a row that was there keeps null", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
		migrate(drizzle(db), { migrationsFolder: folderWithoutNewest("sqlite") });
		expect(tableInfo(db).map((c) => c.name)).not.toContain(COLUMN);
		db.exec(
			"INSERT INTO supervisors (id, host_name, platform, arch, version) VALUES ('old-host', 'h', 'linux', 'x64', '1.0.0')",
		);
		migrate(drizzle(db), { migrationsFolder: migrationsDir("sqlite") });
		expect(tableInfo(db).map((c) => c.name)).toContain(COLUMN);
		const row = db
			.prepare(`SELECT ${COLUMN} AS state FROM supervisors WHERE id = 'old-host'`)
			.get() as {
			state: string | null;
		};
		expect(row.state).toBeNull();
		db.close();
	});

	test("an install that predates Drizzle, through the legacy init: the column is added, a row that was there keeps null", async () => {
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
			CREATE TABLE supervisors (
				id TEXT PRIMARY KEY,
				host_name TEXT NOT NULL,
				platform TEXT NOT NULL,
				arch TEXT NOT NULL,
				version TEXT NOT NULL,
				capabilities_json TEXT NOT NULL DEFAULT '{}',
				trusted_roots_json TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'connected',
				capability_schema_version INTEGER NOT NULL DEFAULT 1,
				config_schema_version INTEGER NOT NULL DEFAULT 1,
				last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
				heartbeat_lease_expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 seconds')),
				enrollment_state TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			INSERT INTO supervisors (id, host_name, platform, arch, version) VALUES ('legacy-host', 'h', 'linux', 'x64', '1.0.0');
		`);
		expect(tableInfo(db).map((c) => c.name)).not.toContain(COLUMN);
		await initializeDatabase(db);
		expect(tableInfo(db).find((c) => c.name === COLUMN)).toMatchObject({
			type: "TEXT",
			notnull: 0,
		});
		const row = db
			.prepare(`SELECT ${COLUMN} AS state FROM supervisors WHERE id = 'legacy-host'`)
			.get() as {
			state: string | null;
		};
		expect(row.state).toBeNull();
		db.close();
	});

	test("the legacy list names the column inside the supervisors group, not at the tail", () => {
		const source = readFileSync(join(import.meta.dir, "client.ts"), "utf-8");
		const at = source.indexOf(`ADD COLUMN ${COLUMN} TEXT`);
		expect(at, "an ALTER for the column in the legacy list").toBeGreaterThan(-1);
		const enrollment = source.indexOf("ALTER TABLE supervisors ADD COLUMN enrollment_state");
		expect(enrollment).toBeGreaterThan(-1);
		expect(at).toBeGreaterThan(enrollment);
		// the next statement after it is not another supervisors one that came before it in the group
		const nextLine = source.slice(at).split("\n")[1] ?? "";
		expect(nextLine).not.toContain("ALTER TABLE supervisors");
		expect(at - enrollment).toBeLessThan(400);
	});
});

describePostgresOnly("supervisors.exclude_rules_state — Postgres", () => {
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
				WHERE table_schema = 'public' AND table_name = 'supervisors' AND column_name = ${COLUMN}
			`) as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
			expect(rows).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
		} finally {
			await sql.end();
		}
	});

	test("Drizzle upgrade from the migration before: the column appears and a row that was there keeps null", async () => {
		const { default: postgres } = await import("postgres");
		const { drizzle } = await import("drizzle-orm/postgres-js");
		const { migrate } = await import("drizzle-orm/postgres-js/migrator");
		const base = new URL(process.env.DATABASE_URL as string);
		const name = `ap_exclude_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const root = await admin();
		await root.unsafe(`CREATE DATABASE "${name}"`);
		const target = new URL(base.toString());
		target.pathname = `/${name}`;
		const conn = postgres(target.toString(), { max: 1, idle_timeout: 5 });
		try {
			await migrate(drizzle(conn), { migrationsFolder: folderWithoutNewest("postgres") });
			const before = (await conn`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'supervisors'
			`) as Array<{ column_name: string }>;
			expect(before.map((r) => r.column_name)).not.toContain(COLUMN);
			await conn`INSERT INTO supervisors (id, host_name, platform, arch, version) VALUES ('old-host', 'h', 'linux', 'x64', '1.0.0')`;
			await migrate(drizzle(conn), { migrationsFolder: migrationsDir("postgres") });
			const after = (await conn.unsafe(
				`SELECT ${COLUMN} AS state FROM supervisors WHERE id = 'old-host'`,
			)) as Array<{ state: string | null }>;
			expect(after).toEqual([{ state: null }]);
		} finally {
			await conn.end();
			await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
			await root.end();
		}
	});
});
