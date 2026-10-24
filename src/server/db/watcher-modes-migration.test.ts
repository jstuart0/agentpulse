/**
 * Watcher modes, phase 1: schema, migration 0012, legacy-init parity, the run
 * indexes, duplicate-open-run resolution and the append-only dispatch audit.
 *
 * Fixtures follow ai-session-summaries.test.ts: a minimal pre-existing
 * `sessions` table routes a handle through the legacy init, the Drizzle migrator
 * on a scratch file is the Drizzle-born install, and every behavioural check on
 * the process-wide database goes through Drizzle's own raw-SQL entry points.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type SQL, sql } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import "../services/ai/__test_db.js";
import { describePostgresOnly, itSqliteOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { AI_DISPATCH_AUDIT_TRIGGERS_SQLITE, DEDUPE_OPEN_RUNS_SQL, getDb, initializeDatabase } =
	await import("./client.js");
const { executeRows } = await import("./sql-helpers.js");
const { aiDispatchAuditPg, aiDispatchAuditSqlite } = await import(
	"./schema/ai/ai-dispatch-audit.js"
);
const { aiWatcherReportsPg, aiWatcherReportsSqlite } = await import(
	"./schema/ai/ai-watcher-reports.js"
);
const { aiHitlRequestsPg, aiHitlRequestsSqlite } = await import("./schema/ai/ai-hitl-requests.js");
const { watcherConfigsPg, watcherConfigsSqlite } = await import("./schema/ai/watcher-configs.js");
const { watcherProposalsPg, watcherProposalsSqlite } = await import(
	"./schema/ai/watcher-proposals.js"
);

const MIGRATIONS_ROOT = resolve(import.meta.dir, "../../../drizzle");
const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-watcher-modes-"));
afterAll(() => {
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});
beforeAll(async () => {
	await initializeDatabase();
});

const NEW_CONFIG_COLUMNS = [
	"notify_enabled",
	"continue_enabled",
	"auto_confirmed_at",
	"auto_confirmed_by",
];
const NEW_PROPOSAL_COLUMNS = ["turn_key", "suggested_prompt", "continue_kind"];
const NEW_HITL_COLUMNS = [
	"turn_key",
	"trigger_event_id",
	"prompt_sha256",
	"approvable",
	"telegram_sent_at",
];

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
	return join(TMP_DIR, `${crypto.randomUUID()}.db`);
}

function legacyFixture(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			display_name TEXT,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			cwd TEXT,
			transcript_path TEXT,
			model TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at TEXT,
			semantic_status TEXT,
			current_task TEXT,
			plan_summary TEXT,
			total_tool_uses INTEGER NOT NULL DEFAULT 0,
			metadata TEXT DEFAULT '{}'
		);
	`);
	return db;
}

async function legacyBooted(): Promise<Database> {
	const db = legacyFixture();
	await initializeDatabase(db);
	return db;
}

async function drizzleBornDb(
	folder = join(MIGRATIONS_ROOT, "sqlite"),
	path = tmpDbPath(),
): Promise<Database> {
	const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
	const { drizzle } = await import("drizzle-orm/bun-sqlite");
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	migrate(drizzle(db), { migrationsFolder: folder });
	return db;
}

function columnNames(db: Database, table: string): string[] {
	return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
		(c) => c.name,
	);
}

function columnType(db: Database, table: string, column: string): string {
	const row = (
		db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string; type: string }>
	).find((c) => c.name === column);
	return (row?.type ?? "").toUpperCase();
}

function insertSession(db: Database, sessionId: string): void {
	db.prepare("INSERT INTO sessions (id, session_id, agent_type) VALUES (?, ?, 'claude_code')").run(
		crypto.randomUUID(),
		sessionId,
	);
}

function insertRun(db: Database, sessionId: string, status: string): string {
	const id = crypto.randomUUID();
	db.prepare(
		"INSERT INTO ai_watcher_runs (id, session_id, trigger_kind, status, dedupe_key) VALUES (?, ?, 'manual', ?, ?)",
	).run(id, sessionId, status, `${sessionId}:${id}`);
	return id;
}

function openRuns(db: Database, sessionId: string): Array<{ id: string; status: string }> {
	return db
		.prepare(
			"SELECT id, status FROM ai_watcher_runs WHERE session_id = ? AND status IN ('queued','claimed','running')",
		)
		.all(sessionId) as Array<{ id: string; status: string }>;
}

function sqliteIndexNames(db: Database, table: string): string[] {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
			.all(table) as Array<{ name: string }>
	).map((r) => r.name);
}

function migrationFile(dialect: "sqlite" | "postgres"): string {
	const dir = join(MIGRATIONS_ROOT, dialect);
	const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const entries = journal.entries.filter((e) => e.tag.endsWith("_watcher_modes"));
	expect(entries, `the ${dialect} journal has exactly one watcher_modes entry`).toHaveLength(1);
	return readFileSync(join(dir, `${entries[0]?.tag}.sql`), "utf8");
}

async function run(query: SQL): Promise<void> {
	if (config.dialect === "postgres") {
		await (getDb() as unknown as { execute: (q: SQL) => Promise<unknown> }).execute(query);
	} else {
		(getDb() as unknown as { run: (q: SQL) => unknown }).run(query);
	}
}

async function rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
	return executeRows<T>(getDb(), query);
}

const AUDIT_ERROR = "ai_dispatch_audit_append_only";

/** Resolves with the thrown error's full text (a driver may wrap the cause). */
async function failureOf(fn: () => Promise<unknown>): Promise<string | null> {
	try {
		await fn();
		return null;
	} catch (err) {
		const parts: string[] = [];
		let cur: unknown = err;
		while (cur instanceof Error) {
			parts.push(cur.message);
			cur = (cur as Error & { cause?: unknown }).cause;
		}
		return parts.join(" | ");
	}
}

