// Acknowledgement model (WAITING vs IDLE) + session-identity hardening.
//
//   Stop               → lastAgentTurnCompletedAt = now, isWorking = false
//   Interrupt          → isWorking = false, neither timestamp moves
//   UserPromptSubmit   → lastUserAcknowledgedAt   = now, isWorking = true
//   UserAcknowledge    → lastUserAcknowledgedAt   = now, nothing else
//
// Both timestamps are nullable and null on rows that predate the columns.
// Identity: one CLI session id ↔ one row, whatever arrives and in whatever
// order; display names, cwd and project are never identity.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { eq } = await import("drizzle-orm");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { processHookEvent } = await import("./event-processor.js");
const { renameSession } = await import("./session-tracker.js");
const { app } = await import("../app.js");

import type { HookEventPayload } from "../../shared/types.js";

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function getSession(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

function hook(
	session_id: string,
	hook_event_name: string,
	extra: Partial<HookEventPayload> = {},
): HookEventPayload {
	return { session_id, hook_event_name, cwd: "/home/u/repo", ...extra };
}

const ack = (session_id: string) =>
	hook(session_id, "UserAcknowledge", {
		source: "copy",
		acknowledged_at: "2026-10-01T10:00:00.000Z",
		transcript_path: "/home/u/.claude/projects/x/s.jsonl",
	});

async function listSessions(): Promise<Array<Record<string, unknown>>> {
	const res = await app.request("/api/v1/sessions");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
	return body.sessions;
}

describe("ack model — timestamps", () => {
	test("new session has both timestamps null", async () => {
		await processHookEvent(hook("s1", "SessionStart"), "claude_code");
		const row = await getSession("s1");
		expect(row?.lastAgentTurnCompletedAt).toBeNull();
		expect(row?.lastUserAcknowledgedAt).toBeNull();
	});

	test("Stop writes lastAgentTurnCompletedAt and clears isWorking", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "hi" }), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(true);
		const before = Date.now();
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		const row = await getSession("s1");
		expect(row?.isWorking).toBe(false);
		expect(row?.lastAgentTurnCompletedAt).not.toBeNull();
		expect(Date.parse(row?.lastAgentTurnCompletedAt ?? "")).toBeGreaterThanOrEqual(before);
	});

	test("Stop does not touch lastUserAcknowledgedAt", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "hi" }), "claude_code");
		const acked = (await getSession("s1"))?.lastUserAcknowledgedAt;
		expect(acked).not.toBeNull();
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		expect((await getSession("s1"))?.lastUserAcknowledgedAt).toBe(acked ?? null);
	});

	test("Interrupt clears isWorking but stamps neither timestamp (Codex)", async () => {
		await processHookEvent(hook("x1", "UserPromptSubmit", { prompt: "go" }), "codex_cli");
		const acked = (await getSession("x1"))?.lastUserAcknowledgedAt;
		await processHookEvent(hook("x1", "Interrupt", { turn_id: "t-1" }), "codex_cli");
		const row = await getSession("x1");
		expect(row?.isWorking).toBe(false);
		expect(row?.lastAgentTurnCompletedAt).toBeNull();
		expect(row?.lastUserAcknowledgedAt).toBe(acked ?? null);
	});

	test("UserPromptSubmit writes lastUserAcknowledgedAt and sets isWorking (Claude and Codex)", async () => {
		for (const [id, agent] of [
			["c1", "claude_code"],
			["x1", "codex_cli"],
		] as const) {
			await processHookEvent(hook(id, "SessionStart"), agent);
			await processHookEvent(hook(id, "UserPromptSubmit", { prompt: "go" }), agent);
			const row = await getSession(id);
			expect(row?.isWorking).toBe(true);
			expect(row?.lastUserAcknowledgedAt).not.toBeNull();
			expect(row?.lastAgentTurnCompletedAt).toBeNull();
		}
	});

	test("UserAcknowledge writes lastUserAcknowledgedAt, stores a user_ack event, changes nothing else", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "hi" }), "claude_code");
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		const before = await getSession("s1");
		await new Promise((r) => setTimeout(r, 2));

		const result = await processHookEvent(ack("s1"), "claude_code");
		expect(result.isNew).toBe(false);
		expect(result.session?.sessionId).toBe("s1");
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.category).toBe("user_ack");

		const after = await getSession("s1");
		expect(after?.lastUserAcknowledgedAt).not.toBeNull();
		expect(after?.lastUserAcknowledgedAt ?? "").not.toBe(before?.lastUserAcknowledgedAt ?? "");
		expect(after?.lastAgentTurnCompletedAt).toBe(before?.lastAgentTurnCompletedAt ?? null);
		expect(after?.isWorking).toBe(false);
		expect(after?.status).toBe("active");
		expect(after?.endedAt).toBeNull();
		expect(after?.cwd).toBe(before?.cwd ?? null);
		// AGEN: an acknowledgement must not bump lastActivityAt — a replaying
		// sender could otherwise keep a dead session alive and suppress the
		// no-activity alert by repeatedly "acknowledging" it.
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt ?? "");

		const stored = await getDb().select().from(events).where(eq(events.sessionId, "s1"));
		const ackEvents = stored.filter((e) => e.eventType === "UserAcknowledge");
		expect(ackEvents).toHaveLength(1);
		expect(ackEvents[0]?.category).toBe("user_ack");
		expect(ackEvents[0]?.isNoise).toBe(false);
		expect((ackEvents[0]?.rawPayload as Record<string, unknown>)?.acknowledged_at).toBe(
			"2026-10-01T10:00:00.000Z",
		);
	});

	test("UserAcknowledge does not set isWorking=true and does not clear it either", async () => {
		await processHookEvent(hook("s1", "SessionStart"), "claude_code");
		await processHookEvent(ack("s1"), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(false);

		await processHookEvent(hook("s1", "PreToolUse", { tool_name: "Bash" }), "claude_code");
		await processHookEvent(ack("s1"), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(true);
	});

	test("UserAcknowledge for an unknown session creates nothing", async () => {
		const result = await processHookEvent(ack("ghost"), "claude_code");
		expect(result.session).toBeNull();
		expect(result.isNew).toBe(false);
		expect(result.events).toHaveLength(0);
		expect(await getSession("ghost")).toBeUndefined();
		const stored = await getDb().select().from(events).where(eq(events.sessionId, "ghost"));
		expect(stored).toHaveLength(0);
	});

	test("UserAcknowledge never reanimates a completed session", async () => {
		await processHookEvent(hook("s1", "SessionStart"), "claude_code");
		await processHookEvent(hook("s1", "SessionEnd"), "claude_code");
		const ended = await getSession("s1");
		expect(ended?.status).toBe("completed");
		await processHookEvent(ack("s1"), "claude_code");
		const row = await getSession("s1");
		expect(row?.status).toBe("completed");
		expect(row?.endedAt).toBe(ended?.endedAt ?? null);
		expect(row?.lastActivityAt).toBe(ended?.lastActivityAt ?? "");
		expect(row?.isWorking).toBe(false);
		expect(row?.lastUserAcknowledgedAt).not.toBeNull();
	});

	test("UserAcknowledge leaves an active permission wait in place (approval precedence)", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "hi" }), "claude_code");
		await processHookEvent(
			hook("s1", "PermissionRequest", { tool_use_id: "t1", tool_name: "Bash" }),
			"claude_code",
		);
		expect((await getSession("s1"))?.semanticStatus).toBe("waiting");
		await processHookEvent(ack("s1"), "claude_code");
		const row = await getSession("s1");
		expect(row?.semanticStatus).toBe("waiting");
		const wait = (row?.metadata as Record<string, unknown>)?.permissionWait as
			| { ids: string[] }
			| undefined;
		expect(wait?.ids).toEqual(["t1"]);
	});
});

