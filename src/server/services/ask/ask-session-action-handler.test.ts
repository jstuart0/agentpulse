// codex r2 High #1 — Ask-command manual renames must route through
// renameSession(sessionId, name, { source: "user" }) so the F5 native-name
// precedence contract (Decision 6) holds for the Ask surface, not just the
// dashboard. README advertises "rename auth-worker to auth-refactor".
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { managedSessions, sessions } = await import("../../db/schema/index.js");
const { applyNativeName } = await import("../session-tracker.js");
const { handleSessionAction } = await import("./ask-session-action-handler.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
});

async function insertSession(id: string, overrides: Record<string, unknown> = {}) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			displayName: id,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			isArchived: false,
			lastActivityAt: now,
			startedAt: now,
			...overrides,
		})
		.execute();
}

async function getSession(id: string) {
	const rows = await getDb().select().from(sessions).execute();
	return rows.find((r) => r.sessionId === id);
}

// resolveSession(null) — the recency fallback path — hits the DB directly
// with a simple query (most-recently-active non-archived session), so it
// needs no search-backend/FTS mocking. Using a null sessionHint keeps this
// test focused on the rename precedence contract rather than NL resolution.
const baseArgs = { origin: "web" as const, threadId: "thread-1", telegramChatId: null };

describe("handleSessionAction rename", () => {
	test("stamps metadata.renameSource: 'user' via renameSession (not a direct displayName write)", async () => {
		await insertSession("ask-rename-1", { displayName: "auth-worker" });

		const result = await handleSessionAction(
			{ action: "rename", sessionHint: null, noteText: null, newName: "auth-refactor" },
			baseArgs,
		);

		expect(result.replyText).toContain("auth-worker");
		expect(result.replyText).toContain("auth-refactor");

		const row = await getSession("ask-rename-1");
		expect(row?.displayName).toBe("auth-refactor");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("user");
	});

	test("still mirrors the managed session title when a managed row exists", async () => {
		await insertSession("ask-rename-managed", { displayName: "old-title" });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: "ask-rename-managed",
				launchRequestId: "lr-1",
				supervisorId: "sup-1",
				managedState: "managed",
				providerSyncState: "synced",
				desiredThreadTitle: "old-title",
			})
			.execute();

		await handleSessionAction(
			{ action: "rename", sessionHint: null, noteText: null, newName: "new-title" },
			baseArgs,
		);

		const [managed] = await getDb().select().from(managedSessions).execute();
		expect(managed?.desiredThreadTitle).toBe("new-title");
		expect(managed?.providerSyncState).toBe("pending");
	});

	test("an Ask rename survives a subsequent applyNativeName pull (the regression this fix closes)", async () => {
		await insertSession("ask-rename-precedence", { displayName: "auth-worker" });

		await handleSessionAction(
			{ action: "rename", sessionHint: null, noteText: null, newName: "auth-refactor" },
			baseArgs,
		);

		const pullResult = await applyNativeName("ask-rename-precedence", "claude-native-name");
		expect(pullResult).toEqual({ found: true, applied: false });

		const row = await getSession("ask-rename-precedence");
		expect(row?.displayName).toBe("auth-refactor");
	});

	test("blank new name is rejected before touching the session", async () => {
		await insertSession("ask-rename-blank", { displayName: "original" });

		const result = await handleSessionAction(
			{ action: "rename", sessionHint: null, noteText: null, newName: "   " },
			baseArgs,
		);

		expect(result.replyText).toContain("I need a new name");
		const row = await getSession("ask-rename-blank");
		expect(row?.displayName).toBe("original");
	});
});
