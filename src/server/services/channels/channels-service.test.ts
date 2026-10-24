import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../ai/__test_db.js";
import { ANONYMOUS_ACTOR } from "../../auth/actor.js";
import { seedLegacyChannel, seedVerifiedChannel } from "../../test-utils/telegram-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { notificationChannels } = await import("../../db/schema/index.js");
const {
	ENROLLMENT_CODE_TTL_MS,
	completeEnrollment,
	createPendingChannel,
	deleteChannel,
	findActiveChannelByChatId,
	findPendingByEnrollmentCode,
	getChannel,
	getChannelCredential,
	listChannels,
	relinkChannel,
	relinkReason,
} = await import("./channels-service.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(notificationChannels).execute();
});

async function rawConfig(id: string): Promise<Record<string, unknown>> {
	const [row] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id));
	return (row?.config ?? {}) as Record<string, unknown>;
}

describe("channels-service", () => {
	test("createPendingChannel returns a 96-bit code and a pending row, and the record never carries the code", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "My Telegram",
		});
		expect(channel.kind).toBe("telegram");
		expect(channel.verifiedAt).toBeNull();
		expect(enrollmentCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
		const stored = await rawConfig(channel.id);
		expect(stored.enrollmentCode).toBe(enrollmentCode);
		expect(typeof stored.enrollmentCodeIssuedAt).toBe("string");
		expect(JSON.stringify(channel)).not.toContain(enrollmentCode);
		expect(JSON.stringify(await getChannel(channel.id))).not.toContain(enrollmentCode);
		expect(JSON.stringify(await listChannels(ANONYMOUS_ACTOR))).not.toContain(enrollmentCode);
	});

	test("two codes differ", async () => {
		const a = await createPendingChannel({ kind: "telegram", label: "A" });
		const b = await createPendingChannel({ kind: "telegram", label: "B" });
		expect(a.enrollmentCode).not.toBe(b.enrollmentCode);
	});

	test("findPendingByEnrollmentCode matches only unverified rows", async () => {
		const a = await createPendingChannel({ kind: "telegram", label: "A" });
		await createPendingChannel({ kind: "telegram", label: "B" });
		const found = await findPendingByEnrollmentCode(a.enrollmentCode);
		expect(found?.id).toBe(a.channel.id);
		const missing = await findPendingByEnrollmentCode("not-a-real-code");
		expect(missing).toBeNull();
	});

	test("a code older than 15 minutes is refused; one just inside the window is accepted", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "T",
		});
		const issue = async (ageMs: number) => {
			const config = { ...(await rawConfig(channel.id)) };
			config.enrollmentCodeIssuedAt = new Date(Date.now() - ageMs).toISOString();
			await getDb()
				.update(notificationChannels)
				.set({ config })
				.where(eq(notificationChannels.id, channel.id));
		};
		await issue(ENROLLMENT_CODE_TTL_MS - 5_000);
		expect((await findPendingByEnrollmentCode(enrollmentCode))?.id).toBe(channel.id);
		await issue(ENROLLMENT_CODE_TTL_MS + 5_000);
		expect(await findPendingByEnrollmentCode(enrollmentCode)).toBeNull();
		expect(
			await completeEnrollment({
				channelId: channel.id,
				chatId: "1",
				fromUserId: "1",
				code: enrollmentCode,
			}),
		).toBeNull();
	});

	test("completeEnrollment stores the chat and the enrolling user, and clears the code", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "C",
		});
		const verified = await completeEnrollment({
			channelId: channel.id,
			chatId: "123456789",
			fromUserId: "123456789",
			code: enrollmentCode,
		});
		expect(verified?.verifiedAt).toBeTruthy();
		const stored = await rawConfig(channel.id);
		expect(stored.enrollmentCode).toBeUndefined();
		expect(stored.enrollmentCodeIssuedAt).toBeUndefined();
		expect(await findPendingByEnrollmentCode(enrollmentCode)).toBeNull();
		expect(await getChannelCredential(channel.id)).toEqual({
			chatId: "123456789",
			fromUserId: "123456789",
		});
	});

	test("a replayed enrollment never re-binds a verified channel (M1)", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "R",
		});
		await completeEnrollment({
			channelId: channel.id,
			chatId: "111",
			fromUserId: "111",
			code: enrollmentCode,
		});
		const replay = await completeEnrollment({
			channelId: channel.id,
			chatId: "222",
			fromUserId: "222",
			code: enrollmentCode,
		});
		expect(replay).toBeNull();
		expect(await getChannelCredential(channel.id)).toEqual({ chatId: "111", fromUserId: "111" });

		// Forced: put the old code back on the verified channel; the conditional update still refuses.
		const config = {
			...(await rawConfig(channel.id)),
			enrollmentCode,
			enrollmentCodeIssuedAt: new Date().toISOString(),
		};
		await getDb()
			.update(notificationChannels)
			.set({ config })
			.where(eq(notificationChannels.id, channel.id));
		const forced = await completeEnrollment({
			channelId: channel.id,
			chatId: "333",
			fromUserId: "333",
			code: enrollmentCode,
		});
		expect(forced).toBeNull();
		expect(await getChannelCredential(channel.id)).toEqual({ chatId: "111", fromUserId: "111" });
	});

	test("two racing redemptions of one code bind exactly one", async () => {
		const { channel, enrollmentCode } = await createPendingChannel({
			kind: "telegram",
			label: "Race",
		});
		const results = await Promise.all(
			["10", "20"].map((id) =>
				completeEnrollment({
					channelId: channel.id,
					chatId: id,
					fromUserId: id,
					code: enrollmentCode,
				}),
			),
		);
		expect(results.filter((r) => r !== null)).toHaveLength(1);
	});

	test("a wrong code binds nothing", async () => {
		const { channel } = await createPendingChannel({ kind: "telegram", label: "W" });
		const bound = await completeEnrollment({
			channelId: channel.id,
			chatId: "1",
			fromUserId: "1",
			code: "not-the-code",
		});
		expect(bound).toBeNull();
		expect((await getChannel(channel.id))?.verifiedAt).toBeNull();
	});

	test("findActiveChannelByChatId returns verified channels only", async () => {
		const { channel } = await createPendingChannel({ kind: "telegram", label: "D" });
		expect(await findActiveChannelByChatId("999")).toBeNull();
		const id = await seedVerifiedChannel({ chatId: "999" });
		expect((await findActiveChannelByChatId("999"))?.id).toBe(id);
		expect(channel.id).not.toBe(id);
	});

	test("deleteChannel removes the row", async () => {
		const { channel } = await createPendingChannel({ kind: "telegram", label: "E" });
		expect(await deleteChannel(channel.id)).toBe(true);
		expect(await getChannel(channel.id)).toBeNull();
		expect((await listChannels(ANONYMOUS_ACTOR)).length).toBe(0);
	});
});

