// Phase 2 (AGEN-16): id-ordered event reads, the dedup_key column and its
// indexes, and the projected classifier / ask-qa loaders.
//
// SQLite plan tests use isolated handles, never the shared singleton: the
// shared test DB is hybrid (Drizzle path for the first file, legacy for the
// rest), which changes which index the planner picks.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const { drizzle } = await import("drizzle-orm/bun-sqlite");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { eq, sql } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("./client.js");
const { events, sessions } = await import("./schema/index.js");
const { executeRows } = await import("./sql-helpers.js");
const { intelligenceForSessions, loadRecentEventsBySession } = await import(
	"../services/ai/intelligence-service.js"
);
const { loadQaEvents } = await import("../services/ask/ask-qa-handler.js");
const { sessionsRouter } = await import("../routes/sessions.js");

const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-event-reads-"));
const SQLITE_MIGRATIONS = join(process.cwd(), "drizzle", "sqlite");
const Q_ID = "SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 500";
const Q_CREATED = "SELECT * FROM events WHERE session_id = ? ORDER BY created_at DESC LIMIT 500";
const SEARCH_BY_SESSION = /SEARCH events USING (COVERING )?INDEX \w+ \(session_id=\?\)/;

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── handles ──────────────────────────────────────────────────────────────────

function tmpDb(): Database {
	const db = new Database(join(TMP_DIR, `${crypto.randomUUID()}.db`));
	db.exec("PRAGMA foreign_keys = ON;");
	return db;
}

function freshHandle(): Database {
	const db = tmpDb();
	migrate(drizzle(db), { migrationsFolder: SQLITE_MIGRATIONS });
	return db;
}

