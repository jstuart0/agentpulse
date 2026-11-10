/**
 * Boot-level tests for the SQLite migration ledger (AGEN-67). Each case runs the real boot in a child process
 * against a temp file, the way a server does: first on the legacy path, then with
 * AGENTPULSE_LEGACY_INIT=false, from databases born at several points in the journal. Every boot asserts exit
 * code, empty stderr, integrity_check, foreign_key_check and which path it took.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./__test_db.js";
import { isSqliteTest } from "../test-utils/backend.js";
import {
	MIGRATIONS_DIR,
	drizzleBornThrough,
	journalOf,
	ledgerRows,
	legacyBuiltDb,
} from "../test-utils/ledger-fixtures.js";
import { writePreexistingInstallFile } from "../test-utils/legacy-install.js";
import { missingFrom, shapeOf } from "../test-utils/schema-shape.js";

/** A boot test: SQLite only, with the time a child process and a few migrations need. */
function itBoot(name: string, fn: () => void | Promise<void>, timeoutMs = 90_000): void {
	test.skipIf(!isSqliteTest)(name, fn, timeoutMs);
}

const open: Database[] = [];
function track(db: Database): Database {
	open.push(db);
	return db;
}

const ROOT = resolve(import.meta.dir, "../../..");
const CHILD = resolve(import.meta.dir, "../test-utils/ledger-boot-child.ts");
const TMP = mkdtempSync(join(tmpdir(), "ap-ledger-boot-"));
const TAGS = journalOf().entries.map((e) => e.tag);
const LEGACY_LINE = "using legacy init path";
const FORCED_LINE = "forcing Drizzle migrate on existing install";

interface BootResult {
	code: number;
	out: string;
	err: string;
}

