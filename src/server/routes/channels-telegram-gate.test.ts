/**
 * Every inbound Telegram update except `/start <code>` is authorized by one
 * gate (a private chat, a linked channel, the enrolled Telegram user) before a
 * handler runs. Driven through handleTelegramUpdate with the Telegram HTTP API
 * replaced by a recorder.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";
import {
	answeredTexts,
	seedLegacyChannel,
	seedVerifiedChannel,
	sentTexts,
	tapUpdate,
	textUpdate,
	withTelegramApi,
} from "../test-utils/telegram-fixtures.js";
import {
	enableAiRuntime,
	seedProvider,
	seedSession,
	setSetting,
} from "../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const schema = await import("../db/schema/index.js");
const { aiActionRequests, aiHitlRequests, notificationChannels, sessions } = schema;
const { createActionRequest, getActionRequest } = await import(
	"../services/ai/action-requests-service.js"
);
const channelsService = await import("../services/channels/channels-service.js");
const askService = await import("../services/ask/ask-service.js");
const { handleTelegramUpdate } = await import("./channels.js");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");

beforeAll(() => initializeDatabase());

let nextChat = 710_000;
/** A chat id nobody has used, so the per-chat enrollment counter starts clean. */
const freshChat = () => {
	nextChat += 1;
	return String(nextChat);
};

beforeEach(async () => {
	await getDb().delete(aiHitlRequests);
	await getDb().delete(aiActionRequests);
	await getDb().delete(notificationChannels);
	await getDb().delete(sessions);
	await enableAiRuntime();
	await setSetting("labs", { askAssistant: true });
});
afterEach(async () => {
	await setSetting("labs", {});
});

async function actionRequest(channelId: string | null) {
	await seedSession("gate-archive");
	return createActionRequest({
		kind: "session_archive",
		question: "Archive?",
		payload: { sessionId: "gate-archive", sessionDisplayName: "gate-archive" },
		origin: "web",
		channelId: channelId ?? undefined,
	});
}

async function hitl(channelId: string | null): Promise<string> {
	await seedSession("gate-hitl");
	const id = crypto.randomUUID();
	const providerId = await seedProvider();
	await getDb()
		.insert(schema.watcherProposals)
		.values({
			id: `p-${id}`,
			sessionId: "gate-hitl",
			providerId,
			state: "complete",
			decision: "ask",
		});
	await getDb()
		.insert(aiHitlRequests)
		.values({
			id,
			proposalId: `p-${id}`,
			sessionId: "gate-hitl",
			channelId,
			status: "awaiting_reply",
		});
	return id;
}

async function hitlStatus(id: string): Promise<string | undefined> {
	const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, id));
	return row?.status;
}

describe("act: approvals", () => {
	test("from the enrolled private chat and user, it is resolved", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const request = await actionRequest(channelId);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `act:approve:${request.id}`, chatId: chat }));
			expect(answeredTexts(calls).join(" ")).toContain("Approved");
		});
		expect((await getActionRequest(request.id))?.status).toBe("applied");
	});

	test("N1: a group chat with the enrolled chat id is refused and the request stays open", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const request = await actionRequest(channelId);
		for (const chatType of ["group", "supergroup"] as const) {
			await withTelegramApi(async (calls) => {
				await handleTelegramUpdate(
					tapUpdate({ data: `act:approve:${request.id}`, chatId: chat, chatType }),
				);
				expect(answeredTexts(calls)).toEqual(["Not authorized."]);
			});
		}
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});

	test("the right private chat but another Telegram user is refused", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const request = await actionRequest(channelId);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(
				tapUpdate({ data: `act:approve:${request.id}`, chatId: chat, fromId: 999 }),
			);
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});

	test("a callback with no message fails closed", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const request = await actionRequest(channelId);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(
				tapUpdate({ data: `act:approve:${request.id}`, chatId: chat, withMessage: false }),
			);
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});

	test("a request tied to no channel can't be approved from Telegram, even by the enrolled user", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const request = await actionRequest(null);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `act:approve:${request.id}`, chatId: chat }));
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});

	test("a request tied to a different channel is refused", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const otherChannel = await seedVerifiedChannel({ chatId: freshChat() });
		const request = await actionRequest(otherChannel);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `act:approve:${request.id}`, chatId: chat }));
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});
});

