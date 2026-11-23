/**
 * The smoke boot (step 9): start the staged server on a copy of the database, on a loopback port, and see
 * it come up as the target version. SQLite only.
 *
 * The copy is made with `VACUUM INTO` into a private temp directory and deleted afterwards whatever happens.
 * The child's environment is built from an allowlist (PATH, a throwaway HOME, the database paths, the port,
 * loopback, production, telemetry and the update check off); it has no secrets key, Telegram, AI or push, and
 * auth stays on. The child runs with the staged tree as its working directory, so no `.env*` is read. It is
 * stopped through its own handle, never by a pid lookup or a name.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseEnv } from "./exec.js";
import { type FetchText, probeHealth } from "./health.js";

export interface SmokeInput {
	stagingDir: string;
	/** The server's entry relative to the staged tree: `dist/server/index.js` in production. */
	entry: string;
	bunBin: string;
	sqlitePath: string;
	targetVersion: string;
	parentEnv: Record<string, string | undefined>;
	fetchText: FetchText;
	timeoutMs: number;
	/** Wait between polls; the clock the caller uses for its own deadlines. */
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** What the copy's `__drizzle_migrations` held while the staged server ran: how many rows and the newest `created_at`. */
export interface LedgerSummary {
	count: number;
	lastCreatedAt: number | null;
}

export type SmokeResult = { ok: true; ledger: LedgerSummary | null; port: number } | { ok: false };

/** The staged server's whole environment: an allowlist, built from nothing the parent holds but PATH and proxy settings. */
export function smokeEnv(input: {
	parentEnv: Record<string, string | undefined>;
	homeDir: string;
	dataDir: string;
	copy: string;
	port: number;
}): Record<string, string> {
	return {
		...baseEnv(input.parentEnv, input.homeDir),
		SQLITE_PATH: input.copy,
		DATA_DIR: input.dataDir,
		PORT: String(input.port),
		HOST: "127.0.0.1",
		NODE_ENV: "production",
		AGENTPULSE_TELEMETRY: "off",
		AGENTPULSE_UPDATE_CHECK: "off",
	};
}

export async function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function stopChild(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
	proc.kill("SIGTERM");
	const exited = await Promise.race([
		proc.exited.then(() => true),
		new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
	]);
	if (!exited) {
		proc.kill("SIGKILL");
		await proc.exited;
	}
}

export async function smokeBoot(input: SmokeInput): Promise<SmokeResult> {
	const work = mkdtempSync(join(tmpdir(), "agentpulse-smoke-"));
	chmodSync(work, 0o700);
	let proc: ReturnType<typeof Bun.spawn> | null = null;
	try {
		const dataDir = join(work, "data");
		const homeDir = join(work, "home");
		mkdirSync(dataDir, { mode: 0o700 });
		mkdirSync(homeDir, { mode: 0o700 });
		const copy = join(dataDir, "agentpulse.db");
		const source = new Database(input.sqlitePath, { readwrite: true });
		try {
			source.run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
		} finally {
			source.close();
		}
		chmodSync(copy, 0o600);
		const port = await freeLoopbackPort();
		const env = smokeEnv({ parentEnv: input.parentEnv, homeDir, dataDir, copy, port });
		proc = Bun.spawn([input.bunBin, input.entry], {
			cwd: input.stagingDir,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const deadline = input.now() + input.timeoutMs;
		while (input.now() < deadline) {
			if (proc.exitCode !== null) return { ok: false };
			const health = await probeHealth(input.fetchText, `http://127.0.0.1:${port}`);
			if (health?.version === input.targetVersion) {
				return { ok: true, ledger: readLedger(copy), port };
			}
			await input.sleep(500);
		}
		return { ok: false };
	} catch {
		return { ok: false };
	} finally {
		if (proc) await stopChild(proc).catch(() => {});
		rmSync(work, { recursive: true, force: true });
	}
}

/** The ledger of the copy, read read-only while the child still holds it. */
function readLedger(path: string): LedgerSummary | null {
	try {
		const db = new Database(path, { readwrite: true });
		try {
			const row = db
				.query("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM __drizzle_migrations")
				.get() as { n?: number; last?: number | null } | null;
			return row && typeof row.n === "number"
				? { count: row.n, lastCreatedAt: row.last ?? null }
				: null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}
