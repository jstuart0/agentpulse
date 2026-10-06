/**
 * AGEN-69 phase 1: the `ai_session_summaries` table (TC-1.1 to TC-1.15).
 *
 * Real databases, nothing stubbed. The table has no code to stub, so every test
 * reads the SQL files or queries the catalog INSIDE its body (never at module
 * top level): before the table exists this file fails as assertions, not as a
 * load error. The ids TC-1.3 (Postgres table and FK counts), TC-1.9 (the real
 * DELETE and archive routes) and the child-table list half of TC-1.15 live in
 * migrations.test.ts, routes/sessions-delete.test.ts and client.test.ts.
 *
 * Fixtures follow migrations.test.ts: a minimal pre-existing `sessions` table
 * routes a handle through the legacy init path; the Drizzle migrator on a
 * scratch file is the Drizzle-born install.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type SQL, eq, sql } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import "../services/ai/__test_db.js";
import { ANONYMOUS_ACTOR } from "../auth/actor.js";
import { TEST_BACKEND, describePostgresOnly, itSqliteOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("./client.js");
const { executeRows } = await import("./sql-helpers.js");
const { aiSessionSummaries, controlActions, projects, sessions, supervisors } = await import(
	"./schema/index.js"
);
const { aiSessionSummariesPg, aiSessionSummariesSqlite } = await import(
	"./schema/ai/ai-session-summaries.js"
);
const { claimNextControlAction, queueCleanupWorkArea, updateControlAction } = await import(
	"../services/control-actions.js"
);
const { createActionRequest, resolveActionRequest } = await import(
	"../services/ai/action-requests-service.js"
);

const TABLE = "ai_session_summaries";
const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-summary-table-"));
afterAll(() => {
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});
beforeAll(async () => {
	await initializeDatabase();
});

const MIGRATIONS_ROOT = resolve(import.meta.dir, "../../../drizzle");

/** The Data table of the plan, in order: name, SQLite type, notnull, default. */
const EXPECTED_COLUMNS: ReadonlyArray<{
	name: string;
	type: string;
	notnull: 0 | 1;
	dflt: string | null;
}> = [
	{ name: "session_id", type: "TEXT", notnull: 1, dflt: null },
	{ name: "schema_version", type: "INTEGER", notnull: 1, dflt: "1" },
	{ name: "generated_at", type: "TEXT", notnull: 0, dflt: null },
	{ name: "attempt_status", type: "TEXT", notnull: 1, dflt: "'idle'" },
	{ name: "through_event_id", type: "INTEGER", notnull: 0, dflt: null },
	{ name: "attempt_started_at", type: "TEXT", notnull: 0, dflt: null },
	{ name: "attempt_token", type: "TEXT", notnull: 0, dflt: null },
	{ name: "attempt_error_code", type: "TEXT", notnull: 0, dflt: null },
	{ name: "summary", type: "TEXT", notnull: 0, dflt: null },
	{ name: "provenance", type: "TEXT", notnull: 0, dflt: null },
];
const EXPECTED_ORDER = EXPECTED_COLUMNS.map((c) => c.name);

// ── helpers ───────────────────────────────────────────────────────────────────

type ColumnInfo = {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
};
type FkInfo = {
	table: string;
	from: string;
	to: string;
	on_update: string;
	on_delete: string;
	match: string;
};

function tmpDbPath(): string {
	return join(TMP_DIR, `${crypto.randomUUID()}.db`);
}

function tableInfo(db: Database, table = TABLE): ColumnInfo[] {
	return (db.prepare(`PRAGMA table_info('${table}')`).all() as ColumnInfo[]).map((c) => ({
		...c,
		type: c.type.toUpperCase(),
	}));
}

function fkList(db: Database, table = TABLE): FkInfo[] {
	return (db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as FkInfo[]).map((f) => ({
		table: f.table,
		from: f.from,
		to: f.to,
		on_update: f.on_update,
		on_delete: f.on_delete,
		match: f.match,
	}));
}

function tableExists(db: Database, table = TABLE): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null
	);
}

function count(db: Database, table: string, where = "1 = 1", ...args: string[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }
	).n;
}

