#!/usr/bin/env bun
/**
 * Manual benchmark for the Ask path's semantic vector scan. Never run in CI.
 *
 * It builds (or reuses) a synthetic SQLite database of event embeddings and
 * measures, through the real app, the real enricher and real concurrent
 * `POST /api/v1/hooks` requests: the longest event-loop stall, wall time and
 * peak RSS of a scan; and hook latency during one and two concurrent scans.
 * Run each mode in its own process (the `all` mode does that) so peak RSS is
 * per mode.
 *
 *   bun scripts/bench-vector-scan.ts --db /tmp/bench.db --rows 60000 --dim 4096 --mode all
 *   bun scripts/bench-vector-scan.ts --db /tmp/bench.db --mode index-build --extend-to 164349
 *
 * Modes: seed, old, scan, scan2, hooks, hooks2, index-build, all.
 * `old` replays the pre-fix read (one unbounded `.all()`, every vector copied)
 * and at 60,000 rows x 4096 dims needs about 1.6 GiB of RAM: only run it on a
 * machine that can spare that.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(String(process.argv[i]).replace(/^--/, ""), String(process.argv[i + 1] ?? ""));
}
const MODE = args.get("mode") ?? "all";
const ROWS = Number(args.get("rows") ?? 60_000);
const DIM = Number(args.get("dim") ?? 4096);
const MODEL = "bench-model";
const DB_PATH = args.get("db") ?? join(mkdtempSync(join(tmpdir(), "ap-bench-")), "bench.db");

// The app reads its config once at import, so these go in before any import of it.
mkdirSync(dirname(DB_PATH), { recursive: true });
process.env.SQLITE_PATH = DB_PATH;
process.env.DATA_DIR = dirname(DB_PATH);
process.env.DISABLE_AUTH = "true";
process.env.AGENTPULSE_VECTOR_SEARCH = "true";
process.env.AGENTPULSE_AI_ENABLED = "true";
process.env.AGENTPULSE_SECRETS_KEY ??= "bench-secrets-key-0123456789abcdef0123";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomUnit(rng: () => number, dim: number): Float32Array {
	const v = new Float32Array(dim);
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		v[i] = rng() * 2 - 1;
		norm += (v[i] as number) ** 2;
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < dim; i++) v[i] = (v[i] as number) / norm;
	return v;
}

function maxRssBytes(): number {
	const raw = process.resourceUsage().maxRSS;
	return process.platform === "darwin" ? raw : raw * 1024;
}
const mib = (bytes: number) => Math.round(bytes / 1_048_576);

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

/** Watches the event loop: the longest gap between two 1 ms timer turns is the longest stall. */
function startStallMeter() {
	let last = performance.now();
	let maxGap = 0;
	const handle = setInterval(() => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
	}, 1);
	return {
		stop: () => {
			clearInterval(handle);
			return maxGap;
		},
	};
}

async function openApp() {
	const { initializeDatabase, getSqlite } = await import("../src/server/db/client.js");
	await initializeDatabase();
	return { getSqlite };
}

