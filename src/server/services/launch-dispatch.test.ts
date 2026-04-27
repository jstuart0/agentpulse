import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { db, initializeDatabase } = await import("../db/client.js");
const { events, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema.js"
);
const { associateObservedSession } = await import("./launch-dispatch.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(managedSessions).execute();
	await db.delete(launchRequests).execute();
	await db.delete(supervisors).execute();
	await db.delete(sessions).execute();
});

async function mkSession(sessionId: string, metadata: Record<string, unknown> = {}) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: new Date().toISOString(),
			metadata,
		})
		.execute();
}

async function mkLaunchRequest(
	correlationId: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const id = crypto.randomUUID();
	await db
		.insert(launchRequests)
		.values({
			id,
			launchCorrelationId: correlationId,
			agentType: "claude_code",
			cwd: "/tmp/x",
			requestedLaunchMode: "interactive_terminal",
			status: "validated",
			...overrides,
		})
		.execute();
	return id;
}

async function readSession(sessionId: string) {
	const rows = await db.select().from(sessions).execute();
	return rows.find((r) => r.sessionId === sessionId);
}

describe("associateObservedSession provenance copy", () => {
	test("copies aiInitiated and askThreadId from launch_request.metadata to sessions.metadata", async () => {
		await mkSession("s-ai");
		await mkLaunchRequest("s-ai", {
			metadata: { aiInitiated: true, askThreadId: "thread-123" },
		});

		const result = await associateObservedSession({ sessionId: "s-ai" });
		expect(result).not.toBeNull();

		const row = await readSession("s-ai");
		expect(row?.metadata).toEqual({ aiInitiated: true, askThreadId: "thread-123" });
	});

	test("leaves sessions.metadata unchanged when launch_request.metadata is null", async () => {
		await mkSession("s-noprov", { existing: "value" });
		await mkLaunchRequest("s-noprov", { metadata: null });

		await associateObservedSession({ sessionId: "s-noprov" });

		const row = await readSession("s-noprov");
		expect(row?.metadata).toEqual({ existing: "value" });
	});

	test("does not overwrite existing sessions.metadata keys (idempotent re-correlation)", async () => {
		await mkSession("s-existing", {
			aiInitiated: false,
			askThreadId: "old-thread",
			other: "keep",
		});
		await mkLaunchRequest("s-existing", {
			metadata: { aiInitiated: true, askThreadId: "new-thread" },
		});

		await associateObservedSession({ sessionId: "s-existing" });

		const row = await readSession("s-existing");
		expect(row?.metadata).toEqual({
			aiInitiated: false,
			askThreadId: "old-thread",
			other: "keep",
		});
	});

	test("ignores unrelated metadata keys on the launch_request", async () => {
		await mkSession("s-extra");
		await mkLaunchRequest("s-extra", {
			metadata: { aiInitiated: true, somethingElse: "ignored" },
		});

		await associateObservedSession({ sessionId: "s-extra" });

		const row = await readSession("s-extra");
		expect(row?.metadata).toEqual({ aiInitiated: true });
	});

	test("returns null and is a no-op when no launch_request matches", async () => {
		await mkSession("s-orphan", { existing: 1 });
		const result = await associateObservedSession({ sessionId: "s-orphan" });
		expect(result).toBeNull();
		const row = await readSession("s-orphan");
		expect(row?.metadata).toEqual({ existing: 1 });
	});
});

describe("associateObservedSession desired-display-name rename", () => {
	test("rewrites auto-generated displayName to the desired one", async () => {
		await mkSession("s-rename");
		await db
			.update(sessions)
			.set({ displayName: "eager-fox" })
			.where(eq(sessions.sessionId, "s-rename"))
			.execute();
		await mkLaunchRequest("s-rename", { desiredDisplayName: "plan-caching" });

		await associateObservedSession({ sessionId: "s-rename" });

		const row = await readSession("s-rename");
		expect(row?.displayName).toBe("plan-caching");
	});

	test("does NOT rewrite when displayName is no longer adjective-noun shape", async () => {
		await mkSession("s-manual");
		await db
			.update(sessions)
			.set({ displayName: "my-feature-work" })
			.where(eq(sessions.sessionId, "s-manual"))
			.execute();
		await mkLaunchRequest("s-manual", { desiredDisplayName: "plan-caching" });

		await associateObservedSession({ sessionId: "s-manual" });

		const row = await readSession("s-manual");
		expect(row?.displayName).toBe("my-feature-work");
	});

	test("does NOT rewrite when launch_request has no desiredDisplayName", async () => {
		await mkSession("s-nopref");
		await db
			.update(sessions)
			.set({ displayName: "eager-fox" })
			.where(eq(sessions.sessionId, "s-nopref"))
			.execute();
		await mkLaunchRequest("s-nopref", { desiredDisplayName: null });

		await associateObservedSession({ sessionId: "s-nopref" });

		const row = await readSession("s-nopref");
		expect(row?.displayName).toBe("eager-fox");
	});

	test("idempotent: a second associate call after rename is a no-op", async () => {
		await mkSession("s-twice");
		await db
			.update(sessions)
			.set({ displayName: "eager-fox" })
			.where(eq(sessions.sessionId, "s-twice"))
			.execute();
		await mkLaunchRequest("s-twice", { desiredDisplayName: "plan-caching" });

		await associateObservedSession({ sessionId: "s-twice" });
		// Simulate a second correlation; the renamed value no longer matches
		// the adjective-noun pattern so the helper must leave it alone (and
		// must not append the desired name a second time).
		await associateObservedSession({ sessionId: "s-twice" });

		const row = await readSession("s-twice");
		expect(row?.displayName).toBe("plan-caching");
	});
});
