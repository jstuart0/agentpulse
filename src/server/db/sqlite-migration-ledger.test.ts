/**
 * The SQLite migration ledger reconcile (AGEN-67). A ledger row is a claim that a migration's effects are
 * in the database, so the tests that matter are the ones that change the database and expect the claim
 * to stop. Every case reruns the call to show it records nothing new. Boot-level behaviour (child
 * processes, the forced path, concurrency) is in sqlite-migration-ledger-boot.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import "./__test_db.js";
import { itSqliteOnly } from "../test-utils/backend.js";
import {
	MIGRATIONS_DIR,
	drizzleBornThrough,
	journalOf,
	ledgerRows,
	legacyBuiltDb,
	legacyBuiltFile,
	syntheticFolder,
} from "../test-utils/ledger-fixtures.js";
import {
	LEDGER_SINCE_VERSION,
	LEGACY_EQUIVALENTS,
	LEGACY_EXCEPTIONS,
	MigrationLedgerAheadError,
	MigrationLedgerError,
	MigrationLedgerGapError,
	MigrationLedgerMalformedError,
	ledgerStats,
	migrationEffects,
	reconcileSqliteMigrationLedger,
} from "./sqlite-migration-ledger.js";

const TAGS = journalOf().entries.map((e) => e.tag);
const open: Database[] = [];
function track(db: Database): Database {
	open.push(db);
	return db;
}
afterAll(() => {
	for (const db of open) db.close();
});

const legacy = (db: Database, folder = MIGRATIONS_DIR) =>
	reconcileSqliteMigrationLedger(db, folder, "legacy");
const forced = (db: Database, folder = MIGRATIONS_DIR) =>
	reconcileSqliteMigrationLedger(db, folder, "forced");
const tagsThrough = (tag: string) => TAGS.slice(0, TAGS.indexOf(tag) + 1);

/** Records through `through`, then proves a second call records nothing and reports the same prefix. */
function expectLegacyThrough(db: Database, through: string | null, folder = MIGRATIONS_DIR) {
	const first = legacy(db, folder);
	expect(first.verifiedThrough).toBe(through);
	expect(first.recorded).toEqual(through === null ? [] : tagsThrough(through));
	const second = legacy(db, folder);
	expect(second.recorded).toEqual([]);
	expect(second.verifiedThrough).toBe(through);
	return first;
}

describe("sqlite migration ledger: fidelity", () => {
	itSqliteOnly(
		"records every journal entry, with the hash and created_at drizzle's own migrate() writes",
		async () => {
			const db = track(await legacyBuiltDb());
			// Population floor: the journal this test is about has at least the 23 entries shipped today.
			expect(TAGS.length).toBeGreaterThanOrEqual(23);
			const report = legacy(db);
			expect(report.recorded).toEqual(TAGS);
			expect(report.verifiedThrough).toBe(TAGS.at(-1) as string);
			expect(report.problem).toBeUndefined();
			expect(report.exceptionsUsed).toEqual(["E1", "E2", "E3"]);

			const born = track(drizzleBornThrough(TAGS.length));
			const written = ledgerRows(db);
			expect(written).toEqual(ledgerRows(born));
			expect(written.length).toBe(TAGS.length);
			// created_at is a number, as drizzle writes it, and drizzle's table has the same columns.
			expect(written.every((r) => typeof r.created_at === "number")).toBe(true);
			expect(db.prepare("PRAGMA table_info('__drizzle_migrations')").all()).toEqual(
				born.prepare("PRAGMA table_info('__drizzle_migrations')").all(),
			);

			const again = legacy(db);
			expect(again.recorded).toEqual([]);
			expect(again.fastPath).toBe(true);
			expect(ledgerRows(db)).toEqual(written);
		},
	);
});

