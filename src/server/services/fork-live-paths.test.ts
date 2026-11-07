/**
 * Delete and archive of a continued session that may still have a process, through every path that reaches
 * them (AGEN-117 P5-I1, T17): the route, the Ask handler (single), the three action-request executors (a
 * single archive, a single delete, a bulk request) and the approve gate. Each turns the refusal into a fixed
 * sentence or a 409, never a throw, a 500 or the raw code. Also an open takeover (`takeover_in_progress`),
 * which the Ask handler already handled and the executors did not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import {
	END_SESSION_FIRST_MESSAGE,
	TAKEOVER_IN_PROGRESS_MESSAGE,
} from "../../shared/takeover-in-progress.js";
import { ANONYMOUS_ACTOR } from "../auth/actor.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { aiActionRequests, controlActions, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { createActionRequest, resolveActionRequest, getActionRequest } = await import(
	"./ai/action-requests-service.js"
);
const { handleSessionAction } = await import("./ask/ask-session-action-handler.js");

const originalDisableAuth = config.disableAuth;
const HOST = "fork-live-host";

beforeAll(async () => {
	await initializeDatabase();
	(await import("../routes/health.js")).markDbReady();
});
beforeEach(async () => {
	(config as Record<string, unknown>).disableAuth = true;
	await getDb().delete(aiActionRequests);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: HOST,
			hostName: "mac-1",
			platform: "darwin",
			arch: "arm64",
			version: "1",
			capabilities: {},
			trustedRoots: [],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		});
});
afterEach(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});
afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
	await getDb().delete(aiActionRequests);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
});

let counter = 0;
async function liveFork(state = "managed"): Promise<string> {
	const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			displayName: `forky-${counter}-${id.slice(-4)}`,
			agentType: "claude_code",
			status: "completed",
			endedAt: now,
			metadata: { forkedFromSessionId: "src" },
		});
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: id,
			launchRequestId: id,
			supervisorId: HOST,
			managedState: state,
			createdAt: now,
			updatedAt: now,
		} as never);
	return id;
}

/** A session with a takeover of it open. */
async function underTakeover(): Promise<string> {
	const id = `00000000-0000-4000-9000-${String(++counter).padStart(12, "0")}`;
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			displayName: `observed-${counter}-${id.slice(-4)}`,
			agentType: "claude_code",
			status: "completed",
			endedAt: new Date().toISOString(),
		});
	await getDb()
		.insert(controlActions)
		.values({
			id: crypto.randomUUID(),
			sessionId: id,
			actionType: "resume",
			requestedBy: "user",
			status: "running",
			metadata: {
				resumeKind: "takeover",
				agentType: "claude_code",
				forkSessionId: crypto.randomUUID(),
			},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as never);
	return id;
}

const exists = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id))).length === 1;
const archived = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0]?.isArchived;

const CASES = [
	["a live fork", liveFork, END_SESSION_FIRST_MESSAGE, "end_session_first"],
	["an open takeover", underTakeover, TAKEOVER_IN_PROGRESS_MESSAGE, "takeover_in_progress"],
] as const;

describe.each(CASES)("%s", (_name, make, sentence, code) => {
	test("the route answers 409 with the code for delete and archive, and changes nothing", async () => {
		const id = await make();
		const del = await app.request(`/api/v1/sessions/${id}`, { method: "DELETE" });
		expect(del.status).toBe(409);
		expect(await del.json()).toEqual({ error: code });
		const arch = await app.request(`/api/v1/sessions/${id}/archive`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		expect(arch.status).toBe(409);
		expect(await exists(id)).toBe(true);
		expect(await archived(id)).toBe(false);
	});

	test.each(["delete", "archive"] as const)(
		"Ask (%s) replies with the sentence, not the code, and does not throw",
		async (action) => {
			const id = await make();
			const reply = await handleSessionAction(
				{
					action,
					sessionHint: (await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0]
						?.displayName,
				} as never,
				{ origin: "web", threadId: "t", telegramChatId: null, actor: ANONYMOUS_ACTOR } as never,
			);
			expect(reply.replyText).toBe(sentence);
			expect(reply.replyText).not.toContain(code);
			expect(await exists(id)).toBe(true);
		},
	);

	test.each([
		["session_archive", (id: string) => ({ sessionId: id, sessionDisplayName: "n" })],
		["session_delete", (id: string) => ({ sessionId: id, sessionDisplayName: "n" })],
		[
			"bulk_session_action",
			(id: string) => ({ action: "delete", sessionIds: [id], sessionNames: ["n"], exclusions: [] }),
		],
		[
			"bulk_session_action",
			(id: string) => ({
				action: "archive",
				sessionIds: [id],
				sessionNames: ["n"],
				exclusions: [],
			}),
		],
	] as const)(
		"the %s executor, approved, fails the request with the sentence and never throws",
		async (kind, payload) => {
			const id = await make();
			const req = await createActionRequest({
				kind,
				question: "?",
				payload: payload(id) as never,
				origin: "web",
			});
			const result = await resolveActionRequest({
				id: req.id,
				decision: "applied",
				resolvedBy: "test-user",
				actor: ANONYMOUS_ACTOR,
			});
			const stored = await getActionRequest(req.id);
			const text = JSON.stringify({ result, stored });
			// A bulk request reports its per-session outcomes in the notification only: the request is applied
			// and the session untouched. The single executors carry the sentence as the failure.
			if (!kind.startsWith("bulk")) expect(text).toContain(sentence.slice(0, 40));
			expect(text).not.toContain(code);
			expect(await exists(id)).toBe(true);
		},
	);
});

describe("unarchive of a live fork", () => {
	test("is allowed (it changes nothing about a process); archive and delete stay refused", async () => {
		const id = await liveFork();
		await getDb().update(sessions).set({ isArchived: true }).where(eq(sessions.sessionId, id));
		const res = await app.request(`/api/v1/sessions/${id}/archive`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: false }),
		});
		expect(res.status).toBe(200);
		expect(await archived(id)).toBe(false);
		const again = await app.request(`/api/v1/sessions/${id}/archive`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		expect(again.status).toBe(409);
	});
});

describe("states that may be deleted", () => {
	test.each(["stopped", "failed", "completed"])(
		"a fork in %s is deleted through the route",
		async (state) => {
			const id = await liveFork(state);
			const del = await app.request(`/api/v1/sessions/${id}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			expect(await exists(id)).toBe(false);
		},
	);
});
