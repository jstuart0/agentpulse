import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { events, sessions } = await import("../../db/schema.js");
const { resolveCandidateSessions, fetchSessionsById } = await import("./resolver.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
});

async function insertSession(input: {
	id: string;
	displayName: string;
	cwd?: string;
	branch?: string;
	task?: string;
	isWorking?: boolean;
	status?: "active" | "idle" | "completed";
}) {
	const now = new Date().toISOString();
	await db
		.insert(sessions)
		.values({
			sessionId: input.id,
			agentType: "claude_code",
			displayName: input.displayName,
			status: input.status ?? "active",
			cwd: input.cwd ?? "/tmp",
			gitBranch: input.branch ?? null,
			currentTask: input.task ?? null,
			isWorking: input.isWorking ?? false,
			lastActivityAt: now,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

describe("Ask resolver", () => {
	test("matches sessions by display name keyword", async () => {
		await insertSession({ id: "s1", displayName: "brave-falcon", cwd: "/home/me/agentpulse" });
		await insertSession({ id: "s2", displayName: "calm-river", cwd: "/home/me/other-thing" });

		const hits = await resolveCandidateSessions({ message: "how is the agentpulse session doing?" });
		expect(hits.map((h) => h.sessionId)).toContain("s1");
		expect(hits.map((h) => h.sessionId)).not.toContain("s2");
	});

	test("boosts working sessions on ties", async () => {
		await insertSession({ id: "idle", displayName: "alpha-tango", isWorking: false });
		await insertSession({ id: "live", displayName: "beta-tango", isWorking: true });

		const hits = await resolveCandidateSessions({ message: "tango status" });
		expect(hits[0].sessionId).toBe("live");
	});

	test("falls back to active sessions when no keyword matches", async () => {
		await insertSession({ id: "a", displayName: "one", isWorking: true });
		await insertSession({ id: "b", displayName: "two" });

		const hits = await resolveCandidateSessions({
			message: "what are the agents doing overall?",
			fallbackToActive: true,
		});
		// Message only contained stopwords — resolver should return the active pool.
		expect(hits.length).toBeGreaterThan(0);
	});

	test("fetchSessionsById returns explicit picks only", async () => {
		await insertSession({ id: "a", displayName: "one" });
		await insertSession({ id: "b", displayName: "two" });
		await insertSession({ id: "c", displayName: "three" });

		const hits = await fetchSessionsById(["a", "c"]);
		expect(hits.map((h) => h.sessionId).sort()).toEqual(["a", "c"]);
	});
});