describe("sqlite migration ledger: the legacy-built database, changed", () => {
	/**
	 * Each row changes a legacy-built database and names where the ledger must stop, and whether a forced
	 * boot then refuses (a later migration's table or column is present, so migrate() would replay it).
	 */
	const cases: Array<{
		name: string;
		sql: string;
		through: string;
		forced: "gap" | "none";
	}> = [
		{
			name: "an index of the last-but-one migration dropped (0021)",
			sql: "DROP INDEX idx_control_actions_session",
			through: "0020_codex_approvals",
			forced: "gap",
		},
		{
			name: "the pairing-codes trigger dropped (0013)",
			sql: "DROP TRIGGER pairing_codes_redeemed_key_immutable",
			through: "0012_watcher_modes",
			forced: "gap",
		},
		{
			name: "ai_session_summaries dropped (0011)",
			sql: "DROP TABLE ai_session_summaries",
			through: "0010_event_embeddings_scan_index",
			forced: "gap",
		},
		{
			name: "the last entry's table dropped (0022)",
			sql: "DROP TABLE fork_tool_calls",
			through: "0021_control_actions_session_index",
			forced: "none",
		},
		{
			name: "a column re-added with another type (0009)",
			sql: "ALTER TABLE sessions DROP COLUMN reported_host; ALTER TABLE sessions ADD COLUMN reported_host INTEGER",
			through: "0008_supervisor_exclude_rules_state",
			forced: "gap",
		},
		{
			name: "a column re-added with another default (0012)",
			sql: "ALTER TABLE watcher_configs DROP COLUMN notify_enabled; ALTER TABLE watcher_configs ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1",
			through: "0011_ai_session_summaries",
			forced: "gap",
		},
		{
			name: "a partial unique index with another WHERE (0012)",
			sql: "DROP INDEX uq_watcher_proposals_session_turn; CREATE UNIQUE INDEX uq_watcher_proposals_session_turn ON watcher_proposals (session_id, turn_key) WHERE turn_key IS NOT NULL AND state <> 'x'",
			through: "0011_ai_session_summaries",
			forced: "gap",
		},
		{
			name: "a partial unique index made non-unique (0012)",
			sql: "DROP INDEX uq_watcher_proposals_session_turn; CREATE INDEX uq_watcher_proposals_session_turn ON watcher_proposals (session_id, turn_key) WHERE turn_key IS NOT NULL",
			through: "0011_ai_session_summaries",
			forced: "gap",
		},
		{
			name: "an owner index without DESC (0017)",
			sql: "DROP INDEX idx_ask_threads_owner_user; CREATE INDEX idx_ask_threads_owner_user ON ask_threads (owner_user_id, updated_at) WHERE archived_at IS NULL",
			through: "0016_launch_idempotency_key",
			forced: "gap",
		},
		{
			name: "an append-only audit trigger weakened, same name (0020)",
			sql: "DROP TRIGGER trg_codex_approval_audit_update; CREATE TRIGGER trg_codex_approval_audit_update BEFORE UPDATE ON codex_approval_audit WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, 'codex_approval_audit_append_only'); END",
			through: "0019_supervisor_outbox_state",
			forced: "gap",
		},
		{
			name: "the FTS table dropped (not a migration's object)",
			sql: "DROP TABLE search_events_fts",
			through: "0022_fork_tool_calls",
			forced: "none",
		},
		{
			name: "the embeddings scan index dropped (0010)",
			sql: "DROP INDEX idx_event_embeddings_model_dim_event",
			through: "0009_session_reported_host",
			forced: "gap",
		},
	];

	for (const c of cases) {
		itSqliteOnly(`legacy mode stops where the schema stops: ${c.name}`, async () => {
			const db = track(await legacyBuiltDb());
			db.exec(c.sql);
			const report = expectLegacyThrough(db, c.through);
			// Whatever it stopped at, what it recorded is a prefix of the real ledger.
			const real = ledgerRows(track(drizzleBornThrough(TAGS.length)));
			expect(ledgerRows(db)).toEqual(real.slice(0, tagsThrough(c.through).length));
			if (c.through !== TAGS.at(-1))
				expect(report.firstUnverified?.tag).toBe(TAGS[TAGS.indexOf(c.through) + 1]);
		});

		itSqliteOnly(
			`forced mode ${c.forced === "gap" ? "refuses" : "goes on"}: ${c.name}`,
			async () => {
				const db = track(await legacyBuiltDb());
				db.exec(c.sql);
				if (c.forced === "gap") {
					expect(() => forced(db)).toThrow(MigrationLedgerGapError);
					// It wrote nothing: an absent ledger stays absent.
					expect(ledgerRows(db)).toEqual([]);
					expect(
						db.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
					).toBeNull();
				} else {
					const report = forced(db);
					expect(report.verifiedThrough).toBe(c.through);
					expect(report.recorded).toEqual(tagsThrough(c.through));
				}
			},
		);
	}
});

