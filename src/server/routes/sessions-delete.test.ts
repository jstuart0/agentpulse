// Slice DB-1 — DELETE /sessions/:id atomicity + cascade coverage.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../services/ai/__test_db.js";

const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const {
	aiHitlRequests,
	aiWatcherRuns,
	controlActions,
	events,
	managedSessions,
	sessions,
	watcherConfigs,
	watcherProposals,
} = await import("../db/schema.js");
const { sessionsRouter } = await import("./sessions.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

beforeEach(async () => {
	// Order matters when FKs are not all cascading yet — start from the
	// child rows. With cascade in place, deleting sessions alone is enough,
	// but explicit cleanup is fine and keeps the suite hermetic.
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(controlActions).execute();
	await getDb().delete(watcherProposals).execute();
	await getDb().delete(aiHitlRequests).execute();
	await getDb().delete(aiWatcherRuns).execute();
	await getDb().delete(watcherConfigs).execute();
	await getDb().delete(sessions).execute();
});

async function seedSessionWithChildren(sessionId: string): Promise<void> {
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" });
	await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "UserPromptSubmit",
			rawPayload: { prompt: "hello" },
		});
	await getDb().insert(managedSessions).values({
		sessionId,
		launchRequestId: "lr-1",
		supervisorId: "sup-1",
	});
	await getDb().insert(controlActions).values({
		id: crypto.randomUUID(),
		sessionId,
		actionType: "stop",
	});
	await getDb().insert(watcherConfigs).values({
		sessionId,
		providerId: "prov-1",
	});
	await getDb().insert(watcherProposals).values({
		id: crypto.randomUUID(),
		sessionId,
		providerId: "prov-1",
	});
	await getDb().insert(aiHitlRequests).values({
		id: crypto.randomUUID(),
		proposalId: "prop-1",
		sessionId,
	});
	await getDb()
		.insert(aiWatcherRuns)
		.values({
			id: crypto.randomUUID(),
			sessionId,
			triggerKind: "idle",
			dedupeKey: `${sessionId}:idle:0`,
		});
}

describe("DELETE /sessions/:id", () => {
	test("cascade removes every child row in one transaction", async () => {
		const sessionId = `del-${crypto.randomUUID()}`;
		await seedSessionWithChildren(sessionId);

		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		const sessionRow = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(sessionRow.length).toBe(0);

		const eventsRow = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
		expect(eventsRow.length).toBe(0);

		const managedRow = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow.length).toBe(0);

		const ctrlRow = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, sessionId));
		expect(ctrlRow.length).toBe(0);

		const watcherCfgRow = await getDb()
			.select()
			.from(watcherConfigs)
			.where(eq(watcherConfigs.sessionId, sessionId));
		expect(watcherCfgRow.length).toBe(0);

		const propRow = await getDb()
			.select()
			.from(watcherProposals)
			.where(eq(watcherProposals.sessionId, sessionId));
		expect(propRow.length).toBe(0);

		const hitlRow = await getDb()
			.select()
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.sessionId, sessionId));
		expect(hitlRow.length).toBe(0);

		const runRow = await getDb()
			.select()
			.from(aiWatcherRuns)
			.where(eq(aiWatcherRuns.sessionId, sessionId));
		expect(runRow.length).toBe(0);
	});

	test("FTS rows for the deleted session are also removed", async () => {
		const sessionId = `fts-${crypto.randomUUID()}`;
		await seedSessionWithChildren(sessionId);

		const raw = new Database(config.sqlitePath);
		try {
			// Sanity-check: the FTS triggers populated entries for our seed.
			const beforeSessions = raw
				.prepare("SELECT COUNT(*) AS n FROM search_sessions_fts WHERE session_id = ?")
				.get(sessionId) as { n: number };
			const beforeEvents = raw
				.prepare("SELECT COUNT(*) AS n FROM search_events_fts WHERE session_id = ?")
				.get(sessionId) as { n: number };
			expect(beforeSessions.n).toBeGreaterThan(0);
			expect(beforeEvents.n).toBeGreaterThan(0);
		} finally {
			raw.close();
		}

		const res = await app.request(`/api/v1/sessions/${sessionId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		const raw2 = new Database(config.sqlitePath);
		try {
			const afterSessions = raw2
				.prepare("SELECT COUNT(*) AS n FROM search_sessions_fts WHERE session_id = ?")
				.get(sessionId) as { n: number };
			const afterEvents = raw2
				.prepare("SELECT COUNT(*) AS n FROM search_events_fts WHERE session_id = ?")
				.get(sessionId) as { n: number };
			expect(afterSessions.n).toBe(0);
			expect(afterEvents.n).toBe(0);
		} finally {
			raw2.close();
		}
	});

	test("transaction rollback on mid-delete throw leaves the session intact", async () => {
		const sessionId = `rollback-${crypto.randomUUID()}`;
		await seedSessionWithChildren(sessionId);

		// drizzle's bun-sqlite `transaction` is synchronous — the only way
		// to get a real BEGIN/ROLLBACK is a sync callback. Throwing here
		// mirrors what the route does internally, with a forced failure
		// after the first delete to verify the events row survives.
		expect(() =>
			getDb().transaction((tx) => {
				tx.delete(events).where(eq(events.sessionId, sessionId)).run();
				throw new Error("simulated mid-transaction failure");
			}),
		).toThrow("simulated mid-transaction failure");

		// Both the parent session and the event rows that we nominally
		// deleted should still be present — the rollback restored them.
		const sessionRow = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(sessionRow.length).toBe(1);

		const eventsRow = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
		expect(eventsRow.length).toBeGreaterThan(0);
	});

	afterAll(() => {
		config.disableAuth = originalDisableAuth;
	});
});