/**
 * A pre-existing install: only the `sessions` table as the original legacy init
 * created it (UNIQUE session_id, and the columns the search triggers read), so
 * initializeDatabase(handle) takes the legacy path and builds everything else.
 */
function legacyFixture(path = ":memory:"): Database {
	const db = new Database(path);
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

function sqliteMigrationsDir(): string {
	return join(MIGRATIONS_ROOT, "sqlite");
}

async function drizzleBornDb(
	folder = sqliteMigrationsDir(),
	path = tmpDbPath(),
): Promise<Database> {
	const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
	const { drizzle } = await import("drizzle-orm/bun-sqlite");
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	migrate(drizzle(db), { migrationsFolder: folder });
	return db;
}

function insertSession(db: Database, sessionId: string): void {
	db.prepare("INSERT INTO sessions (id, session_id, agent_type) VALUES (?, ?, 'claude_code')").run(
		crypto.randomUUID(),
		sessionId,
	);
}

/**
 * The summaries migration, found by its journal tag rather than a number: this
 * branch may be renumbered at merge when another branch takes the same slot.
 */
function migrationSql(dialect: "sqlite" | "postgres"): string {
	const dir = join(MIGRATIONS_ROOT, dialect);
	const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const entries = journal.entries.filter((e) => e.tag.endsWith("_ai_session_summaries"));
	expect(entries, `the ${dialect} journal has exactly one ai_session_summaries entry`).toHaveLength(
		1,
	);
	return readFileSync(join(dir, `${entries[0]?.tag}.sql`), "utf8");
}

function statements(text: string): string[] {
	return text
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Dialect-neutral raw write/read against the process-wide test database. */
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
async function summaryCount(sessionId: string): Promise<number> {
	const r = await rows<{ n: number | string }>(
		sql`SELECT COUNT(*) AS n FROM ai_session_summaries WHERE session_id = ${sessionId}`,
	);
	return Number(r[0]?.n);
}
async function seedSessionWithSummary(sessionId: string): Promise<void> {
	await run(sql`INSERT INTO sessions (id, session_id, agent_type)
		VALUES (${crypto.randomUUID()}, ${sessionId}, 'claude_code')`);
	await run(sql`INSERT INTO ai_session_summaries (session_id) VALUES (${sessionId})`);
	expect(await summaryCount(sessionId), "positive control: the summary row exists").toBe(1);
}

// ── TC-1.0: the selector the Postgres-only blocks skip on ────────────────────

test("TC-1.0 backend selector agrees with config.dialect", () => {
	// AGENTPULSE_TEST_BACKEND picks which blocks run; DATABASE_URL picks the
	// database. Set to different backends, the dialect-only blocks skip silently
	// while every other test runs against the other database.
	expect(TEST_BACKEND).toBe(config.dialect);
});

// ── TC-1.1 / TC-1.2: columns, in the Data table's order ──────────────────────

test("TC-1.1 the TypeScript tables declare the ten columns in the Data table's order, with their nullability and defaults", () => {
	const wantNotNull = new Set(["session_id", "schema_version", "attempt_status"]);
	const sqliteCols = getSqliteTableConfig(aiSessionSummariesSqlite).columns;
	const pgCols = getPgTableConfig(aiSessionSummariesPg).columns;
	for (const cols of [sqliteCols, pgCols]) {
		expect(cols.map((c) => c.name)).toEqual(EXPECTED_ORDER);
		for (const c of cols) {
			expect(c.notNull, `${c.name} notNull`).toBe(wantNotNull.has(c.name));
		}
		expect(cols.filter((c) => c.primary).map((c) => c.name)).toEqual(["session_id"]);
		expect(cols.find((c) => c.name === "schema_version")?.default).toBe(1);
		expect(cols.find((c) => c.name === "attempt_status")?.default).toBe("idle");
	}
});

test("TC-1.1 a Drizzle round trip through the runtime table: insert a session id alone, read back the defaults", async () => {
	const sessionId = `sum-rt-${crypto.randomUUID()}`;
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" });
	try {
		await getDb().insert(aiSessionSummaries).values({ sessionId });
		const [row] = await getDb()
			.select()
			.from(aiSessionSummaries)
			.where(eq(aiSessionSummaries.sessionId, sessionId));
		expect(row).toEqual({
			sessionId,
			schemaVersion: 1,
			generatedAt: null,
			attemptStatus: "idle",
			throughEventId: null,
			attemptStartedAt: null,
			attemptToken: null,
			attemptErrorCode: null,
			summary: null,
			provenance: null,
		});
	} finally {
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
	}
});

itSqliteOnly(
	"TC-1.1 fresh Drizzle install: ten columns in the Data table's order, with the plan's types, keys and defaults",
	async () => {
		const db = await drizzleBornDb();
		try {
			const cols = tableInfo(db);
			expect(cols.map((c) => c.name)).toEqual(EXPECTED_ORDER);
			expect(cols.map((c) => c.cid)).toEqual(EXPECTED_ORDER.map((_, i) => i));
			for (const want of EXPECTED_COLUMNS) {
				const got = cols.find((c) => c.name === want.name);
				expect(got?.type, `${want.name} type`).toBe(want.type);
				expect(got?.dflt_value, `${want.name} default`).toBe(want.dflt);
				expect(got?.notnull, `${want.name} notnull`).toBe(want.notnull);
			}
			expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["session_id"]);
			expect(cols.map((c) => c.name)).not.toContain("attempt_error_message");
		} finally {
			db.close();
		}
	},
);

describePostgresOnly("ai_session_summaries on Postgres", () => {
	test("TC-1.2 information_schema: ten columns in order; summary and provenance are json; schema_version is integer NOT NULL DEFAULT 1", async () => {
		const cols = await rows<{
			column_name: string;
			data_type: string;
			is_nullable: string;
			column_default: string | null;
		}>(sql`SELECT column_name, data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = ${TABLE}
			ORDER BY ordinal_position`);
		expect(cols.map((c) => c.column_name)).toEqual(EXPECTED_ORDER);
		const by = (n: string) => cols.find((c) => c.column_name === n);
		const wantType: Record<string, string> = {
			session_id: "text",
			schema_version: "integer",
			generated_at: "text",
			attempt_status: "text",
			through_event_id: "integer",
			attempt_started_at: "text",
			attempt_token: "text",
			attempt_error_code: "text",
			summary: "json",
			provenance: "json",
		};
		for (const [name, type] of Object.entries(wantType)) {
			expect(by(name)?.data_type, `${name} data_type`).toBe(type);
		}
		expect(by("schema_version")?.is_nullable).toBe("NO");
		expect(by("schema_version")?.column_default).toBe("1");
		expect(by("attempt_status")?.is_nullable).toBe("NO");
		expect(by("attempt_status")?.column_default).toContain("'idle'");
		expect(by("session_id")?.is_nullable).toBe("NO");
		for (const nullable of [
			"generated_at",
			"through_event_id",
			"attempt_started_at",
			"attempt_token",
			"attempt_error_code",
			"summary",
			"provenance",
		]) {
			expect(by(nullable)?.is_nullable, `${nullable} nullable`).toBe("YES");
		}
		const pk = await rows<{ column_name: string }>(sql`SELECT kcu.column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
				ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
			WHERE tc.table_schema = 'public' AND tc.table_name = ${TABLE}
			  AND tc.constraint_type = 'PRIMARY KEY'
			ORDER BY kcu.ordinal_position`);
		expect(pk.map((r) => r.column_name)).toEqual(["session_id"]);
		expect(cols.map((c) => c.column_name)).not.toContain("attempt_error_message");
	});

	test("TC-1.8 Postgres: deleting a session deletes its summary row", async () => {
		const id = `sum-pg-${crypto.randomUUID()}`;
		await seedSessionWithSummary(id);
		await run(sql`DELETE FROM sessions WHERE session_id = ${id}`);
		expect(await summaryCount(id)).toBe(0);
	});
});

// ── TC-1.4 / TC-1.5: the legacy path and the three definitions ───────────────

itSqliteOnly(
	"TC-1.4 an existing install without the table gains it through the legacy boot",
	async () => {
		const db = legacyFixture();
		try {
			expect(tableExists(db), "fixture starts without the table").toBe(false);
			await initializeDatabase(db);
			expect(tableExists(db)).toBe(true);
			expect(
				db.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
			).toBeNull();
		} finally {
			db.close();
		}
	},
);

itSqliteOnly(
	"TC-1.5 legacy-created and Drizzle-created tables are identical: table_info (with cid order) and foreign_key_list",
	async () => {
		const legacy = await legacyBooted();
		const born = await drizzleBornDb();
		try {
			const legacyCols = tableInfo(legacy);
			expect(legacyCols.length).toBe(EXPECTED_COLUMNS.length);
			expect(legacyCols).toEqual(tableInfo(born));
			expect(legacyCols.map((c) => c.name)).toEqual(EXPECTED_ORDER);
			const wantFk = [
				{
					table: "sessions",
					from: "session_id",
					to: "session_id",
					on_update: "NO ACTION",
					on_delete: "CASCADE",
					match: "NONE",
				},
			];
			expect(fkList(legacy)).toEqual(wantFk);
			expect(fkList(born)).toEqual(wantFk);
		} finally {
			legacy.close();
			born.close();
		}
	},
);

// ── TC-1.6 / TC-1.7: the cascade, fresh and legacy ───────────────────────────

function expectCascadeOn(db: Database): void {
	expect(
		(db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
		"foreign keys are on for this handle",
	).toBe(1);
	const sid = `casc-${crypto.randomUUID()}`;
	insertSession(db, sid);
	db.prepare(`INSERT INTO ${TABLE} (session_id) VALUES (?)`).run(sid);
	expect(count(db, TABLE, "session_id = ?", sid), "positive control").toBe(1);
	db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sid);
	expect(count(db, TABLE, "session_id = ?", sid)).toBe(0);
}

itSqliteOnly("TC-1.6 fresh SQLite: deleting a session deletes its summary row", async () => {
	const db = await drizzleBornDb();
	try {
		expectCascadeOn(db);
	} finally {
		db.close();
	}
});

itSqliteOnly(
	"TC-1.7 legacy SQLite: the inline cascade works on a legacy-init database (the plan's contingency trigger)",
	async () => {
		const db = await legacyBooted();
		try {
			expectCascadeOn(db);
		} finally {
			db.close();
		}
	},
);

// ── TC-1.10: every other delete site ─────────────────────────────────────────

test("TC-1.10a control-actions cleanup_workarea (finalizeCleanupWorkArea) removes the summary row", async () => {
	const now = new Date().toISOString();
	const supervisorId = `sup-${crypto.randomUUID()}`;
	const projectId = crypto.randomUUID();
	const sessionId = `sum-ctl-${crypto.randomUUID()}`;
	await getDb()
		.insert(supervisors)
		.values({
			id: supervisorId,
			hostName: "test-host",
			platform: "darwin",
			arch: "arm64",
			version: "0.1.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_cleanup_workarea"],
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		});
	await getDb()
		.insert(projects)
		.values({
			id: projectId,
			name: `proj-${projectId.slice(0, 8)}`,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			tags: ["scratch"],
			isFavorite: false,
			createdAt: now,
			updatedAt: now,
		});
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code", projectId });
	await run(sql`INSERT INTO ai_session_summaries (session_id) VALUES (${sessionId})`);
	expect(await summaryCount(sessionId), "positive control").toBe(1);

	const queued = await queueCleanupWorkArea(
		{
			projectId,
			cwd: `/tmp/scratch-${projectId.slice(0, 8)}`,
			targetSupervisorId: supervisorId,
		},
		{ userId: null, label: "user" },
	);
	const claimed = await claimNextControlAction(supervisorId);
	expect(claimed?.id).toBe(queued.id);
	try {
		const updated = await updateControlAction({
			actionId: queued.id,
			supervisorId,
			status: "succeeded",
		});
		expect(updated?.status).toBe("succeeded");

		const left = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(left, "the session itself is gone").toHaveLength(0);
		expect(await summaryCount(sessionId)).toBe(0);
	} finally {
		await getDb().delete(controlActions).where(eq(controlActions.id, queued.id));
		await getDb().delete(supervisors).where(eq(supervisors.id, supervisorId));
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
	}
});