describe("sqlite migration ledger: the exception list", () => {
	itSqliteOnly("E1 to E3 each match a real difference on a legacy-built database", async () => {
		const db = track(await legacyBuiltDb());
		// A stale entry would not appear here: it names a difference the legacy path no longer has.
		expect(legacy(db).exceptionsUsed).toEqual(LEGACY_EXCEPTIONS.map((e) => e.id));
	});

	itSqliteOnly("a difference outside the exceptions is not verified", async () => {
		const db = track(await legacyBuiltDb());
		// A default on a column the migration gives none (E1 is only sessions.metadata).
		db.exec(
			"ALTER TABLE sessions DROP COLUMN current_turn_started_at; ALTER TABLE sessions ADD COLUMN current_turn_started_at TEXT DEFAULT 'x'",
		);
		expectLegacyThrough(db, "0016_launch_idempotency_key");
	});

	const e = (id: string) => LEGACY_EXCEPTIONS.find((x) => x.id === id);
	const col = (type: string, nn: number, dflt: string, pk: number, pkn: number) =>
		`${type}|nn=${nn}|dflt=${dflt}|pk=${pk}|pkn=${pkn}`;

	test("E1 is one column's default and nothing else", () => {
		expect(
			e("E1")?.matches(
				"column:sessions.metadata",
				col("TEXT", 0, "", 0, 1),
				col("TEXT", 0, "'{}'", 0, 1),
			),
		).toBe(true);
		expect(
			e("E1")?.matches(
				"column:sessions.status",
				col("TEXT", 0, "", 0, 1),
				col("TEXT", 0, "'{}'", 0, 1),
			),
		).toBe(false);
		expect(
			e("E1")?.matches(
				"column:sessions.metadata",
				col("TEXT", 0, "", 0, 1),
				col("TEXT", 0, "'x'", 0, 1),
			),
		).toBe(false);
	});

	test("E2 is a single-column, non-INTEGER primary key that is nullable, and nothing else", () => {
		expect(
			e("E2")?.matches("column:t.id", col("TEXT", 1, "", 1, 1), col("TEXT", 0, "", 1, 1)),
		).toBe(true);
		expect(
			e("E2")?.matches("column:t.id", col("INTEGER", 1, "", 1, 1), col("INTEGER", 0, "", 1, 1)),
		).toBe(false);
		expect(e("E2")?.matches("column:t.a", col("TEXT", 1, "", 1, 2), col("TEXT", 0, "", 1, 2))).toBe(
			false,
		);
		expect(e("E2")?.matches("column:t.x", col("TEXT", 1, "", 0, 1), col("TEXT", 0, "", 0, 1))).toBe(
			false,
		);
	});

	test("E3 is a cascade on a rebuild target's session_id, and nothing else", () => {
		const cascade = (key: string, expected: string, live: string) =>
			e("E3")?.matches(key, expected, live);
		expect(
			cascade(
				"fk:events.session_id->sessions.session_id",
				"NO ACTION|NO ACTION",
				"CASCADE|NO ACTION",
			),
		).toBe(true);
		// A table the rebuild doesn't touch.
		expect(
			cascade(
				"fk:fork_tool_calls.session_id->sessions.session_id",
				"NO ACTION|NO ACTION",
				"CASCADE|NO ACTION",
			),
		).toBe(false);
		// Another column, or another rule.
		expect(
			cascade("fk:events.other->sessions.session_id", "NO ACTION|NO ACTION", "CASCADE|NO ACTION"),
		).toBe(false);
		expect(
			cascade(
				"fk:events.session_id->sessions.session_id",
				"NO ACTION|NO ACTION",
				"SET NULL|NO ACTION",
			),
		).toBe(false);
	});
});