describe("ack model — transitions (timestamp order the client classifies on)", () => {
	const turn = async (id: string) => (await getSession(id))?.lastAgentTurnCompletedAt ?? null;
	const acked = async (id: string) => (await getSession(id))?.lastUserAcknowledgedAt ?? null;
	const later = (a: string | null, b: string | null) => (a ?? "") >= (b ?? "");

	test("prompt → Stop → ack → prompt → Stop keeps the expected ordering", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "1" }), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(true); // WORKING

		await new Promise((r) => setTimeout(r, 2));
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(false);
		expect(later(await turn("s1"), await acked("s1"))).toBe(true); // WAITING: turn ≥ ack

		await new Promise((r) => setTimeout(r, 2));
		await processHookEvent(ack("s1"), "claude_code");
		expect(later(await acked("s1"), await turn("s1"))).toBe(true); // IDLE: ack ≥ turn
		expect((await getSession("s1"))?.isWorking).toBe(false);

		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "2" }), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(true); // WORKING
		expect(later(await acked("s1"), await turn("s1"))).toBe(true);

		await new Promise((r) => setTimeout(r, 2));
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		expect((await getSession("s1"))?.isWorking).toBe(false);
		expect(Date.parse((await turn("s1")) ?? "")).toBeGreaterThan(
			Date.parse((await acked("s1")) ?? ""),
		); // WAITING again
	});
});