test("TC-1.10b an approved AI session_delete action request removes the summary row", async () => {
	const sessionId = `sum-ai-${crypto.randomUUID()}`;
	await seedSessionWithSummary(sessionId);
	try {
		const req = await createActionRequest({
			kind: "session_delete",
			question: "Delete session?",
			payload: { sessionId, sessionDisplayName: sessionId },
			origin: "web",
		});
		const result = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test-user",
			actor: ANONYMOUS_ACTOR,
		});
		expect(result.ok).toBe(true);
		expect(await summaryCount(sessionId)).toBe(0);
	} finally {
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
	}
});

test("TC-1.10c an approved AI bulk delete (deleteOne) removes the summary row", async () => {
	const sessionId = `sum-bulk-${crypto.randomUUID()}`;
	await seedSessionWithSummary(sessionId);
	// deleteOne refuses a session that is still running; finish it first.
	await run(sql`UPDATE sessions SET ended_at = ${new Date().toISOString()}, status = 'completed'
		WHERE session_id = ${sessionId}`);
	try {
		const req = await createActionRequest({
			kind: "bulk_session_action",
			question: "Delete sessions?",
			payload: {
				action: "delete",
				sessionIds: [sessionId],
				sessionNames: ["bulk"],
				exclusions: [],
			},
			origin: "web",
		});
		const result = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test-user",
			actor: ANONYMOUS_ACTOR,
		});
		expect(result.ok).toBe(true);
		const left = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(left, "the session itself is gone").toHaveLength(0);
		expect(await summaryCount(sessionId)).toBe(0);
	} finally {
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
	}
});