describe("HITL taps", () => {
	test("the enrolled user's tap resolves it", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const id = await hitl(channelId);
		await withTelegramApi(async () => {
			await handleTelegramUpdate(tapUpdate({ data: `hitl:${id}:decline`, chatId: chat }));
		});
		expect(await hitlStatus(id)).toBe("declined");
	});

	test("a group-chat tap and a different Telegram user each get Not authorized and leave it open", async () => {
		const chat = freshChat();
		const channelId = await seedVerifiedChannel({ chatId: chat });
		const id = await hitl(channelId);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(
				tapUpdate({ data: `hitl:${id}:approve`, chatId: chat, chatType: "group" }),
			);
			await handleTelegramUpdate(
				tapUpdate({ data: `hitl:${id}:approve`, chatId: chat, fromId: 12 }),
			);
			expect(answeredTexts(calls)).toEqual(["Not authorized.", "Not authorized."]);
		});
		expect(await hitlStatus(id)).toBe("awaiting_reply");
	});

	test("a HITL tied to no channel can't be acted on from Telegram", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const id = await hitl(null);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `hitl:${id}:approve`, chatId: chat }));
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect(await hitlStatus(id)).toBe("awaiting_reply");
	});

	test("a HITL tied to another channel is refused", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const other = await seedVerifiedChannel({ chatId: freshChat() });
		const id = await hitl(other);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `hitl:${id}:approve`, chatId: chat }));
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect(await hitlStatus(id)).toBe("awaiting_reply");
	});
});

describe("Ask messages", () => {
	function stubAsk() {
		const turn = spyOn(askService, "runAskTurn").mockImplementation((async () => ({
			assistantMessage: { content: "an answer", errorMessage: null },
		})) as never);
		const thread = spyOn(askService, "findOrCreateTelegramThread").mockImplementation(
			(async () => ({
				id: "thread-1",
			})) as never,
		);
		return {
			turn,
			restore: () => {
				turn.mockRestore();
				thread.mockRestore();
			},
		};
	}

	test("the enrolled chat gets an Ask turn and its answer", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const ask = stubAsk();
		try {
			await withTelegramApi(async (calls) => {
				await handleTelegramUpdate(textUpdate({ text: "which sessions are stuck?", chatId: chat }));
				expect(sentTexts(calls)).toEqual(["an answer"]);
			});
			expect(ask.turn).toHaveBeenCalledTimes(1);
		} finally {
			ask.restore();
		}
	});

	test("N1: a group message from the enrolled chat id, or another sender, starts no turn and gets no reply", async () => {
		const chat = freshChat();
		await seedVerifiedChannel({ chatId: chat });
		const ask = stubAsk();
		try {
			await withTelegramApi(async (calls) => {
				await handleTelegramUpdate(
					textUpdate({ text: "which sessions are stuck?", chatId: chat, chatType: "group" }),
				);
				await handleTelegramUpdate(
					textUpdate({ text: "which sessions are stuck?", chatId: chat, fromId: 12 }),
				);
				expect(calls).toEqual([]);
			});
			expect(ask.turn).not.toHaveBeenCalled();
		} finally {
			ask.restore();
		}
	});

	test("an unlinked private chat gets exactly one 'isn't linked' reply and no turn", async () => {
		const ask = stubAsk();
		try {
			await withTelegramApi(async (calls) => {
				await handleTelegramUpdate(textUpdate({ text: "hello there", chatId: freshChat() }));
				const texts = sentTexts(calls);
				expect(texts).toHaveLength(1);
				expect(texts[0]).toContain("isn't linked");
			});
			expect(ask.turn).not.toHaveBeenCalled();
		} finally {
			ask.restore();
		}
	});

	test("an unlinked private chat sending a bare command gets nothing", async () => {
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(textUpdate({ text: "/help", chatId: freshChat() }));
			expect(calls).toEqual([]);
		});
	});

	test("with the assistant off, an unlinked chat gets no reply", async () => {
		await setSetting("labs", {});
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(textUpdate({ text: "hello there", chatId: freshChat() }));
			expect(calls).toEqual([]);
		});
	});
});

describe("channels enrolled before the Telegram user was recorded", () => {
	test("a private chat's channel works for that user and refuses another", async () => {
		const chat = freshChat();
		const channelId = await seedLegacyChannel({ chatId: chat });
		const request = await actionRequest(channelId);
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(
				tapUpdate({ data: `act:approve:${request.id}`, chatId: chat, fromId: 999 }),
			);
			expect(answeredTexts(calls)).toEqual(["Not authorized."]);
		});
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
		await withTelegramApi(async () => {
			await handleTelegramUpdate(tapUpdate({ data: `act:approve:${request.id}`, chatId: chat }));
		});
		expect((await getActionRequest(request.id))?.status).toBe("applied");
	});

	test("a group-enrolled channel refuses every callback and message until it is re-linked", async () => {
		const groupChat = "-100777";
		const channelId = await seedLegacyChannel({ chatId: groupChat });
		const request = await actionRequest(channelId);
		const ask = spyOn(askService, "runAskTurn");
		try {
			await withTelegramApi(async (calls) => {
				await handleTelegramUpdate(
					tapUpdate({
						data: `act:approve:${request.id}`,
						chatId: groupChat,
						chatType: "group",
						fromId: 5,
					}),
				);
				await handleTelegramUpdate(
					textUpdate({ text: "hi there", chatId: groupChat, chatType: "group", fromId: 5 }),
				);
				expect(answeredTexts(calls)).toEqual(["Not authorized."]);
				expect(sentTexts(calls)).toEqual([]);
			});
			expect(ask).not.toHaveBeenCalled();
		} finally {
			ask.mockRestore();
		}
		expect((await getActionRequest(request.id))?.status).toBe("awaiting_reply");
	});
});