describe("sqlite migration ledger: synthetic journals", () => {
	const BASE = [
		"CREATE TABLE `a` (`id` integer PRIMARY KEY NOT NULL, `y` text, `z` text);--> statement-breakpoint",
		"CREATE TABLE `b` (`id` integer PRIMARY KEY NOT NULL);--> statement-breakpoint",
		"CREATE INDEX `idx_a_z` ON `a` (`z`);",
	].join("\n");
	type Case = { name: string; second: string; apply: string; recorded?: never };
	const removals: Case[] = [
		{
			name: "DROP COLUMN",
			second: "ALTER TABLE `a` DROP COLUMN `y`;",
			apply: "ALTER TABLE a DROP COLUMN y",
		},
		{ name: "DROP INDEX", second: "DROP INDEX `idx_a_z`;", apply: "DROP INDEX idx_a_z" },
		{ name: "DROP TABLE", second: "DROP TABLE `b`;", apply: "DROP TABLE b" },
		{
			name: "RENAME TO",
			second: "ALTER TABLE `b` RENAME TO `c`;",
			apply: "ALTER TABLE b RENAME TO c",
		},
		{
			name: "RENAME COLUMN",
			second: "ALTER TABLE `a` RENAME COLUMN `y` TO `yy`;",
			apply: "ALTER TABLE a RENAME COLUMN y TO yy",
		},
	];

	for (const c of removals) {
		itSqliteOnly(
			`${c.name}: unverified while the object is there, verified once it is gone`,
			() => {
				const folder = syntheticFolder([
					{ tag: "0000_base", sql: BASE },
					{ tag: "0001_change", sql: c.second },
				]);
				// Built through the first entry by drizzle itself, so its ledger sits at 0000.
				const db = track(new Database(":memory:"));
				migrate(drizzle(db), {
					migrationsFolder: syntheticFolder([{ tag: "0000_base", sql: BASE }]),
				});
				expect(ledgerRows(db).length).toBe(1);

				const before = legacy(db, folder);
				expect(before.verifiedThrough).toBe("0000_base");
				expect(before.firstUnverified?.tag).toBe("0001_change");
				expect(before.recorded).toEqual([]);
				// Forced mode lets migrate() run it, and migrate() really does.
				expect(() => forced(db, folder)).not.toThrow();
				const trial = track(Database.deserialize(db.serialize()));
				migrate(drizzle(trial), { migrationsFolder: folder });
				expect(ledgerRows(trial).length).toBe(2);

				db.exec(c.apply);
				const after = legacy(db, folder);
				expect(after.verifiedThrough).toBe("0001_change");
				expect(after.recorded).toEqual(["0001_change"]);
				expect(legacy(db, folder).recorded).toEqual([]);
			},
		);
	}

	itSqliteOnly(
		"a drizzle-kit table rebuild that adds NOT NULL is unverified on the old table",
		() => {
			const folder = syntheticFolder([
				{
					tag: "0000_base",
					sql: "CREATE TABLE `t` (`id` integer PRIMARY KEY NOT NULL, `v` text);",
				},
				{
					tag: "0001_rebuild",
					sql: [
						"PRAGMA foreign_keys=OFF;--> statement-breakpoint",
						"CREATE TABLE `__new_t` (`id` integer PRIMARY KEY NOT NULL, `v` text NOT NULL);--> statement-breakpoint",
						"INSERT INTO `__new_t`(`id`, `v`) SELECT `id`, `v` FROM `t`;--> statement-breakpoint",
						"DROP TABLE `t`;--> statement-breakpoint",
						"ALTER TABLE `__new_t` RENAME TO `t`;--> statement-breakpoint",
						"PRAGMA foreign_keys=ON;",
					].join("\n"),
				},
			]);
			const db = track(new Database(":memory:"));
			db.exec("CREATE TABLE t (id integer PRIMARY KEY NOT NULL, v text)");
			const before = legacy(db, folder);
			expect(before.verifiedThrough).toBe("0000_base");
			expect(before.firstUnverified).toEqual({ tag: "0001_rebuild", keys: ["column:t.v"] });
			// The rebuild is not a data statement.
			expect(migrationEffects(folder).entries.map((e) => e.hasData)).toEqual([false, false]);

			db.exec("DROP TABLE t; CREATE TABLE t (id integer PRIMARY KEY NOT NULL, v text NOT NULL)");
			expect(legacy(db, folder).verifiedThrough).toBe("0001_rebuild");
		},
	);

	itSqliteOnly(
		"a rebuild owns the whole table, so a column that kept its spelling is still required",
		() => {
			const folder = syntheticFolder([
				{
					tag: "0000_base",
					sql: "CREATE TABLE `t` (`id` integer PRIMARY KEY NOT NULL, `v` text, `w` text);",
				},
				{
					tag: "0001_rebuild",
					sql: [
						"CREATE TABLE `__new_t` (`id` integer PRIMARY KEY NOT NULL, `v` text NOT NULL, `w` text);--> statement-breakpoint",
						"INSERT INTO `__new_t`(`id`, `v`, `w`) SELECT `id`, `v`, `w` FROM `t`;--> statement-breakpoint",
						"DROP TABLE `t`;--> statement-breakpoint",
						"ALTER TABLE `__new_t` RENAME TO `t`;",
					].join("\n"),
				},
			]);
			const keys = migrationEffects(folder).entries[1]?.effects.map((e) => e.key);
			expect(keys).toContain("column:t.w");
			expect(keys).toContain("column:t.id");
		},
	);

	itSqliteOnly("a data-only entry with no legacy equivalent ends the prefix", () => {
		const folder = syntheticFolder([
			{ tag: "0000_base", sql: BASE },
			{ tag: "0001_data", sql: "UPDATE `a` SET `y` = 'x';" },
			{ tag: "0002_more", sql: "CREATE TABLE `c` (`id` integer PRIMARY KEY NOT NULL);" },
		]);
		const db = track(new Database(":memory:"));
		db.exec(BASE.replaceAll("--> statement-breakpoint", ""));
		db.exec("CREATE TABLE c (id integer PRIMARY KEY NOT NULL)");
		const report = legacy(db, folder);
		expect(report.verifiedThrough).toBe("0000_base");
		expect(report.firstUnverified).toEqual({
			tag: "0001_data",
			keys: ["data statements with no legacy equivalent"],
		});
		expect(report.recorded).toEqual(["0000_base"]);
		// Forced mode refuses: 0002's table is there, and migrate() would replay it.
		expect(() => forced(db, folder)).toThrow(MigrationLedgerGapError);
	});

	itSqliteOnly("an UPDATE inside a trigger body is not a data statement", () => {
		const folder = syntheticFolder([
			{
				tag: "0000_base",
				sql: [
					"CREATE TABLE `a` (`id` integer PRIMARY KEY NOT NULL, `y` text);--> statement-breakpoint",
					"CREATE TRIGGER `a_touch` AFTER INSERT ON `a` BEGIN UPDATE a SET y = 'x' WHERE id = NEW.id; END;",
				].join("\n"),
			},
		]);
		expect(migrationEffects(folder).entries[0]?.hasData).toBe(false);
	});

	test("every LEGACY_EQUIVALENTS entry names a journal entry that really has a data statement", () => {
		const entries = migrationEffects(MIGRATIONS_DIR).entries;
		for (const q of LEGACY_EQUIVALENTS) {
			const entry = entries.find((e) => e.tag === q.tag);
			expect(entry, `stale equivalent ${q.tag}`).toBeDefined();
			expect(entry?.hasData, `${q.tag} has no data statement`).toBe(true);
		}
		// And the reverse: every shipped data statement has one.
		for (const e of entries.filter((x) => x.hasData)) {
			expect(LEGACY_EQUIVALENTS.map((q) => q.tag)).toContain(e.tag);
		}
		expect(LEGACY_EQUIVALENTS.map((q) => q.tag)).toEqual(["0012_watcher_modes"]);
	});
});