// ── TC-1.11: legacy boot is idempotent ───────────────────────────────────────

itSqliteOnly(
	"TC-1.11 booting the legacy path twice does not throw and keeps an existing row",
	async () => {
		const db = await legacyBooted();
		try {
			const sid = `idem-${crypto.randomUUID()}`;
			insertSession(db, sid);
			db.prepare(
				`INSERT INTO ${TABLE} (session_id, attempt_status, attempt_token) VALUES (?, 'generating', 'tok-1')`,
			).run(sid);
			await expect(initializeDatabase(db)).resolves.toBeUndefined();
			const row = db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = ?`).get(sid) as Record<
				string,
				unknown
			> | null;
			expect(row?.attempt_status).toBe("generating");
			expect(row?.attempt_token).toBe("tok-1");
			expect(tableInfo(db).map((c) => c.name)).toEqual(EXPECTED_ORDER);
		} finally {
			db.close();
		}
	},
);

// ── TC-1.12: the migration SQL is idempotent ─────────────────────────────────

/** Scratch schemas and databases a crashed earlier run left behind. */
async function sweepStaleScratch(postgres: typeof import("postgres")): Promise<void> {
	const admin = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });
	try {
		const schemas = (await admin.unsafe(
			"SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ap\\_sum\\_%'",
		)) as unknown as Array<{ nspname: string }>;
		for (const { nspname } of schemas) {
			await admin.unsafe(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
		}
		const dbs = (await admin.unsafe(
			"SELECT datname FROM pg_database WHERE datname LIKE 'ap\\_sum\\_upgrade\\_%'",
		)) as unknown as Array<{ datname: string }>;
		for (const { datname } of dbs) {
			await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
		}
	} finally {
		await admin.end();
	}
}

test("TC-1.12 the migration SQL runs twice without error, and beside a pre-created table", async () => {
	if (config.dialect === "sqlite") {
		const text = migrationSql("sqlite");
		expect(text.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1);
		expect(text).not.toMatch(/DROP|ALTER/i);
		const db = legacyFixture();
		try {
			for (const s of statements(text)) db.exec(s);
			for (const s of statements(text)) db.exec(s);
			expect(tableInfo(db).map((c) => c.name)).toEqual(EXPECTED_ORDER);
		} finally {
			db.close();
		}
		// A table the legacy boot already made (an install that later runs the
		// Drizzle migration) coexists with it.
		const precreated = await legacyBooted();
		try {
			expect(tableExists(precreated), "the legacy boot made the table").toBe(true);
			for (const s of statements(text)) precreated.exec(s);
			expect(tableInfo(precreated).map((c) => c.name)).toEqual(EXPECTED_ORDER);
		} finally {
			precreated.close();
		}
		return;
	}

	const text = migrationSql("postgres");
	expect(text.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1);
	expect(text).not.toMatch(/DROP|ALTER/i);
	const { default: postgres } = await import("postgres");
	await sweepStaleScratch(postgres);
	const schema = `ap_sum_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const client = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });
	try {
		await client.unsafe(`CREATE SCHEMA "${schema}"`);
		await client.unsafe(`SET search_path TO "${schema}"`);
		await client.unsafe("CREATE TABLE sessions (session_id text PRIMARY KEY)");
		for (const s of statements(text)) await client.unsafe(s);
		for (const s of statements(text)) await client.unsafe(s);
		const cols = (await client.unsafe(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = '${schema}' AND table_name = '${TABLE}' ORDER BY ordinal_position`,
		)) as unknown as Array<{ column_name: string }>;
		expect(cols.map((c) => c.column_name)).toEqual(EXPECTED_ORDER);
	} finally {
		await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await client.end();
	}
});

// ── TC-1.13: a database one migration behind keeps its rows ──────────────────

/** A copy of a migrations folder with the summaries migration (and anything after) removed. */
function priorMigrationsDir(dialect: "sqlite" | "postgres"): string {
	const full = join(MIGRATIONS_ROOT, dialect);
	const prior = mkdtempSync(join(TMP_DIR, `prior-${dialect}-`));
	cpSync(full, prior, { recursive: true });
	const journalPath = join(prior, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const at = journal.entries.findIndex((e) => e.tag.includes("ai_session_summaries"));
	expect(at, `the ${dialect} journal has an ai_session_summaries entry`).toBeGreaterThan(-1);
	for (const dropped of journal.entries.slice(at)) unlinkSync(join(prior, `${dropped.tag}.sql`));
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
	return prior;
}

test("TC-1.13 a database migrated to just before the table keeps every row and gains the table", async () => {
	if (config.dialect === "sqlite") {
		const prior = priorMigrationsDir("sqlite");
		const path = tmpDbPath();
		const before = await drizzleBornDb(prior, path);
		try {
			expect(tableExists(before), "the prior schema has no summaries table").toBe(false);
			insertSession(before, "up-1");
			insertSession(before, "up-2");
			before
				.prepare(
					"INSERT INTO events (session_id, event_type, raw_payload) VALUES (?, 'UserPromptSubmit', '{}')",
				)
				.run("up-1");
		} finally {
			before.close();
		}
		const after = await drizzleBornDb(sqliteMigrationsDir(), path);
		try {
			expect(count(after, "sessions")).toBe(2);
			expect(count(after, "events")).toBe(1);
			expect(tableExists(after)).toBe(true);
			expect(count(after, TABLE)).toBe(0);
		} finally {
			after.close();
		}
		return;
	}

	const { default: postgres } = await import("postgres");
	const { migrate } = await import("drizzle-orm/postgres-js/migrator");
	const { drizzle: drizzlePg } = await import("drizzle-orm/postgres-js");
	const prior = priorMigrationsDir("postgres");
	await sweepStaleScratch(postgres);
	const dbName = `ap_sum_upgrade_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const scratchUrl = new URL(config.databaseUrl);
	scratchUrl.pathname = `/${dbName}`;
	const admin = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });
	try {
		await admin.unsafe(`CREATE DATABASE "${dbName}"`);
	} finally {
		await admin.end();
	}
	try {
		const a = postgres(scratchUrl.toString(), { max: 1, idle_timeout: 5 });
		try {
			await migrate(drizzlePg(a), { migrationsFolder: prior });
			const gone = await a`SELECT 1 FROM information_schema.tables WHERE table_name = ${TABLE}`;
			expect(gone.length, "the prior schema has no summaries table").toBe(0);
			await a`INSERT INTO sessions (id, session_id, agent_type) VALUES ('r1', 'up-1', 'claude_code'), ('r2', 'up-2', 'claude_code')`;
			await a`INSERT INTO events (session_id, event_type, raw_payload) VALUES ('up-1', 'UserPromptSubmit', '{}')`;
		} finally {
			await a.end();
		}
		const b = postgres(scratchUrl.toString(), { max: 1, idle_timeout: 5 });
		try {
			await migrate(drizzlePg(b), { migrationsFolder: join(MIGRATIONS_ROOT, "postgres") });
			const s = (await b`SELECT COUNT(*)::int AS n FROM sessions`) as Array<{ n: number }>;
			const e = (await b`SELECT COUNT(*)::int AS n FROM events`) as Array<{ n: number }>;
			const t = (await b`SELECT COUNT(*)::int AS n FROM ai_session_summaries`) as Array<{
				n: number;
			}>;
			expect(s[0]?.n).toBe(2);
			expect(e[0]?.n).toBe(1);
			expect(t[0]?.n).toBe(0);
		} finally {
			await b.end();
		}
	} finally {
		const admin2 = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });
		try {
			await admin2.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
		} finally {
			await admin2.end();
		}
	}
});