describe("legacy credentials", () => {
	test("a private chat enrolled before the user was recorded derives it from the chat id", async () => {
		const id = await seedLegacyChannel({ chatId: "12345" });
		expect(await getChannelCredential(id)).toEqual({ chatId: "12345", fromUserId: "12345" });
	});

	test("a group enrolled before the user was recorded has no known user", async () => {
		const id = await seedLegacyChannel({ chatId: "-100777" });
		expect(await getChannelCredential(id)).toEqual({ chatId: "-100777", fromUserId: null });
		const channel = await getChannel(id);
		expect(channel && (await relinkReason(channel, "solo"))).toBe("group_chat");
	});
});

describe("relinkChannel", () => {
	test("clears the credential, keeps the id, and issues a new code once", async () => {
		const id = await seedVerifiedChannel({ chatId: "42" });
		const relinked = await relinkChannel(id);
		expect(relinked?.channel.id).toBe(id);
		expect(relinked?.channel.verifiedAt).toBeNull();
		expect(await getChannelCredential(id)).toBeNull();
		expect(await findActiveChannelByChatId("42")).toBeNull();
		expect(JSON.stringify(relinked?.channel)).not.toContain(relinked?.enrollmentCode ?? "x");
		expect((await findPendingByEnrollmentCode(relinked?.enrollmentCode ?? ""))?.id).toBe(id);
	});

	test("the new code binds a different user, and the old chat no longer resolves", async () => {
		const id = await seedVerifiedChannel({ chatId: "42" });
		const relinked = await relinkChannel(id);
		const bound = await completeEnrollment({
			channelId: id,
			chatId: "77",
			fromUserId: "77",
			code: relinked?.enrollmentCode ?? "",
		});
		expect(bound?.verifiedAt).not.toBeNull();
		expect(await findActiveChannelByChatId("42")).toBeNull();
		expect((await findActiveChannelByChatId("77"))?.id).toBe(id);
	});

	test("claims a channel owned by local for the re-linking user", async () => {
		const id = await seedVerifiedChannel({ chatId: "42" });
		await relinkChannel(id, { claimForUserId: "user-9" });
		expect((await getChannel(id))?.userId).toBe("user-9");
		const owned = await seedVerifiedChannel({ chatId: "43", userId: "user-1" });
		await relinkChannel(owned, { claimForUserId: "user-9" });
		expect((await getChannel(owned))?.userId).toBe("user-1");
	});

	test("an unknown channel is null", async () => {
		expect(await relinkChannel("missing")).toBeNull();
	});
});

describe("listChannels", () => {
	test("solo lists every channel; team lists an admin everything and a member only their own", async () => {
		const mine = await seedVerifiedChannel({ chatId: "1", userId: "u-mine" });
		const theirs = await seedVerifiedChannel({ chatId: "2", userId: "u-theirs" });
		const local = await seedVerifiedChannel({ chatId: "3", userId: "local" });
		const ids = async (actor: Parameters<typeof listChannels>[0]) =>
			new Set((await listChannels(actor)).map((c) => c.id));
		expect(await ids({ userId: "u-mine", label: "user", role: "member", mode: "solo" })).toEqual(
			new Set([mine, theirs, local]),
		);
		expect(await ids({ userId: "u-admin", label: "user", role: "admin", mode: "team" })).toEqual(
			new Set([mine, theirs, local]),
		);
		expect(await ids({ userId: "u-mine", label: "user", role: "member", mode: "team" })).toEqual(
			new Set([mine]),
		);
		expect(await ids({ userId: null, label: "telegram", mode: "team" })).toEqual(new Set());
	});
});