describe("sqlite migration ledger: a ledger ahead of the schema, or unreadable", () => {
	itSqliteOnly(
		"a ledger short of the tail but past a missing column: forced mode throws Ahead, legacy mode reports it, nothing is written",
		() => {
			const db = track(drizzleBornThrough(TAGS.length - 1));
			db.exec("ALTER TABLE sessions DROP COLUMN reported_host");
			const before = ledgerRows(db);
			expect(() => forced(db)).toThrow(MigrationLedgerAheadError);
			const report = legacy(db);
			expect(report.problem?.kind).toBe("ahead");
			expect(report.problem?.message).toContain(LEDGER_SINCE_VERSION);
			expect(report.recorded).toEqual([]);
			expect(ledgerRows(db)).toEqual(before);
		},
	);

	itSqliteOnly(
		"a ledger at the tail: legacy mode trusts it, forced mode looks and refuses an overstated one",
		() => {
			const db = track(drizzleBornThrough(TAGS.length));
			db.exec("ALTER TABLE sessions DROP COLUMN reported_host");
			const before = ledgerRows(db);
			// Legacy mode keeps the fast path (it only ever adds rows, so there is nothing to protect).
			const trusted = legacy(db);
			expect(trusted.fastPath).toBe(true);
			expect(trusted.problem).toBeUndefined();
			// Forced mode hands the database to migrate(), which would skip everything: it looks.
			expect(() => forced(db)).toThrow(MigrationLedgerAheadError);
			expect(ledgerRows(db)).toEqual(before);
		},
	);

	itSqliteOnly(
		"a ledger at the tail on a sound database passes forced mode without the fast path",
		() => {
			const db = track(drizzleBornThrough(TAGS.length));
			const report = forced(db);
			expect(report.fastPath).toBe(false);
			expect(report.verifiedThrough).toBe(TAGS.at(-1) as string);
			expect(report.problem).toBeUndefined();
			expect(report.recorded).toEqual([]);
		},
	);

	itSqliteOnly("a ledger max above the tail with the schema verified: forced mode proceeds", () => {
		const db = track(drizzleBornThrough(TAGS.length));
		db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?)").run(
			(journalOf().entries.at(-1)?.when ?? 0) + 9000,
		);
		const report = forced(db);
		expect(report.problem).toBeUndefined();
		expect(report.newerRows).toBe(1);
		expect(report.verifiedThrough).toBe(TAGS.at(-1) as string);
	});

	itSqliteOnly(
		"a ledger max that matches no journal entry is read by value, as drizzle reads it",
		() => {
			const entries = journalOf().entries;
			const between = (entries[10]?.when as number) + 1;
			// Schema complete: the entries after the odd row are recorded, none is replayed.
			const full = track(drizzleBornThrough(TAGS.length));
			full.exec("DELETE FROM __drizzle_migrations");
			full
				.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('odd', ?)")
				.run(between);
			const report = forced(full);
			expect(report.ledgerThrough).toBe(TAGS[10] as string);
			expect(report.recorded).toEqual(TAGS.slice(11));
			// Schema just past that row: the next entry is recorded, nothing is flagged.
			const partial = track(drizzleBornThrough(12));
			partial.exec("DELETE FROM __drizzle_migrations");
			partial
				.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('odd', ?)")
				.run(between);
			const partialReport = forced(partial);
			expect(partialReport.problem).toBeUndefined();
			expect(partialReport.recorded).toEqual([TAGS[11] as string]);
			// Schema only as far as the entry before it: the row claims a little more than is verified, which
			// is "ahead" (it is judged against the last verified entry's time, not rounded down).
			const justShort = track(drizzleBornThrough(11));
			justShort.exec("DELETE FROM __drizzle_migrations");
			justShort
				.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('odd', ?)")
				.run(between);
			expect(() => forced(justShort)).toThrow(MigrationLedgerAheadError);
			// A max past what the schema shows is a ledger ahead of it.
			const short = track(drizzleBornThrough(5));
			short.exec("DELETE FROM __drizzle_migrations");
			short
				.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('odd', ?)")
				.run(between);
			expect(() => forced(short)).toThrow(MigrationLedgerAheadError);
		},
	);

	itSqliteOnly("a row past the journal's tail with a full schema is a note, not an error", () => {
		const db = track(drizzleBornThrough(TAGS.length));
		const tail = journalOf().entries.at(-1);
		db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?)").run(
			(tail?.when ?? 0) + 5000,
		);
		const report = forced(db);
		expect(report.newerRows).toBe(1);
		expect(report.problem).toBeUndefined();
		expect(report.recorded).toEqual([]);
	});

	itSqliteOnly("a row past the tail with a column missing: forced mode throws", () => {
		const db = track(drizzleBornThrough(TAGS.length));
		const tail = journalOf().entries.at(-1);
		db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?)").run(
			(tail?.when ?? 0) + 5000,
		);
		db.exec("ALTER TABLE sessions DROP COLUMN reported_host");
		expect(() => forced(db)).toThrow(MigrationLedgerAheadError);
	});

	const malformed: Array<{ name: string; setup: (db: Database) => void }> = [
		{
			name: "missing columns",
			setup: (db) => db.exec("CREATE TABLE __drizzle_migrations (id integer, hash text)"),
		},
		{
			name: "a NULL created_at",
			setup: (db) => {
				db.exec(
					"CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
				);
				db.exec("INSERT INTO __drizzle_migrations (hash) VALUES ('x')");
			},
		},
		{
			name: "a text created_at",
			setup: (db) => {
				db.exec(
					"CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
				);
				db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', 'abc')");
			},
		},
	];
	for (const m of malformed) {
		itSqliteOnly(
			`${m.name}: forced mode throws Malformed, legacy mode warns, nothing is written`,
			async () => {
				const db = track(await legacyBuiltDb());
				m.setup(db);
				const snapshot = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
				const rows = db.prepare("SELECT * FROM __drizzle_migrations").all();
				expect(() => forced(db)).toThrow(MigrationLedgerMalformedError);
				const report = legacy(db);
				expect(report.problem?.kind).toBe("malformed");
				expect(report.recorded).toEqual([]);
				expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(
					snapshot,
				);
				expect(db.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(rows);
			},
		);
	}

	test("the fail-closed errors share a base class", () => {
		for (const E of [
			MigrationLedgerGapError,
			MigrationLedgerAheadError,
			MigrationLedgerMalformedError,
		]) {
			expect(new E("x")).toBeInstanceOf(MigrationLedgerError);
		}
	});
});

