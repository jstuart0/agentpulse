/**
 * The SQLite snapshot and restore around an update that adds a migration (U16).
 *
 * Only called after both services are confirmed gone. The database is opened for reading and writing (never
 * created): a read-only open of a WAL database whose sidecars are gone, as after a clean stop, can't be made at
 * all. Opening replays the committed WAL frames, so a snapshot is complete even when the WAL was never
 * checkpointed. The installation id is read and turned into the same fingerprint /health reports, and
 * `VACUUM INTO` writes a private copy that must pass `integrity_check` before anything is renamed. Restore
 * copies the snapshot to a temp file in the database's own directory, fsyncs it, deletes the stale `-wal`,
 * `-shm` and `-journal`, renames the temp over the database and checks it again: the live file is never
 * absent, and a restore that doesn't check out is reported, never started on.
 */
import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { INSTALLATION_ID_KEY, fingerprintOf } from "../shared/db-fingerprint.js";

export type SnapshotFailure = "db_path_mismatch" | "snapshot_failed";

export class SnapshotError extends Error {
	constructor(readonly code: SnapshotFailure) {
		super(code);
	}
}

/** The fingerprint of the database at `path`, or null when it has no installation id or can't be read. */
export async function fingerprintOfFile(path: string): Promise<string | null> {
	let db: Database | null = null;
	try {
		db = new Database(path, { readwrite: true });
		const row = db.query("SELECT value FROM settings WHERE key = ?").get(INSTALLATION_ID_KEY) as {
			value?: unknown;
		} | null;
		return typeof row?.value === "string" && row.value ? await fingerprintOf(row.value) : null;
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

function integrityOk(path: string): boolean {
	let db: Database | null = null;
	try {
		db = new Database(path, { readwrite: true });
		const rows = db.query("PRAGMA integrity_check").all() as { integrity_check?: string }[];
		return rows.length === 1 && rows[0]?.integrity_check === "ok";
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

/** Keeps the newest `keep` snapshots (by name, which starts with the version and ends with a sortable time). */
export function pruneSnapshots(dir: string, keep: number): void {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".db"));
	} catch {
		return;
	}
	const byAge = names
		.map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	for (const old of byAge.slice(keep)) rmSync(join(dir, old.name), { force: true });
}

/**
 * Snapshots `sqlitePath` into `dir`. Throws `SnapshotError`: `db_path_mismatch` when the file's fingerprint
 * isn't the one /health reported before the stop (the unit runs another database than the record names),
 * `snapshot_failed` for anything else, before any rename.
 */
export async function takeSnapshot(input: {
	sqlitePath: string;
	dir: string;
	version: string;
	now: number;
	expectedFingerprint: string | null;
}): Promise<string> {
	if (!existsSync(input.sqlitePath)) throw new SnapshotError("snapshot_failed");
	if (input.expectedFingerprint !== null) {
		const actual = await fingerprintOfFile(input.sqlitePath);
		if (actual !== input.expectedFingerprint) throw new SnapshotError("db_path_mismatch");
	}
	mkdirSync(input.dir, { recursive: true, mode: 0o700 });
	chmodSync(input.dir, 0o700);
	const target = join(input.dir, `${input.version}-${input.now}.db`);
	let db: Database | null = null;
	try {
		db = new Database(input.sqlitePath, { readwrite: true });
		db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
	} catch {
		rmSync(target, { force: true });
		throw new SnapshotError("snapshot_failed");
	} finally {
		db?.close();
	}
	chmodSync(target, 0o600);
	if (!integrityOk(target)) {
		rmSync(target, { force: true });
		throw new SnapshotError("snapshot_failed");
	}
	pruneSnapshots(input.dir, 2);
	return target;
}

/** Puts `snapshot` back as `sqlitePath`. Returns false when the snapshot is unreadable or the restored file doesn't check out. */
export function restoreSnapshot(snapshot: string, sqlitePath: string): boolean {
	const temp = join(dirname(sqlitePath), `.${basename(sqlitePath)}.restore-${process.pid}`);
	try {
		if (!integrityOk(snapshot)) return false;
		copyFileSync(snapshot, temp);
		chmodSync(temp, 0o600);
		const fd = openSync(temp, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		for (const suffix of ["-wal", "-shm", "-journal"])
			rmSync(`${sqlitePath}${suffix}`, { force: true });
		renameSync(temp, sqlitePath);
		return integrityOk(sqlitePath);
	} catch {
		rmSync(temp, { force: true });
		return false;
	}
}