// ── TypeScript tables ─────────────────────────────────────────────────────────

test("the TypeScript tables declare the new columns on both dialects", () => {
	const names = (cols: Array<{ name: string }>) => cols.map((c) => c.name);
	for (const [sqliteTable, pgTable, fresh] of [
		[watcherConfigsSqlite, watcherConfigsPg, NEW_CONFIG_COLUMNS],
		[watcherProposalsSqlite, watcherProposalsPg, NEW_PROPOSAL_COLUMNS],
		[aiHitlRequestsSqlite, aiHitlRequestsPg, NEW_HITL_COLUMNS],
	] as const) {
		const sqliteCols = names(getSqliteTableConfig(sqliteTable).columns);
		const pgCols = names(getPgTableConfig(pgTable).columns);
		for (const column of fresh) {
			expect(sqliteCols, `sqlite ${column}`).toContain(column);
			expect(pgCols, `postgres ${column}`).toContain(column);
		}
	}
	const reportCols = names(getSqliteTableConfig(aiWatcherReportsSqlite).columns);
	expect(names(getPgTableConfig(aiWatcherReportsPg).columns)).toEqual(reportCols);
	const auditCols = names(getSqliteTableConfig(aiDispatchAuditSqlite).columns);
	expect(names(getPgTableConfig(aiDispatchAuditPg).columns)).toEqual(auditCols);
});

// ── Drizzle-born and legacy installs agree ───────────────────────────────────

