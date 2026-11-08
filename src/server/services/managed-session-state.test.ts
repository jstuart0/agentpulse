import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, managedSessions, sessions } = await import("../db/schema/index.js");
const { appendManagedSessionEvents, upsertManagedSessionState } = await import(
	"./managed-session-state.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, metadata: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "codex_cli",
			status: "active",
			lastActivityAt: new Date().toISOString(),
			metadata,
		})
		.execute();
}

async function readSession(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

describe("upsertManagedSessionState — metadata merge (late read-modify-write)", () => {
	test("merges input.metadata onto existing metadata for an existing session", async () => {
		await mkSession("managed-1", { existing: "value" });
		await seedOwnedLaunch("managed-1", "sup-1");

		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-1",
			metadata: { providerRunId: "run-1" },
		});

		const row = await readSession("managed-1");
		expect(row?.metadata).toEqual({ existing: "value", providerRunId: "run-1" });
	});

	test("preserves a concurrent writer's metadata keys (e.g. permissionWait) alongside its own", async () => {
		await mkSession("managed-2", {
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});
		await seedOwnedLaunch("managed-2", "sup-1");

		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-2",
			metadata: { providerRunId: "run-2" },
		});

		const row = await readSession("managed-2");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
			providerRunId: "run-2",
		});
	});

	test("new-session insert path is unaffected — metadata is just input.metadata", async () => {
		await seedOwnedLaunch("managed-new", "sup-1");
		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-new",
			metadata: { providerRunId: "run-new" },
		});

		const row = await readSession("managed-new");
		expect(row?.metadata).toEqual({ providerRunId: "run-new" });
	});
});

// F85 (ian mid-build): the returned `session` (what supervisors.ts's
// `c.json(result)` sends back to the caller verbatim) must carry
// nameSource/nativeName, not just the WS broadcast the caller can't see.
describe("upsertManagedSessionState — result.session carries nameSource/nativeName (F85)", () => {
	test("a manually-pinned session's result.session reflects nameSource:'user'", async () => {
		await mkSession("managed-pinned", { renameSource: "user", nativeName: "codex-thread-name" });
		await seedOwnedLaunch("managed-pinned", "sup-1");

		const result = await upsertManagedSessionState("sup-1", {
			sessionId: "managed-pinned",
			metadata: { providerRunId: "run-3" },
		});

		expect(result.session.nameSource).toBe("user");
		expect(result.session.nativeName).toBe("codex-thread-name");
	});

	test("a new session's result.session defaults to nameSource:'generated'", async () => {
		await seedOwnedLaunch("managed-generated", "sup-1");

		const result = await upsertManagedSessionState("sup-1", {
			sessionId: "managed-generated",
		});

		expect(result.session.nameSource).toBe("generated");
		expect(result.session.nativeName).toBeNull();
	});
});

// AGEN-122 (F14, F51): what a fork's rows store is rebuilt from a whitelist on the way in.
describe("appendManagedSessionEvents: a fork's row payloads are whitelisted", () => {
	const storedPayloads = async (sessionId: string) =>
		(
			await getDb().select().from(events).where(eq(events.sessionId, sessionId)).orderBy(events.id)
		).map((e) => e.rawPayload as Record<string, unknown>);

	test("a call row stores its five keys; an exit code out of range is dropped while the row stores", async () => {
		await mkSession("fork-1");
		await seedOwnedLaunch("fork-1", "sup-1");
		await appendManagedSessionEvents("sup-1", "fork-1", [
			{
				eventType: "HeadlessStatus",
				category: "progress_update",
				content: "Bash: didn't succeed",
				rawPayload: {
					source: "claude_stream",
					kind: "call",
					claudeStreamRuntime: true,
					tool: "Bash",
					toolOutcome: "failed",
					is_error: true,
					exit_code: 300,
					tool_use_id: "toolu_01abc",
					command: "cat ~/.ssh/id_rsa",
				},
			},
			{
				eventType: "HeadlessStatus",
				category: "progress_update",
				content: "Bash: didn't succeed (second)",
				rawPayload: {
					source: "claude_stream",
					kind: "call",
					claudeStreamRuntime: true,
					tool: "Bash",
					toolOutcome: "failed",
					is_error: true,
					exit_code: 3,
					tool_use_id: "toolu_02abc",
				},
			},
		]);
		const [dropped, kept] = await storedPayloads("fork-1");
		expect(dropped).toEqual({
			source: "claude_stream",
			kind: "call",
			claudeStreamRuntime: true,
			tool: "Bash",
			toolOutcome: "failed",
			is_error: true,
			tool_use_id: "toolu_01abc",
		});
		expect(kept?.exit_code).toBe(3);
	});

	test("an unasked-turn row with an extra key is stored without it; a row without the marker is untouched", async () => {
		await mkSession("fork-2");
		await seedOwnedLaunch("fork-2", "sup-1");
		await appendManagedSessionEvents("sup-1", "fork-2", [
			{
				eventType: "HeadlessStatus",
				category: "progress_update",
				content: "x",
				rawPayload: {
					source: "claude_stream",
					kind: "turn_unasked",
					claudeStreamRuntime: true,
					command: "rm -rf /",
				},
			},
			{
				eventType: "ManagedWarning",
				category: "system_event",
				content: "y",
				rawPayload: { anything: "stays" },
			},
		]);
		const [row, other] = await storedPayloads("fork-2");
		expect(row).toEqual({
			source: "claude_stream",
			kind: "turn_unasked",
			claudeStreamRuntime: true,
		});
		expect(other).toEqual({ anything: "stays" });
	});
});