describe("ack model — API serialization", () => {
	test("rows without the timestamps serialize both fields as null and keep existing fields", async () => {
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "legacy-1",
				displayName: "legacy-1",
				agentType: "claude_code",
				status: "active",
				isWorking: false,
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();

		const row = (await listSessions()).find((s) => s.sessionId === "legacy-1");
		expect(row).toBeDefined();
		expect(row).toHaveProperty("lastAgentTurnCompletedAt", null);
		expect(row).toHaveProperty("lastUserAcknowledgedAt", null);
		for (const key of [
			"id",
			"sessionId",
			"displayName",
			"agentType",
			"status",
			"isWorking",
			"isArchived",
			"semanticStatus",
			"metadata",
			"lastActivityAt",
			"startedAt",
			"endedAt",
			"cwd",
			"projectId",
			"managed",
			"nameSource",
		]) {
			expect(row).toHaveProperty(key);
		}
	});

	test("after Stop and ack both fields are ISO strings on the list and detail endpoints", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "hi" }), "claude_code");
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		await processHookEvent(ack("s1"), "claude_code");
		const row = (await listSessions()).find((s) => s.sessionId === "s1");
		expect(typeof row?.lastAgentTurnCompletedAt).toBe("string");
		expect(typeof row?.lastUserAcknowledgedAt).toBe("string");
		expect(Number.isNaN(Date.parse(String(row?.lastAgentTurnCompletedAt)))).toBe(false);

		const detail = await app.request("/api/v1/sessions/s1");
		expect(detail.status).toBe(200);
		const body = (await detail.json()) as { session: Record<string, unknown> };
		expect(typeof body.session.lastAgentTurnCompletedAt).toBe("string");
		expect(typeof body.session.lastUserAcknowledgedAt).toBe("string");
	});
});

describe("session identity — one CLI session id, one row", () => {
	test("repeated SessionStart with the same id never creates a second row", async () => {
		await processHookEvent(hook("same", "SessionStart", { source: "startup" }), "claude_code");
		await processHookEvent(hook("same", "SessionStart", { source: "resume" }), "claude_code");
		await processHookEvent(hook("same", "SessionStart", { source: "compact" }), "claude_code");
		const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, "same"));
		expect(rows).toHaveLength(1);
	});

	test("simultaneous first hooks for a brand-new session id: one row, no throw", async () => {
		await Promise.all([
			processHookEvent(hook("race", "SessionStart"), "claude_code"),
			processHookEvent(hook("race", "UserPromptSubmit", { prompt: "hi" }), "claude_code"),
			processHookEvent(hook("race", "PreToolUse", { tool_name: "Bash" }), "claude_code"),
		]);
		const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, "race"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.isWorking).toBe(true);
	});

	test("Stop, then later tool/prompt events, stay on the same row", async () => {
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "1" }), "claude_code");
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		await processHookEvent(hook("s1", "PreToolUse", { tool_name: "Bash" }), "claude_code");
		await processHookEvent(hook("s1", "UserPromptSubmit", { prompt: "2" }), "claude_code");
		const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, "s1"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("active");
	});

	test("PreCompact/PostCompact and subagent events do not create a session of their own", async () => {
		await processHookEvent(hook("parent", "SessionStart"), "codex_cli");
		await processHookEvent(hook("parent", "PreCompact", { trigger: "auto" }), "codex_cli");
		await processHookEvent(hook("parent", "PostCompact", { trigger: "auto" }), "codex_cli");
		await processHookEvent(
			hook("parent", "SubagentStart", { agent_id: "a1", agent_type: "Explore" }),
			"claude_code",
		);
		await processHookEvent(hook("parent", "SubagentStop", { agent_id: "a1" }), "claude_code");
		const all = await getDb().select().from(sessions);
		expect(all).toHaveLength(1);
		expect(all[0]?.sessionId).toBe("parent");
	});

	test("a display-name change updates the row; it never changes identity", async () => {
		await processHookEvent(hook("s1", "SessionStart"), "claude_code");
		const before = await getSession("s1");
		await renameSession("s1", "zany-sage", { source: "user" });
		await processHookEvent(hook("s1", "Stop"), "claude_code");
		const after = await getSession("s1");
		expect(after?.id).toBe(before?.id ?? "");
		expect(after?.displayName).toBe("zany-sage");
		expect(await getDb().select().from(sessions)).toHaveLength(1);
	});

	test("several genuine sessions in the same cwd stay separate; Claude and Codex ids do not collide", async () => {
		const cwd = "/home/u/repo";
		await processHookEvent(
			hook("11111111-aaaa-4bbb-8ccc-000000000001", "SessionStart", { cwd }),
			"claude_code",
		);
		await processHookEvent(
			hook("11111111-aaaa-4bbb-8ccc-000000000002", "SessionStart", { cwd }),
			"claude_code",
		);
		await processHookEvent(
			hook("01a0f6d3-2fc9-75f3-896f-eaca319518e2", "SessionStart", { cwd }),
			"codex_cli",
		);
		const all = await getDb().select().from(sessions);
		expect(all).toHaveLength(3);
		expect(new Set(all.map((s) => s.sessionId)).size).toBe(3);
		expect(all.filter((s) => s.agentType === "codex_cli")).toHaveLength(1);
	});
});

