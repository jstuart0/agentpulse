// Phase 6 (AGEN-16): the shared persistEvents write path.
//
// P4-helper: insertNormalizedEvents returns DTO rows, sorted by id,
// matching the DB.
// P4-order: an insert that fails (NOT NULL) never runs the compensating
// delete for the row it would have superseded (bob L1 / F47).
// P6-inject: callers can never write dedup_key, however they try (F65).
//
// Every test uses its own session id and filters by it (harness rule 1).

import { beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { insertNormalizedEvents } = await import("./event-processor.js");
const { appendManagedSessionEvents } = await import("./managed-session-state.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { emitAiEvent } = await import("./ai/ai-events.js");
const { createAssistantTranscriptEvent } = await import("./event-normalizer.js");
const { eq } = await import("drizzle-orm");

import type { NormalizedEvent } from "./event-normalizer.js";

beforeAll(() => initializeDatabase());

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
		})
		.execute();
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

function normalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
	return {
		eventType: "AiReport",
		category: "system_event",
		source: "launch_system",
		content: "default content",
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		...overrides,
	};
}

describe("P4-helper: insertNormalizedEvents returns DTO rows sorted by id, matching the DB", () => {
	test("id/content/createdAt equal the DB row; no dedupKey key; ascending id order", async () => {
		const sid = newSessionId("p4helper");
		await mkSession(sid);

		const inputs = [0, 1, 2].map((i) => normalizedEvent({ content: `msg-${i}` }));
		const result = await insertNormalizedEvents(sid, inputs);

		expect(result).toHaveLength(3);
		const ids = result.map((r) => r.id);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(3);
		for (const row of result) {
			expect(row.id).toBeGreaterThan(0);
			expect(row).not.toHaveProperty("dedupKey");
		}

		const dbRows = await rowsFor(sid);
		expect(dbRows).toHaveLength(3);
		for (const row of result) {
			const dbRow = dbRows.find((r) => r.id === row.id);
			expect(dbRow, `no DB row for id ${row.id}`).toBeDefined();
			expect(row.content).toBe(dbRow?.content ?? null);
			expect(row.createdAt).toBe(dbRow?.createdAt ?? "");
		}
	});
});

describe("P4-order: a failed insert leaves the superseded row intact (bob L1 / F47)", () => {
	test("a NOT NULL violation on eventType rejects, and the managed_control row it would have superseded still exists", async () => {
		const sid = newSessionId("p4order");
		await mkSession(sid);

		await insertNormalizedEvents(sid, [
			normalizedEvent({
				eventType: "ManagedMessage",
				category: "assistant_message",
				source: "managed_control",
				content: "X",
			}),
		]);
		const before = await rowsFor(sid);
		expect(before.filter((r) => r.source === "managed_control")).toHaveLength(1);

		// observed_transcript (priority 50) outranks managed_control (20), so
		// the planner marks the managed row's id in deletesIfStored. The
		// insert itself is malformed (eventType: null violates NOT NULL), so
		// it must reject before any compensating delete runs.
		const badEvent = {
			...createAssistantTranscriptEvent(
				"X",
				{ transcript_uuid: "tu-p4order" },
				"claude_transcript_text",
			),
			eventType: null,
		} as unknown as NormalizedEvent;

		let threw = false;
		try {
			await insertNormalizedEvents(sid, [badEvent]);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);

		const after = await rowsFor(sid);
		expect(after.filter((r) => r.source === "managed_control")).toHaveLength(1);
	});
});

describe("P6-inject: callers can never write dedup_key (F65)", () => {
	test("insertNormalizedEvents, appendManagedSessionEvents, and emitAiEvent all store dedup_key IS NULL, for two distinct sessions", async () => {
		for (const suffix of ["a", "b"]) {
			const sidNormalized = newSessionId(`p6inject-normalized-${suffix}`);
			await mkSession(sidNormalized);
			const injectedNormalized = {
				...normalizedEvent({ content: `inj-${suffix}` }),
				dedupKey: "t:x",
				dedup_key: "t:x",
			} as unknown as NormalizedEvent;
			await insertNormalizedEvents(sidNormalized, [injectedNormalized]);

			const sidManaged = newSessionId(`p6inject-managed-${suffix}`);
			await mkSession(sidManaged);
			const supervisorId = crypto.randomUUID();
			await seedOwnedLaunch(sidManaged, supervisorId);
			await appendManagedSessionEvents(supervisorId, sidManaged, [
				{
					eventType: "InjectTest",
					category: "assistant_message",
					content: `inj-mgd-${suffix}`,
					dedupKey: "t:x",
					dedup_key: "t:x",
					// biome-ignore lint/suspicious/noExplicitAny: deliberately hostile input for F65
				} as any,
			]);

			const sidAi = newSessionId(`p6inject-ai-${suffix}`);
			await mkSession(sidAi);
			await emitAiEvent({
				sessionId: sidAi,
				source: "launch_system",
				category: "system_event",
				eventType: "InjectTest",
				content: `inj-ai-${suffix}`,
				rawPayload: { dedup_key: "t:x" },
			});

			for (const sid of [sidNormalized, sidManaged, sidAi]) {
				const dbRows = await rowsFor(sid);
				expect(dbRows.length, `no rows stored for ${sid}`).toBeGreaterThan(0);
				for (const row of dbRows) {
					expect(row.dedupKey, `${sid} row ${row.id}`).toBeNull();
				}
			}
		}
	});
});