// ── TC-1.14: the foreign key is enforced ─────────────────────────────────────

test("TC-1.14 a summary row for an unknown session is rejected", async () => {
	const unknown = `no-such-${crypto.randomUUID()}`;
	const real = `sum-fk-${crypto.randomUUID()}`;
	await run(sql`INSERT INTO sessions (id, session_id, agent_type)
		VALUES (${crypto.randomUUID()}, ${real}, 'claude_code')`);
	try {
		await run(sql`INSERT INTO ai_session_summaries (session_id) VALUES (${real})`);
		expect(await summaryCount(real), "positive control: a real session is accepted").toBe(1);
		// Drizzle wraps the driver error; the constraint text is on the cause.
		const failure = await run(
			sql`INSERT INTO ai_session_summaries (session_id) VALUES (${unknown})`,
		).then(
			() => null,
			(e: unknown) => e as Error & { cause?: Error },
		);
		expect(failure, "the insert was rejected").not.toBeNull();
		expect(`${failure?.message} ${failure?.cause?.message ?? ""}`).toMatch(/foreign key|violates/i);
		expect(await summaryCount(unknown)).toBe(0);
	} finally {
		await run(sql`DELETE FROM sessions WHERE session_id = ${real}`);
	}
});

// ── TC-1.15: the FK-convention departure ─────────────────────────────────────