for (const [label, boot] of [
	["fresh Drizzle install", () => drizzleBornDb()],
	["legacy-init install", () => legacyBooted()],
] as const) {
	itSqliteOnly(
		`${label}: tables and columns match the Drizzle schema by set equality`,
		async () => {
			const db = await boot();
			try {
				const expectations: Array<[string, Array<{ name: string }>]> = [
					["watcher_configs", getSqliteTableConfig(watcherConfigsSqlite).columns],
					["watcher_proposals", getSqliteTableConfig(watcherProposalsSqlite).columns],
					["ai_hitl_requests", getSqliteTableConfig(aiHitlRequestsSqlite).columns],
					["ai_watcher_reports", getSqliteTableConfig(aiWatcherReportsSqlite).columns],
					["ai_dispatch_audit", getSqliteTableConfig(aiDispatchAuditSqlite).columns],
				];
				for (const [table, declared] of expectations) {
					expect(new Set(columnNames(db, table)), table).toEqual(
						new Set(declared.map((c) => c.name)),
					);
				}
				for (const column of NEW_CONFIG_COLUMNS) {
					expect(columnNames(db, "watcher_configs")).toContain(column);
				}
				for (const column of NEW_PROPOSAL_COLUMNS) {
					expect(columnNames(db, "watcher_proposals")).toContain(column);
				}
				for (const column of NEW_HITL_COLUMNS) {
					expect(columnNames(db, "ai_hitl_requests")).toContain(column);
				}
				// D2 / bob round-3: the HITL trigger must be integer to compare with events.id.
				expect(columnType(db, "ai_hitl_requests", "trigger_event_id")).toBe("INTEGER");
				expect(columnType(db, "ai_watcher_reports", "trigger_event_id")).toBe("INTEGER");
				expect(columnType(db, "ai_watcher_reports", "through_event_id")).toBe("INTEGER");
			} finally {
				db.close();
			}
		},
	);

	itSqliteOnly(
		`${label}: mode defaults are 0 and 1, and rows read back as Continue-only`,
		async () => {
			const db = await boot();
			try {
				insertSession(db, "mode-defaults");
				db.prepare("INSERT INTO watcher_configs (session_id, provider_id) VALUES (?, 'p')").run(
					"mode-defaults",
				);
				const row = db
					.prepare(
						"SELECT notify_enabled AS n, continue_enabled AS c, auto_confirmed_at AS a, auto_confirmed_by AS b FROM watcher_configs",
					)
					.get() as { n: number; c: number; a: null; b: null };
				expect(row).toEqual({ n: 0, c: 1, a: null, b: null });
			} finally {
				db.close();
			}
		},
	);

	itSqliteOnly(
		`${label}: ai_watcher_reports has its cascade FK and a unique (session, turn)`,
		async () => {
			const db = await boot();
			try {
				const fks = db.prepare("PRAGMA foreign_key_list('ai_watcher_reports')").all() as Array<{
					table: string;
					from: string;
					on_delete: string;
				}>;
				expect(fks.map((f) => [f.table, f.from, f.on_delete])).toEqual([
					["sessions", "session_id", "CASCADE"],
				]);
				insertSession(db, "report-dup");
				const insert = db.prepare(
					"INSERT INTO ai_watcher_reports (id, session_id, turn_key) VALUES (?, 'report-dup', 'p:1')",
				);
				insert.run(crypto.randomUUID());
				expect(() => insert.run(crypto.randomUUID())).toThrow(/UNIQUE/i);
				db.prepare("DELETE FROM sessions WHERE session_id = 'report-dup'").run();
				expect(
					(db.prepare("SELECT COUNT(*) AS n FROM ai_watcher_reports").get() as { n: number }).n,
				).toBe(0);
				expect(sqliteIndexNames(db, "ai_watcher_reports")).toEqual(
					expect.arrayContaining([
						"uq_ai_watcher_reports_session_turn",
						"idx_ai_watcher_reports_session_created",
						"idx_ai_watcher_reports_telegram_sent",
					]),
				);
			} finally {
				db.close();
			}
		},
	);

	itSqliteOnly(
		`${label}: ai_dispatch_audit has no foreign keys and survives its session`,
		async () => {
			const db = await boot();
			try {
				expect(db.prepare("PRAGMA foreign_key_list('ai_dispatch_audit')").all()).toEqual([]);
				insertSession(db, "audit-survives");
				db.prepare(
					"INSERT INTO ai_dispatch_audit (id, session_id, actor_kind) VALUES ('a1', 'audit-survives', 'user')",
				).run();
				db.prepare("DELETE FROM sessions WHERE session_id = 'audit-survives'").run();
				expect(
					(db.prepare("SELECT COUNT(*) AS n FROM ai_dispatch_audit").get() as { n: number }).n,
				).toBe(1);
			} finally {
				db.close();
			}
		},
	);

	itSqliteOnly(`${label}: dispatch audit is append-only (xander round-3 M6)`, async () => {
		const db = await boot();
		try {
			const insert = (id: string, outcome = "pending") =>
				db
					.prepare(
						"INSERT INTO ai_dispatch_audit (id, session_id, actor_kind, outcome, prompt_text) VALUES (?, 's', 'user', ?, 'Run the tests')",
					)
					.run(id, outcome);
			insert("p1");
			// pending -> sent
			db.prepare(
				"UPDATE ai_dispatch_audit SET outcome = 'sent', completed_at = 'now' WHERE id = 'p1'",
			).run();
			// sent -> refused is not a transition
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET outcome = 'refused' WHERE id = 'p1'").run(),
			).toThrow(AUDIT_ERROR);
			// sent -> failed needs the one allowed code
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET outcome = 'failed' WHERE id = 'p1'").run(),
			).toThrow(AUDIT_ERROR);
			db.prepare(
				"UPDATE ai_dispatch_audit SET outcome = 'failed', refusal_code = 'expired_unclaimed' WHERE id = 'p1'",
			).run();
			// failed is terminal
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET outcome = 'sent' WHERE id = 'p1'").run(),
			).toThrow(AUDIT_ERROR);

			// Named member: the prompt text is immutable, whatever the outcome.
			insert("p2");
			expect(() =>
				db
					.prepare(
						"UPDATE ai_dispatch_audit SET outcome = 'sent', prompt_text = 'something else' WHERE id = 'p2'",
					)
					.run(),
			).toThrow(AUDIT_ERROR);
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET prompt_text = 'x' WHERE id = 'p2'").run(),
			).toThrow(AUDIT_ERROR);
			// ...and the row is unchanged by the refused attempts.
			expect(
				(
					db.prepare("SELECT prompt_text AS t FROM ai_dispatch_audit WHERE id = 'p2'").get() as {
						t: string;
					}
				).t,
			).toBe("Run the tests");

			// A row inserted as refused can't be updated at all.
			insert("r1", "refused");
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET completed_at = 'x' WHERE id = 'r1'").run(),
			).toThrow(AUDIT_ERROR);
			expect(() =>
				db.prepare("UPDATE ai_dispatch_audit SET outcome = 'failed' WHERE id = 'r1'").run(),
			).toThrow(AUDIT_ERROR);

			// Nothing is ever deleted.
			expect(() => db.prepare("DELETE FROM ai_dispatch_audit WHERE id = 'p2'").run()).toThrow(
				AUDIT_ERROR,
			);
			expect(() => db.prepare("DELETE FROM ai_dispatch_audit").run()).toThrow(AUDIT_ERROR);
		} finally {
			db.close();
		}
	});
}