// AGEN: the synthetic UserAcknowledge hook event must not let a stranger's
// key clear another user's WAITING. Accept when the posting key's owner
// matches the session's owner, or when either side is unowned; otherwise
// drop it silently (still a stored-nothing no-op, same as an unknown
// session — never an error, since the hook route is always-200).
describe("ack model — UserAcknowledge respects session ownership", () => {
	const ctxFor = (ownerUserId: string | null, ingestKeyId: string | null) => ({
		keyId: ingestKeyId ?? "anonymous",
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId, ingestKeyId },
	});

	test("matching owner: the ack applies", async () => {
		await processHookEvent(
			hook("own-match", "SessionStart"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		const result = await processHookEvent(
			ack("own-match"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		expect(result.session?.lastUserAcknowledgedAt).not.toBeNull();
	});

	test("mismatched owner: the ack is dropped, nothing stamped or stored", async () => {
		await processHookEvent(
			hook("own-mismatch", "SessionStart"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		const before = await getSession("own-mismatch");
		const result = await processHookEvent(
			ack("own-mismatch"),
			"claude_code",
			ctxFor("user-B", "key-B"),
		);
		expect(result.session).toBeNull();
		expect(result.events).toHaveLength(0);
		const after = await getSession("own-mismatch");
		expect(after?.lastUserAcknowledgedAt).toBe(before?.lastUserAcknowledgedAt ?? null);
		const stored = await getDb().select().from(events).where(eq(events.sessionId, "own-mismatch"));
		expect(stored.filter((e) => e.eventType === "UserAcknowledge")).toHaveLength(0);
	});

	test("session unowned, posting key owned: the ack applies (either side null)", async () => {
		await processHookEvent(
			hook("own-session-null", "SessionStart"),
			"claude_code",
			ctxFor(null, null),
		);
		const result = await processHookEvent(
			ack("own-session-null"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		expect(result.session?.lastUserAcknowledgedAt).not.toBeNull();
	});

	// AGEN: an ownerless posting key (no caller context, or a service key)
	// must not be able to acknowledge — and so hide the WAITING/ERROR state
	// of — a session someone else owns. Unlike the ingest owner-fill rule,
	// there is no "either side null passes" exception once the row itself
	// is owned: only a matching owner may clear it.
	test("session owned, posting key unowned (anonymous/service key): the ack is dropped, nothing stamped or stored", async () => {
		await processHookEvent(
			hook("own-poster-null", "SessionStart"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		const before = await getSession("own-poster-null");
		const result = await processHookEvent(
			ack("own-poster-null"),
			"claude_code",
			ctxFor(null, null),
		);
		expect(result.session).toBeNull();
		expect(result.events).toHaveLength(0);
		const after = await getSession("own-poster-null");
		expect(after?.lastUserAcknowledgedAt).toBe(before?.lastUserAcknowledgedAt ?? null);
		const stored = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "own-poster-null"));
		expect(stored.filter((e) => e.eventType === "UserAcknowledge")).toHaveLength(0);
	});

	test("every dropped ack (mismatched owner, or ownerless key on an owned session) bumps the owner-mismatch counter", async () => {
		const { getIngestOwnerMismatchCount, _resetIngestOwnerMismatchForTest } = await import(
			"../routes/ingest-counters.js"
		);
		_resetIngestOwnerMismatchForTest();

		await processHookEvent(
			hook("own-counter-1", "SessionStart"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		await processHookEvent(ack("own-counter-1"), "claude_code", ctxFor("user-B", "key-B"));
		expect(getIngestOwnerMismatchCount()).toBe(1);

		await processHookEvent(
			hook("own-counter-2", "SessionStart"),
			"claude_code",
			ctxFor("user-A", "key-A"),
		);
		await processHookEvent(ack("own-counter-2"), "claude_code", ctxFor(null, null));
		expect(getIngestOwnerMismatchCount()).toBe(2);
	});
});

// AGEN security: "mark as unseen" is not hook-reachable. UserUnacknowledge
// must never reach the generic event path (which would set status:"active"
// and clear endedAt, hiding a failed session's ERROR) regardless of who
// posts it — the dashboard's DELETE /sessions/:id/acknowledge route is the
// only legitimate way to clear an acknowledgement.
describe("ack model — UserUnacknowledge is not hook-reachable", () => {
	const ctxFor = (ownerUserId: string | null, ingestKeyId: string | null) => ({
		keyId: ingestKeyId ?? "anonymous",
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId, ingestKeyId },
	});

	async function mkFailedSession(sessionId: string, ownerUserId: string | null) {
		await getDb()
			.insert(sessions)
			.values({
				sessionId,
				displayName: sessionId,
				agentType: "claude_code",
				status: "failed",
				isWorking: false,
				endedAt: "2026-10-01T09:00:00.000Z",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				lastUserAcknowledgedAt: null,
				metadata: {},
				ownerUserId,
			})
			.execute();
	}

	const unack = (session_id: string) =>
		hook(session_id, "UserUnacknowledge", { source: "dashboard" });

	test.each([
		["owned by a different user", "user-A", ctxFor("user-B", "key-B")],
		["owned by the posting user", "user-A", ctxFor("user-A", "key-A")],
		["owned, posted by an ownerless key", "user-A", ctxFor(null, null)],
		["unowned, posted by an ownerless key", null, ctxFor(null, null)],
	] as const)(
		"against a failed session (%s): no-op, still 200-shaped",
		async (_label, owner, ctx) => {
			const sessionId = `unack-${owner ?? "none"}-${ctx.keyId}`;
			await mkFailedSession(sessionId, owner);
			const before = await getSession(sessionId);

			const result = await processHookEvent(unack(sessionId), "claude_code", ctx);

			expect(result.session).toBeNull();
			expect(result.events).toHaveLength(0);
			const after = await getSession(sessionId);
			expect(after?.status).toBe(before?.status ?? "failed");
			expect(after?.endedAt).toBe(before?.endedAt ?? null);
			expect(after?.lastUserAcknowledgedAt).toBe(before?.lastUserAcknowledgedAt ?? null);
			expect(after?.lastActivityAt).toBe(before?.lastActivityAt ?? "");
			const stored = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
			expect(stored).toHaveLength(0);
		},
	);

	test("bumps the unacknowledge-dropped counter, not the owner-mismatch counter", async () => {
		const {
			getIngestUnacknowledgeDroppedCount,
			getIngestOwnerMismatchCount,
			_resetIngestUnacknowledgeDroppedForTest,
			_resetIngestOwnerMismatchForTest,
		} = await import("../routes/ingest-counters.js");
		_resetIngestUnacknowledgeDroppedForTest();
		_resetIngestOwnerMismatchForTest();

		await mkFailedSession("unack-counter", "user-A");
		await processHookEvent(unack("unack-counter"), "claude_code", ctxFor("user-B", "key-B"));

		expect(getIngestUnacknowledgeDroppedCount()).toBe(1);
		expect(getIngestOwnerMismatchCount()).toBe(0);
	});
});
