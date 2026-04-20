import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiHitlRequests, events, sessions, watcherProposals } = await import("../../db/schema.js");
const { buildDigest, getDailyDigest, invalidateDigestCache } = await import("./digest-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiHitlRequests).execute();
	await db.delete(watcherProposals).execute();
	await db.delete(events).execute();
	await db.delete(sessions).execute();
	invalidateDigestCache();
});

async function mkSession(
	sessionId: string,
	cwd: string | null,
	status: string,
	lastActivity: string,
) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: `name-${sessionId}`,
			agentType: "claude_code",
			status,
			cwd,
			lastActivityAt: lastActivity,
			startedAt: lastActivity,
		})
		.execute();
}

describe("digest-service", () => {
	test("groups sessions by cwd and counts per-repo stats", async () => {
		const now = new Date();
		const recent = new Date(now.getTime() - 60_000).toISOString();
		await mkSession("a1", "/home/u/proj-a", "active", recent);
		await mkSession("a2", "/home/u/proj-a", "completed", recent);
		await mkSession("b1", "/home/u/proj-b", "active", recent);

		const digest = await buildDigest({ now });
		expect(digest.totals.repos).toBe(2);
		expect(digest.totals.sessions).toBe(3);

		const projA = digest.repos.find((r) => r.projectName === "proj-a");
		expect(projA?.sessions.length).toBe(2);
		expect(projA?.completedToday).toBe(1);
	});

	test("excludes sessions outside the window", async () => {
		const now = new Date();
		const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
		await mkSession("stale", "/proj", "active", old);
		const digest = await buildDigest({ now });
		expect(digest.totals.sessions).toBe(0);
	});

	test("includes plan-completion events in topPlanCompletions", async () => {
		const now = new Date();
		const recent = new Date(now.getTime() - 60_000).toISOString();
		await mkSession("s1", "/proj", "active", recent);
		await db
			.insert(events)
			.values({
				sessionId: "s1",
				eventType: "PlanUpdate",
				category: "plan_update",
				rawPayload: {},
				content: "Plan complete: shipped feature X",
				source: "observed_hook",
				createdAt: recent,
			})
			.execute();
		const digest = await buildDigest({ now });
		const proj = digest.repos[0];
		expect(proj?.topPlanCompletions.length).toBe(1);
		expect(proj?.topPlanCompletions[0]).toContain("shipped feature X");
	});

	test("getDailyDigest caches across calls on same day", async () => {
		const now = new Date("2026-04-20T12:00:00Z");
		const recent = new Date(now.getTime() - 60_000).toISOString();
		await mkSession("s1", "/p", "active", recent);
		const a = await getDailyDigest({ now });
		// Add another session; if the cache is hit, we should NOT see it.
		await mkSession("s2", "/p", "active", recent);
		const b = await getDailyDigest({ now });
		expect(b.totals.sessions).toBe(a.totals.sessions);

		invalidateDigestCache();
		const c = await getDailyDigest({ now });
		expect(c.totals.sessions).toBe(2);
	});
});