// ── run indexes and duplicate open runs ──────────────────────────────────────

itSqliteOnly(
	"the Drizzle install has the open-run unique index and the two run indexes",
	async () => {
		const db = await drizzleBornDb();
		try {
			expect(sqliteIndexNames(db, "ai_watcher_runs")).toEqual(
				expect.arrayContaining([
					"idx_ai_watcher_runs_open_per_session",
					"idx_ai_watcher_runs_status_lease",
					"idx_ai_watcher_runs_session_created",
				]),
			);
			insertSession(db, "dup-open");
			insertRun(db, "dup-open", "queued");
			// Named member: a second open run for the same session violates the index.
			expect(() => insertRun(db, "dup-open", "running")).toThrow(/UNIQUE/i);
			// A finished run does not.
			insertRun(db, "dup-open", "succeeded");
		} finally {
			db.close();
		}
	},
);

itSqliteOnly(
	"migration 0012 resolves duplicate open runs: the higher rowid stays open",
	async () => {
		// A copy of the migrations folder that stops before 0012.
		const folder = join(TMP_DIR, `before-${crypto.randomUUID()}`);
		cpSync(join(MIGRATIONS_ROOT, "sqlite"), folder, { recursive: true });
		const journalPath = join(folder, "meta", "_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			entries: Array<{ tag: string }>;
		};
		expect(journal.entries.at(-1)?.tag).toEndWith("_watcher_modes");
		journal.entries = journal.entries.slice(0, -1);
		writeFileSync(journalPath, JSON.stringify(journal));

		const path = tmpDbPath();
		const before = await drizzleBornDb(folder, path);
		insertSession(before, "dupes");
		insertSession(before, "single");
		const older = insertRun(before, "dupes", "queued");
		const newer = insertRun(before, "dupes", "running");
		const lone = insertRun(before, "single", "queued");
		before.close();

		const after = await drizzleBornDb(join(MIGRATIONS_ROOT, "sqlite"), path);
		try {
			expect(openRuns(after, "dupes").map((r) => r.id)).toEqual([newer]);
			const cancelled = after
				.prepare(
					"SELECT status, last_error_sub_type AS sub, completed_at FROM ai_watcher_runs WHERE id = ?",
				)
				.get(older) as { status: string; sub: string; completed_at: string | null };
			expect(cancelled.status).toBe("cancelled");
			expect(cancelled.sub).toBe("duplicate_open_run");
			expect(cancelled.completed_at).not.toBeNull();
			expect(openRuns(after, "single").map((r) => r.id)).toEqual([lone]);
			expect(sqliteIndexNames(after, "ai_watcher_runs")).toContain(
				"idx_ai_watcher_runs_open_per_session",
			);
		} finally {
			after.close();
		}
	},
);