describe("sqlite migration ledger: atomic, and cheap on the second boot", () => {
	itSqliteOnly("a failure on the third row leaves no rows and no open transaction", async () => {
		const db = track(await legacyBuiltDb());
		db.exec(
			`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
			 CREATE TRIGGER stop_at_three BEFORE INSERT ON __drizzle_migrations
			 WHEN (SELECT count(*) FROM __drizzle_migrations) = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		);
		expect(() => legacy(db)).toThrow("boom");
		expect(db.inTransaction).toBe(false);
		expect(ledgerRows(db)).toEqual([]);
	});

	itSqliteOnly(
		"a writer that records the ledger between the look and the write leaves no duplicates",
		async () => {
			const path = join(mkdtempSync(join(tmpdir(), "ap-ledger-race-")), "race.db");
			await legacyBuiltFile(path);
			const mine = track(new Database(path));
			const theirs = track(new Database(path));
			// The other boot gets in after this one has decided what to record and before it writes.
			const racing = new Proxy(mine, {
				get(target, prop) {
					const value = Reflect.get(target, prop);
					if (prop === "transaction") {
						return (fn: () => unknown) => {
							legacy(theirs);
							return target.transaction(fn as never);
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const report = legacy(racing);
			expect(report.recorded).toEqual([]);
			const rows = ledgerRows(mine);
			expect(rows.length).toBe(TAGS.length);
			expect(new Set(rows.map((r) => r.created_at)).size).toBe(TAGS.length);
		},
	);

	itSqliteOnly(
		"the effects are replayed once per process, and a database at the tail is not introspected",
		async () => {
			migrationEffects(MIGRATIONS_DIR);
			const replays = ledgerStats.replays;
			migrationEffects(MIGRATIONS_DIR);
			expect(ledgerStats.replays).toBe(replays);

			const db = track(await legacyBuiltDb());
			legacy(db);
			const introspections = ledgerStats.liveIntrospections;
			const report = legacy(db);
			expect(report.fastPath).toBe(true);
			expect(ledgerStats.liveIntrospections).toBe(introspections);
			expect(ledgerStats.replays).toBe(replays);
		},
	);
});

describe("sqlite migration ledger: constructs the comparer must not wave through", () => {
	itSqliteOnly(
		"a string literal's double quotes are part of the value (0002's default)",
		async () => {
			const db = track(await legacyBuiltDb());
			db.exec(
				"ALTER TABLE api_keys DROP COLUMN scopes; ALTER TABLE api_keys ADD COLUMN scopes text DEFAULT '[ingest]' NOT NULL",
			);
			expectLegacyThrough(db, "0001_true_misty_knight");
		},
	);

	const TABLE = (extra: string, options = "") =>
		`CREATE TABLE \`t\` (\`id\` integer PRIMARY KEY NOT NULL, \`v\` integer${extra})${options};`;
	const REBUILD = (to: string) =>
		[
			"PRAGMA foreign_keys=OFF;--> statement-breakpoint",
			`${to.replace("`t`", "`__new_t`")}--> statement-breakpoint`,
			"INSERT INTO `__new_t`(`id`, `v`) SELECT `id`, `v` FROM `t`;--> statement-breakpoint",
			"DROP TABLE `t`;--> statement-breakpoint",
			"ALTER TABLE `__new_t` RENAME TO `t`;--> statement-breakpoint",
			"PRAGMA foreign_keys=ON;",
		].join("\n");

	const rebuilds: Array<{ name: string; before: string; after: string }> = [
		{ name: "a CHECK added", before: TABLE(""), after: TABLE(", CHECK (`v` > 0)") },
		{
			name: "a CHECK changed",
			before: TABLE(", CHECK (`v` > 0)"),
			after: TABLE(", CHECK (`v` > 5)"),
		},
		{ name: "STRICT added", before: TABLE(""), after: TABLE("", " STRICT") },
		{
			name: "a generated column added",
			before: TABLE(""),
			after: TABLE(", `w` integer GENERATED ALWAYS AS (`v` * 2) VIRTUAL"),
		},
	];
	for (const c of rebuilds) {
		itSqliteOnly(`a table rebuild with ${c.name} is unverified on the old table`, () => {
			const folder = syntheticFolder([
				{ tag: "0000_base", sql: c.before },
				{ tag: "0001_rebuild", sql: REBUILD(c.after) },
			]);
			const db = track(new Database(":memory:"));
			db.exec(c.before.replaceAll("--> statement-breakpoint", ""));
			const report = legacy(db, folder);
			expect(report.verifiedThrough).toBe("0000_base");
			expect(report.firstUnverified?.tag).toBe("0001_rebuild");
			db.exec(`DROP TABLE t; ${c.after}`);
			expect(legacy(db, folder).verifiedThrough).toBe("0001_rebuild");
		});
	}

	itSqliteOnly("a composite foreign key is one constraint, not two", () => {
		const parent =
			"CREATE TABLE `p` (`a` integer NOT NULL, `b` integer NOT NULL, PRIMARY KEY(`a`, `b`));";
		const folder = syntheticFolder([
			{
				tag: "0000_base",
				sql: `${parent}--> statement-breakpoint\nCREATE TABLE \`c\` (\`a\` integer, \`b\` integer, FOREIGN KEY (\`a\`, \`b\`) REFERENCES \`p\`(\`a\`, \`b\`));`,
			},
		]);
		const db = track(new Database(":memory:"));
		db.exec(
			`${parent} CREATE TABLE c (a integer, b integer, FOREIGN KEY (a) REFERENCES p(a), FOREIGN KEY (b) REFERENCES p(b))`,
		);
		expect(legacy(db, folder).verifiedThrough).toBeNull();
		db.exec(
			"DROP TABLE c; CREATE TABLE c (a integer, b integer, FOREIGN KEY (a, b) REFERENCES p(a, b))",
		);
		expect(legacy(db, folder).verifiedThrough).toBe("0000_base");
	});

	itSqliteOnly(
		"a leftover __new_ table from a stopped rebuild is a gap; forced mode refuses and writes nothing",
		async () => {
			const db = track(await legacyBuiltDb());
			db.exec("CREATE TABLE __new_sessions (id integer PRIMARY KEY NOT NULL)");
			expect(() => forced(db)).toThrow(MigrationLedgerGapError);
			expect(ledgerRows(db)).toEqual([]);
			expect(
				db.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
			).toBeNull();
			const report = legacy(db);
			expect(report.problem?.kind).toBe("gap");
			expect(report.problem?.message).toContain("__new_sessions");
		},
	);

	itSqliteOnly(
		"an entry whose column a later entry drops doesn't verify on a database that never had it",
		() => {
			const base = "CREATE TABLE `a` (`id` integer PRIMARY KEY NOT NULL);";
			const folder = syntheticFolder([
				{ tag: "0000_base", sql: base },
				{ tag: "0001_add", sql: "ALTER TABLE `a` ADD `x` text;" },
				{
					tag: "0002_drop",
					sql: "ALTER TABLE `a` DROP COLUMN `x`;--> statement-breakpoint\nCREATE TABLE `y` (`id` integer PRIMARY KEY NOT NULL);",
				},
			]);
			// Built through 0000 only: no x, no y.
			const db = track(new Database(":memory:"));
			migrate(drizzle(db), {
				migrationsFolder: syntheticFolder([{ tag: "0000_base", sql: base }]),
			});
			const report = legacy(db, folder);
			expect(report.verifiedThrough).toBe("0000_base");
			expect(report.firstUnverified?.tag).toBe("0001_add");
			expect(report.recorded).toEqual([]);
			// And migrate() really does run the rest from there.
			migrate(drizzle(db), { migrationsFolder: folder });
			expect(ledgerRows(db).length).toBe(3);

			// A database that did run all three has neither x nor... y exists: all three verify.
			const done = track(new Database(":memory:"));
			migrate(drizzle(done), { migrationsFolder: folder });
			done.exec("DELETE FROM __drizzle_migrations");
			expect(legacy(done, folder).verifiedThrough).toBe("0002_drop");
		},
	);
});

describe("sqlite migration ledger: what each entry owns", () => {
	const effects = migrationEffects(MIGRATIONS_DIR);
	const byTag = (tag: string) => effects.entries.find((e) => e.tag === tag);

	test("hand-picked effects", () => {
		expect(
			byTag("0009_session_reported_host")?.effects.find(
				(e) => e.key === "column:sessions.reported_host",
			)?.expected,
		).toMatch(/^TEXT\|/);
		expect(
			byTag("0013_pairing_codes")?.effects.some((e) =>
				e.key.startsWith("trigger:create trigger pairing_codes_redeemed_key_immutable"),
			),
		).toBe(true);
		expect(byTag("0021_control_actions_session_index")?.effects.map((e) => e.key)).toEqual([
			"index:control_actions(session_id)",
		]);
		expect(
			byTag("0022_fork_tool_calls")?.effects.some((e) => e.key === "table:fork_tool_calls"),
		).toBe(true);
		expect(byTag("0012_watcher_modes")?.hasData).toBe(true);
		expect(LEGACY_EQUIVALENTS.map((q) => q.tag)).toContain("0012_watcher_modes");
		// An index's key is its structure, DESC included, never its name.
		expect(byTag("0017_ask_thread_owner_turn_start")?.effects.map((e) => e.key)).toContain(
			"index:ask_threads(owner_user_id,updated_at desc) where archived_at is null",
		);
	});

	// Present at its own entry, absent at the one before: for every entry, on databases drizzle built.
	for (let i = 1; i <= TAGS.length; i++) {
		itSqliteOnly(
			`${TAGS[i - 1]}: verified on a database built through it, not on one built before it`,
			() => {
				const at = track(drizzleBornThrough(i));
				const atReport = forced(at);
				expect(atReport.verifiedThrough).toBe(TAGS[i - 1] as string);
				expect(atReport.recorded).toEqual([]);
				if (i > 1) {
					const before = track(drizzleBornThrough(i - 1));
					const beforeReport = forced(before);
					expect(beforeReport.verifiedThrough).toBe(TAGS[i - 2] as string);
					expect(beforeReport.firstUnverified?.tag).toBe(TAGS[i - 1] as string);
				}
			},
		);
	}
});
