// R16 (AGEN-16 Phase 2, F79): Postgres search event results are ordered
// `e.created_at DESC, e.id DESC` — a stable tiebreak for rows sharing the
// same second, which paginated offset queries otherwise reorder between
// requests.

import { expect, test } from "bun:test";
import { describePostgresOnly } from "../../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema/index.js");
const { PostgresSearchBackend } = await import("./postgres-search-backend.js");

function uid(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

describePostgresOnly("Postgres search order is stable for same-second events (R16)", () => {
	test("two matching events with an identical created_at return in id DESC order", async () => {
		await initializeDatabase();

		const sid = uid("r16");
		const token = uid("tok").replace(/-/g, "");
		const sameInstant = "2026-04-20 00:00:00";

		await getDb()
			.insert(sessions)
			.values({ sessionId: sid, displayName: sid, agentType: "claude_code", status: "active" })
			.execute();

		const [first] = await getDb()
			.insert(events)
			.values({
				sessionId: sid,
				eventType: "UserPromptSubmit",
				category: "prompt",
				source: "observed_hook",
				content: `first ${token}`,
				isNoise: false,
				rawPayload: { prompt: `first ${token}` },
				createdAt: sameInstant,
			})
			.returning({ id: events.id });
		const [second] = await getDb()
			.insert(events)
			.values({
				sessionId: sid,
				eventType: "UserPromptSubmit",
				category: "prompt",
				source: "observed_hook",
				content: `second ${token}`,
				isNoise: false,
				rawPayload: { prompt: `second ${token}` },
				createdAt: sameInstant,
			})
			.returning({ id: events.id });

		expect(first?.id).toBeDefined();
		expect(second?.id).toBeDefined();
		expect((second?.id as number) > (first?.id as number)).toBe(true);

		const backend = new PostgresSearchBackend();
		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await backend.search({ q: token, kinds: ["event"], sessionId: sid });
			expect(result.hits.map((h) => h.eventId)).toEqual([second?.id, first?.id]);
		}
	});

	test("the raw-SQL ordering guard: every event ORDER BY has an id tiebreak", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(new URL("./postgres-search-backend.ts", import.meta.url), "utf8");
		// Matches the events query's ORDER BY regardless of table-alias
		// prefix — AGEN-27's MATERIALIZED CTE fence (percy TB17 review,
		// Critical 1) moved the final ORDER BY onto the CTE's own
		// (unprefixed) output columns, so "e.created_at" no longer appears
		// literally; "created_at" does, and no other ORDER BY clause in this
		// file mentions it (the sessions query orders by started_at), so this
		// match is unambiguously the events ordering either way.
		const eventOrderings = src.match(/ORDER BY [a-z_.]*created_at[^\n]*/g) ?? [];
		expect(eventOrderings.length).toBeGreaterThan(0);
		for (const line of eventOrderings) {
			expect(line).toMatch(/,\s*(e\.)?id (DESC|ASC)/);
		}
	});
});
