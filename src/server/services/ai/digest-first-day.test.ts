// R10/R10b (AGEN-16 Phase 2): the digest's plan-completion window used
// `events.createdAt >= windowStart.toISOString()`. events.created_at is a
// bare "YYYY-MM-DD HH:MM:SS" (SQLite) / offset text (Postgres) column, never
// a "T"-separated ISO string, so the lexicographic compare excluded the
// window's first day (' ' < 'T' for the same wall date).

import { beforeAll, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema/index.js");
const { buildDigest } = await import("./digest-service.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function withTZ<T>(tz: string, fn: () => Promise<T>): Promise<T> {
	const saved = process.env.TZ;
	process.env.TZ = tz;
	try {
		return await fn();
	} finally {
		process.env.TZ = saved ?? "UTC";
	}
}

function uniqueId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function seedActiveSessionWithPlanEvent(cwd: string, planCreatedAt: string) {
	const sessionId = uniqueId("digest");
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			cwd,
			lastActivityAt: "2026-09-29 11:00:00",
		})
		.execute();
	await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: "PlanUpdate",
			category: "plan_update",
			source: "observed_hook",
			content: "Plan complete: x",
			isNoise: false,
			rawPayload: {},
			createdAt: planCreatedAt,
		})
		.execute();
	return sessionId;
}

const NOW = new Date("2026-09-29T12:00:00Z");
const WINDOW_MS = 86_400_000; // windowStart = 2026-09-28T12:00:00Z

describe("digest first-day plan completions (R10/R10b)", () => {
	test("R10 includes a plan completion from the window's first day", async () => {
		const cwd = uniqueId("/repo/r10");
		await seedActiveSessionWithPlanEvent(cwd, "2026-09-28 18:00:00");

		const digest = await buildDigest({ now: NOW, windowMs: WINDOW_MS });
		const repo = digest.repos.find((r) => r.cwd === cwd);
		expect(repo).toBeDefined();
		expect(repo?.topPlanCompletions).toContain("Plan complete: x");
	});

	test("R10 (NY) same result under a non-UTC TZ", async () => {
		const cwd = uniqueId("/repo/r10ny");
		await seedActiveSessionWithPlanEvent(cwd, "2026-09-28 18:00:00");

		await withTZ("America/New_York", async () => {
			const digest = await buildDigest({ now: NOW, windowMs: WINDOW_MS });
			const repo = digest.repos.find((r) => r.cwd === cwd);
			expect(repo).toBeDefined();
			expect(repo?.topPlanCompletions).toContain("Plan complete: x");
		});
	});

	test("R10b still excludes a row before the window", async () => {
		const cwd = uniqueId("/repo/r10b");
		await seedActiveSessionWithPlanEvent(cwd, "2026-09-28 06:00:00");

		const digest = await buildDigest({ now: NOW, windowMs: WINDOW_MS });
		const repo = digest.repos.find((r) => r.cwd === cwd);
		expect(repo).toBeDefined();
		expect(repo?.topPlanCompletions).toEqual([]);
	});
});