itSqliteOnly(
	"H4: a Drizzle-born DB with duplicate open runs still boots on the legacy path",
	async () => {
		const path = tmpDbPath();
		const born = await drizzleBornDb(join(MIGRATIONS_ROOT, "sqlite"), path);
		born.exec("DROP INDEX idx_ai_watcher_runs_open_per_session");
		insertSession(born, "h4");
		insertRun(born, "h4", "queued");
		const kept = insertRun(born, "h4", "claimed");
		expect(openRuns(born, "h4")).toHaveLength(2);
		born.close();

		const db = new Database(path);
		db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		try {
			// AGENTPULSE_LEGACY_INIT is unset: the existing `sessions` table routes to legacy init.
			await initializeDatabase(db);
			expect(openRuns(db, "h4").map((r) => r.id)).toEqual([kept]);
			expect(sqliteIndexNames(db, "ai_watcher_runs")).toContain(
				"idx_ai_watcher_runs_open_per_session",
			);
		} finally {
			db.close();
		}
	},
);

itSqliteOnly(
	"DEDUPE_OPEN_RUNS_SQL is one statement and is copied verbatim into the 0012 file",
	() => {
		expect(DEDUPE_OPEN_RUNS_SQL.trim().endsWith(";")).toBe(false);
		expect(DEDUPE_OPEN_RUNS_SQL.match(/UPDATE /g)).toHaveLength(1);
		const text = readFileSync(
			join(
				MIGRATIONS_ROOT,
				"sqlite",
				`${(JSON.parse(readFileSync(join(MIGRATIONS_ROOT, "sqlite", "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries.at(-1)?.tag}.sql`,
			),
			"utf8",
		);
		expect(text.startsWith(`${DEDUPE_OPEN_RUNS_SQL};`)).toBe(true);
		for (const trigger of AI_DISPATCH_AUDIT_TRIGGERS_SQLITE) {
			expect(text, "trigger text copied verbatim").toContain(trigger);
		}
	},
);

// ── the process-wide database, either backend ────────────────────────────────

