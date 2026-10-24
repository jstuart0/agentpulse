/**
 * HITL taps from Telegram, after the inbound gate: the channel must be the
 * request's, the channel's owner must be allowed to decide, the decision is the
 * same resolveProposal every other surface uses, and the person is told what
 * really happened.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import { seedLocalUser, setStoredMode } from "../test-utils/team-fixtures.js";
import {
	answeredTexts,
	seedVerifiedChannel,
	sentTexts,
	tapUpdate,
	withTelegramApi,
} from "../test-utils/telegram-fixtures.js";
import {
	clearSetting,
	enableAiRuntime,
	seedEvent,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProposalWithHitl,
	seedProvider,
	seedSession,
	sha256,
} from "../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const schema = await import("../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	notificationChannels,
	sessions,
	supervisors,
	watcherProposals,
} = schema;
const { handleTelegramUpdate } = await import("./channels.js");
const feature = await import("../services/ai/feature.js");

const PROMPT = "Run the failing test and fix it";
let providerId = "";
let chat = 940_000;
const nextChat = () => {
	chat += 1;
	return chat;
};

beforeAll(() => initializeDatabase());

async function reset() {
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await getDb().delete(notificationChannels);
	await resetIdentityState();
	await clearSetting(feature.AI_KILL_SWITCH_KEY);
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

async function world(
	options: {
		channelUserId?: string;
		ownerUserId?: string;
		managed?: boolean;
		approvable?: boolean;
		prompt?: string;
	} = {},
) {
	const chatId = nextChat();
	const channelId = await seedVerifiedChannel({
		chatId: String(chatId),
		userId: options.channelUserId,
	});
	const sessionId = `tg-${chatId}`;
	if (options.managed === false) await seedSession(sessionId, { ownerUserId: options.ownerUserId });
	else await seedLiveManagedSession(sessionId, { ownerUserId: options.ownerUserId });
	const turn = await seedFinishedTurn(sessionId);
	const prompt = options.prompt ?? PROMPT;
	const ids = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
		channelId,
		approvable: options.approvable,
	});
	return { chatId, channelId, sessionId, prompt, ...turn, ...ids };
}

const tap = (w: { chatId: number; hitlId: string }, action: "approve" | "decline") =>
	withTelegramApi(async (calls) => {
		await handleTelegramUpdate(tapUpdate({ data: `hitl:${w.hitlId}:${action}`, chatId: w.chatId }));
		return { answers: answeredTexts(calls), sent: sentTexts(calls) };
	});

async function hitlStatus(id: string) {
	const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, id));
	return row?.status;
}
const promptActions = (sessionId: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));

describe("approving from Telegram", () => {
	test("really sends: the person is told so, the action is queued by the chat, and the audit row names the Telegram user", async () => {
		const w = await world();
		const { answers, sent } = await tap(w, "approve");
		expect(answers).toEqual(["Sent to the session."]);
		expect(sent).toEqual(["✅ Sent to the session."]);
		const rows = await promptActions(w.sessionId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.requestedBy).toBe("telegram");
		const [audit] = await getDb()
			.select()
			.from(aiDispatchAudit)
			.where(eq(aiDispatchAudit.sessionId, w.sessionId));
		expect(audit).toMatchObject({
			outcome: "sent",
			actorKind: "telegram",
			telegramFromId: String(w.chatId),
			telegramChatId: String(w.chatId),
			promptText: PROMPT,
			controlActionId: rows[0]?.id,
		});
		expect(await hitlStatus(w.hitlId)).toBe("applied");
	});

	test("every AI event from the tap is on the managed-control authority, none claim to be hook-observed", async () => {
		const w = await world();
		await tap(w, "approve");
		const aiEvents = (
			await getDb().select().from(events).where(eq(events.sessionId, w.sessionId))
		).filter((e) => (e.category ?? "").startsWith("ai_"));
		expect(aiEvents.map((e) => e.eventType).sort()).toEqual(["AiContinueSent", "AiHitlResponse"]);
		for (const event of aiEvents) expect(event.source).toBe("managed_control");
	});

	test("an observed session says so and leaves the request open", async () => {
		const w = await world({ managed: false });
		const { answers } = await tap(w, "approve");
		expect(answers).toEqual(["This session can't receive prompts; copy it from the dashboard."]);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("a request whose turn moved on is out of date; one past its expiry has expired; a second tap is already resolved", async () => {
		const stale = await world();
		await seedEvent(stale.sessionId, { eventType: "UserPromptSubmit", category: "prompt" });
		expect((await tap(stale, "approve")).answers).toEqual(["This suggestion is out of date."]);

		const expired = await world();
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, expired.hitlId));
		expect((await tap(expired, "approve")).answers).toEqual(["This request expired."]);

		const twice = await world();
		await tap(twice, "approve");
		expect((await tap(twice, "approve")).answers).toEqual(["Already resolved."]);
		expect(await promptActions(twice.sessionId)).toHaveLength(1);
	});

	test("a prompt the filter blocks is reported as blocked, and nothing is sent", async () => {
		const prompt = "Wipe everything with rm -rf / when done";
		const w = await world({ prompt });
		const { answers } = await tap(w, "approve");
		expect(answers).toEqual(["Blocked by the safety filter."]);
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("a suggestion that isn't approvable is not sent from Telegram", async () => {
		const w = await world({ approvable: false });
		const { answers } = await tap(w, "approve");
		expect(answers).toEqual(["Open the dashboard to review this one."]);
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("declining sends nothing and works", async () => {
		const w = await world();
		const { answers } = await tap(w, "decline");
		expect(answers).toEqual(["Declined ✗"]);
		expect(await hitlStatus(w.hitlId)).toBe("declined");
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});
});

describe("team mode", () => {
	test("a channel owned by local refuses Approve with the re-link reply, and Dismiss still works", async () => {
		await setStoredMode("team");
		const w = await world({ channelUserId: "local" });
		expect((await tap(w, "approve")).answers).toEqual([
			"Re-link this channel to approve from Telegram.",
		]);
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect((await tap(w, "decline")).answers).toEqual(["Declined ✗"]);
		expect(await hitlStatus(w.hitlId)).toBe("declined");
	});

	test("the channel's owner may approve on their own session; a channel whose owner doesn't own the session is told to use the dashboard", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("tg-owner", "user");
		const stranger = await seedLocalUser("tg-stranger", "user");
		const admin = await seedLocalUser("tg-admin", "admin");

		const own = await world({ channelUserId: owner.id, ownerUserId: owner.id });
		expect((await tap(own, "approve")).answers).toEqual(["Sent to the session."]);

		const foreign = await world({ channelUserId: stranger.id, ownerUserId: owner.id });
		expect((await tap(foreign, "approve")).answers).toEqual(["Approve this in the dashboard."]);
		expect(await promptActions(foreign.sessionId)).toHaveLength(0);

		const byAdmin = await world({ channelUserId: admin.id, ownerUserId: owner.id });
		expect((await tap(byAdmin, "approve")).answers).toEqual(["Sent to the session."]);
	});
});

describe("the callback carries only an id and an action", () => {
	test("extra fields are an unknown action and resolve nothing", async () => {
		const w = await world();
		const result = await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(
				tapUpdate({ data: `hitl:${w.hitlId}:approve:deadbeef`, chatId: w.chatId }),
			);
			return answeredTexts(calls);
		});
		expect(result).toEqual(["Unknown action."]);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("source scan: the call that resolves reads its hash from the server's row and nothing from the update", () => {
		const source = readFileSync(join(import.meta.dir, "channels.ts"), "utf8");
		const start = source.indexOf("async function handleHitlCallback(");
		const end = source.indexOf("async function handleActionCallback(");
		const handler = source.slice(start, end);
		const call = handler.slice(
			handler.indexOf("resolveProposal({"),
			handler.indexOf("});", handler.indexOf("resolveProposal({")),
		);
		expect(call).toContain("promptSha256: hitl.promptSha256");
		expect(call).not.toMatch(/\bcb\./);
		expect(call).not.toMatch(/customPrompt/);
		// The callback is only ever parsed for an id and an action.
		expect(handler).toContain("parseHitlCallbackData(cb.data");
	});
});

describe("a request not tied to this channel", () => {
	test("a request with no channel gets Not authorized and is not resolved", async () => {
		const w = await world();
		await getDb()
			.update(aiHitlRequests)
			.set({ channelId: null })
			.where(eq(aiHitlRequests.id, w.hitlId));
		const { answers } = await tap(w, "approve");
		expect(answers).toEqual(["Not authorized."]);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect(sha256(PROMPT)).toHaveLength(64);
	});
});