async function legacyHandle(): Promise<Database> {
	const db = tmpDb();
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			display_name TEXT,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			cwd TEXT,
			current_task TEXT,
			notes TEXT DEFAULT '',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			total_tool_uses INTEGER NOT NULL DEFAULT 0,
			metadata TEXT DEFAULT '{}'
		);
	`);
	await initializeDatabase(db);
	return db;
}

async function hybridHandle(): Promise<Database> {
	const db = freshHandle();
	await initializeDatabase(db);
	return db;
}

function plan(db: Database, query: string): string {
	return (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("s") as Array<{ detail: string }>)
		.map((row) => row.detail)
		.join(" | ");
}

function indexNames(db: Database): string[] {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

function isUniqueIndex(db: Database, name: string): boolean {
	const rows = db.prepare("PRAGMA index_list(events)").all() as Array<{
		name: string;
		unique: number;
	}>;
	return rows.find((row) => row.name === name)?.unique === 1;
}

function eventColumns(db: Database): string[] {
	return (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(
		(row) => row.name,
	);
}

function assertDedupSchema(db: Database) {
	expect(indexNames(db)).toContain("idx_events_session_id_id");
	expect(indexNames(db)).toContain("uq_events_session_dedup_key");
	expect(isUniqueIndex(db, "uq_events_session_dedup_key")).toBe(true);
	expect(eventColumns(db)).toContain("dedup_key");
}

// ── shared-DB helpers (both backends) ────────────────────────────────────────

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, displayName: sessionId, agentType: "claude_code", status: "active" })
		.execute();
}

type SeedRow = { sessionId: string; content: string; rawPayload?: Record<string, unknown> };

async function seedEvents(rows: SeedRow[]) {
	for (let i = 0; i < rows.length; i += 200) {
		await getDb()
			.insert(events)
			.values(
				rows.slice(i, i + 200).map((row) => ({
					sessionId: row.sessionId,
					eventType: "PostToolUse",
					category: "tool_event" as const,
					source: "observed_hook" as const,
					content: row.content,
					isNoise: false,
					toolName: "Bash",
					toolInput: { command: "true" },
					rawPayload: row.rawPayload ?? {},
				})),
			)
			.execute();
	}
}

function keyedInsert(sessionId: string, dedupKey: string | null, content = "x") {
	return getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "PostToolUse",
			category: "tool_event",
			source: "observed_hook",
			content,
			isNoise: false,
			rawPayload: {},
			dedupKey,
		})
		.onConflictDoNothing()
		.returning();
}

// ── R1–R4 (SQLite plans and legacy DDL) ──────────────────────────────────────

describeSqliteOnly("event reads use the (session_id, id) index", () => {
	test("R1 ORDER BY id DESC is an index search on fresh, legacy and hybrid handles", async () => {
		for (const [label, db] of [
			["fresh", freshHandle()],
			["legacy", await legacyHandle()],
			["hybrid", await hybridHandle()],
		] as const) {
			const detail = plan(db, Q_ID);
			expect(detail, label).toMatch(SEARCH_BY_SESSION);
			expect(detail, label).not.toContain("SCAN events");
			expect(detail, label).not.toContain("USE TEMP B-TREE");
			db.close();
		}
	});

	test("R2 ORDER BY created_at DESC still sorts in a temp B-tree (R1 discriminates)", () => {
		const db = freshHandle();
		expect(plan(db, Q_CREATED)).toContain("USE TEMP B-TREE");
		db.close();
	});
});

describeSqliteOnly("dedup_key schema on every SQLite boot path", () => {
	test("R3 legacy init adds the column and both indexes, and re-running is safe", async () => {
		const legacy = await legacyHandle();
		assertDedupSchema(legacy);
		await initializeDatabase(legacy);
		assertDedupSchema(legacy);
		legacy.close();

		const fresh = freshHandle();
		assertDedupSchema(fresh);
		fresh.close();
	});

	test("R4 the legacy cascade rebuild keeps the column and indexes on a Drizzle DB", async () => {
		const db = freshHandle();
		await initializeDatabase(db);
		const fks = db.prepare("PRAGMA foreign_key_list(events)").all() as Array<{
			table: string;
			on_delete: string;
		}>;
		expect(fks.find((fk) => fk.table === "sessions")?.on_delete).toBe("CASCADE");
		assertDedupSchema(db);

		db.prepare("INSERT INTO sessions (id, session_id, agent_type) VALUES ('r4', 'r4', 'x')").run();
		const insert = db.prepare(
			"INSERT INTO events (session_id, event_type, raw_payload, dedup_key) VALUES ('r4', 'Stop', '{}', 't:k') ON CONFLICT DO NOTHING RETURNING id",
		);
		expect(insert.all()).toHaveLength(1);
		expect(insert.all()).toHaveLength(0);
		db.close();
	});
});

describe("generated migrations are hand-edited to IF NOT EXISTS (R3b)", () => {
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(dialect, () => {
			const dir = join(process.cwd(), "drizzle", dialect);
			// F92: select the migration by content (does it add dedup_key?), not
			// by its "0003_" number — the sibling branch also claims migration
			// index 0003, so whichever branch merges second renumbers this file
			// on rebase, and a number-based lookup would silently match nothing
			// (or the wrong file) after that.
			const files = readdirSync(dir).filter(
				(name) =>
					name.endsWith(".sql") && readFileSync(join(dir, name), "utf8").includes("dedup_key"),
			);
			expect(files).toHaveLength(1);
			const text = readFileSync(join(dir, files[0] as string), "utf8");
			const indexStatements = text.match(/CREATE (UNIQUE )?INDEX[^;]*/g) ?? [];
			expect(indexStatements.length).toBeGreaterThanOrEqual(2);
			for (const statement of indexStatements) {
				expect(statement).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS /);
			}
			expect(text).toContain("dedup_key");
			if (dialect === "postgres") expect(text).toMatch(/ADD COLUMN IF NOT EXISTS "dedup_key"/);
		});
	}
});

// ── R5 / R5b (both backends) ─────────────────────────────────────────────────

describe("UNIQUE (session_id, dedup_key) with ON CONFLICT DO NOTHING", () => {
	test("R5 conflicts are per session, NULL keys never conflict, first row in a statement wins", async () => {
		const a = newSessionId("r5a");
		const b = newSessionId("r5b");
		await mkSession(a);
		await mkSession(b);

		expect(await keyedInsert(a, "t:same")).toHaveLength(1);
		expect(await keyedInsert(a, "t:same")).toEqual([]);
		expect(await keyedInsert(b, "t:same")).toHaveLength(1);
		expect(await keyedInsert(a, null)).toHaveLength(1);
		expect(await keyedInsert(a, null)).toHaveLength(1);

		const both = await getDb()
			.insert(events)
			.values(
				["first", "second"].map((content) => ({
					sessionId: a,
					eventType: "PostToolUse",
					category: "tool_event" as const,
					source: "observed_hook" as const,
					content,
					isNoise: false,
					rawPayload: {},
					dedupKey: "t:in-statement",
				})),
			)
			.onConflictDoNothing()
			.returning();
		expect(both.map((row) => row.content)).toEqual(["first"]);

		const stored = await getDb().select().from(events).where(eq(events.sessionId, a));
		expect(stored).toHaveLength(4);
	});

	test("R5b DO NOTHING still rejects FK and NOT NULL violations", async () => {
		const sid = newSessionId("r5b");
		await mkSession(sid);
		// Wrapped in an async IIFE, not passed as a bare Drizzle query builder:
		// bun's expect(...).rejects doesn't drain Drizzle's lazy thenable the
		// same way `await` does, and silently sees it as resolved.
		await expect(
			(async () => keyedInsert(newSessionId("r5b-missing"), "t:fk"))(),
		).rejects.toThrow();
		await expect(
			(async () =>
				getDb()
					.insert(events)
					.values({
						sessionId: sid,
						eventType: null as unknown as string,
						source: "observed_hook",
						isNoise: false,
						rawPayload: {},
						dedupKey: "t:nn",
					})
					.onConflictDoNothing()
					.returning())(),
		).rejects.toThrow();
	});
});

// ── R6 (Postgres catalog) ────────────────────────────────────────────────────

describePostgresOnly("Postgres migration creates valid indexes (R6)", () => {
	test("both indexes exist, are valid and ready, and the unique one is unique", async () => {
		const rows = await executeRows<{
			name: string;
			indisvalid: boolean;
			indisready: boolean;
			indisunique: boolean;
		}>(
			getDb(),
			sql`SELECT c.relname AS name, i.indisvalid, i.indisready, i.indisunique
			      FROM pg_index i
			      JOIN pg_class c ON c.oid = i.indexrelid
			      JOIN pg_class t ON t.oid = i.indrelid
			     WHERE t.relname = 'events'
			       AND c.relname IN ('idx_events_session_id_id', 'uq_events_session_dedup_key')
			     ORDER BY c.relname`,
		);
		expect(rows.map((row) => row.name)).toEqual([
			"idx_events_session_id_id",
			"uq_events_session_dedup_key",
		]);
		for (const row of rows) {
			expect(row.indisvalid, row.name).toBe(true);
			expect(row.indisready, row.name).toBe(true);
		}
		expect(rows.find((row) => row.name === "uq_events_session_dedup_key")?.indisunique).toBe(true);

		const listed = await executeRows<{ indexname: string }>(
			getDb(),
			sql`SELECT indexname FROM pg_indexes WHERE tablename = 'events'`,
		);
		const listedNames = listed.map((row) => row.indexname);
		expect(listedNames).toContain("idx_events_session_id_id");
		expect(listedNames).toContain("uq_events_session_dedup_key");

		const columns = await executeRows<{ column_name: string }>(
			getDb(),
			sql`SELECT column_name FROM information_schema.columns
			     WHERE table_name = 'events' AND column_name = 'dedup_key'`,
		);
		expect(columns).toHaveLength(1);
	});
});

// ── R7–R8, R11 (loaders, both backends) ──────────────────────────────────────

describe("loadRecentEventsBySession (classifier loader)", () => {
	test("R7 returns each session's last N rows ascending, never mixing sessions", async () => {
		const ids = [newSessionId("r7a"), newSessionId("r7b"), newSessionId("r7c")];
		for (const id of ids) await mkSession(id);
		const rows: SeedRow[] = [];
		for (let i = 1; i <= 60; i++) {
			for (const id of ids) rows.push({ sessionId: id, content: `r${i}` });
		}
		await seedEvents(rows);

		const absent = newSessionId("r7-absent");
		const loaded = await loadRecentEventsBySession([...ids, absent], 50);
		const expected = Array.from({ length: 50 }, (_, i) => `r${i + 11}`);
		for (const id of ids) {
			const list = loaded.get(id) ?? [];
			expect(list.map((row) => row.content)).toEqual(expected);
			expect(list.every((row) => row.sessionId === id)).toBe(true);
			const eventIds = list.map((row) => row.id);
			expect(eventIds).toEqual([...eventIds].sort((x, y) => x - y));
		}
		expect(loaded.get(absent)).toEqual([]);
	});

	test("R7b a hostile session id loads only its own rows", async () => {
		const hostile = `q'),(x-- ${crypto.randomUUID()}`;
		const other = newSessionId("r7b-other");
		await mkSession(hostile);
		await mkSession(other);
		await seedEvents([
			{ sessionId: hostile, content: "mine-1" },
			{ sessionId: other, content: "theirs" },
			{ sessionId: hostile, content: "mine-2" },
		]);
		const loaded = await loadRecentEventsBySession([hostile], 50);
		expect(loaded.get(hostile)?.map((row) => row.content)).toEqual(["mine-1", "mine-2"]);
		expect([...loaded.keys()]).toEqual([hostile]);
	});

	test("R7c empty input is an empty map, with no query error", async () => {
		expect((await loadRecentEventsBySession([], 50)).size).toBe(0);
		expect((await intelligenceForSessions([])).size).toBe(0);
	});

	test("R11 rows are projected: no rawPayload or toolInput, even for a 100 KB payload", async () => {
		const sid = newSessionId("r11");
		await mkSession(sid);
		await seedEvents([
			{ sessionId: sid, content: "big", rawPayload: { blob: "x".repeat(100_000) } },
		]);
		const [row] = (await loadRecentEventsBySession([sid], 50)).get(sid) ?? [];
		expect(row?.content).toBe("big");
		const keys = Object.keys(row ?? {});
		expect(keys).not.toContain("rawPayload");
		expect(keys).not.toContain("toolInput");
	});
});

