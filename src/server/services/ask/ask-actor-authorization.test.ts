/**
 * Ask intents that change a session run the owner-or-admin rule for the real
 * actor (the signed-in caller on the web; a Telegram chat has none). Refusal
 * text: "Only the owner or an admin can do that."
 *
 * Gated: pin, unpin, rename (direct writes), archive and delete (refused when
 * the request is made, and again when approved), bulk archive and delete
 * (sessions the actor can't change are left out). Open by design: add a note
 * (as on the REST route), stop, resume (a new launch), Q&A, search, digest.
 * Solo is unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../ai/__test_db.js";
import type { Actor } from "../../auth/actor.js";
import { TELEGRAM_ACTOR } from "../../auth/actor.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedLocalUser,
	setStoredMode,
} from "../../test-utils/team-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { aiActionRequests, managedSessions, sessions } = await import("../../db/schema/index.js");
const { handleSessionAction } = await import("./ask-session-action-handler.js");
const { handleBulkAction } = await import("./ask-bulk-action-handler.js");

const REFUSAL = "Only the owner or an admin can do that.";

beforeAll(() => initializeDatabase());
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(aiActionRequests);
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

const web = { origin: "web" as const, threadId: "thread-1", telegramChatId: null };

async function insertSession(
	id: string,
	ownerUserId: string | null,
	extra: Record<string, unknown> = {},
) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			displayName: id,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			startedAt: now,
			ownerUserId,
			...extra,
		});
}
async function row(id: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
	return r;
}
const requestCount = async () => (await getDb().select().from(aiActionRequests)).length;

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("ask-alice");
	const bob = await seedLocalUser("ask-bob");
	const admin = await seedLocalUser("ask-admin", "admin");
	const as = (userId: string, role: "member" | "admin"): Actor => ({
		userId,
		label: "user",
		role,
		mode: "team",
	});
	return {
		alice,
		bob,
		owner: as(alice.id, "member"),
		stranger: as(bob.id, "member"),
		admin: as(admin.id, "admin"),
	};
}

const pin = { action: "pin" as const, sessionHint: null, noteText: null, newName: null };
const unpin = { ...pin, action: "unpin" as const };
const rename = { ...pin, action: "rename" as const, newName: "renamed" };
const note = { ...pin, action: "add_note" as const, noteText: "a note" };
const archive = { ...pin, action: "archive" as const };
const del = { ...pin, action: "delete" as const };

describe("team mode: pin, unpin and rename", () => {
	test("a member who isn't the owner is refused, and nothing changes", async () => {
		const t = await team();
		await insertSession("ask-1", t.alice.id, { displayName: "original" });

		for (const intent of [pin, unpin, rename]) {
			const result = await handleSessionAction(intent, { ...web, actor: t.stranger });
			expect(result.replyText).toBe(REFUSAL);
			expect(result.actionRequestId).toBeNull();
		}
		const after = await row("ask-1");
		expect(after?.isPinned).toBe(false);
		expect(after?.displayName).toBe("original");
	});

	test("the owner and an admin may", async () => {
		const t = await team();
		await insertSession("ask-2", t.alice.id);
		expect((await handleSessionAction(pin, { ...web, actor: t.owner })).replyText).toContain(
			"Pinned",
		);
		expect((await handleSessionAction(unpin, { ...web, actor: t.admin })).replyText).toContain(
			"Unpinned",
		);
		expect((await handleSessionAction(rename, { ...web, actor: t.admin })).replyText).toContain(
			"Renamed",
		);
		expect((await row("ask-2"))?.displayName).toBe("renamed");
	});

	test("a Telegram chat has no identity: refused on an owned session and on an unowned one", async () => {
		const t = await team();
		await insertSession("ask-3", t.alice.id);
		expect((await handleSessionAction(pin, { ...web, actor: TELEGRAM_ACTOR })).replyText).toBe(
			REFUSAL,
		);
		await reset();
		await setStoredMode("team");
		await insertSession("ask-3b", null);
		expect((await handleSessionAction(pin, { ...web, actor: TELEGRAM_ACTOR })).replyText).toBe(
			REFUSAL,
		);
		expect((await row("ask-3b"))?.isPinned).toBe(false);
	});

	test("a signed-in member may change an unowned session", async () => {
		const t = await team();
		await insertSession("ask-4", null);
		expect((await handleSessionAction(pin, { ...web, actor: t.stranger })).replyText).toContain(
			"Pinned",
		);
	});
});

describe("team mode: notes are open", () => {
	test("any signed-in member, or a chat, may add a note to anyone's session", async () => {
		const t = await team();
		await insertSession("ask-5", t.alice.id);
		for (const actor of [t.stranger, TELEGRAM_ACTOR]) {
			const result = await handleSessionAction(note, { ...web, actor });
			expect(result.replyText).toContain("Note appended");
		}
		expect((await row("ask-5"))?.notes).toBe("a note\na note");
	});
});

describe("team mode: archive and delete requests", () => {
	test("refused when the actor couldn't do it, and no request is created", async () => {
		const t = await team();
		await insertSession("ask-6", t.alice.id);
		for (const intent of [archive, del]) {
			const result = await handleSessionAction(intent, { ...web, actor: t.stranger });
			expect(result.replyText).toBe(REFUSAL);
			expect(result.actionRequestId).toBeNull();
		}
		expect(await requestCount()).toBe(0);
	});

	test("queued for the owner and for an admin", async () => {
		const t = await team();
		await insertSession("ask-7", t.alice.id);
		expect(
			(await handleSessionAction(archive, { ...web, actor: t.owner })).actionRequestId,
		).not.toBeNull();
		expect(
			(await handleSessionAction(del, { ...web, actor: t.admin })).actionRequestId,
		).not.toBeNull();
		expect(await requestCount()).toBe(2);
	});
});

describe("team mode: bulk archive and delete", () => {
	const completed = {
		action: "archive" as const,
		filter: { strategy: "attribute" as const, status: "completed" as const },
	} as never;

	async function seedMixed(t: Awaited<ReturnType<typeof team>>) {
		const ended = new Date().toISOString();
		const base = { status: "completed", endedAt: ended };
		await insertSession("bulk-mine", t.bob.id, base);
		await insertSession("bulk-theirs", t.alice.id, base);
		await insertSession("bulk-unowned", null, base);
	}

	test("only the sessions the actor may change are queued", async () => {
		const t = await team();
		await seedMixed(t);

		const result = await handleBulkAction(completed, [], { ...web, actor: t.stranger });

		expect(result.actionRequestId).not.toBeNull();
		const [request] = await getDb().select().from(aiActionRequests);
		const ids = ((request?.payload as { sessionIds: string[] }).sessionIds ?? []).sort();
		expect(ids).toEqual(["bulk-mine", "bulk-unowned"]);
	});

	test("when none qualify the reply is the refusal and nothing is queued", async () => {
		const t = await team();
		await insertSession("bulk-only-theirs", t.alice.id, {
			status: "completed",
			endedAt: new Date().toISOString(),
		});

		const result = await handleBulkAction(completed, [], { ...web, actor: t.stranger });

		expect(result.replyText).toBe(REFUSAL);
		expect(await requestCount()).toBe(0);
	});

	test("an admin gets every session; a chat none", async () => {
		const t = await team();
		await seedMixed(t);
		const asAdmin = await handleBulkAction(completed, [], { ...web, actor: t.admin });
		expect(asAdmin.actionRequestId).not.toBeNull();
		await getDb().delete(aiActionRequests);
		const asChat = await handleBulkAction(completed, [], { ...web, actor: TELEGRAM_ACTOR });
		expect(asChat.replyText).toBe(REFUSAL);
		expect(await requestCount()).toBe(0);
	});
});

describe("solo mode is unchanged", () => {
	test("anyone, a chat included, may pin, rename, archive and bulk-archive", async () => {
		const alice = await seedLocalUser("ask-solo");
		await insertSession("solo-1", alice.id);
		for (const actor of [TELEGRAM_ACTOR, { userId: null, label: "anonymous" as const }]) {
			expect((await handleSessionAction(pin, { ...web, actor })).replyText).toContain("Pinned");
			expect((await handleSessionAction(rename, { ...web, actor })).replyText).toContain("Renamed");
			expect(
				(await handleSessionAction(archive, { ...web, actor })).actionRequestId,
			).not.toBeNull();
		}
		await insertSession("solo-2", alice.id, {
			status: "completed",
			endedAt: new Date().toISOString(),
		});
		const bulk = await handleBulkAction(
			{ action: "archive", filter: { strategy: "attribute", status: "completed" } } as never,
			[],
			{ ...web, actor: TELEGRAM_ACTOR },
		);
		expect(bulk.actionRequestId).not.toBeNull();
	});
});
