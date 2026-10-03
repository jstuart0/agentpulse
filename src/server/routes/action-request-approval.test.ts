/**
 * Approving an action request in team mode, at its two real callers.
 *  - The dashboard's decide route runs the owner-or-admin rule for the signed-in
 *    approver: a member on someone else's session is refused (403 not_owner),
 *    the session is kept and the request stays open; the owner may approve.
 *  - A chat approval (Telegram) acts as a chat with no identity: in team mode
 *    it can't approve an owner-gated action, is told so plainly, and does not
 *    consume the request. Solo is unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { aiActionRequests, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { createActionRequest, getActionRequest } = await import(
	"../services/ai/action-requests-service.js"
);
const telegram = await import("../services/channels/telegram.js");
const { handleTelegramUpdate } = await import("./channels.js");

const CHAT_REFUSAL =
	"Approve this in the dashboard. Chat approvals can't act on a member's session in team mode.";

/** What the bot answered to the callback tap. The network call itself is replaced. */
async function tapFromChat(requestId: string, action: "approve" | "decline"): Promise<string[]> {
	const answers: string[] = [];
	const spy = spyOn(telegram, "answerCallbackQuery").mockImplementation(async (_id, text) => {
		answers.push(text ?? "");
	});
	try {
		await handleTelegramUpdate({
			update_id: 1,
			callback_query: {
				id: "cb-1",
				from: { id: 555 },
				data: `act:${action}:${requestId}`,
				message: { chat: { id: 555 } },
			},
		} as never);
	} finally {
		spy.mockRestore();
	}
	return answers;
}

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(aiActionRequests);
	await getDb().delete(sessions);
}
beforeEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", true, { allowProtected: true });
});
afterEach(async () => {
	await reset();
	// Leave AI off at runtime, as a fresh install has it.
	await upsertSetting("ai.enabled", false, { allowProtected: true });
});

async function world() {
	const alice = await seedLocalUser("ar-alice");
	const bob = await seedLocalUser("ar-bob");
	const admin = await seedLocalUser("ar-admin", "admin");
	return {
		alice: { id: alice.id, cookie: await cookieHeadersFor(alice.id) },
		bob: { id: bob.id, cookie: await cookieHeadersFor(bob.id) },
		admin: { id: admin.id, cookie: await cookieHeadersFor(admin.id) },
	};
}
async function seedSession(id: string, ownerUserId: string | null) {
	await getDb()
		.insert(sessions)
		.values({ sessionId: id, agentType: "claude_code", status: "completed", ownerUserId });
}
async function archiveRequest(sessionId: string) {
	return createActionRequest({
		kind: "session_archive",
		question: "Archive?",
		payload: { sessionId, sessionDisplayName: sessionId },
		origin: "web",
	});
}
const decide = (id: string, headers: Headers, decision: "applied" | "declined" = "applied") =>
	app.request(
		`/api/v1/ai/action-requests/${id}/decide`,
		jsonRequest("POST", { decision }, headers),
	);
async function archived(id: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
	return row?.isArchived;
}

describe("the dashboard's decide route", () => {
	test("a member approving an action on someone else's session is refused with 403 not_owner; nothing is burned", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-1", w.alice.id);
		const request = await archiveRequest("ar-1");

		const res = await decide(request.id, w.bob.cookie);

		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("not_owner");
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
		expect(await archived("ar-1")).toBe(false);
	});

	test("then the owner approves the same request and it runs; an admin may too", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-2", w.alice.id);
		const request = await archiveRequest("ar-2");
		expect((await decide(request.id, w.bob.cookie)).status).toBe(403);

		const res = await decide(request.id, w.alice.cookie);

		expect(res.status).toBe(200);
		expect((await getActionRequest(request.id))?.status).toBe("applied");
		expect(await archived("ar-2")).toBe(true);

		await seedSession("ar-2b", w.alice.id);
		const second = await archiveRequest("ar-2b");
		expect((await decide(second.id, w.admin.cookie)).status).toBe(200);
		expect(await archived("ar-2b")).toBe(true);
	});

	test("the approver is recorded as the person, not as the AI", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-3", w.alice.id);
		const request = await archiveRequest("ar-3");
		await decide(request.id, w.alice.cookie);
		const [row] = await getDb()
			.select()
			.from(aiActionRequests)
			.where(eq(aiActionRequests.id, request.id));
		expect(row?.resolvedByUserId).toBe(w.alice.id);
	});

	test("solo: any signed-in user approves", async () => {
		const w = await world();
		await seedSession("ar-4", w.alice.id);
		const request = await archiveRequest("ar-4");
		expect((await decide(request.id, w.bob.cookie)).status).toBe(200);
		expect(await archived("ar-4")).toBe(true);
	});
});

describe("a chat approval (Telegram)", () => {
	test("team: an owner-gated action is refused with a plain message, and the request stays open", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-5", w.alice.id);
		const request = await archiveRequest("ar-5");

		const answers = await tapFromChat(request.id, "approve");

		expect(answers).toEqual([CHAT_REFUSAL]);
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
		expect(await archived("ar-5")).toBe(false);

		// The dashboard can still take it.
		expect((await decide(request.id, w.alice.cookie)).status).toBe(200);
	});

	test("team: an unowned session is refused to a chat too: it has no identity", async () => {
		await setStoredMode("team");
		await seedSession("ar-6", null);
		const request = await archiveRequest("ar-6");
		expect(await tapFromChat(request.id, "approve")).toEqual([CHAT_REFUSAL]);
		expect(await archived("ar-6")).toBe(false);
	});

	test("solo: the chat approves as before", async () => {
		const w = await world();
		await seedSession("ar-7", w.alice.id);
		const request = await archiveRequest("ar-7");
		const answers = await tapFromChat(request.id, "approve");
		expect(answers.join(" ")).toContain("Approved");
		expect(await archived("ar-7")).toBe(true);
	});

	test("declining is still possible from a chat in team mode", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-8", w.alice.id);
		const request = await archiveRequest("ar-8");
		expect(await tapFromChat(request.id, "decline")).toEqual(["Declined."]);
		expect((await getActionRequest(request.id))?.status).toBe("declined");
	});

	test("an already-resolved request still answers as before", async () => {
		const w = await world();
		await seedSession("ar-9", w.alice.id);
		const request = await archiveRequest("ar-9");
		await decide(request.id, w.alice.cookie);
		expect(await tapFromChat(request.id, "approve")).toEqual(["Already resolved."]);
	});

	test("the Telegram routes pass the one named chat actor, never an inline one", () => {
		const channels = readFileSync(join(import.meta.dir, "channels.ts"), "utf8");
		expect(/label:\s*"telegram"/.test(channels)).toBe(false);
		expect(channels.match(/actor:\s*TELEGRAM_ACTOR/g)?.length).toBe(2);
	});
});
