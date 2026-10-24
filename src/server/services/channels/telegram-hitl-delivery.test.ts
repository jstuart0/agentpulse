/**
 * Delivering a HITL to Telegram: the channel's detail setting, the group-chat
 * floor on detail, and the one global cap on messages per hour that counts
 * reports and HITL requests together.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../ai/__test_db.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import { cookieHeadersFor, jsonRequest, seedLocalUser } from "../../test-utils/team-fixtures.js";
import {
	seedLegacyChannel,
	seedVerifiedChannel,
	sentTexts,
	withTelegramApi,
} from "../../test-utils/telegram-fixtures.js";
import { seedSession } from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { app } = await import("../../app.js");
const schema = await import("../../db/schema/index.js");
const { aiHitlRequests, aiWatcherReports, notificationChannels, sessions } = schema;
const { dispatchHitlToChannel } = await import("./dispatch.js");
const { NOTIFY_TELEGRAM_GLOBAL_PER_HOUR, telegramSendsSince } = await import(
	"./telegram-budget.js"
);
const { updateChannelConfig } = await import("./channels-service.js");

beforeAll(() => initializeDatabase());

async function reset() {
	await getDb().delete(aiHitlRequests);
	await getDb().delete(aiWatcherReports);
	await getDb().delete(notificationChannels);
	await getDb().delete(sessions);
	await resetIdentityState();
}
beforeEach(reset);
afterEach(reset);

let n = 0;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function openHitl(channelId: string | null, sessionId = `hd-${++n}`) {
	await seedSession(sessionId);
	const id = crypto.randomUUID();
	await getDb()
		.insert(aiHitlRequests)
		.values({ id, proposalId: `p-${id}`, sessionId, channelId, status: "awaiting_reply" });
	return { id, sessionId };
}

const message = (hitlId: string, sessionId: string) => ({
	hitlId,
	proposalId: "p",
	sessionId,
	sessionDisplayName: "my session",
	decision: "continue" as const,
	prompt: "Run the failing test and fix it",
	why: null,
	deliverable: true,
	approvable: true,
	promptSha256: null,
});

/** `reports` report rows and `hitls` HITL rows, each stamped as sent within the hour. */
async function plantSends(reports: number, hitls: number) {
	const sessionId = `cap-${++n}`;
	await seedSession(sessionId);
	for (let i = 0; i < reports; i += 1) {
		await getDb()
			.insert(aiWatcherReports)
			.values({
				sessionId,
				turnKey: `p:${i}`,
				status: "delivered",
				telegramSentAt: minutesAgo(10),
			});
	}
	for (let i = 0; i < hitls; i += 1) {
		const hitlSession = `${sessionId}-h${i}`;
		await seedSession(hitlSession);
		await getDb()
			.insert(aiHitlRequests)
			.values({
				proposalId: `cap-${i}`,
				sessionId: hitlSession,
				status: "applied",
				telegramSentAt: minutesAgo(10),
			});
	}
}

async function stampOf(hitlId: string) {
	const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId));
	return row?.telegramSentAt ?? null;
}