itSqliteOnly(
	"TC-1.15 the legacy boot's rebuildSessionChildFks leaves the table, its cascade FK and its rows alone",
	async () => {
		const db = await legacyBooted();
		const log = spyOn(console, "log");
		try {
			const sid = `keep-${crypto.randomUUID()}`;
			insertSession(db, sid);
			db.prepare(`INSERT INTO ${TABLE} (session_id, attempt_status) VALUES (?, 'failed')`).run(sid);
			const ddlBefore = (
				db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(TABLE) as { sql: string }
			).sql;

			// Re-arm the rebuild: put a child table back to the pre-cascade shape so
			// the next boot has real rebuild work to do beside our table.
			db.exec(`
				PRAGMA foreign_keys = OFF;
				DROP TABLE watcher_configs;
				CREATE TABLE watcher_configs (
					session_id TEXT PRIMARY KEY,
					enabled INTEGER NOT NULL DEFAULT 0,
					provider_id TEXT NOT NULL,
					policy TEXT NOT NULL DEFAULT 'ask_always',
					max_continuations INTEGER NOT NULL DEFAULT 10,
					continuations_used INTEGER NOT NULL DEFAULT 0,
					created_at TEXT NOT NULL DEFAULT (datetime('now')),
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				PRAGMA foreign_keys = ON;
			`);
			log.mockClear();
			await initializeDatabase(db);

			const lines = log.mock.calls.map((c) => String(c[0]));
			expect(
				lines.some((l) => l.includes("Rebuilding watcher_configs")),
				"positive control: the rebuild did run for the re-armed table",
			).toBe(true);
			expect(lines.some((l) => l.includes(`Rebuilding ${TABLE}`))).toBe(false);
			expect(
				fkList(db, "watcher_configs").map((f) => f.on_delete),
				"positive control: the rebuild restored watcher_configs' cascade FK",
			).toEqual(["CASCADE"]);
			expect(
				(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(TABLE) as { sql: string })
					.sql,
			).toBe(ddlBefore);
			expect(fkList(db)).toEqual([
				{
					table: "sessions",
					from: "session_id",
					to: "session_id",
					on_update: "NO ACTION",
					on_delete: "CASCADE",
					match: "NONE",
				},
			]);
			expect(count(db, TABLE, "session_id = ? AND attempt_status = 'failed'", sid)).toBe(1);
		} finally {
			log.mockRestore();
			db.close();
		}
	},
);
