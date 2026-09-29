// Phase 2 (AGEN-16, Decision 20 / F74): SQLite FTS event index keyed by
// rowid = events.id. Isolated handles only — never the shared singleton.
//
// Events are built with an INDEXED type interleaved with a NON-INDEXED type
// so event ids and FTS insertion order diverge (without interleaving, base
// rowids coincide with event ids and every rowid assertion is trivially
// green at base).

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../services/ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { initializeDatabase } = await import("./client.js");
const { SqliteFtsBackend } = await import("../services/search/sqlite-fts-backend.js");

const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-fts-rowid-"));

afterAll(() => {
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// The 2d4bb8a (pre-Decision-20) trigger DDL text — frozen here because the
// module changes; the test can't derive it from the current source.
const OLD_FTS_TRIGGERS = `
	DROP TRIGGER IF EXISTS trg_events_ai_fts;
	DROP TRIGGER IF EXISTS trg_events_ad_fts;
	CREATE TRIGGER trg_events_ai_fts AFTER INSERT ON events
	WHEN NEW.event_type IN (
		'UserPromptSubmit','AssistantMessage','Stop','TaskCreated','TaskCompleted',
		'SubagentStop','SessionEnd','AiProposal','AiReport','AiHitlRequest'
	)
	BEGIN
		INSERT INTO search_events_fts(event_id, session_id, event_type, text, created_at)
		VALUES (
			NEW.id,
			NEW.session_id,
			NEW.event_type,
			COALESCE(
				json_extract(NEW.raw_payload, '$.prompt'),
				json_extract(NEW.raw_payload, '$.message'),
				json_extract(NEW.raw_payload, '$.summary'),
				json_extract(NEW.raw_payload, '$.why'),
				json_extract(NEW.raw_payload, '$.title'),
				NEW.content, ''
			),
			NEW.created_at
		);
	END;
	CREATE TRIGGER trg_events_ad_fts AFTER DELETE ON events
	BEGIN
		DELETE FROM search_events_fts WHERE event_id = OLD.id;
	END;
`;

function tmpDb(): Database {
	const db = new Database(join(TMP_DIR, `${crypto.randomUUID()}.db`));
	db.exec("PRAGMA foreign_keys = ON;");
	return db;
}

/** A legacy-style handle, bootstrapped once (new-style DDL), then
 * downgraded to the pre-Decision-20 trigger text to simulate an
 * un-upgraded install. */
async function legacyHandleWithOldTriggers(): Promise<Database> {
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
	db.exec(OLD_FTS_TRIGGERS);
	return db;
}

function insertSession(db: Database, sessionId: string) {
	db.prepare("INSERT INTO sessions (id, session_id, agent_type) VALUES (?, ?, 'claude_code')").run(
		sessionId,
		sessionId,
	);
}

/** Insert `count` interleaved events (half indexed 'UserPromptSubmit', half
 * non-indexed 'PreToolUse') for one session, inside a single transaction. */
function insertInterleavedEvents(db: Database, sessionId: string, count: number) {
	const insert = db.prepare(
		"INSERT INTO events (session_id, event_type, raw_payload, content, created_at) VALUES (?, ?, '{}', ?, ?)",
	);
	db.exec("BEGIN;");
	try {
		for (let i = 0; i < count; i++) {
			const indexed = i % 2 === 0;
			insert.run(
				sessionId,
				indexed ? "UserPromptSubmit" : "PreToolUse",
				`row ${i}`,
				`2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`,
			);
		}
		db.exec("COMMIT;");
	} catch (err) {
		db.exec("ROLLBACK;");
		throw err;
	}
}

function ftsRows(db: Database): Array<{ rowid: number; event_id: number }> {
	return db.prepare("SELECT rowid, event_id FROM search_events_fts ORDER BY rowid").all() as Array<{
		rowid: number;
		event_id: number;
	}>;
}

function triggerSql(db: Database, name: string): string | null {
	const row = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
		.get(name) as { sql: string | null } | undefined;
	return row?.sql ?? null;
}

describeSqliteOnly("R12: upgraded DBs are re-keyed to rowid = events.id", () => {
	test("re-keys the trigger and FTS rows, and is idempotent", async () => {
		const db = await legacyHandleWithOldTriggers();
		const sid = `r12-${crypto.randomUUID()}`;
		insertSession(db, sid);
		insertInterleavedEvents(db, sid, 4000); // 2000 indexed

		expect(triggerSql(db, "trg_events_ad_fts")).not.toContain("rowid = OLD.id");

		await initializeDatabase(db);

		// (a)
		const upgradedTrigger = triggerSql(db, "trg_events_ad_fts");
		expect(upgradedTrigger).toContain("rowid = OLD.id");

		// (b)
		const indexedEventIds = (
			db
				.prepare("SELECT id FROM events WHERE session_id = ? AND event_type = 'UserPromptSubmit'")
				.all(sid) as Array<{ id: number }>
		).map((r) => r.id);
		expect(indexedEventIds).toHaveLength(2000);
		const rows = ftsRows(db);
		expect(rows).toHaveLength(2000);
		for (const row of rows) expect(row.rowid).toBe(row.event_id);

		// (c)
		const explain = db
			.prepare("EXPLAIN QUERY PLAN DELETE FROM search_events_fts WHERE rowid = ?")
			.all(1) as Array<{ detail: string }>;
		const detail = explain.map((r) => r.detail).join(" | ");
		expect(detail).toMatch(/VIRTUAL TABLE INDEX \d+:=/);

		// (d)
		const targetId = indexedEventIds[0] as number;
		db.prepare("DELETE FROM events WHERE id = ?").run(targetId);
		const remaining = ftsRows(db);
		expect(remaining).toHaveLength(1999);
		expect(remaining.some((r) => r.rowid === targetId)).toBe(false);

		// (e) idempotent re-run
		const countBefore = ftsRows(db).length;
		await initializeDatabase(db);
		expect(triggerSql(db, "trg_events_ad_fts")).toBe(upgradedTrigger);
		expect(ftsRows(db)).toHaveLength(countBefore);

		db.close();
	}, 30_000);
});

describeSqliteOnly("R13: deleting a session removes exactly its FTS rows", () => {
	test("session A's rows are gone; session B's are untouched", async () => {
		const db = await legacyHandleWithOldTriggers();
		const a = `r13a-${crypto.randomUUID()}`;
		const b = `r13b-${crypto.randomUUID()}`;
		insertSession(db, a);
		insertSession(db, b);
		insertInterleavedEvents(db, a, 200);
		insertInterleavedEvents(db, b, 200);

		await initializeDatabase(db);

		const bRowsBefore = db
			.prepare("SELECT rowid FROM search_events_fts WHERE session_id = ?")
			.all(b) as Array<{ rowid: number }>;
		expect(bRowsBefore).toHaveLength(100);

		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(a);

		const aRowsAfter = db
			.prepare("SELECT rowid FROM search_events_fts WHERE session_id = ?")
			.all(a) as unknown[];
		expect(aRowsAfter).toHaveLength(0);

		const bRowsAfter = db
			.prepare("SELECT rowid FROM search_events_fts WHERE session_id = ? ORDER BY rowid")
			.all(b) as Array<{ rowid: number }>;
		expect(bRowsAfter).toEqual(bRowsBefore.slice().sort((x, y) => x.rowid - y.rowid));

		db.close();
	}, 30_000);
});

describeSqliteOnly("R14/R14b: boot backfill is scoped to indexed events", () => {
	test("R14 a consistent index is not rebuilt on a second boot", async () => {
		const db = await legacyHandleWithOldTriggers();
		const sid = `r14-${crypto.randomUUID()}`;
		insertSession(db, sid);
		// 500 non-indexed tool events + 50 indexed, fully indexed already.
		const insert = db.prepare(
			"INSERT INTO events (session_id, event_type, raw_payload, content, created_at) VALUES (?, ?, '{}', ?, ?)",
		);
		db.exec("BEGIN;");
		for (let i = 0; i < 500; i++) {
			insert.run(sid, "PreToolUse", `tool ${i}`, "2026-01-01 00:00:00");
		}
		for (let i = 0; i < 50; i++) {
			insert.run(sid, "UserPromptSubmit", `prompt ${i}`, "2026-01-01 00:00:01");
		}
		db.exec("COMMIT;");

		await initializeDatabase(db); // upgrades + fully backfills once

		const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
		await initializeDatabase(db); // second boot: should not rebuild
		const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
		expect(after - before).toBeLessThan(50);

		db.close();
	}, 30_000);

	test("R14b a genuinely short FTS index is still repaired", async () => {
		const db = await legacyHandleWithOldTriggers();
		const sid = `r14b-${crypto.randomUUID()}`;
		insertSession(db, sid);
		insertInterleavedEvents(db, sid, 100); // 50 indexed
		await initializeDatabase(db);

		const [indexedRow] = db
			.prepare(
				"SELECT id FROM events WHERE session_id = ? AND event_type = 'UserPromptSubmit' LIMIT 1",
			)
			.all(sid) as Array<{ id: number }>;
		const targetId = indexedRow?.id as number;
		db.prepare("DELETE FROM search_events_fts WHERE rowid = ?").run(targetId);
		expect(db.prepare("SELECT 1 FROM search_events_fts WHERE rowid = ?").get(targetId)).toBeNull();

		await initializeDatabase(db);

		const restored = db
			.prepare("SELECT rowid, event_id FROM search_events_fts WHERE rowid = ?")
			.get(targetId) as { rowid: number; event_id: number } | undefined;
		expect(restored).toBeDefined();
		expect(restored?.rowid).toBe(targetId);
		expect(restored?.event_id).toBe(targetId);

		db.close();
	}, 30_000);
});

describeSqliteOnly("R15: SqliteFtsBackend indexes and removes by rowid", () => {
	test("indexEvent/removeEvent round-trip by rowid, out of natural insertion order", async () => {
		const db = await legacyHandleWithOldTriggers();
		await initializeDatabase(db); // upgrades triggers first
		const backend = new SqliteFtsBackend(db);
		await backend.initialize();

		const sid = `r15-${crypto.randomUUID()}`;
		await backend.indexEvent({
			eventId: 7,
			sessionId: sid,
			eventType: "UserPromptSubmit",
			text: "seven",
			createdAt: "2026-01-01 00:00:00",
		});
		await backend.indexEvent({
			eventId: 3,
			sessionId: sid,
			eventType: "UserPromptSubmit",
			text: "three",
			createdAt: "2026-01-01 00:00:01",
		});

		const rows = ftsRows(db).filter((r) => [3, 7].includes(r.rowid));
		expect(rows).toEqual([
			{ rowid: 3, event_id: 3 },
			{ rowid: 7, event_id: 7 },
		]);

		await backend.removeEvent(3);
		const afterRemove = ftsRows(db).filter((r) => [3, 7].includes(r.rowid));
		expect(afterRemove).toEqual([{ rowid: 7, event_id: 7 }]);

		db.close();
	});

	test("rebuild() re-keys every row by rowid = event_id", async () => {
		const db = await legacyHandleWithOldTriggers();
		const sid = `r15b-${crypto.randomUUID()}`;
		insertSession(db, sid);
		insertInterleavedEvents(db, sid, 20); // 10 indexed, non-contiguous ids
		await initializeDatabase(db);

		const backend = new SqliteFtsBackend(db);
		const result = await backend.rebuild();
		expect(result.eventsIndexed).toBeGreaterThan(0);

		const rows = db
			.prepare("SELECT rowid, event_id FROM search_events_fts WHERE session_id = ?")
			.all(sid) as Array<{ rowid: number; event_id: number }>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.rowid).toBe(row.event_id);

		db.close();
	}, 30_000);
});
