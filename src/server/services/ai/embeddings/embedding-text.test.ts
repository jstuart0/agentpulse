// Phase 5 growth mitigations (AGEN-16, D14/F34): the synthetic
// "Turn completed" Stop placeholder isn't embedded — every turn in every
// session would otherwise embed a near-duplicate of it. A Stop row that
// does carry real content (rawPayload.message) is still embedded.
//
// event_embeddings is SQLite-only this release (see CLAUDE.md), so this
// file is gated with describeSqliteOnly. Assertions query event_embeddings
// by this test's own event ids (never a global scan), since runBackfill
// itself scans the whole shared test DB (harness rule 1 doesn't forbid a
// tool whose own contract is DB-wide — it forbids *this test* depending on
// an empty DB, which the id-scoped assertions below avoid).

import { beforeAll, expect, test } from "bun:test";
import { describeSqliteOnly } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { getDb, getSqlite, initializeDatabase } = await import("../../../db/client.js");
const { events, sessions } = await import("../../../db/schema/index.js");
const { config } = await import("../../../config.js");
const { runBackfill, __resetEmbeddingAdapterForTests, __setEmbeddingAdapterForTests } =
	await import("./embedding-service.js");

const originalVectorSearch = config.vectorSearchEnabled;

beforeAll(async () => {
	await initializeDatabase();
	// dialect resolves naturally to "sqlite" since DATABASE_URL is unset in tests.
	(config as Record<string, unknown>).vectorSearchEnabled = true;
});

// Hardcoded rather than imported from event-normalizer.ts's
// SYNTHETIC_STOP_CONTENT: this must match the literal
// normalizeSystemEvent's Stop case actually emits, independent of
// whether the exported constant exists yet (RED@P5-start) or has been
// refactored later. A drifted duplicate here is exactly the failure this
// test exists to catch, so the literal is deliberate, not a shortcut.
const SYNTHETIC_STOP_TEXT = "Turn completed";

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code" })
		.onConflictDoNothing();
}

async function insertStopRow(
	sessionId: string,
	rawPayload: Record<string, unknown>,
): Promise<number> {
	const [row] = await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "Stop",
			category: "system_event",
			source: "observed_hook",
			content: SYNTHETIC_STOP_TEXT,
			isNoise: false,
			rawPayload,
		})
		.returning({ id: events.id });
	return row.id;
}

function embeddingRow(eventId: number, model: string): { dim: number } | undefined {
	return getSqlite()
		.prepare("SELECT dim FROM event_embeddings WHERE event_id = ? AND model = ?")
		.get(eventId, model) as { dim: number } | undefined;
}

describeSqliteOnly("embedding text — synthetic Stop skip (G5)", () => {
	test("G5: a synthetic 'Turn completed' Stop row is skipped; a Stop with rawPayload.message is still embedded", async () => {
		const sid = newSessionId("g5");
		await mkSession(sid);
		const model = `g5-test-model-${sid}`;

		__resetEmbeddingAdapterForTests();
		const embedded: string[] = [];
		__setEmbeddingAdapterForTests({
			kind: "ollama",
			model,
			dim: 4,
			embed: async (text: string) => {
				embedded.push(text);
				return new Float32Array(4).fill(0.1);
			},
		});

		const syntheticId = await insertStopRow(sid, {});
		const realId = await insertStopRow(sid, { message: "hi" });

		try {
			const result = await runBackfill();
			expect(result.error).toBeNull();

			// The synthetic row got the dim=0 skip marker (never sent to the
			// adapter); the real row got a real dim=4 vector.
			expect(embeddingRow(syntheticId, model)?.dim).toBe(0);
			expect(embeddingRow(realId, model)?.dim).toBe(4);
			expect(embedded).toContain("hi");
		} finally {
			__resetEmbeddingAdapterForTests();
			(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
		}
	});
});
