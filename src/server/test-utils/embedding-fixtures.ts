/**
 * Seeds `events` and `event_embeddings` rows with explicit ids, models and
 * vectors, through the raw handle. Test-only: it is the one place outside the
 * embedding service that writes the table.
 */
import { getSqlite } from "../db/client.js";

/** Deterministic PRNG (mulberry32). No Math.random in gate tests. */
export function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function randomUnitVector(rng: () => number, dim: number): Float32Array {
	const v = new Float32Array(dim);
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		v[i] = rng() * 2 - 1;
		norm += v[i] * v[i];
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < dim; i++) v[i] /= norm;
	return v;
}

export interface SeedRow {
	id: number;
	sessionId: string;
	model: string;
	dim: number;
	/** null means no vector row at all (an event without an embedding). */
	vector: Float32Array | Uint8Array | null;
	createdAt?: string;
	/** Insert the vector row without an `events` row (an orphan). */
	orphan?: boolean;
}

/** Sessions are created `completed`, so the Ask resolver's "active sessions" fallback never picks them. */
export function ensureSessions(sessionIds: string[]): void {
	const sqlite = getSqlite();
	const insert = sqlite.prepare(
		"INSERT OR IGNORE INTO sessions (id, session_id, agent_type, status) VALUES (?, ?, 'claude_code', 'completed')",
	);
	sqlite.transaction(() => {
		for (const id of sessionIds) insert.run(`row-${id}`, id);
	})();
}

export function seedRows(rows: SeedRow[]): void {
	ensureSessions([...new Set(rows.filter((r) => !r.orphan).map((r) => r.sessionId))]);
	const sqlite = getSqlite();
	const insertEvent = sqlite.prepare(
		"INSERT OR REPLACE INTO events (id, session_id, event_type, content, raw_payload, created_at) VALUES (?, ?, 'UserPromptSubmit', ?, '{}', ?)",
	);
	const insertVector = sqlite.prepare(
		"INSERT OR REPLACE INTO event_embeddings (event_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
	);
	sqlite.transaction(() => {
		for (const row of rows) {
			if (!row.orphan) {
				insertEvent.run(
					row.id,
					row.sessionId,
					`event ${row.id}`,
					row.createdAt ?? "2026-01-01 00:00:00",
				);
			}
			if (row.vector === null) continue;
			const blob =
				row.vector instanceof Float32Array
					? new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
					: row.vector;
			insertVector.run(row.id, row.model, row.dim, blob);
		}
	})();
}

export function clearEmbeddingFixtures(): void {
	const sqlite = getSqlite();
	sqlite.exec("DELETE FROM event_embeddings");
	sqlite.exec("DELETE FROM events");
}

/** Convenience: `count` events with ids `startId..startId+count-1`, one session per `perSession` events. */
export function seedRandomRange(opts: {
	startId: number;
	count: number;
	model: string;
	dim: number;
	seed: number;
	sessionFor?: (id: number) => string;
}): { rows: SeedRow[]; vectors: Map<number, Float32Array> } {
	const rng = makeRng(opts.seed);
	const sessionFor = opts.sessionFor ?? ((id) => `s-${id % 7}`);
	const rows: SeedRow[] = [];
	const vectors = new Map<number, Float32Array>();
	for (let i = 0; i < opts.count; i++) {
		const id = opts.startId + i;
		const vector = randomUnitVector(rng, opts.dim);
		vectors.set(id, vector);
		rows.push({ id, sessionId: sessionFor(id), model: opts.model, dim: opts.dim, vector });
	}
	ensureSessions([...new Set(rows.map((r) => r.sessionId))]);
	seedRows(rows);
	return { rows, vectors };
}

/** A unit vector whose cosine to `base` is roughly `alpha` (1 = base itself). */
export function mixedVector(rng: () => number, base: Float32Array, alpha: number): Float32Array {
	const noise = randomUnitVector(rng, base.length);
	const out = new Float32Array(base.length);
	let norm = 0;
	for (let i = 0; i < out.length; i++) {
		out[i] = (base[i] as number) * alpha + (noise[i] as number) * (1 - alpha);
		norm += (out[i] as number) * (out[i] as number);
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / norm;
	return out;
}

/** Everything `event_embeddings` holds, read back unbounded (tests only): the oracle's input. */
export function readAllEmbeddingRows(
	model: string,
	dim: number,
): Array<{ eventId: number; sessionId: string; vector: Uint8Array }> {
	return getSqlite()
		.prepare(
			`SELECT v.event_id AS eventId, e.session_id AS sessionId, v.vector AS vector
			 FROM event_embeddings v JOIN events e ON e.id = v.event_id
			 WHERE v.model = ? AND v.dim = ? ORDER BY v.event_id DESC`,
		)
		.all(model, dim) as Array<{ eventId: number; sessionId: string; vector: Uint8Array }>;
}

/** Inserts one `events` row (and its session) with a JSON payload given as text or an object; returns its id. */
export function insertEventRow(opts: {
	id?: number;
	sessionId?: string;
	type: string;
	content?: string | null;
	rawPayload: string | Record<string, unknown> | unknown[] | number | null;
}): number {
	const sqlite = getSqlite();
	const sessionId = opts.sessionId ?? "emb-session";
	ensureSessions([sessionId]);
	const payload =
		typeof opts.rawPayload === "string" ? opts.rawPayload : JSON.stringify(opts.rawPayload);
	const result = sqlite
		.prepare(
			"INSERT INTO events (id, session_id, event_type, content, raw_payload) VALUES (?, ?, ?, ?, ?)",
		)
		.run(opts.id ?? null, sessionId, opts.type, opts.content ?? null, payload);
	return Number(result.lastInsertRowid);
}

/** Empties the tables an embedding run reads and writes. */
export function resetEmbeddingWorld(): void {
	const sqlite = getSqlite();
	sqlite.exec("DELETE FROM event_embeddings");
	sqlite.exec("DELETE FROM events");
}