test("the process database has every new column and both new tables", async () => {
	const cols = await rows<{ table_name: string; column_name: string }>(
		config.dialect === "postgres"
			? sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('watcher_configs','watcher_proposals','ai_hitl_requests','ai_watcher_reports','ai_dispatch_audit')`
			: sql`SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('watcher_configs','watcher_proposals','ai_hitl_requests','ai_watcher_reports','ai_dispatch_audit')`,
	);
	const byTable = new Map<string, Set<string>>();
	for (const c of cols) {
		const set = byTable.get(c.table_name) ?? new Set<string>();
		set.add(c.column_name);
		byTable.set(c.table_name, set);
	}
	for (const column of NEW_CONFIG_COLUMNS) expect(byTable.get("watcher_configs")).toContain(column);
	for (const column of NEW_PROPOSAL_COLUMNS) {
		expect(byTable.get("watcher_proposals")).toContain(column);
	}
	for (const column of NEW_HITL_COLUMNS) expect(byTable.get("ai_hitl_requests")).toContain(column);
	expect(byTable.get("ai_watcher_reports")?.size).toBe(
		getSqliteTableConfig(aiWatcherReportsSqlite).columns.length,
	);
	expect(byTable.get("ai_dispatch_audit")?.size).toBe(
		getSqliteTableConfig(aiDispatchAuditSqlite).columns.length,
	);
});

test("the process database enforces one open run per session", async () => {
	const sessionId = `idx-${crypto.randomUUID()}`;
	await run(sql`INSERT INTO sessions (id, session_id, agent_type)
		VALUES (${crypto.randomUUID()}, ${sessionId}, 'claude_code')`);
	try {
		await run(sql`INSERT INTO ai_watcher_runs (id, session_id, trigger_kind, status, dedupe_key)
			VALUES (${crypto.randomUUID()}, ${sessionId}, 'manual', 'queued', ${`${sessionId}:a`})`);
		const failure = await failureOf(() =>
			run(sql`INSERT INTO ai_watcher_runs (id, session_id, trigger_kind, status, dedupe_key)
				VALUES (${crypto.randomUUID()}, ${sessionId}, 'manual', 'running', ${`${sessionId}:b`})`),
		);
		expect(failure, "the second open run is refused").not.toBeNull();
	} finally {
		await run(sql`DELETE FROM sessions WHERE session_id = ${sessionId}`);
	}
});

describePostgresOnly("ai_dispatch_audit on Postgres is append-only", () => {
	async function seed(id: string, outcome = "pending"): Promise<void> {
		await run(sql`INSERT INTO ai_dispatch_audit (id, session_id, actor_kind, outcome, prompt_text, config_snapshot)
			VALUES (${id}, 'pg-audit', 'user', ${outcome}, 'Run the tests', ${JSON.stringify({ policy: "ask_always" })}::json)`);
	}

	test("S3: TRUNCATE is refused too, and the rows survive it", async () => {
		const id = `pg-${crypto.randomUUID()}`;
		await seed(id);
		expect(await failureOf(() => run(sql`TRUNCATE ai_dispatch_audit`))).toContain(AUDIT_ERROR);
		expect(await rows(sql`SELECT id FROM ai_dispatch_audit WHERE id = ${id}`)).toHaveLength(1);
	});

	test("only the permitted transitions and columns change; nothing is deleted", async () => {
		const id = `pg-${crypto.randomUUID()}`;
		await seed(id);
		await run(
			sql`UPDATE ai_dispatch_audit SET outcome = 'sent', completed_at = 'now' WHERE id = ${id}`,
		);
		expect(
			await failureOf(() =>
				run(sql`UPDATE ai_dispatch_audit SET outcome = 'refused' WHERE id = ${id}`),
			),
		).toContain(AUDIT_ERROR);
		expect(
			await failureOf(() =>
				run(sql`UPDATE ai_dispatch_audit SET outcome = 'failed' WHERE id = ${id}`),
			),
		).toContain(AUDIT_ERROR);
		await run(
			sql`UPDATE ai_dispatch_audit SET outcome = 'failed', refusal_code = 'expired_unclaimed' WHERE id = ${id}`,
		);

		const other = `pg-${crypto.randomUUID()}`;
		await seed(other);
		// Named member: the prompt text is immutable.
		expect(
			await failureOf(() =>
				run(
					sql`UPDATE ai_dispatch_audit SET outcome = 'sent', prompt_text = 'else' WHERE id = ${other}`,
				),
			),
		).toContain(AUDIT_ERROR);
		expect(
			await failureOf(() =>
				run(
					sql`UPDATE ai_dispatch_audit SET config_snapshot = '{"policy":"auto"}'::json WHERE id = ${other}`,
				),
			),
		).toContain(AUDIT_ERROR);

		const refused = `pg-${crypto.randomUUID()}`;
		await seed(refused, "refused");
		expect(
			await failureOf(() =>
				run(sql`UPDATE ai_dispatch_audit SET completed_at = 'x' WHERE id = ${refused}`),
			),
		).toContain(AUDIT_ERROR);
		expect(
			await failureOf(() => run(sql`DELETE FROM ai_dispatch_audit WHERE id = ${other}`)),
		).toContain(AUDIT_ERROR);
		const [still] = await rows<{ prompt_text: string }>(
			sql`SELECT prompt_text FROM ai_dispatch_audit WHERE id = ${other}`,
		);
		expect(still?.prompt_text).toBe("Run the tests");
	});

	test("the Postgres migration installs the guard idempotently", () => {
		const text = migrationFile("postgres");
		expect(text).toContain("CREATE OR REPLACE FUNCTION ai_dispatch_audit_guard()");
		expect(text).toContain("DROP TRIGGER IF EXISTS trg_ai_dispatch_audit_update");
		expect(text).toContain("DROP TRIGGER IF EXISTS trg_ai_dispatch_audit_delete");
		expect(text).toContain('ADD COLUMN IF NOT EXISTS "notify_enabled"');
	});
});
