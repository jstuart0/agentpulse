/**
 * Fixtures for the SQLite migration ledger tests: databases at known points in the journal, built the
 * way each kind of install is really built (drizzle's own `migrate()` for a Drizzle-born one, the legacy
 * init for a legacy-born one), and synthetic migration folders for cases the shipped journal can't show.
 * Not a test file. Callers import "../db/__test_db.js" first, as every DB test does.
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { preexistingInstall } from "./legacy-install.js";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../drizzle/sqlite");
const SCRATCH = mkdtempSync(join(tmpdir(), "ap-ledger-fixtures-"));

export interface JournalEntry {
	idx: number;
	tag: string;
	when: number;
	version: string;
	breakpoints: boolean;
}

export function journalOf(folder = MIGRATIONS_DIR): { entries: JournalEntry[] } {
	return JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
}

const truncated = new Map<string, string>();

/** A copy of the shipped migrations folder whose journal stops after `count` entries. */
export function truncatedFolder(count: number, base = MIGRATIONS_DIR): string {
	const memoKey = `${base}:${count}`;
	const hit = truncated.get(memoKey);
	if (hit) return hit;
	const dir = mkdtempSync(join(SCRATCH, "trunc-"));
	cpSync(base, dir, { recursive: true });
	const path = join(dir, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] };
	for (const dropped of journal.entries.slice(count)) unlinkSync(join(dir, `${dropped.tag}.sql`));
	writeFileSync(path, JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
	truncated.set(memoKey, dir);
	return dir;
}

/** A database drizzle's own `migrate()` built through the first `count` journal entries. */
export function drizzleBornThrough(
	count: number,
	path = ":memory:",
	base = MIGRATIONS_DIR,
): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	migrate(drizzle(db), { migrationsFolder: truncatedFolder(count, base) });
	return db;
}

let legacyTemplate: Uint8Array | undefined;

/**
 * A database the legacy init built from an old install's `sessions` table, with its ledger removed: the
 * schema of a legacy-path install, and nothing in `__drizzle_migrations`. Built once, copied per test.
 */
export async function legacyBuiltDb(): Promise<Database> {
	return Database.deserialize(await legacyBuiltImage());
}

/** The same database as a file image, for tests that need two connections to one file. */
export async function legacyBuiltFile(path: string): Promise<void> {
	writeFileSync(path, await legacyBuiltImage());
}

async function legacyBuiltImage(): Promise<Uint8Array> {
	if (!legacyTemplate) {
		const { initializeDatabase } = await import("../db/client.js");
		const built = preexistingInstall();
		await initializeDatabase(built);
		built.exec("DROP TABLE IF EXISTS __drizzle_migrations");
		legacyTemplate = built.serialize();
		built.close();
	}
	return legacyTemplate;
}

/** A migrations folder holding exactly these files, journal times 1 s apart from a fixed start. */
export function syntheticFolder(files: ReadonlyArray<{ tag: string; sql: string }>): string {
	const dir = mkdtempSync(join(SCRATCH, "synthetic-"));
	mkdirSync(join(dir, "meta"));
	const entries = files.map((f, idx) => ({
		idx,
		version: "6",
		when: 1_800_000_000_000 + idx * 1000,
		tag: f.tag,
		breakpoints: true,
	}));
	writeFileSync(
		join(dir, "meta", "_journal.json"),
		JSON.stringify({ version: "7", dialect: "sqlite", entries }),
	);
	for (const f of files) writeFileSync(join(dir, `${f.tag}.sql`), f.sql);
	return dir;
}

/** The ledger rows in insertion order, as drizzle wrote them. */
export function ledgerRows(db: Database): Array<{ hash: string; created_at: number }> {
	const exists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'")
		.get();
	if (!exists) return [];
	return db
		.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id")
		.all() as Array<{
		hash: string;
		created_at: number;
	}>;
}
