import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { notificationChannels } = await import("../../db/schema.js");
const {
	completeEnrollment,
	createPendingChannel,
	deleteChannel,
	findActiveChannelByChatId,
	findPendingByEnrollmentCode,
	getChannel,
	getChannelCredential,
	listChannels,
} = await import("./channels-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(notificationChannels).execute();
});

describe("channels-service", () => {
	test("createPendingChannel returns an enrollment code and pending row", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "My Telegram",
		});
		expect(channel.kind).toBe("telegram");
		expect(channel.verifiedAt).toBeNull();
		expect(enrollmentCode.length).toBeGreaterThan(0);
		expect((channel.config as Record<string, unknown>)?.enrollmentCode).toBe(enrollmentCode);
	});

	test("findPendingByEnrollmentCode matches only unverified rows", async () => {
		const a = await createPendingChannel({ kind: "telegram", label: "A" });
		await createPendingChannel({ kind: "telegram", label: "B" });
		const found = await findPendingByEnrollmentCode(a.enrollmentCode);
		expect(found?.id).toBe(a.channel.id);
		const missing = await findPendingByEnrollmentCode("not-a-real-code");
		expect(missing).toBeNull();
	});

	test("completeEnrollment stores encrypted chat id and clears the code", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "C",
		});
		const verified = await completeEnrollment({
			channelId: channel.id,
			chatId: "123456789",
		});
		expect(verified?.verifiedAt).toBeTruthy();
		expect((verified?.config as Record<string, unknown>)?.enrollmentCode).toBeUndefined();
		// Enrollment code should no longer match anything pending.
		const reused = await findPendingByEnrollmentCode(enrollmentCode);
		expect(reused).toBeNull();
		// Credential decrypts back to the chat id.
		const cred = await getChannelCredential(channel.id);
		expect(cred?.chatId).toBe("123456789");
	});

	test("findActiveChannelByChatId returns verified channels only", async () => {
		const { channel } = await createPendingChannel({ kind: "telegram", label: "D" });
		expect(await findActiveChannelByChatId("999")).toBeNull();
		await completeEnrollment({ channelId: channel.id, chatId: "999" });
		const found = await findActiveChannelByChatId("999");
		expect(found?.id).toBe(channel.id);
	});

	test("deleteChannel removes the row", async () => {
		const { channel } = await createPendingChannel({ kind: "telegram", label: "E" });
		expect(await deleteChannel(channel.id)).toBe(true);
		expect(await getChannel(channel.id)).toBeNull();
		expect((await listChannels()).length).toBe(0);
	});
});
