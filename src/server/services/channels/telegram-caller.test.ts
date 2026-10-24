import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";
import {
	seedLegacyChannel,
	seedVerifiedChannel,
	tapUpdate,
	textUpdate,
} from "../../test-utils/telegram-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { notificationChannels } = await import("../../db/schema/index.js");
const channelsService = await import("./channels-service.js");
const { authorizeTelegramCaller } = await import("./telegram-caller.js");

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(notificationChannels);
});

describe("authorizeTelegramCaller", () => {
	test("the enrolled user in the enrolled private chat is authorized, with the channel", async () => {
		const id = await seedVerifiedChannel({ chatId: "5001" });
		for (const update of [
			tapUpdate({ data: "hitl:x:approve", chatId: 5001 }),
			textUpdate({ text: "hello", chatId: 5001 }),
		]) {
			const result = await authorizeTelegramCaller(update);
			expect(result).toMatchObject({ ok: true, fromId: "5001", chatId: "5001" });
			expect(result.ok && result.channel.id).toBe(id);
		}
	});

	test("a callback is told 'not_authorized' for every refusal; a message is silent or told it isn't linked", async () => {
		await seedVerifiedChannel({ chatId: "5002" });
		const callbacks = [
			tapUpdate({ data: "x", chatId: 5002, chatType: "group" }),
			tapUpdate({ data: "x", chatId: 5002, fromId: 1 }),
			tapUpdate({ data: "x", chatId: 5002, withMessage: false }),
			tapUpdate({ data: "x", chatId: 5099 }),
		];
		for (const update of callbacks) {
			expect(await authorizeTelegramCaller(update)).toEqual({ ok: false, reply: "not_authorized" });
		}
		expect(
			await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5002, chatType: "group" })),
		).toEqual({
			ok: false,
			reply: "silent",
		});
		expect(
			await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5002, fromId: 1 })),
		).toEqual({
			ok: false,
			reply: "silent",
		});
		expect(await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5099 }))).toEqual({
			ok: false,
			reply: "not_linked",
		});
	});

	test("an inactive or unverified channel is not linked", async () => {
		const id = await seedVerifiedChannel({ chatId: "5003" });
		await channelsService.deactivateChannel(id);
		expect(await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5003 }))).toEqual({
			ok: false,
			reply: "not_linked",
		});
		const pending = await seedVerifiedChannel({ chatId: "5004" });
		await channelsService.relinkChannel(pending);
		expect(await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5004 }))).toEqual({
			ok: false,
			reply: "not_linked",
		});
	});

	test("a channel enrolled before the user was recorded: a private chat derives it, a group never matches", async () => {
		await seedLegacyChannel({ chatId: "5005" });
		expect((await authorizeTelegramCaller(textUpdate({ text: "x", chatId: 5005 }))).ok).toBe(true);
		expect(
			await authorizeTelegramCaller(tapUpdate({ data: "x", chatId: 5005, fromId: 999 })),
		).toEqual({ ok: false, reply: "not_authorized" });

		await seedLegacyChannel({ chatId: "-100777" });
		for (const chatType of ["group", "supergroup", "private"] as const) {
			const result = await authorizeTelegramCaller(
				tapUpdate({ data: "x", chatId: "-100777", chatType, fromId: 5 }),
			);
			expect({ chatType, ok: result.ok }).toEqual({ chatType, ok: false });
		}
	});
});
