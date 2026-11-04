import { Database } from "bun:sqlite";
/**
 * An install on the legacy SQLite init path (the existing-install path: no Drizzle migrate) must end up
 * with every table, column, index and trigger a fresh Drizzle-migrated database has. The legacy init is a
 * hand-kept list that mirrors the migrations, so a migration that forgets its mirror leaves a column
 * missing and every Drizzle select on that table fails with "no such column". Compared by structure, not
 * name: a legacy inline UNIQUE and a Drizzle `_unique` index are the same thing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./__test_db.js";
import { isSqliteTest, itSqliteOnly } from "../test-utils/backend.js";
import { preexistingInstall, writePreexistingInstallFile } from "../test-utils/legacy-install.js";

const { initializeDatabase } = await import("./client.js");
const MIGRATIONS = resolve(import.meta.dir, "../../../drizzle/sqlite");
const TMP = mkdtempSync(join(tmpdir(), "ap-legacy-parity-"));

/** What the opt-in vector table adds only when vector search is built in, and Drizzle's own bookkeeping. */
const NOT_ON_LEGACY = new Set(["event_embeddings", "__drizzle_migrations"]);

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

/**
 * Tables whose columns are compared in full (NOT NULL, default, foreign key and its delete rule), not
 * just by name and type. The older tables differ on purpose and harmlessly (a legacy `id TEXT PRIMARY
 * KEY` is nullable, `events.session_id` is rebuilt with its cascade only after boot), so a blanket
 * comparison would only report those. A table born in a migration with its constraints must match.
 */
const FULLY_COMPARED = new Set(["codex_approvals", "codex_approval_audit"]);

/** SQLite reads `false` and `true` as 0 and 1, so a default spelled either way is the same default. */
function normalizeDefault(value: unknown): string {
	const text = normalizeSql(String(value));
	return text === "false" ? "0" : text === "true" ? "1" : text;
}

