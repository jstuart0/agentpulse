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
import { seedVerifiedChannel, tapUpdate } from "../test-utils/telegram-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { aiActionRequests, notificationChannels, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { createActionRequest, getActionRequest } = await import(
	"../services/ai/action-requests-service.js"
);
const telegram = await import("../services/channels/telegram.js");
const { handleTelegramUpdate } = await import("./channels.js");

const CHAT_REFUSAL =
	"Approve this in the dashboard. Chat approvals can't act on a member's session in team mode.";

/** The enrolled chat these taps come from; its channel is owned by a real (non-"local") user. */
const CHAT_ID = 555;
let chatChannelId = "";

/** What the bot answered to the callback tap. The network call itself is replaced. */
async function tapFromChat(requestId: string, action: "approve" | "decline"): Promise<string[]> {
	const answers: string[] = [];
	const spy = spyOn(telegram, "answerCallbackQuery").mockImplementation(async (_id, text) => {
		answers.push(text ?? "");
	});
	try {
		await handleTelegramUpdate(tapUpdate({ data: `act:${action}:${requestId}`, chatId: CHAT_ID }));
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
	await getDb().delete(notificationChannels);
	await getDb().delete(sessions);
}
beforeEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	chatChannelId = await seedVerifiedChannel({ chatId: String(CHAT_ID), userId: "chat-owner" });
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
		channelId: chatChannelId,
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
	test("team: a member is refused with 403 admin_required before anything is looked up, owner or not; nothing is burned", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-1", w.alice.id);
		const request = await archiveRequest("ar-1");

		for (const member of [w.bob, w.alice]) {
			const res = await decide(request.id, member.cookie);
			expect(res.status).toBe(403);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toBe("admin_required");
			expect(body).not.toHaveProperty("actionRequest");
		}
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
		expect(await archived("ar-1")).toBe(false);
	});

	test("team: a member can't tell a real request from a made-up one, or a decided one from an open one", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-1b", w.alice.id);
		const real = await archiveRequest("ar-1b");
		await decide(real.id, w.admin.cookie);
		const answers = [];
		for (const id of [real.id, "no-such-request"]) {
			for (const decision of ["applied", "declined"] as const) {
				const res = await decide(id, w.bob.cookie, decision);
				answers.push([res.status, await res.json()]);
			}
		}
		expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
		expect(answers[0]?.[0]).toBe(403);
	});

	test("team: an admin approves and it runs; the approver is recorded as that person, not as the AI", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("ar-2", w.alice.id);
		const request = await archiveRequest("ar-2");

		const res = await decide(request.id, w.admin.cookie);

		expect(res.status).toBe(200);
		expect((await getActionRequest(request.id))?.status).toBe("applied");
		expect(await archived("ar-2")).toBe(true);
		const [row] = await getDb()
			.select()
			.from(aiActionRequests)
			.where(eq(aiActionRequests.id, request.id));
		expect(row?.resolvedByUserId).toBe(w.admin.id);
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

		// The dashboard can still take it, as an admin.
		expect((await decide(request.id, w.admin.cookie)).status).toBe(200);
	});

	test("team: an unowned session is refused to a chat too: it has no identity", async () => {
		await setStoredMode("team");
		await seedSession("ar-6", null);
		const request = await archiveRequest("ar-6");
		expect(await tapFromChat(request.id, "approve")).toEqual([CHAT_REFUSAL]);
		expect(await archived("ar-6")).toBe(false);
	});

	test("a request with no channel can't be answered from any chat: Not authorized, in solo too", async () => {
		const w = await world();
		await seedSession("ar-10", w.alice.id);
		const request = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "ar-10", sessionDisplayName: "ar-10" },
			origin: "web",
		});
		for (const action of ["approve", "decline"] as const) {
			expect(await tapFromChat(request.id, action)).toEqual(["Not authorized."]);
		}
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
		expect(await archived("ar-10")).toBe(false);
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
		// The one inline actor is the channel owner's authority check in channelOwnerMayApprove,
		// which carries the owner's user id; nothing that is *passed to a resolver* is inline.
		expect(channels.match(/label:\s*"telegram"/g)?.length).toBe(1);
		expect(channels.match(/actor:\s*TELEGRAM_ACTOR/g)?.length).toBe(3); // ask, action request, HITL decision
	});
});