describe("enrollment", () => {
	async function pending() {
		const { channel, enrollmentCode } = await channelsService.createPendingChannel({
			kind: "telegram",
			label: "pending",
		});
		return { id: channel.id, code: enrollmentCode };
	}
	const start = (code: string, chatId: string, chatType: "private" | "group" = "private") =>
		textUpdate({ text: `/start ${code}`, chatId, chatType });

	test("a private chat redeems the code and is bound with its Telegram user", async () => {
		const { id, code } = await pending();
		const chat = freshChat();
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(start(code, chat));
			expect(sentTexts(calls)[0]).toContain("Linked");
		});
		expect(await channelsService.getChannelCredential(id)).toEqual({
			chatId: chat,
			fromUserId: chat,
		});
	});

	test("a group-chat /start is refused and the channel stays pending", async () => {
		const { id, code } = await pending();
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(start(code, "-5001", "group"));
			expect(sentTexts(calls)).toHaveLength(1);
			expect(sentTexts(calls)[0]).not.toContain("Linked");
		});
		expect((await channelsService.getChannel(id))?.verifiedAt).toBeNull();
	});

	test("a code older than 15 minutes is refused", async () => {
		const { id, code } = await pending();
		const [row] = await getDb()
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.id, id));
		await getDb()
			.update(notificationChannels)
			.set({
				config: {
					...(row?.config as Record<string, unknown>),
					enrollmentCodeIssuedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
				},
			})
			.where(eq(notificationChannels.id, id));
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(start(code, freshChat()));
			expect(sentTexts(calls)).toEqual(["This code isn't valid."]);
		});
		expect((await channelsService.getChannel(id))?.verifiedAt).toBeNull();
	});

	test("the sixth wrong code from one chat gets no reply", async () => {
		const chat = freshChat();
		await withTelegramApi(async (calls) => {
			for (let i = 0; i < 5; i += 1) {
				await handleTelegramUpdate(start(`wrong-${i}`, chat));
			}
			expect(sentTexts(calls)).toHaveLength(5);
			await handleTelegramUpdate(start("wrong-5", chat));
			expect(sentTexts(calls)).toHaveLength(5);
			// Even the right code is ignored for the rest of the window.
			const { code } = await pending();
			await handleTelegramUpdate(start(code, chat));
			expect(sentTexts(calls)).toHaveLength(5);
		});
	});

	test("M1: a replayed /start after the bind, and one on an already-verified channel, leave the credential alone", async () => {
		const { id, code } = await pending();
		const first = freshChat();
		const second = freshChat();
		await withTelegramApi(async () => {
			await handleTelegramUpdate(start(code, first));
			await handleTelegramUpdate(start(code, second));
		});
		expect(await channelsService.getChannelCredential(id)).toEqual({
			chatId: first,
			fromUserId: first,
		});

		// Forced: the code is put back on the verified channel.
		const [row] = await getDb()
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.id, id));
		await getDb()
			.update(notificationChannels)
			.set({
				config: {
					...(row?.config as Record<string, unknown>),
					enrollmentCode: code,
					enrollmentCodeIssuedAt: new Date().toISOString(),
				},
			})
			.where(eq(notificationChannels.id, id));
		await withTelegramApi(async () => {
			await handleTelegramUpdate(start(code, second));
		});
		expect(await channelsService.getChannelCredential(id)).toEqual({
			chatId: first,
			fromUserId: first,
		});
	});
});

describe("drift: the gate is the only door", () => {
	const source = readFileSync(join(import.meta.dir, "channels.ts"), "utf8");

	test("channels.ts no longer looks a channel up by chat id; the gate is called before any handler", () => {
		expect(source.includes("findActiveChannelByChatId(")).toBe(false);
		const handlers = [...source.matchAll(/^async function (handle[A-Za-z]+)\(/gm)].map((m) => m[1]);
		expect(handlers.length).toBeGreaterThanOrEqual(3);
		const body = source.slice(source.indexOf("async function handleTelegramUpdate("));
		const end = body.indexOf("\n}\n");
		const updateBody = body.slice(0, end);
		const gate = updateBody.indexOf("authorizeTelegramCaller(");
		expect(gate).toBeGreaterThan(-1);
		for (const handler of [
			"handleHitlCallback(",
			"handleActionCallback(",
			"handleTelegramAskMessage(",
		]) {
			expect(updateBody.indexOf(handler)).toBeGreaterThan(gate);
		}
		// Only enrollment runs before the gate.
		expect(updateBody.indexOf("handleEnrollmentStart(")).toBeLessThan(gate);
	});
});