/** A trigger's SQL with the spelling differences that don't change what it does taken out. */
function normalizeSql(text: string): string {
	return text
		.replace(/[`"]/g, "")
		.replace(/\bif not exists\b/gi, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),;=<>])\s*/g, "$1")
		.trim()
		.toLowerCase();
}

function shapeOf(db: Database): Shape {
	const shape: Shape = {
		tables: new Set(),
		columns: new Set(),
		indexes: new Set<string>(),
		triggers: new Set<string>(),
	};
	const objects = db
		.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
		.all() as Row[];
	for (const o of objects) {
		const name = String(o.name);
		if (o.type === "trigger") {
			// By name and by what it does: a trigger whose body drifted is a different trigger.
			shape.triggers.add(name);
			shape.triggers.add(`${name}: ${normalizeSql(String(o.sql))}`);
		}
		if (o.type !== "table" || NOT_ON_LEGACY.has(name) || name.includes("_fts")) continue;
		shape.tables.add(name);
		for (const c of db.prepare(`PRAGMA table_info('${name}')`).all() as Row[]) {
			shape.columns.add(`${name}.${c.name} ${String(c.type).toUpperCase()}`);
			// NOT NULL and the default decide what an insert may omit and what a row reads back as.
			if (FULLY_COMPARED.has(name)) {
				shape.columns.add(
					`${name}.${c.name} notnull=${c.notnull} default=${normalizeDefault(c.dflt_value)}`,
				);
			}
		}
		for (const f of FULLY_COMPARED.has(name)
			? (db.prepare(`PRAGMA foreign_key_list('${name}')`).all() as Row[])
			: []) {
			shape.columns.add(
				`${name}.${f.from} -> ${f.table}.${f.to} on_delete=${f.on_delete} on_update=${f.on_update}`,
			);
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

/** What migration 0018 added (AGEN-83): the delivery-receipts table (and its indexes with it) and events.occurred_at. */
const MANAGED_DELIVERY_SQL = [
	"DROP TABLE IF EXISTS managed_delivery_receipts",
	"ALTER TABLE events DROP COLUMN occurred_at",
];

/** What migration 0020 added (AGEN-87): both Codex approval tables (their indexes and triggers with them). */
const CODEX_APPROVALS_SQL = [
	"DROP TRIGGER IF EXISTS trg_codex_approvals_finalize_audit",
	"DROP TRIGGER IF EXISTS trg_codex_approval_audit_update",
	"DROP TRIGGER IF EXISTS trg_codex_approval_audit_delete",
	"DROP TABLE IF EXISTS codex_approvals",
	"DROP TABLE IF EXISTS codex_approval_audit",
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

	itSqliteOnly(
		"an install that predates managed delivery receipts (0018) gets the table, its indexes and events.occurred_at",
		async () => {
			const legacy = preexistingInstall();
			const born = await drizzleBorn();
			open.push(legacy, born);
			await initializeDatabase(legacy);
			for (const statement of MANAGED_DELIVERY_SQL) legacy.exec(statement);
			// The drop list is real: the shape really lacks what it names.
			const gap = missingFrom(shapeOf(legacy), shapeOf(born));
			expect(gap).toContain("tables: managed_delivery_receipts");
			expect(gap).toContain("columns: events.occurred_at TEXT");
			expect(gap.some((item) => item.startsWith("indexes: managed_delivery_receipts("))).toBe(true);

			await initializeDatabase(legacy);

			expect(missingFrom(shapeOf(legacy), shapeOf(born))).toEqual([]);
		},
	);

	itSqliteOnly(
		"an install that predates Codex approvals (0020) gets both tables, their indexes and the audit triggers",
		async () => {
			const legacy = preexistingInstall();
			const born = await drizzleBorn();
			open.push(legacy, born);
			await initializeDatabase(legacy);
			for (const statement of CODEX_APPROVALS_SQL) legacy.exec(statement);
			// The drop list is real: the shape really lacks what it names.
			const gap = missingFrom(shapeOf(legacy), shapeOf(born));
			expect(gap).toContain("tables: codex_approvals");
			expect(gap).toContain("tables: codex_approval_audit");
			expect(gap).toContain("triggers: trg_codex_approvals_finalize_audit");
			expect(gap).toContain("triggers: trg_codex_approval_audit_update");
			expect(gap).toContain("triggers: trg_codex_approval_audit_delete");

			await initializeDatabase(legacy);

			expect(missingFrom(shapeOf(legacy), shapeOf(born))).toEqual([]);
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

	test.skipIf(!isSqliteTest)(
		"the Codex approval suites pass unchanged on a database the legacy init built",
		async () => {
			// The suites that prove the audit is append-only, that a session delete cascades and finalizes
			// its audit rows, and that a request is recorded, answered and synced, run in a child process
			// against a file that held only an old install's `sessions` table, so boot takes the legacy
			// path. Same suites, same assertions: nothing here is re-implemented against a different schema.
			const dir = mkdtempSync(join(TMP, "legacy-run-"));
			const file = join(dir, "legacy.db");
			writePreexistingInstallFile(file);
			const suites = [
				"src/server/db/codex-approvals-migration.test.ts",
				"src/server/services/codex-approvals.test.ts",
				"src/server/services/codex-approvals-stop-fence.test.ts",
				"src/server/services/codex-approvals-review.test.ts",
				"src/server/routes/sessions-delete.test.ts",
			];
			const child = Bun.spawn([process.execPath, "test", ...suites], {
				cwd: resolve(import.meta.dir, "../../.."),
				env: { ...process.env, SQLITE_PATH: file, DATA_DIR: dir },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			await child.exited;
			const output = `${stdout}\n${stderr}`;

			// It really was the legacy path: boot said so, never "Fresh SQLite install", and the file has no
			// Drizzle migration table.
			expect(output).toContain("Existing SQLite install detected — using legacy init path");
			expect(output).not.toContain("Fresh SQLite install");
			const after = new Database(file, { readonly: true });
			try {
				const tables = (
					after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]
				).map((t) => t.name);
				expect(tables).not.toContain("__drizzle_migrations");
				expect(tables).toContain("codex_approvals");
			} finally {
				after.close();
			}

			// A population floor, so "0 failed" can't mean nothing ran.
			const passed = Number(/^\s*(\d+) pass/m.exec(output)?.[1] ?? 0);
			const failed = Number(/^\s*(\d+) fail/m.exec(output)?.[1] ?? Number.NaN);
			expect(passed).toBeGreaterThanOrEqual(100);
			expect(failed, output.slice(-3000)).toBe(0);
			expect(existsSync(file)).toBe(true);
		},
		180_000,
	);

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
