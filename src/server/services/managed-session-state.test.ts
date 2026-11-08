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

	// The canary's `detail-in-row` mutation (AGEN-123) puts a `leaked` key on a turn_unasked row. The whitelist
	// strips it, so that variant survives by design; the canary now leaks through `content`, which the whitelist keeps.
	test("a leaked key on a turn_unasked row never reaches storage, through the real append path", async () => {
		await mkSession("fork-3");
		await seedOwnedLaunch("fork-3", "sup-1");
		const token = "FT-LEAK-7f3a9c";
		await appendManagedSessionEvents("sup-1", "fork-3", [
			{
				eventType: "HeadlessStatus",
				category: "progress_update",
				content: "Read (1): ran without asking",
				rawPayload: {
					source: "claude_stream",
					kind: "turn_unasked",
					claudeStreamRuntime: true,
					leaked: token,
				},
			},
		]);
		const rows = await getDb().select().from(events).where(eq(events.sessionId, "fork-3"));
		expect(JSON.stringify(rows)).not.toContain(token);
	});

	// Review M1: the whitelist follows the session, not the sender's marker, and a call row's text is the fixed words.
	describe("a session the server marked as a fork is normalized whatever the sender says", () => {
		const SECRET = "TOKEN-sk-live-4f2a";
		const mkFork = async (id: string) => {
			await mkSession(id, { forkedFromSessionId: "source-1" });
			await seedOwnedLaunch(id, "sup-1");
		};
		const rowsOf = (id: string) =>
			getDb().select().from(events).where(eq(events.sessionId, id)).orderBy(events.id);

		test("an unmarked row keeps no payload key outside the whitelist, and no marker is invented", async () => {
			await mkFork("fork-m1-a");
			await appendManagedSessionEvents("sup-1", "fork-m1-a", [
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content: "Bash: didn't succeed",
					rawPayload: {
						source: "claude_stream",
						kind: "call",
						tool: "Bash",
						toolOutcome: "failed",
						tool_use_id: "toolu_m1",
						command: SECRET,
						output: SECRET,
					},
				},
			]);
			const [row] = await rowsOf("fork-m1-a");
			expect(JSON.stringify(row)).not.toContain(SECRET);
			expect(row?.rawPayload).toEqual({
				source: "claude_stream",
				kind: "call",
				tool: "Bash",
				toolOutcome: "failed",
				tool_use_id: "toolu_m1",
			});
		});

		test("host text in a call row's content is replaced by the fixed words; the legitimate rows are kept as sent", async () => {
			await mkFork("fork-m1-b");
			const call = (content: string, id: string, extra: object = {}) => ({
				eventType: "HeadlessStatus",
				category: "progress_update" as const,
				content,
				rawPayload: {
					source: "claude_stream",
					kind: "call",
					claudeStreamRuntime: true,
					tool: "Bash",
					toolOutcome: "approved",
					tool_use_id: id,
					...extra,
				},
			});
			await appendManagedSessionEvents("sup-1", "fork-m1-b", [
				call(`Bash: ${SECRET}`, "toolu_1"),
				call("Read: ran, you approved it", "toolu_2", { tool: "Read" }),
				call("Subagent Read: ran without asking", "toolu_3", { toolOutcome: "unasked" }),
				call("Agent: ran, you approved it", "toolu_4", { tool: "Agent" }),
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content: `Ran without asking you this turn: Read (4), Bash (2). ${SECRET}`,
					rawPayload: { source: "claude_stream", kind: "turn_unasked", claudeStreamRuntime: true },
				},
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content:
						"Ran without asking you this turn: Read (4), Bash (2). These were read-only, or your Claude settings allowed them.",
					rawPayload: { source: "claude_stream", kind: "turn_unasked", claudeStreamRuntime: true },
				},
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content: "Claude tried this and was refused: Write (1).",
					rawPayload: { source: "claude_stream", kind: "turn_refused", claudeStreamRuntime: true },
				},
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content: SECRET,
					rawPayload: { source: "claude_stream", kind: "mystery", claudeStreamRuntime: true },
				},
				{
					eventType: "HeadlessPromptSubmitted",
					category: "prompt",
					content: "please run the tests",
					rawPayload: { source: "agentpulse_workspace", claudeStreamRuntime: true },
				},
				{
					eventType: "HeadlessPromptFailed",
					category: "system_event",
					content: "The turn didn't finish.",
					rawPayload: { status: "turn_error", claudeStreamRuntime: true },
				},
			]);
			const rows = await rowsOf("fork-m1-b");
			expect(JSON.stringify(rows)).not.toContain(SECRET);
			expect(rows.map((r) => r.content)).toEqual([
				"Bash: ran, you approved it",
				"Read: ran, you approved it",
				"Subagent Read: ran without asking",
				"Agent: ran, you approved it",
				"Ran without asking you this turn:",
				"Ran without asking you this turn: Read (4), Bash (2). These were read-only, or your Claude settings allowed them.",
				"Claude tried this and was refused: Write (1).",
				null,
				"please run the tests",
				"The turn didn't finish.",
			]);
		});

		test("a session that is not a fork keeps its content (positive control)", async () => {
			await mkSession("plain-m1");
			await seedOwnedLaunch("plain-m1", "sup-1");
			await appendManagedSessionEvents("sup-1", "plain-m1", [
				{
					eventType: "HeadlessStatus",
					category: "progress_update",
					content: "anything the launch says",
					rawPayload: { kind: "call", extra: "kept" },
				},
			]);
			const [row] = await rowsOf("plain-m1");
			expect(row?.content).toBe("anything the launch says");
			expect(row?.rawPayload).toEqual({ kind: "call", extra: "kept" });
		});
	});

	test("an Agent call row keeps its tool name; a non-reported name loses it", async () => {
		await mkSession("fork-4");
		await seedOwnedLaunch("fork-4", "sup-1");
		const call = (tool: string, id: string) => ({
			eventType: "HeadlessStatus",
			category: "progress_update" as const,
			content: `${tool}: ran, you approved it`,
			rawPayload: {
				source: "claude_stream",
				kind: "call",
				claudeStreamRuntime: true,
				tool,
				toolOutcome: "approved",
				is_error: false,
				tool_use_id: id,
			},
		});
		await appendManagedSessionEvents("sup-1", "fork-4", [
			call("Agent", "toolu_agent1"),
			call("Task", "toolu_task1"),
		]);
		const [agent, task] = await storedPayloads("fork-4");
		expect(agent?.tool).toBe("Agent");
		expect(task).not.toHaveProperty("tool");
	});
});
