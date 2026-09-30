/**
 * AGEN-54: run-backup.sh must snapshot via `VACUUM INTO` instead of
 * sqlite3's `.backup` command, which livelocks under sustained concurrent
 * write load (observed stalled >20min in production; 12-15h completions in
 * backup history). This exercises the real script as a subprocess against a
 * temp SQLite DB with a concurrent writer running throughout, and asserts:
 * bounded completion time, a passing integrity_check on the output,
 * row count >= the pre-start count, retention still applied, and that a
 * forced failure leaves no .tmp file behind and prior backups untouched.
 *
 * SRC/BACKUP_DIR/RETENTION_SCRIPT are supplied via env overrides
 * (AGENTPULSE_BACKUP_SRC / AGENTPULSE_BACKUP_DIR / AGENTPULSE_RETENTION_SCRIPT)
 * so the script never touches its hardcoded production paths (/data,
 * /backups) during the test — everything lives under a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "run-backup.sh");
const RETENTION_SCRIPT = join(import.meta.dir, "retention.sh");
const RUN_TIMEOUT = 30_000;
const BOUNDED_MS = 15_000;

async function sqlite(dbPath: string, sql: string): Promise<string> {
	const proc = Bun.spawn(["sqlite3", dbPath, sql], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`sqlite3 failed: ${err || out}`);
	return out;
}

function runBackup(env: Record<string, string>) {
	const proc = Bun.spawn(["sh", SCRIPT], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
	});
	return proc;
}

async function collect(proc: ReturnType<typeof Bun.spawn>) {
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, out: out + err };
}

const dirs: string[] = [];

afterEach(async () => {
	while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function tmpRoot(prefix: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

async function writeStub(dir: string, name: string, content: string) {
	const path = join(dir, name);
	await Bun.write(path, content);
	await Bun.$`chmod +x ${path}`.quiet();
	return path;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `dir` until an entry matching `suffix` appears, or times out. */
async function waitForEntry(dir: string, suffix: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entries = await readdir(dir).catch(() => [] as string[]);
		const found = entries.find((f) => f.endsWith(suffix));
		if (found) return found;
		await sleep(5);
	}
	throw new Error(`timed out waiting for an entry ending in ${suffix} in ${dir}`);
}

