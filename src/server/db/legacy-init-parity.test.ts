import { Database } from "bun:sqlite";
/**
 * An install on the legacy SQLite init path (the existing-install path: no Drizzle migrate) must end up
 * with every table, column, index and trigger a fresh Drizzle-migrated database has. The legacy init is a
 * hand-kept list that mirrors the migrations, so a migration that forgets its mirror leaves a column
 * missing and every Drizzle select on that table fails with "no such column". Compared by structure, not
 * name: a legacy inline UNIQUE and a Drizzle `_unique` index are the same thing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./__test_db.js";
import { itSqliteOnly } from "../test-utils/backend.js";

const { initializeDatabase } = await import("./client.js");
const MIGRATIONS = resolve(import.meta.dir, "../../../drizzle/sqlite");
const TMP = mkdtempSync(join(tmpdir(), "ap-legacy-parity-"));

/** What the opt-in vector table adds only when vector search is built in, and Drizzle's own bookkeeping. */
const NOT_ON_LEGACY = new Set(["event_embeddings", "__drizzle_migrations"]);

/** A pre-existing install's `sessions` table: its presence is what routes boot to the legacy init. */
function preexistingInstall(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	db.exec(`CREATE TABLE sessions (
		id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, display_name TEXT, agent_type TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active', cwd TEXT, transcript_path TEXT, model TEXT,
		started_at TEXT NOT NULL DEFAULT (datetime('now')), last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
		ended_at TEXT, semantic_status TEXT, current_task TEXT, plan_summary TEXT,
		total_tool_uses INTEGER NOT NULL DEFAULT 0, metadata TEXT DEFAULT '{}')`);
	return db;
}

async function drizzleBorn(): Promise<Database> {
	const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
	const { drizzle } = await import("drizzle-orm/bun-sqlite");
	const db = new Database(join(TMP, `${crypto.randomUUID()}.db`));
	db.exec("PRAGMA foreign_keys = ON;");
	migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
	return db;
}

interface Shape {
	tables: Set<string>;
	columns: Set<string>;
	indexes: Set<string>;
	triggers: Set<string>;
}

type Row = Record<string, string | number | null>;

function shapeOf(db: Database): Shape {
	const shape: Shape = {
		tables: new Set(),
		columns: new Set(),
		indexes: new Set<string>(),
		triggers: new Set<string>(),
	};
	const objects = db
		.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
		.all() as Row[];
	for (const o of objects) {
		const name = String(o.name);
		if (o.type === "trigger") shape.triggers.add(name);
		if (o.type !== "table" || NOT_ON_LEGACY.has(name) || name.includes("_fts")) continue;
		shape.tables.add(name);
		for (const c of db.prepare(`PRAGMA table_info('${name}')`).all() as Row[]) {
			shape.columns.add(`${name}.${c.name} ${String(c.type).toUpperCase()}`);
		}
		for (const i of db.prepare(`PRAGMA index_list('${name}')`).all() as Row[]) {
			if (i.origin === "pk") continue;
			const cols = (db.prepare(`PRAGMA index_info('${i.name}')`).all() as Row[]).map((c) => c.name);
			shape.indexes.add(`${name}(${cols.join(",")}) unique=${i.unique} partial=${i.partial}`);
		}
	}
	return shape;
}

function missingFrom(legacy: Shape, born: Shape): string[] {
	const out: string[] = [];
	for (const kind of ["tables", "columns", "indexes", "triggers"] as const) {
		for (const item of born[kind]) if (!legacy[kind].has(item)) out.push(`${kind}: ${item}`);
	}
	return out.sort();
}

/** Every object the branch's migrations (0013-0017) added, by the names its legacy mirror must give them. */
const MOBILE_COMPANION_SQL = [
	"DROP TRIGGER IF EXISTS pairing_codes_redeemed_key_immutable",
	"DROP TABLE IF EXISTS pairing_codes",
	"DROP TABLE IF EXISTS mobile_device_activities",
	"DROP TABLE IF EXISTS mobile_devices",
	"DROP TABLE IF EXISTS ai_hitl_deliveries",
	"DROP INDEX IF EXISTS launch_requests_idempotency_key_unique",
	"DROP INDEX IF EXISTS idx_launch_requests_created_at",
	"DROP INDEX IF EXISTS idx_ask_threads_owner_user",
	"DROP INDEX IF EXISTS idx_ask_threads_owner_key",
	"ALTER TABLE launch_requests DROP COLUMN idempotency_key",
	"ALTER TABLE ask_threads DROP COLUMN owner_user_id",
	"ALTER TABLE ask_threads DROP COLUMN owner_key_id",
	"ALTER TABLE sessions DROP COLUMN current_turn_started_at",
];

describe("legacy SQLite init parity with Drizzle migrations", () => {
	const open: Database[] = [];
	afterAll(() => {
		for (const db of open) db.close();
	});

	itSqliteOnly("an existing install ends with everything a fresh Drizzle install has", async () => {
		const legacy = preexistingInstall();
		const born = await drizzleBorn();
		open.push(legacy, born);
		await initializeDatabase(legacy);
		expect(missingFrom(shapeOf(legacy), shapeOf(born))).toEqual([]);
	});

	itSqliteOnly(
		"an install that predates the mobile companion gets all of its tables, columns, indexes and triggers",
		async () => {
			const legacy = preexistingInstall();
			const born = await drizzleBorn();
			open.push(legacy, born);
			await initializeDatabase(legacy);
			for (const statement of MOBILE_COMPANION_SQL) legacy.exec(statement);
			// The drop list is real: the shape really lacks what it names.
			expect(missingFrom(shapeOf(legacy), shapeOf(born)).length).toBeGreaterThan(8);

			await initializeDatabase(legacy);

			expect(missingFrom(shapeOf(legacy), shapeOf(born))).toEqual([]);
			expect(
				(legacy.prepare("PRAGMA table_info('launch_requests')").all() as Row[]).map((c) => c.name),
			).toContain("idempotency_key");
		},
	);

	itSqliteOnly("the legacy init is idempotent: a second boot changes nothing", async () => {
		const legacy = preexistingInstall();
		open.push(legacy);
		await initializeDatabase(legacy);
		const first = shapeOf(legacy);
		await initializeDatabase(legacy);
		expect(missingFrom(shapeOf(legacy), first)).toEqual([]);
		expect(missingFrom(first, shapeOf(legacy))).toEqual([]);
	});

	test("the guard sees a gap: a shape missing a column is reported", () => {
		const a: Shape = {
			tables: new Set(["t"]),
			columns: new Set(["t.x TEXT"]),
			indexes: new Set<string>(),
			triggers: new Set<string>(),
		};
		const b = { ...a, columns: new Set<string>() };
		expect(missingFrom(b, a)).toEqual(["columns: t.x TEXT"]);
	});
});