describe("loadQaEvents (ask-qa loader)", () => {
	test("R8 caps at 2,000 rows, newest first", async () => {
		const sid = newSessionId("r8");
		await mkSession(sid);
		await seedEvents(
			Array.from({ length: 2100 }, (_, i) => ({ sessionId: sid, content: `q${i}` })),
		);
		const loaded = await loadQaEvents(sid);
		expect(loaded).toHaveLength(2000);
		expect(loaded[0]?.content).toBe("q2099");
		const ids = loaded.map((row) => row.id);
		expect(ids).toEqual([...ids].sort((x, y) => y - x));
	});
});

// ── R9 (REST never exposes dedup_key) ────────────────────────────────────────

describe("REST never exposes dedupKey", () => {
	test("R9 /sessions/:id, /timeline and /events/:eventId/context all omit it", async () => {
		const sid = newSessionId("r9");
		await mkSession(sid);
		// Seed directly with a non-null dedup_key — no public write path sets
		// one yet at Phase 2, so this is the only way to exercise the read side.
		await getDb()
			.insert(events)
			.values({
				sessionId: sid,
				eventType: "PostToolUse",
				category: "tool_event",
				source: "observed_hook",
				content: "keyed",
				isNoise: false,
				rawPayload: {},
				dedupKey: `t:${crypto.randomUUID()}`,
			});
		const [row] = await getDb()
			.select({ id: events.id })
			.from(events)
			.where(eq(events.sessionId, sid));
		const eventId = row?.id;
		expect(eventId).toBeGreaterThan(0);

		const detail = await app.fetch(new Request(`http://x/api/v1/sessions/${sid}`));
		expect(detail.status).toBe(200);
		const detailBody = (await detail.json()) as { events: Array<Record<string, unknown>> };
		expect(detailBody.events.length).toBeGreaterThan(0);
		for (const e of detailBody.events) expect("dedupKey" in e).toBe(false);

		const timeline = await app.fetch(new Request(`http://x/api/v1/sessions/${sid}/timeline`));
		expect(timeline.status).toBe(200);
		const timelineBody = (await timeline.json()) as { events: Array<Record<string, unknown>> };
		expect(timelineBody.events.length).toBeGreaterThan(0);
		for (const e of timelineBody.events) expect("dedupKey" in e).toBe(false);

		const context = await app.fetch(
			new Request(`http://x/api/v1/sessions/${sid}/events/${eventId}/context`),
		);
		expect(context.status).toBe(200);
		const contextBody = (await context.json()) as { events: Array<Record<string, unknown>> };
		expect(contextBody.events.length).toBeGreaterThan(0);
		for (const e of contextBody.events) expect("dedupKey" in e).toBe(false);
	});
});