describe("run-backup.sh (AGEN-54: VACUUM INTO)", () => {
	test(
		"completes under concurrent writes, passes integrity_check, preserves rows, applies retention",
		async () => {
			const root = await tmpRoot("ap-backup-vacuum-");
			const dataDir = join(root, "data");
			const backupsDir = join(root, "backups");
			await Bun.write(join(dataDir, ".keep"), "");
			await Bun.write(join(backupsDir, ".keep"), "");
			const src = join(dataDir, "agentpulse.db");

			await sqlite(
				src,
				"PRAGMA journal_mode=WAL; CREATE TABLE sessions(id INTEGER PRIMARY KEY, x TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY, x TEXT); INSERT INTO sessions(x) VALUES ('seed');",
			);

			// Pre-seed 35 fake old backups, split across two distinct past
			// months, so retention.sh has real work to do: 30 are kept
			// unconditionally by rank, the newest-per-month becomes a
			// monthly survivor, and the remaining 6 oldest get removed.
			// Filenames encode the month (parsed by retention.sh); mtimes are
			// set to match so `ls -1t` ranks them in the same order the
			// filenames imply.
			// Build 15 Feb entries (day 15..1) then 20 Jan entries (day 20..1).
			const febDays = Array.from({ length: 15 }, (_, i) => 15 - i);
			const janDays = Array.from({ length: 20 }, (_, i) => 20 - i);
			const fakeDates: string[] = [
				...febDays.map((d) => `202002${String(d).padStart(2, "0")}`),
				...janDays.map((d) => `202001${String(d).padStart(2, "0")}`),
			];
			let mtimeCursor = new Date("2026-01-01T00:00:00Z").getTime();
			for (const ymd of fakeDates) {
				const name = `agentpulse-${ymd}T000000Z.db`;
				const path = join(backupsDir, name);
				await writeFile(path, "not a real db; retention.sh only stat/rm's this");
				mtimeCursor -= 1000;
				const mtime = new Date(mtimeCursor);
				await utimes(path, mtime, mtime);
			}
			// mtimeCursor is now strictly in the past for every fake file,
			// so today's real backup ranks newest without needing its own
			// explicit mtime.
			const preCount = fakeDates.length;
			expect(preCount).toBe(35);

			// Concurrent writer: inserts a row every ~50ms for the duration
			// of the backup run, simulating the sustained write load that
			// livelocked the old `.backup`-based script.
			const writer = Bun.spawn(
				[
					"sh",
					"-c",
					'i=0; while true; do i=$((i+1)); sqlite3 "$1" "PRAGMA busy_timeout=2000; INSERT INTO events(x) VALUES (\'w\'||$i);" >/dev/null 2>&1 || true; sleep 0.05; done',
					"writer",
					src,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);

			try {
				const preRow = await sqlite(src, "SELECT count(*) FROM events;");
				const preEventCount = Number.parseInt(preRow.trim(), 10);

				const start = Date.now();
				const proc = runBackup({
					AGENTPULSE_BACKUP_SRC: src,
					AGENTPULSE_BACKUP_DIR: backupsDir,
					AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
				});
				const { code, out } = await collect(proc);
				const elapsed = Date.now() - start;

				expect(code).toBe(0);
				expect(elapsed).toBeLessThan(BOUNDED_MS);
				expect(out).toContain("[backup] ok:");
				expect(out).toContain("[retention] done");

				const entries = await readdir(backupsDir);
				const dbFiles = entries.filter((f) => f.endsWith(".db"));
				const producedName = dbFiles.find((f) => !fakeDates.some((d) => f.includes(d)));
				expect(producedName).toBeDefined();
				const producedPath = join(backupsDir, producedName as string);

				const integrity = await sqlite(producedPath, "PRAGMA integrity_check;");
				expect(integrity.trim()).toBe("ok");

				const postRow = await sqlite(producedPath, "SELECT count(*) FROM events;");
				const postEventCount = Number.parseInt(postRow.trim(), 10);
				expect(postEventCount).toBeGreaterThanOrEqual(preEventCount);

				const sessionsRow = await sqlite(producedPath, "SELECT count(*) FROM sessions;");
				expect(Number.parseInt(sessionsRow.trim(), 10)).toBeGreaterThanOrEqual(1);

				// Retention applied: 35 fake + 1 real = 36 pre-existing
				// candidates; retention.sh keeps 30 by rank plus whatever
				// monthly survivors fall outside the top 30 (none extra here
				// since both fake months' survivors rank within the top 30),
				// so exactly 30 should remain and the 6 oldest fakes removed.
				expect(dbFiles.length).toBe(30);
				const oldestSixNames = fakeDates.slice(-6).map((ymd) => `agentpulse-${ymd}T000000Z.db`);
				for (const name of oldestSixNames) {
					expect(dbFiles).not.toContain(name);
				}
			} finally {
				writer.kill();
				await writer.exited;
			}
		},
		RUN_TIMEOUT,
	);

	test(
		"forced failure (read-only backup dir) leaves no .tmp file and prior backups untouched",
		async () => {
			const root = await tmpRoot("ap-backup-vacuum-fail-");
			const dataDir = join(root, "data");
			const backupsDir = join(root, "backups");
			await Bun.write(join(dataDir, ".keep"), "");
			await Bun.write(join(backupsDir, ".keep"), "");
			const src = join(dataDir, "agentpulse.db");

			await sqlite(
				src,
				"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
			);

			// A prior, already-completed backup that must survive untouched.
			const priorPath = join(backupsDir, "agentpulse-20260101T000000Z.db");
			await sqlite(priorPath, "CREATE TABLE sessions(id INTEGER PRIMARY KEY);");
			const before = await Bun.file(priorPath).text();

			await Bun.$`chmod 555 ${backupsDir}`.quiet();
			try {
				const proc = runBackup({
					AGENTPULSE_BACKUP_SRC: src,
					AGENTPULSE_BACKUP_DIR: backupsDir,
					AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
				});
				const { code, out } = await collect(proc);

				expect(code).not.toBe(0);
				expect(out).toContain("[backup] ERROR:");

				const after = await Bun.file(priorPath).text();
				expect(after).toBe(before);
			} finally {
				await Bun.$`chmod 755 ${backupsDir}`.quiet();
			}

			const entries = await readdir(backupsDir);
			const tmpFiles = entries.filter((f) => f.endsWith(".tmp"));
			expect(tmpFiles).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test("refuses a backup path containing a single quote", async () => {
		const root = await tmpRoot("ap-backup-vacuum-quote-");
		const dataDir = join(root, "data");
		const backupsDir = join(root, "back'up");
		await Bun.write(join(dataDir, ".keep"), "");
		await Bun.write(join(backupsDir, ".keep"), "");
		const src = join(dataDir, "agentpulse.db");
		await sqlite(
			src,
			"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
		);

		const proc = runBackup({
			AGENTPULSE_BACKUP_SRC: src,
			AGENTPULSE_BACKUP_DIR: backupsDir,
			AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
		});
		const { code, out } = await collect(proc);

		expect(code).toBe(4);
		expect(out).toContain("refusing unsafe backup path");

		const entries = await readdir(backupsDir);
		expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	test("fails clearly when the backup filesystem has insufficient free space", async () => {
		const root = await tmpRoot("ap-backup-vacuum-space-");
		const dataDir = join(root, "data");
		const backupsDir = join(root, "backups");
		await Bun.write(join(dataDir, ".keep"), "");
		await Bun.write(join(backupsDir, ".keep"), "");
		const src = join(dataDir, "agentpulse.db");
		await sqlite(
			src,
			"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
		);

		// Fabricate an impossible free-space requirement by pointing the
		// script's df check at the real backup dir but asserting the guard
		// logic directly is fragile across filesystems, so instead we grow
		// the "source" size reporting by asserting the documented exit code
		// is reachable: run the real preflight against a tiny available-space
		// ceiling is not portable to fake from userspace without a quota fs,
		// so this test targets the guard's boundary condition via a stub
		// `df` on PATH that reports near-zero availability.
		const stubDir = join(root, "stub-bin");
		await writeStub(
			stubDir,
			"df",
			'#!/bin/sh\nprintf "%s\\n" "Filesystem 1024-blocks Used Available Capacity Mounted on"\nprintf "%s\\n" "stub 1 1 0 100% /"\n',
		);

		const proc = Bun.spawn(["sh", SCRIPT], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				AGENTPULSE_BACKUP_SRC: src,
				AGENTPULSE_BACKUP_DIR: backupsDir,
				AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
			},
		});
		const { code, out } = await collect(proc);

		expect(code).toBe(3);
		expect(out).toContain("insufficient free space");

		const entries = await readdir(backupsDir);
		expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	test(
		"SIGTERM sent mid-run removes the in-flight .tmp file (AGEN-54 otto #1: trap)",
		async () => {
			const root = await tmpRoot("ap-backup-vacuum-sigterm-");
			const dataDir = join(root, "data");
			const backupsDir = join(root, "backups");
			await Bun.write(join(dataDir, ".keep"), "");
			await Bun.write(join(backupsDir, ".keep"), "");
			const src = join(dataDir, "agentpulse.db");

			// A DB large enough that VACUUM INTO takes a real, non-instant
			// amount of wall-clock time, so there is a genuine window in
			// which agentpulse-<TS>.db.tmp exists on disk before the whole
			// script would otherwise finish.
			await sqlite(
				src,
				"PRAGMA journal_mode=WAL; CREATE TABLE sessions(id INTEGER PRIMARY KEY, x TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY, x TEXT); INSERT INTO events(x) WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x<100000) SELECT hex(randomblob(400)) FROM cnt;",
			);

			const proc = Bun.spawn(["sh", SCRIPT], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					AGENTPULSE_BACKUP_SRC: src,
					AGENTPULSE_BACKUP_DIR: backupsDir,
					AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
				},
			});

			// Confirm we are genuinely interrupting an in-flight backup, not
			// racing a process that hasn't started sqlite3 yet or has already
			// finished.
			await waitForEntry(backupsDir, ".db.tmp", 5_000);
			proc.kill(); // SIGTERM by default

			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const code = await proc.exited;
			const combined = out + err;

			expect(code).toBe(143);
			expect(combined).toContain("interrupted by signal");

			const entries = await readdir(backupsDir);
			expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
		},
		RUN_TIMEOUT,
	);

	test(
		"startup sweep removes a stale .tmp older than 60 minutes, leaves a fresh one alone (AGEN-54 otto #1: SIGKILL can't be trapped)",
		async () => {
			const root = await tmpRoot("ap-backup-vacuum-sweep-");
			const dataDir = join(root, "data");
			const backupsDir = join(root, "backups");
			await Bun.write(join(dataDir, ".keep"), "");
			await Bun.write(join(backupsDir, ".keep"), "");
			const src = join(dataDir, "agentpulse.db");
			await sqlite(
				src,
				"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
			);

			// Plant a stale tmp file (as a SIGKILL'd prior run would leave
			// behind — SIGKILL cannot be trapped, so the only way to reclaim
			// it is a startup sweep) and a fresh one that must survive this run.
			const stalePath = join(backupsDir, "agentpulse-20200101T000000Z.db.tmp");
			await writeFile(stalePath, "leftover from a killed run");
			const oldMtime = new Date("2020-01-01T00:00:00Z");
			await utimes(stalePath, oldMtime, oldMtime);

			const freshPath = join(backupsDir, "agentpulse-freshlyinterrupted.db.tmp");
			await writeFile(freshPath, "leftover from a run that just started");

			const proc = runBackup({
				AGENTPULSE_BACKUP_SRC: src,
				AGENTPULSE_BACKUP_DIR: backupsDir,
				AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
			});
			const { code, out } = await collect(proc);

			expect(code).toBe(0);
			expect(out).toContain("swept stale tmp file(s)");
			expect(out).toContain(stalePath);

			const entries = await readdir(backupsDir);
			expect(entries).not.toContain("agentpulse-20200101T000000Z.db.tmp");
			expect(entries).toContain("agentpulse-freshlyinterrupted.db.tmp");
		},
		RUN_TIMEOUT,
	);

	test("a failed promotion rename removes the .tmp file and exits 7 (AGEN-54 otto #2)", async () => {
		const root = await tmpRoot("ap-backup-vacuum-mvfail-");
		const dataDir = join(root, "data");
		const backupsDir = join(root, "backups");
		await Bun.write(join(dataDir, ".keep"), "");
		await Bun.write(join(backupsDir, ".keep"), "");
		const src = join(dataDir, "agentpulse.db");
		await sqlite(
			src,
			"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
		);

		const stubDir = join(root, "stub-bin");
		await writeStub(stubDir, "mv", '#!/bin/sh\necho "stub mv: forced failure" >&2\nexit 1\n');

		const proc = Bun.spawn(["sh", SCRIPT], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				AGENTPULSE_BACKUP_SRC: src,
				AGENTPULSE_BACKUP_DIR: backupsDir,
				AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
			},
		});
		const { code, out } = await collect(proc);

		expect(code).toBe(7);
		expect(out).toContain("promotion rename failed");

		const entries = await readdir(backupsDir);
		expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	test("a failed sha256sum is non-fatal: backup still succeeds and retention still runs (AGEN-54 otto #3)", async () => {
		const root = await tmpRoot("ap-backup-vacuum-shafail-");
		const dataDir = join(root, "data");
		const backupsDir = join(root, "backups");
		await Bun.write(join(dataDir, ".keep"), "");
		await Bun.write(join(backupsDir, ".keep"), "");
		const src = join(dataDir, "agentpulse.db");
		await sqlite(
			src,
			"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
		);

		const stubDir = join(root, "stub-bin");
		await writeStub(
			stubDir,
			"sha256sum",
			'#!/bin/sh\necho "stub sha256sum: forced failure" >&2\nexit 1\n',
		);

		const proc = Bun.spawn(["sh", SCRIPT], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: `${stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				AGENTPULSE_BACKUP_SRC: src,
				AGENTPULSE_BACKUP_DIR: backupsDir,
				AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
			},
		});
		const { code, out } = await collect(proc);

		expect(code).toBe(0);
		expect(out).toContain("[backup] ok:");
		expect(out).toContain("WARN: sha256sum failed");
		expect(out).toContain("[retention] done");

		const entries = await readdir(backupsDir);
		expect(entries.some((f) => f.endsWith(".db"))).toBe(true);
	});

	test("uses busy_timeout on the VACUUM INTO connection (AGEN-54 otto #4)", async () => {
		const source = await readFile(SCRIPT, "utf8");
		// The exit-code table's own comment mentions "VACUUM INTO" too, so
		// this specifically targets the sqlite3 invocation line, not any
		// mention of the phrase.
		const vacuumLine = source
			.split("\n")
			.find((l) => l.trim().startsWith('sqlite3 "$SRC"') && l.includes("VACUUM INTO"));
		expect(vacuumLine).toBeDefined();
		expect(vacuumLine).toContain("busy_timeout");
	});

	test("logs the sqlite3 version at start (AGEN-54 otto #5)", async () => {
		const root = await tmpRoot("ap-backup-vacuum-version-");
		const dataDir = join(root, "data");
		const backupsDir = join(root, "backups");
		await Bun.write(join(dataDir, ".keep"), "");
		await Bun.write(join(backupsDir, ".keep"), "");
		const src = join(dataDir, "agentpulse.db");
		await sqlite(
			src,
			"CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE events(id INTEGER PRIMARY KEY);",
		);

		const proc = runBackup({
			AGENTPULSE_BACKUP_SRC: src,
			AGENTPULSE_BACKUP_DIR: backupsDir,
			AGENTPULSE_RETENTION_SCRIPT: RETENTION_SCRIPT,
		});
		const { code, out } = await collect(proc);

		expect(code).toBe(0);
		expect(out).toMatch(/\[backup] \d+\.\d+\.\d+/);
	});
});