async function seed(getSqlite: () => Database, targetRows: number) {
	const sqlite = getSqlite();
	const existing = (
		sqlite.prepare("SELECT COUNT(*) AS n FROM event_embeddings").get() as { n: number }
	).n;
	if (existing >= targetRows) return existing;
	const rng = mulberry32(42 + existing);
	const insertSession = sqlite.prepare(
		"INSERT OR IGNORE INTO sessions (id, session_id, agent_type) VALUES (?, ?, 'claude_code')",
	);
	const insertEvent = sqlite.prepare(
		"INSERT INTO events (id, session_id, event_type, content, raw_payload) VALUES (?, ?, 'UserPromptSubmit', 'x', '{}')",
	);
	const insertVector = sqlite.prepare(
		"INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, ?, ?, ?)",
	);
	for (let s = 0; s < 50; s++) insertSession.run(`bench-s-${s}`, `bench-s-${s}`);
	const BATCH = 2_000;
	// Hook traffic from earlier modes also writes `events`, so new ids start past every existing one.
	let nextId =
		(sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m + 1;
	for (let done = existing; done < targetRows; done += BATCH) {
		const batch = Math.min(BATCH, targetRows - done);
		sqlite.transaction(() => {
			for (let i = 0; i < batch; i++, nextId++) {
				insertEvent.run(nextId, `bench-s-${nextId % 50}`);
				const v = randomUnit(rng, DIM);
				insertVector.run(nextId, MODEL, DIM, new Uint8Array(v.buffer));
			}
		})();
	}
	sqlite.exec("ANALYZE");
	return targetRows;
}

const QUERY = randomUnit(mulberry32(7), DIM);
const adapter = { kind: "ollama" as const, model: MODEL, dim: DIM, embed: async () => QUERY };

async function runOld(getSqlite: () => Database) {
	const { bufferToVector, cosineSimilarity } = await import(
		"../src/server/services/ai/embeddings/types.js"
	);
	const stall = startStallMeter();
	const started = performance.now();
	const rows = getSqlite()
		.prepare(
			`SELECT v.event_id AS eventId, v.vector AS vector, e.session_id AS sessionId
			 FROM event_embeddings v JOIN events e ON e.id = v.event_id
			 WHERE v.model = ? AND v.dim = ?`,
		)
		.all(MODEL, DIM) as Array<{ vector: Buffer }>;
	const readMs = performance.now() - started;
	let hits = 0;
	for (const row of rows) if (cosineSimilarity(QUERY, bufferToVector(row.vector)) >= 0.4) hits++;
	const wallMs = performance.now() - started;
	await new Promise((resolve) => setTimeout(resolve, 5));
	return { rows: rows.length, hits, readMs, wallMs, longestSyncBlockMs: stall.stop() };
}

async function runScans(concurrent: number, withHooks: boolean) {
	const { VectorEmbeddingEnricher } = await import(
		"../src/server/services/ai/embeddings/vector-enricher.js"
	);
	const { getLastVectorScanStats } = await import(
		"../src/server/services/ai/embeddings/vector-scan.js"
	);
	let hook: Awaited<ReturnType<typeof startHookLoad>> | null = null;
	if (withHooks) hook = await startHookLoad();
	const stall = startStallMeter();
	const rssBefore = process.memoryUsage().rss;
	const started = performance.now();
	await Promise.all(
		Array.from({ length: concurrent }, () =>
			new VectorEmbeddingEnricher(adapter).enrich("a question"),
		),
	);
	const wallMs = performance.now() - started;
	const stats = getLastVectorScanStats();
	const longestStallMs = stall.stop();
	const hookResult = hook ? await hook.stop() : null;
	return {
		concurrent,
		wallMs,
		longestStallMs,
		rssBeforeMiB: mib(rssBefore),
		peakRssMiB: mib(maxRssBytes()),
		stats,
		hook: hookResult,
	};
}

/** Real concurrent hook deliveries against a real listening server, one every ~15 ms. */
async function startHookLoad() {
	const { app } = await import("../src/server/app.js");
	const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
	const latencies: number[] = [];
	let running = true;
	const sessionId = `bench-hook-${crypto.randomUUID()}`;
	const loop = (async () => {
		while (running) {
			const t0 = performance.now();
			const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/hooks`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: sessionId,
					hook_event_name: "UserPromptSubmit",
					prompt: "bench",
				}),
			});
			await res.arrayBuffer();
			latencies.push(performance.now() - t0);
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
	})();
	return {
		async stop() {
			running = false;
			await loop;
			server.stop(true);
			latencies.sort((a, b) => a - b);
			return {
				requests: latencies.length,
				p50: percentile(latencies, 50),
				p95: percentile(latencies, 95),
				p99: percentile(latencies, 99),
				max: latencies[latencies.length - 1],
			};
		},
	};
}

async function hookBaseline() {
	const hook = await startHookLoad();
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	return hook.stop();
}

async function indexBuild(getSqlite: () => Database, extendTo: number) {
	const sqlite = getSqlite();
	sqlite.exec("DROP INDEX IF EXISTS idx_event_embeddings_model_dim_event");
	await seed(getSqlite, extendTo);
	const started = performance.now();
	sqlite.exec(
		"CREATE INDEX idx_event_embeddings_model_dim_event ON event_embeddings (model, dim, event_id)",
	);
	const ms = performance.now() - started;
	const rows = (sqlite.prepare("SELECT COUNT(*) AS n FROM event_embeddings").get() as { n: number })
		.n;
	return { rows, indexBuildMs: ms, peakRssMiB: mib(maxRssBytes()) };
}

async function child(mode: string, extra: string[] = []) {
	const proc = Bun.spawn(
		[
			process.execPath,
			import.meta.path,
			"--mode",
			mode,
			"--db",
			DB_PATH,
			"--rows",
			String(ROWS),
			"--dim",
			String(DIM),
			...extra,
		],
		{ stdout: "pipe", stderr: "inherit", env: process.env },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim().split("\n").pop() ?? "";
}

async function main() {
	if (MODE === "all") {
		const environment = {
			platform: `${process.platform} ${process.arch}`,
			bun: Bun.version,
			date: new Date().toISOString(),
			loadAverage: (await import("node:os")).loadavg().map((n) => Number(n.toFixed(2))),
			rows: ROWS,
			dim: DIM,
		};
		console.log(JSON.stringify({ environment }));
		for (const mode of [
			"seed",
			"scan",
			"scan2",
			"hooks",
			"hooks2",
			...(args.get("old") === "yes" ? ["old"] : []),
		]) {
			console.log(await child(mode));
		}
		return;
	}
	const { getSqlite } = await openApp();
	const sqliteHandle = getSqlite;
	let result: unknown;
	switch (MODE) {
		case "seed":
			result = { mode: MODE, rows: await seed(sqliteHandle, ROWS), dbExists: existsSync(DB_PATH) };
			break;
		case "old":
			result = { mode: MODE, ...(await runOld(sqliteHandle)), peakRssMiB: mib(maxRssBytes()) };
			break;
		case "scan":
			result = { mode: MODE, ...(await runScans(1, false)) };
			break;
		case "scan2":
			result = { mode: MODE, ...(await runScans(2, false)) };
			break;
		case "hooks":
			result = { mode: MODE, baseline: await hookBaseline(), ...(await runScans(1, true)) };
			break;
		case "hooks2":
			result = { mode: MODE, ...(await runScans(2, true)) };
			break;
		case "index-build":
			result = {
				mode: MODE,
				...(await indexBuild(sqliteHandle, Number(args.get("extend-to") ?? ROWS))),
			};
			break;
		default:
			throw new Error(`unknown mode ${MODE}`);
	}
	console.log(JSON.stringify(result));
	if (!args.get("db")) rmSync(dirname(DB_PATH), { recursive: true, force: true });
}

await main();
