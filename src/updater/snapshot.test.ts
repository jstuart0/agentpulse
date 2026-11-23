import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOf } from "../shared/db-fingerprint.js";
import { SnapshotError, fingerprintOfFile, restoreSnapshot, takeSnapshot } from "./snapshot.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ap-snap-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A WAL database whose rows live only in the WAL, copied out while its writer is still open: what a hard stop leaves. */
function walOnlyDatabase(): string {
	const live = join(root, "live");
	mkdirSync(live);
	const path = join(live, "agentpulse.db");
	const db = new Database(path, { create: true });
	db.run("PRAGMA journal_mode=WAL");
	db.run("PRAGMA wal_autocheckpoint=0");
	db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
	db.run("INSERT INTO settings VALUES ('installation_id', 'abc-123')");
	db.run("CREATE TABLE t (n INTEGER)");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	for (let i = 0; i < 25; i++) db.run("INSERT INTO t VALUES (?)", [i]);
	const copy = join(root, "crashed");
	mkdirSync(copy);
	const target = join(copy, "agentpulse.db");
	copyFileSync(path, target);
	if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${target}-wal`);
	db.close();
	return target;
}

function rows(path: string): number {
	const db = new Database(path, { readwrite: true });
	try {
		return (db.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
	} finally {
		db.close();
	}
}

describe("snapshot", () => {
	test("rows left un-checkpointed in the WAL survive the snapshot", async () => {
		const db = walOnlyDatabase();
		expect(existsSync(`${db}-wal`)).toBe(true);
		// the main file alone doesn't hold them (control: the WAL is what carries the rows)
		const alone = join(root, "alone.db");
		copyFileSync(db, alone);
		expect(rows(alone)).toBeLessThan(25);
		const path = await takeSnapshot({
			sqlitePath: db,
			dir: join(root, "snaps"),
			version: "0.13.0",
			now: 1,
			expectedFingerprint: await fingerprintOf("abc-123"),
		});
		expect(rows(path)).toBe(25);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "snaps")).mode & 0o777).toBe(0o700);
	});

	test("a cleanly stopped WAL database (no -wal, no -shm) can be snapshotted", async () => {
		const clean = join(root, "clean.db");
		const db = new Database(clean, { create: true });
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
		db.run("INSERT INTO settings VALUES ('installation_id', 'abc-123')");
		db.run("CREATE TABLE t (n INTEGER)");
		db.run("INSERT INTO t VALUES (1)");
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		// what a clean stop leaves: the sidecars are gone
		rmSync(`${clean}-wal`, { force: true });
		rmSync(`${clean}-shm`, { force: true });
		expect(existsSync(`${clean}-wal`)).toBe(false);
		const path = await takeSnapshot({
			sqlitePath: clean,
			dir: join(root, "snaps"),
			version: "0.13.0",
			now: 1,
			expectedFingerprint: await fingerprintOf("abc-123"),
		});
		expect(rows(path)).toBe(1);
	});

	test("a fingerprint that isn't the running server's is db_path_mismatch, and nothing is written", async () => {
		const db = walOnlyDatabase();
		const err = await takeSnapshot({
			sqlitePath: db,
			dir: join(root, "snaps"),
			version: "0.13.0",
			now: 1,
			expectedFingerprint: "000000000000",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SnapshotError);
		expect((err as SnapshotError).code).toBe("db_path_mismatch");
		expect(existsSync(join(root, "snaps"))).toBe(false);
	});

	test("a missing database is snapshot_failed", async () => {
		const err = await takeSnapshot({
			sqlitePath: join(root, "nope.db"),
			dir: join(root, "snaps"),
			version: "0.13.0",
			now: 1,
			expectedFingerprint: null,
		}).catch((e) => e);
		expect((err as SnapshotError).code).toBe("snapshot_failed");
	});

	test("only the newest two snapshots are kept", async () => {
		const db = walOnlyDatabase();
		for (const now of [1, 2, 3]) {
			await takeSnapshot({
				sqlitePath: db,
				dir: join(root, "snaps"),
				version: "0.13.0",
				now,
				expectedFingerprint: null,
			});
			await new Promise((r) => setTimeout(r, 15));
		}
		expect(readdirSync(join(root, "snaps")).sort()).toEqual(["0.13.0-2.db", "0.13.0-3.db"]);
	});

	test("fingerprintOfFile reads the installation id", async () => {
		const db = walOnlyDatabase();
		expect(await fingerprintOfFile(db)).toBe(await fingerprintOf("abc-123"));
		expect(await fingerprintOfFile(join(root, "missing.db"))).toBeNull();
	});
});

describe("restore", () => {
	test("replaces the database, removes stale -wal and -shm, and the result checks out", async () => {
		const db = walOnlyDatabase();
		const snap = await takeSnapshot({
			sqlitePath: db,
			dir: join(root, "snaps"),
			version: "0.13.0",
			now: 1,
			expectedFingerprint: null,
		});
		// the live database has since been written to, and has stale sidecars
		writeFileSync(`${db}-wal`, "garbage");
		writeFileSync(`${db}-shm`, "garbage");
		writeFileSync(`${db}-journal`, "garbage");
		expect(restoreSnapshot(snap, db)).toBe(true);
		expect(existsSync(`${db}-wal`)).toBe(false);
		expect(existsSync(`${db}-shm`)).toBe(false);
		expect(existsSync(`${db}-journal`)).toBe(false);
		expect(rows(db)).toBe(25);
		expect(readdirSync(join(root, "crashed")).filter((n) => n.includes("restore"))).toEqual([]);
	});

	test("a corrupt snapshot isn't restored and the live database is untouched", async () => {
		const db = walOnlyDatabase();
		const before = readdirSync(join(root, "crashed")).sort();
		const bad = join(root, "bad.db");
		writeFileSync(bad, "this is not a database".repeat(100));
		expect(restoreSnapshot(bad, db)).toBe(false);
		expect(readdirSync(join(root, "crashed")).sort()).toEqual(before);
	});
});