// ── F98: id ordering is bound to real call sites, not just a hand-written
// SQL string ──────────────────────────────────────────────────────────────
//
// R1/R2 assert on Q_ID/Q_CREATED (literal SQL), which never changes even if
// every real call site reverts to desc(events.createdAt). These two tests
// close that gap: a source-scan guard (so any of the six sites reverting is
// caught immediately, without needing a behavior test per site) plus one
// behavior test that drives the actual bug through a real route.

describe("F98: id-order guard against reverting to createdAt", () => {
	function walk(dir: string, out: string[]) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "__fixtures__" || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, out);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			out.push(full);
		}
	}

	test("no non-test src/server file orders the events table by created_at without an id tiebreak", () => {
		const root = join(process.cwd(), "src", "server");
		const files: string[] = [];
		walk(root, files);

		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			if (/desc\(events\.createdAt\)/.test(text)) {
				offenders.push(`${file}: desc(events.createdAt)`);
			}
			// Qualified so the sessions-table ordering in
			// postgres-search-backend.ts (`FROM sessions ... ORDER BY created_at
			// DESC`, no e./events. prefix) is correctly out of scope — it isn't
			// this bug's population.
			const rawOrderings = text.match(/ORDER BY (e\.|events\.)created_at[^\n,]*(,[^\n]*)?/g) ?? [];
			for (const line of rawOrderings) {
				if (/,\s*(e\.)?id (DESC|ASC)/.test(line)) continue;
				offenders.push(`${file}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("F98: session detail returns events in id order through the real route", () => {
	test("two events whose created_at order disagrees with id order come back id-ordered", async () => {
		const sid = newSessionId("f98");
		await mkSession(sid);
		// Inserted first (smaller id) but a LATER wall-clock time. If the route
		// reverted to ORDER BY created_at DESC, this row would sort first.
		const [earlierIdLaterClock] = await getDb()
			.insert(events)
			.values({
				sessionId: sid,
				eventType: "PostToolUse",
				category: "tool_event",
				source: "observed_hook",
				content: "later-clock",
				isNoise: false,
				rawPayload: {},
				createdAt: "2026-01-01 00:00:10",
			})
			.returning({ id: events.id });
		// Inserted second (larger id) but an EARLIER wall-clock time — the
		// correct id-DESC order must put this one first.
		const [laterIdEarlierClock] = await getDb()
			.insert(events)
			.values({
				sessionId: sid,
				eventType: "PostToolUse",
				category: "tool_event",
				source: "observed_hook",
				content: "earlier-clock",
				isNoise: false,
				rawPayload: {},
				createdAt: "2026-01-01 00:00:05",
			})
			.returning({ id: events.id });

		expect((laterIdEarlierClock?.id ?? 0) > (earlierIdLaterClock?.id ?? 0)).toBe(true);

		const detail = await app.fetch(new Request(`http://x/api/v1/sessions/${sid}`));
		expect(detail.status).toBe(200);
		const body = (await detail.json()) as { events: Array<{ id: number }> };
		const ids = body.events.map((e) => e.id);
		const posLater = ids.indexOf(laterIdEarlierClock?.id ?? -1);
		const posEarlier = ids.indexOf(earlierIdLaterClock?.id ?? -1);
		expect(posLater).toBeGreaterThanOrEqual(0);
		expect(posEarlier).toBeGreaterThanOrEqual(0);
		// id DESC: the larger id (posted with an earlier createdAt) must come
		// before the smaller id, proving the route sorts by id, not createdAt.
		expect(posLater).toBeLessThan(posEarlier);
	});
});