describe("detail", () => {
	test("minimal is the default: no prompt text and no Approve button, Dismiss only", async () => {
		const channelId = await seedVerifiedChannel({ chatId: "5101" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			const result = await dispatchHitlToChannel({
				channelId,
				message: message(h.id, h.sessionId),
			});
			expect(result.ok).toBe(true);
			const sent = calls.find((c) => c.method === "sendMessage");
			expect(String(sent?.body.text)).not.toContain("failing test");
			const buttons = (
				sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }
			).inline_keyboard[0];
			expect(buttons?.map((b) => b.text)).toEqual(["Dismiss"]);
		});
		expect(await stampOf(h.id)).not.toBeNull();
	});

	test("full carries the redacted text and an Approve button when the session can take it", async () => {
		const channelId = await seedVerifiedChannel({ chatId: "5102" });
		await updateChannelConfig(channelId, { detail: "full" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			await dispatchHitlToChannel({ channelId, message: message(h.id, h.sessionId) });
			const sent = calls.find((c) => c.method === "sendMessage");
			expect(String(sent?.body.text)).toContain("failing test");
			const buttons = (
				sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }
			).inline_keyboard[0];
			expect(buttons?.map((b) => b.text)).toEqual(["✅ Approve", "Dismiss"]);
		});
	});

	test("full with a session that can't take a prompt (deliverable false) has Dismiss only", async () => {
		const channelId = await seedVerifiedChannel({ chatId: "5103" });
		await updateChannelConfig(channelId, { detail: "full" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			await dispatchHitlToChannel({
				channelId,
				message: { ...message(h.id, h.sessionId), deliverable: false },
			});
			const sent = calls.find((c) => c.method === "sendMessage");
			expect(
				(
					sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }
				).inline_keyboard[0]?.map((b) => b.text),
			).toEqual(["Dismiss"]);
		});
	});

	test("a channel enrolled in a group is always minimal, whatever its stored setting", async () => {
		const channelId = await seedLegacyChannel({ chatId: "-100555" });
		await updateChannelConfig(channelId, { detail: "full" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			await dispatchHitlToChannel({ channelId, message: message(h.id, h.sessionId) });
			const sent = calls.find((c) => c.method === "sendMessage");
			expect(String(sent?.body.text)).not.toContain("failing test");
		});
	});

	test("the config route refuses full for a group channel and accepts it for a private one", async () => {
		const user = await seedLocalUser("hd-user", "user");
		const cookie = await cookieHeadersFor(user.id);
		const group = await seedLegacyChannel({ chatId: "-100556" });
		const refused = await app.request(
			`/api/v1/channels/${group}/config`,
			jsonRequest("PATCH", { detail: "full" }, cookie),
		);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe(
			"detail_full_needs_private_chat",
		);
		const minimal = await app.request(
			`/api/v1/channels/${group}/config`,
			jsonRequest("PATCH", { detail: "minimal" }, cookie),
		);
		expect(minimal.status).toBe(200);

		const priv = await seedVerifiedChannel({ chatId: "5104" });
		const ok = await app.request(
			`/api/v1/channels/${priv}/config`,
			jsonRequest("PATCH", { detail: "full" }, cookie),
		);
		expect(ok.status).toBe(200);
		const bad = await app.request(
			`/api/v1/channels/${priv}/config`,
			jsonRequest("PATCH", { detail: "everything" }, cookie),
		);
		expect(bad.status).toBe(400);
	});
});

describe("the global cap", () => {
	test("30 sends in the last hour, 15 reports and 15 HITL requests, stop a HITL message; the HITL rows count", async () => {
		await plantSends(15, 15);
		expect(await telegramSendsSince(minutesAgo(60))).toBe(NOTIFY_TELEGRAM_GLOBAL_PER_HOUR);
		const channelId = await seedVerifiedChannel({ chatId: "5201" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			const result = await dispatchHitlToChannel({
				channelId,
				message: message(h.id, h.sessionId),
			});
			expect(result).toMatchObject({ ok: false, skipped: true });
			expect(sentTexts(calls)).toEqual([]);
		});
		expect(await stampOf(h.id)).toBeNull();
	});

	test("29 sends still let one through, and it is stamped", async () => {
		await plantSends(15, 14);
		const channelId = await seedVerifiedChannel({ chatId: "5202" });
		const h = await openHitl(channelId);
		await withTelegramApi(async (calls) => {
			const result = await dispatchHitlToChannel({
				channelId,
				message: message(h.id, h.sessionId),
			});
			expect(result.ok).toBe(true);
			expect(sentTexts(calls)).toHaveLength(1);
		});
		expect(await stampOf(h.id)).not.toBeNull();
	});

	test("sends older than an hour do not count", async () => {
		const sessionId = `old-${++n}`;
		await seedSession(sessionId);
		for (let i = 0; i < 40; i += 1) {
			await getDb()
				.insert(aiWatcherReports)
				.values({
					sessionId,
					turnKey: `p:${i}`,
					status: "delivered",
					telegramSentAt: minutesAgo(61),
				});
		}
		expect(await telegramSendsSince(minutesAgo(60))).toBe(0);
	});

	test("a failed send is not stamped, so it does not count", async () => {
		const channelId = await seedVerifiedChannel({ chatId: "5203" });
		const h = await openHitl(channelId);
		const real = globalThis.fetch;
		await withTelegramApi(async () => {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
					status: 400,
				})) as unknown as typeof fetch;
			const result = await dispatchHitlToChannel({
				channelId,
				message: message(h.id, h.sessionId),
			});
			expect(result.ok).toBe(false);
			globalThis.fetch = real;
		});
		expect(await stampOf(h.id)).toBeNull();
	});
});
