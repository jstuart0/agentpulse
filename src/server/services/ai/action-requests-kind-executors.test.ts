import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * Slice 2.5 smoke tests — KIND_EXECUTORS registry.
 *
 * Verifies that:
 *   1. session_archive path: approved action_request transitions to "applied"
 *      and the session row gains is_archived=1.
 *   2. session_delete path: approved action_request transitions to "applied"
 *      and the session row is gone.
 *   3. Missing-session race-loss path: session deleted between creation and
 *      approval → action_request transitions to "failed" with the session-gone
 *      failure reason.
 *   4. Unsupported-kind path: an action_request with kind="foo_bar" fails with
 *      the "Unsupported action kind: foo_bar" message.
 *
 * These are pure-DB integration tests — no HTTP server needed.
 */
import { eq } from "drizzle-orm";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiActionRequests, sessions } = await import("../../db/schema.js");
const { createActionRequest, resolveActionRequest, getActionRequest } = await import(
	"./action-requests-service.js"
);

// ---- helpers ----------------------------------------------------------------

function makeSession(sessionId: string) {
	return db.insert(sessions).values({
		sessionId,
		displayName: `Session ${sessionId}`,
		agentType: "claude_code",
		status: "active",
		isWorking: false,
		isPinned: false,
		isArchived: false,
		totalToolUses: 0,
	});
}

function sessionActionPayload(sessionId: string) {
	return { sessionId, sessionDisplayName: `Session ${sessionId}` };
}

// ---- setup ------------------------------------------------------------------

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	// Wipe between tests.
	await db.delete(aiActionRequests).execute();
	await db.delete(sessions).execute();
});

// ---- tests ------------------------------------------------------------------

describe("KIND_EXECUTORS registry — session_archive", () => {
	test("approved action_request becomes applied and session is archived", async () => {
		await makeSession("s-archive-1");

		const req = await createActionRequest({
			kind: "session_archive",
			question: "Archive session?",
			payload: sessionActionPayload("s-archive-1"),
			origin: "web",
		});

		const result = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test-user",
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.status).toBe("applied");

		const updated = await getActionRequest(req.id);
		expect(updated?.status).toBe("applied");

		const [row] = await db.select().from(sessions).where(eq(sessions.sessionId, "s-archive-1"));
		expect(row?.isArchived).toBe(true);
	});
});

describe("KIND_EXECUTORS registry — session_delete", () => {
	test("approved action_request becomes applied and session row is gone", async () => {
		await makeSession("s-delete-1");

		const req = await createActionRequest({
			kind: "session_delete",
			question: "Delete session?",
			payload: sessionActionPayload("s-delete-1"),
			origin: "web",
		});

		const result = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test-user",
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.status).toBe("applied");

		const updated = await getActionRequest(req.id);
		expect(updated?.status).toBe("applied");

		const remaining = await db.select().from(sessions).where(eq(sessions.sessionId, "s-delete-1"));
		expect(remaining.length).toBe(0);
	});
});

describe("KIND_EXECUTORS registry — missing-session race-loss", () => {
	test("session absent at execute time → action_request fails with session-gone reason", async () => {
		// Create the request but do NOT create the session row.
		const req = await createActionRequest({
			kind: "session_archive",
			question: "Archive session?",
			payload: sessionActionPayload("s-ghost"),
			origin: "web",
		});

		const result = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test-user",
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.reason === "failed") {
			expect(result.failureReason).toContain("no longer exists");
		}

		const updated = await getActionRequest(req.id);
		expect(updated?.status).toBe("failed");
	});
});

describe("KIND_EXECUTORS registry — unsupported kind", () => {
	test("action_request with unknown kind fails with Unsupported action kind message", async () => {
		// Insert directly so we can bypass the CreateActionRequestInput literal union.
		const now = new Date().toISOString();
		await db.insert(aiActionRequests).values({
			kind: "foo_bar",
			status: "awaiting_reply",
			question: "Do the foo bar?",
			payload: {},
			origin: "web",
			createdAt: now,
			updatedAt: now,
		});

		const [row] = await db.select().from(aiActionRequests);
		const id = row.id;

		const result = await resolveActionRequest({
			id,
			decision: "applied",
			resolvedBy: "test-user",
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.reason === "failed") {
			expect(result.failureReason).toContain("Unsupported action kind");
			expect(result.failureReason).toContain("foo_bar");
		}

		const updated = await getActionRequest(id);
		expect(updated?.status).toBe("failed");
		expect(updated?.failureReason).toContain("foo_bar");
	});
});

// ---- L-5 — runtime kind validation in createActionRequest ------------------

describe("createActionRequest — runtime kind gate", () => {
	test("rejects unknown kind at write time before touching the DB", async () => {
		const before = await db.select().from(aiActionRequests);
		// Cast through unknown to bypass the literal union at compile time and
		// hit the runtime gate. The runtime check is the safety net for callers
		// who came in over a generic JSON path (e.g. ts-ignored RPC).
		const promise = createActionRequest({
			kind: "bogus" as unknown as Parameters<typeof createActionRequest>[0]["kind"],
			question: "Do something bogus?",
			payload: {},
			origin: "web",
		});
		await expect(promise).rejects.toThrow(/unknown action request kind/i);
		const after = await db.select().from(aiActionRequests);
		// No row should have been inserted.
		expect(after.length).toBe(before.length);
	});

	test("accepts every kind from the canonical KNOWN_ACTION_REQUEST_KINDS list", async () => {
		const { KNOWN_ACTION_REQUEST_KINDS } = await import("./action-requests-types.js");
		// All kinds in the canonical list must round-trip through createActionRequest
		// without the runtime gate rejecting them. We don't bother stamping a real
		// payload — the gate only checks the kind discriminant.
		for (const kind of KNOWN_ACTION_REQUEST_KINDS) {
			const req = await createActionRequest({
				kind,
				question: `Test: ${kind}`,
				payload: {},
				origin: "web",
			});
			expect(req.kind).toBe(kind);
		}
	});
});

// ---- M-5 — narrowPayload behaves correctly --------------------------------

describe("narrowPayload", () => {
	test("returns the typed payload when kind matches", async () => {
		const { narrowPayload } = await import("./action-requests-service.js");
		const req = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "s-narrow-1", sessionDisplayName: "Hello" },
			origin: "web",
		});
		const reloaded = await getActionRequest(req.id);
		if (!reloaded) throw new Error("expected reloaded request");
		const payload = narrowPayload(reloaded, "session_archive");
		expect(payload.sessionId).toBe("s-narrow-1");
		expect(payload.sessionDisplayName).toBe("Hello");
	});

	test("throws when narrowing to the wrong kind", async () => {
		const { narrowPayload } = await import("./action-requests-service.js");
		const req = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "s-narrow-2", sessionDisplayName: null },
			origin: "web",
		});
		const reloaded = await getActionRequest(req.id);
		if (!reloaded) throw new Error("expected reloaded request");
		expect(() => narrowPayload(reloaded, "launch_request")).toThrow(
			/expected kind "launch_request"/,
		);
	});
});
