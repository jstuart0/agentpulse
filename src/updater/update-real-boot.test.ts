/**
 * The real server, booted by the updater's own smoke-boot function. The end-to-end test uses a fixture server to
 * test ordering; this one proves what the fixture can't: that `src/server/index.ts` at HEAD starts under the
 * smoke environment's allowlist (no secrets, loopback, auth on, update check off) on a database copy that is one
 * migration behind, migrates it, and answers /health as the version in package.json.
 *
 * A `git archive` of HEAD is unpacked into a scratch staging tree and the worktree's own node_modules is linked
 * in (no network). If this ever measures over 60 s it moves to `test:slow`, which ci.yml runs on every pull
 * request; that move is recorded in the commit, never a silent skip.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fetchCapped } from "../shared/capped-fetch.js";
import { smokeBoot } from "./smoke.js";

const REPO = join(import.meta.dir, "..", "..");
let scratch: string;
let staging: string;
let olderDb: string;
let journalEntries: { tag: string; when: number }[];

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "ap-realboot-"));
	staging = join(scratch, "staging");
	mkdirSync(staging);
	const archive = Bun.spawnSync(["git", "-C", REPO, "archive", "HEAD"], { stdout: "pipe" });
	if (archive.exitCode !== 0) throw new Error("git archive failed");
	writeFileSync(join(scratch, "tree.tar"), archive.stdout);
	const untar = Bun.spawnSync(["tar", "-xf", join(scratch, "tree.tar"), "-C", staging]);
	if (untar.exitCode !== 0) throw new Error("tar failed");
	symlinkSync(join(REPO, "node_modules"), join(staging, "node_modules"));

	// A database migrated to the second-to-last journal entry only.
	const journal = JSON.parse(
		readFileSync(join(staging, "drizzle", "sqlite", "meta", "_journal.json"), "utf-8"),
	);
	journalEntries = journal.entries;
	const older = join(scratch, "older-migrations");
	mkdirSync(join(older, "meta"), { recursive: true });
	const kept = journal.entries.slice(0, -1);
	for (const entry of kept) {
		writeFileSync(
			join(older, `${entry.tag}.sql`),
			readFileSync(join(staging, "drizzle", "sqlite", `${entry.tag}.sql`)),
		);
	}
	writeFileSync(
		join(older, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: kept }),
	);
	olderDb = join(scratch, "older.db");
	const sqlite = new Database(olderDb, { create: true });
	migrate(drizzle(sqlite), { migrationsFolder: older });
	sqlite.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const smokeDirs = () =>
	new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("agentpulse-smoke-")));

describe("the real server under the smoke environment", () => {
	test("boots a one-migration-behind copy, migrates it, and answers /health as package.json's version", async () => {
		const before = smokeDirs();
		const version = JSON.parse(readFileSync(join(staging, "package.json"), "utf-8"))
			.version as string;
		const ledgerBefore = new Database(olderDb, { readwrite: true });
		const rowsBefore = (
			ledgerBefore.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }
		).n;
		ledgerBefore.close();
		expect(rowsBefore).toBe(journalEntries.length - 1);

		const result = await smokeBoot({
			stagingDir: staging,
			entry: join("src", "server", "index.ts"),
			bunBin: process.execPath,
			sqlitePath: olderDb,
			targetVersion: version,
			// secrets in the parent environment must not reach the server
			parentEnv: {
				PATH: process.env.PATH,
				ANTHROPIC_API_KEY: "leak",
				AGENTPULSE_SECRETS_KEY: "leak",
				TELEGRAM_BOT_TOKEN: "leak",
			},
			fetchText: fetchCapped,
			timeoutMs: 60_000,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			now: Date.now,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// named member: the ledger is at the last migration, with the last migration's own time
		expect(result.ledger?.count).toBe(journalEntries.length);
		expect(result.ledger?.lastCreatedAt).toBe(
			journalEntries[journalEntries.length - 1]?.when as number,
		);
		// the copy is deleted, and the child is gone (stopped by its handle)
		expect([...smokeDirs()].filter((d) => !before.has(d))).toEqual([]);
		expect(
			await fetchCapped(`http://127.0.0.1:${result.port}/api/v1/health`, {
				deadlineMs: 1500,
				maxBytes: 65536,
			}),
		).toMatchObject({ ok: false });
		// the original database was only read
		const after = new Database(olderDb, { readwrite: true });
		expect(
			(after.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n,
		).toBe(rowsBefore);
		after.close();
		expect(existsSync(join(staging, "data"))).toBe(false);
	}, 120_000);

	test("a server that never reports the target version is a smoke failure", async () => {
		const result = await smokeBoot({
			stagingDir: staging,
			entry: join("src", "server", "index.ts"),
			bunBin: process.execPath,
			sqlitePath: olderDb,
			targetVersion: "99.0.0",
			parentEnv: { PATH: process.env.PATH },
			fetchText: fetchCapped,
			timeoutMs: 15_000,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			now: Date.now,
		});
		expect(result.ok).toBe(false);
	}, 60_000);
});