async function boot(
	file: string,
	opts: { forced?: boolean; vector?: boolean; cwd?: string } = {},
): Promise<BootResult> {
	const dir = resolve(file, "..");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		TMPDIR: tmpdir(),
		HOME: dir,
		SQLITE_PATH: file,
		DATA_DIR: dir,
	};
	if (opts.forced) env.AGENTPULSE_LEGACY_INIT = "false";
	if (opts.vector) env.AGENTPULSE_VECTOR_SEARCH = "true";
	const child = Bun.spawn([process.execPath, CHILD], {
		cwd: opts.cwd ?? ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

/** A boot that must have worked: exit 0, quiet stderr, a sound file, and the path it was meant to take. */
function expectHealthy(file: string, r: BootResult, path: "legacy" | "forced") {
	expect(r.err, r.err).toBe("");
	expect(r.code, `${r.out}\n${r.err}`).toBe(0);
	if (path === "forced") {
		expect(r.out).toContain(FORCED_LINE);
		expect(r.out).not.toContain(LEGACY_LINE);
	} else {
		expect(r.out).toContain(LEGACY_LINE);
		expect(r.out).not.toContain(FORCED_LINE);
	}
	const db = new Database(file, { readonly: true });
	try {
		expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
}

function fileIn(name: string): string {
	return join(mkdtempSync(join(TMP, `${name}-`)), "app.db");
}

function inspect<T>(file: string, fn: (db: Database) => T): T {
	const db = new Database(file, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** A Drizzle-born file at the first `count` entries, by drizzle's own migrate(). */
function bornFile(count: number, name = "born"): string {
	const file = fileIn(name);
	drizzleBornThrough(count, file).close();
	return file;
}

const fullLedger = ledgerRows(drizzleBornThrough(TAGS.length));
const fullShape = shapeOf(drizzleBornThrough(TAGS.length));
const ledgerOf = (file: string) => inspect(file, ledgerRows);
const schemaOf = (file: string) =>
	inspect(file, (db) =>
		db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
	);

afterAll(() => {
	for (const db of open) db.close();
});

describe("migration ledger boot: acceptance A, a Drizzle-born database that the legacy init topped up", () => {
	// Birth points through the journal, by tag index.
	for (const idx of [0, 2, 5, 8, 11, 14, 17, 20]) {
		const count = idx + 1;
		itBoot(
			`born at ${TAGS[idx]}: legacy boot, then forced boot`,
			async () => {
				const file = bornFile(count);
				// The fixture is what it claims: its ledger stops here, and a later migration's table isn't there.
				const rows = ledgerOf(file);
				expect(rows.length).toBe(count);
				expect(rows.at(-1)?.created_at).toBe(journalOf().entries[idx]?.when as number);
				expect(
					inspect(file, (db) =>
						db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fork_tool_calls'").get(),
					),
				).toBeNull();

				expectHealthy(file, await boot(file), "legacy");
				expect(ledgerOf(file)).toEqual(fullLedger);

				const second = await boot(file, { forced: true });
				expectHealthy(file, second, "forced");
				expect(ledgerOf(file)).toEqual(fullLedger);
				expect(missingFrom(inspect(file, shapeOf), fullShape)).toEqual([]);
			},
			60_000,
		);
	}
});

describe("migration ledger boot: acceptance B, a Drizzle-born database whose ledger is gone", () => {
	itBoot("rows deleted: a forced boot records every entry", async () => {
		const file = bornFile(TAGS.length);
		const db = new Database(file);
		db.exec("DELETE FROM __drizzle_migrations");
		db.close();
		expectHealthy(file, await boot(file, { forced: true }), "forced");
		expect(ledgerOf(file)).toEqual(fullLedger);
	});

	itBoot("table dropped: a forced boot records every entry", async () => {
		const file = bornFile(TAGS.length);
		const db = new Database(file);
		db.exec("DROP TABLE __drizzle_migrations");
		db.close();
		expectHealthy(file, await boot(file, { forced: true }), "forced");
		expect(ledgerOf(file)).toEqual(fullLedger);
	});
});

describe("migration ledger boot: the rest", () => {
	itBoot(
		"a clean older database goes through drizzle, not through the legacy init",
		async () => {
			const file = bornFile(9, "older");
			const seed = new Database(file);
			seed.exec(
				"INSERT INTO sessions (id, session_id, agent_type) VALUES ('s1', 's1', 'claude_code'); INSERT INTO watcher_proposals (id, session_id, provider_id, state) VALUES ('p1', 's1', 'x', 'hitl_waiting')",
			);
			seed.close();

			const r = await boot(file, { forced: true, vector: true });
			expectHealthy(file, r, "forced");
			// Reconcile recorded nothing (the ledger stood at 0008) and drizzle applied 0009 onward.
			expect(r.out).toContain("verified through 0008_supervisor_exclude_rules_state; recorded 0");
			expect(ledgerOf(file)).toEqual(fullLedger);
			inspect(file, (db) => {
				// Only the legacy path creates the vector delete trigger and backfills a HITL request.
				expect(
					db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trg_events_ad_embeddings'").get(),
				).toBeNull();
				expect(db.prepare("SELECT count(*) AS n FROM ai_hitl_requests").get()).toEqual({ n: 0 });
				expect(
					db
						.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'reported_host'")
						.get(),
				).not.toBeNull();
			});
		},
		60_000,
	);

	itBoot(
		"a second forced boot records nothing and changes nothing",
		async () => {
			const file = bornFile(6);
			expectHealthy(file, await boot(file), "legacy");
			expectHealthy(file, await boot(file, { forced: true }), "forced");
			const schema = schemaOf(file);
			const ledger = ledgerOf(file);
			const again = await boot(file, { forced: true });
			expectHealthy(file, again, "forced");
			expect(again.out).toContain("verified through 0022_fork_tool_calls; recorded 0");
			expect(schemaOf(file)).toEqual(schema);
			expect(ledgerOf(file)).toEqual(ledger);
		},
		60_000,
	);

	itBoot("a fresh install never reconciles: the ledger is drizzle's alone", async () => {
		const file = fileIn("fresh");
		const r = await boot(file, { forced: true });
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("Fresh SQLite install");
		expect(r.out).not.toContain("migration ledger (");
		expect(ledgerOf(file)).toEqual(fullLedger);
	});

	itBoot(
		"legacy, forced, legacy, forced: every boot works and nothing changes after the first",
		async () => {
			const file = bornFile(3);
			expectHealthy(file, await boot(file), "legacy");
			const schema = schemaOf(file);
			const ledger = ledgerOf(file);
			expect(ledger).toEqual(fullLedger);
			for (const forced of [true, false, true]) {
				expectHealthy(file, await boot(file, { forced }), forced ? "forced" : "legacy");
				expect(ledgerOf(file)).toEqual(ledger);
				expect(schemaOf(file)).toEqual(schema);
			}
		},
		60_000,
	);

	itBoot(
		"recovery: a refused forced boot, a legacy boot, then a forced boot that works",
		async () => {
			const file = fileIn("recovery");
			writePreexistingInstallFile(file);
			expectHealthy(file, await boot(file), "legacy");
			const db = new Database(file);
			db.exec("DROP TABLE __drizzle_migrations; DROP INDEX idx_control_actions_session");
			db.close();

			const refused = await boot(file, { forced: true });
			expect(refused.code).toBe(1);
			expect(refused.err).toContain("[boot]");
			expect(refused.err).toContain("0022_fork_tool_calls");
			expect(refused.err).toContain("0.11.0");
			expect(refused.err).not.toContain("    at ");
			// It wrote nothing.
			expect(
				inspect(file, (d) =>
					d.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
				),
			).toBeNull();

			expectHealthy(file, await boot(file), "legacy");
			expectHealthy(file, await boot(file, { forced: true }), "forced");
			expect(ledgerOf(file)).toEqual(fullLedger);
		},
		60_000,
	);

	itBoot(
		"a migration shipped after this release: legacy names it, forced applies it, a partial one is refused",
		async () => {
			const folder = mkdtempSync(join(TMP, "future-"));
			const migrations = join(folder, "drizzle", "sqlite");
			mkdirSync(join(folder, "drizzle"), { recursive: true });
			cpSync(MIGRATIONS_DIR, migrations, { recursive: true });
			const journalPath = join(migrations, "meta", "_journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf8"));
			const tail = journal.entries.at(-1);
			journal.entries.push({
				idx: tail.idx + 1,
				version: "6",
				when: tail.when + 1000,
				tag: "0023_ledger_probe",
				breakpoints: true,
			});
			writeFileSync(journalPath, JSON.stringify(journal));
			writeFileSync(
				join(migrations, "0023_ledger_probe.sql"),
				"ALTER TABLE `sessions` ADD `ledger_probe` text;--> statement-breakpoint\nCREATE TABLE `ledger_probe_t` (`id` integer PRIMARY KEY NOT NULL);",
			);

			const file = fileIn("future");
			writePreexistingInstallFile(file);
			expectHealthy(file, await boot(file), "legacy");
			expect(ledgerOf(file).length).toBe(TAGS.length);
			const withPartial = fileIn("future-partial");
			writePreexistingInstallFile(withPartial);
			expectHealthy(withPartial, await boot(withPartial), "legacy");

			const legacyBoot = await boot(file, { cwd: folder });
			expectHealthy(file, legacyBoot, "legacy");
			expect(legacyBoot.out).toContain(
				"verified through 0022_fork_tool_calls; recorded 0; first unverified 0023_ledger_probe",
			);
			expect(ledgerOf(file).length).toBe(TAGS.length);

			const forcedBoot = await boot(file, { cwd: folder, forced: true });
			expectHealthy(file, forcedBoot, "forced");
			expect(ledgerOf(file).length).toBe(TAGS.length + 1);
			expect(
				inspect(file, (d) =>
					d
						.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'ledger_probe'")
						.get(),
				),
			).not.toBeNull();

			// The same migration half applied: the column is there and the ledger doesn't cover it.
			const partial = new Database(withPartial);
			partial.exec("ALTER TABLE sessions ADD COLUMN ledger_probe text");
			partial.close();
			const refused = await boot(withPartial, { cwd: folder, forced: true });
			expect(refused.code).toBe(1);
			expect(refused.err).toContain("0023_ledger_probe");
			expect(ledgerOf(withPartial).length).toBe(TAGS.length);
		},
		90_000,
	);

	itBoot(
		"the embeddings table and scan index exist on the legacy path whatever the vector flag says",
		async () => {
			const off = fileIn("vector-off");
			writePreexistingInstallFile(off);
			expectHealthy(off, await boot(off), "legacy");
			const names = (file: string, type: string) =>
				inspect(file, (d) =>
					(
						d.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as {
							name: string;
						}[]
					).map((r) => r.name),
				);
			expect(names(off, "table")).toContain("event_embeddings");
			expect(names(off, "index")).toContain("idx_event_embeddings_model_dim_event");
			expect(names(off, "index")).not.toContain("idx_event_embeddings_model");
			expect(names(off, "trigger")).not.toContain("trg_events_ad_embeddings");

			const on = fileIn("vector-on");
			writePreexistingInstallFile(on);
			expectHealthy(on, await boot(on, { vector: true }), "legacy");
			expect(names(on, "table")).toContain("event_embeddings");
			expect(names(on, "index")).toContain("idx_event_embeddings_model_dim_event");
			expect(names(on, "index")).toContain("idx_event_embeddings_model");
			expect(names(on, "trigger")).toContain("trg_events_ad_embeddings");
		},
		60_000,
	);

	itBoot(
		"two boots at once, both reconciling an installed database, leave one row per migration",
		async () => {
			// Two boots racing on a file that has no schema yet can fail in the legacy init itself with
			// "database schema has changed" (it predates the ledger), so the race starts from an installed
			// database whose ledger is missing.
			for (let round = 0; round < 3; round++) {
				const file = fileIn(`race-${round}`);
				writePreexistingInstallFile(file);
				expectHealthy(file, await boot(file), "legacy");
				const db = new Database(file);
				db.exec("DROP TABLE __drizzle_migrations");
				db.close();
				const [a, b] = await Promise.all([boot(file), boot(file)]);
				expect(a.code, `${a.out}\n${a.err}`).toBe(0);
				expect(b.code, `${b.out}\n${b.err}`).toBe(0);
				const rows = ledgerOf(file);
				expect(rows.length).toBe(TAGS.length);
				expect(new Set(rows.map((r) => r.created_at)).size).toBe(TAGS.length);
			}
		},
		120_000,
	);
});

/** A copy of the migrations folder, under a working directory's drizzle/sqlite, with one more entry after the tail. */
function folderWithFutureEntry(sql: string): string {
	const folder = mkdtempSync(join(TMP, "future-"));
	const migrations = join(folder, "drizzle", "sqlite");
	mkdirSync(join(folder, "drizzle"), { recursive: true });
	cpSync(MIGRATIONS_DIR, migrations, { recursive: true });
	const journalPath = join(migrations, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));
	const tail = journal.entries.at(-1);
	journal.entries.push({
		idx: tail.idx + 1,
		version: "6",
		when: tail.when + 1000,
		tag: "0023_future",
		breakpoints: true,
	});
	writeFileSync(journalPath, JSON.stringify(journal));
	writeFileSync(join(migrations, "0023_future.sql"), sql);
	return folder;
}

describe("migration ledger boot: audit fixes", () => {
	itBoot(
		"a leftover __new_ table: the forced boot refuses cleanly and records nothing",
		async () => {
			const folder = folderWithFutureEntry(
				"CREATE TABLE `__new_lp` (`id` integer PRIMARY KEY NOT NULL);--> statement-breakpoint\nALTER TABLE `__new_lp` RENAME TO `lp`;",
			);
			const file = fileIn("leftover");
			writePreexistingInstallFile(file);
			expectHealthy(file, await boot(file), "legacy");
			const db = new Database(file);
			db.exec("DROP TABLE __drizzle_migrations; CREATE TABLE __new_lp (id integer)");
			db.close();

			const refused = await boot(file, { cwd: folder, forced: true });
			expect(refused.code).toBe(1);
			expect(refused.err).toContain("[boot]");
			expect(refused.err).toContain("__new_lp");
			expect(refused.err).not.toContain("    at ");
			// Nothing was written: the ledger table was not even recreated.
			expect(
				inspect(file, (d) =>
					d.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
				),
			).toBeNull();
		},
	);

	itBoot(
		"a ledger row past the tail with a verified schema: the forced boot proceeds",
		async () => {
			const file = bornFile(TAGS.length, "newer");
			const db = new Database(file);
			db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?)").run(
				(journalOf().entries.at(-1)?.when as number) + 5000,
			);
			db.close();
			const r = await boot(file, { forced: true });
			expectHealthy(file, r, "forced");
			expect(r.out).toContain("1 ledger row(s) from a newer release");
			expect(ledgerOf(file).length).toBe(TAGS.length + 1);
		},
	);

	itBoot(
		"two forced boots at once from an older database: no corruption, a loser fails and a restart works",
		async () => {
			// Two processes on one SQLite file is outside the supported deployment (one process per file). What
			// this shows is that the worst case is a failed boot: migrate() reads its ledger before it begins, so
			// the loser can replay a migration the winner just applied, and its transaction rolls back.
			for (let round = 0; round < 3; round++) {
				const file = bornFile(1, `race-forced-${round}`);
				const [a, b] = await Promise.all([
					boot(file, { forced: true }),
					boot(file, { forced: true }),
				]);
				expect(
					[a.code, b.code].every((c) => c === 0 || c === 1),
					`${a.err}\n${b.err}`,
				).toBe(true);
				expect([a.code, b.code]).toContain(0);
				for (const r of [a, b]) {
					if (r.code === 1) expect(r.err).toMatch(/duplicate column|already exists|locked|busy/i);
				}
				inspect(file, (d) => {
					expect(d.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
					expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
				});
				// The ledger is one row per migration, whoever won.
				expect(ledgerOf(file)).toEqual(fullLedger);
				// A restart works.
				expectHealthy(file, await boot(file, { forced: true }), "forced");
				expect(ledgerOf(file)).toEqual(fullLedger);
			}
		},
		180_000,
	);
});

describe("migration ledger boot: wiring", () => {
	itBoot("the legacy boot logs one line and goes on when the ledger can't be written", async () => {
		const db = track(await legacyBuiltDb());
		db.exec(
			`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
			 CREATE TRIGGER stop_at_three BEFORE INSERT ON __drizzle_migrations
			 WHEN (SELECT count(*) FROM __drizzle_migrations) = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		);
		const { initializeDatabase } = await import("./client.js");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await initializeDatabase(db);
			const lines = warn.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("migration ledger not updated"));
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("boom");
		} finally {
			warn.mockRestore();
			log.mockRestore();
		}
		expect(db.inTransaction).toBe(false);
		expect(ledgerRows(db)).toEqual([]);
	});
});

test("index.ts ends a MigrationLedgerError boot with the message and exit 1, not a stack trace", () => {
	const index = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");
	const boot = index.slice(index.indexOf("await initializeDatabase()") - 10);
	const handler = boot.slice(0, boot.indexOf("await normalizeStoredMachineNamesSafely()"));
	expect(handler).toContain("err instanceof MigrationLedgerError");
	expect(handler).toContain("console.error(");
	expect(handler).toContain("process.exit(1)");
});

describe("sqlite migration ledger: boot routing invariant", () => {
	const root = resolve(import.meta.dir, "../../..");

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) return sourceFiles(full);
			return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/test-utils/")
				? [full]
				: [];
		});
	}

	test("the only SQLite migrate() call sits behind a forced reconcile for existing installs", () => {
		const importers = sourceFiles(join(root, "src")).filter((f) =>
			readFileSync(f, "utf8").includes("drizzle-orm/bun-sqlite/migrator"),
		);
		expect(importers.map((f) => f.slice(root.length + 1))).toEqual(["src/server/db/client.ts"]);

		const client = readFileSync(join(root, "src/server/db/client.ts"), "utf8");
		const imports = client.match(/import\("drizzle-orm\/bun-sqlite\/migrator"\)/g) ?? [];
		expect(imports.length).toBe(1);
		const afterImport = client.slice(client.indexOf('import("drizzle-orm/bun-sqlite/migrator")'));
		const call = afterImport.search(/^\s*migrate\(/m);
		expect(call).toBeGreaterThan(0);
		const before = afterImport.slice(0, call);
		expect(before).toContain("if (isExistingInstall)");
		expect(before).toContain("reconcileSqliteMigrationLedger(");
		expect(before).toContain('"forced"');
		// Exactly one SQLite migrate call after that import (the Postgres migrator is imported earlier).
		expect(afterImport.match(/^\s*migrate\(/gm)?.length).toBe(1);
	});
});
