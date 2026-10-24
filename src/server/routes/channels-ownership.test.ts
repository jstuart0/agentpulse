/**
 * Channel ownership and re-link, in team mode and solo: who sees which
 * channel, that the enrollment code is returned exactly once, what a channel
 * owned by "local" means in team mode, and the re-link route's guards.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";
import {
	answeredTexts,
	seedVerifiedChannel,
	sentTexts,
	tapUpdate,
	withTelegramApi,
} from "../test-utils/telegram-fixtures.js";
import { enableAiRuntime, seedSession } from "../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const { aiActionRequests, aiHitlRequests, notificationChannels, sessions } = schema;
const channelsService = await import("../services/channels/channels-service.js");
const { createActionRequest } = await import("../services/ai/action-requests-service.js");
const { handleTelegramUpdate } = await import("./channels.js");
const telegram = await import("../services/channels/telegram.js");
const { dispatchHitlToChannel } = await import("../services/channels/dispatch.js");
const { OWNER_CHECKED_ROUTES, TEAM_ADMIN_ROUTES } = await import("../auth/route-scope-policy.js");

const originalDisableAuth = config.disableAuth;
const originalToken = (config as Record<string, unknown>).telegramBotToken;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).telegramBotToken = originalToken;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(aiActionRequests);
	await getDb().delete(notificationChannels);
	await getDb().delete(sessions);
	await resetIdentityState();
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
});
afterEach(reset);

async function team() {
	await setStoredMode("team");
	const admin = await seedLocalUser("c-admin", "admin");
	const adminB = await seedLocalUser("c-admin-b", "admin");
	const member = await seedLocalUser("c-member", "user");
	const adminKey = await seedKey("c-admin-key", ["manage"], admin.id);
	return {
		admin,
		adminB,
		member,
		adminCookie: await cookieHeadersFor(admin.id),
		adminBCookie: await cookieHeadersFor(adminB.id),
		memberCookie: await cookieHeadersFor(member.id),
		adminKey: bearerHeaders(adminKey.key),
	};
}

/** Every JSON body a request produced, as one string, to scan for a secret. */
async function bodyText(res: Response): Promise<string> {
	return await res.text();
}

describe("the enrollment code is shown once", () => {
	test("create returns it; list, get and stats never do; the member never sees the channel", async () => {
		const t = await team();
		await withTelegramApi(async () => {
			const created = await app.request(
				"/api/v1/channels",
				jsonRequest("POST", { kind: "telegram", label: "ops" }, t.adminCookie),
			);
			expect(created.status).toBe(201);
			const body = (await created.json()) as {
				channel: { id: string; userId: string };
				enrollmentCode: string;
			};
			expect(body.enrollmentCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
			expect(body.channel.userId).toBe(t.admin.id);

			const scanned: string[] = [];
			for (const [url, headers] of [
				["/api/v1/channels", t.adminCookie],
				[`/api/v1/channels/${body.channel.id}`, t.adminCookie],
				[`/api/v1/channels/${body.channel.id}/stats`, t.adminCookie],
				["/api/v1/channels", t.memberCookie],
				[`/api/v1/channels/${body.channel.id}`, t.memberCookie],
				[`/api/v1/channels/${body.channel.id}/stats`, t.memberCookie],
			] as const) {
				scanned.push(await bodyText(await app.request(url, { headers })));
			}
			for (const text of scanned) expect(text).not.toContain(body.enrollmentCode);
		});
	});
});

describe("team mode: who sees which channel", () => {
	test("a member sees none of an admin's channels: 404 on the reads and the re-link, and the admin gate (403) answers the rest before the id is even looked up", async () => {
		const t = await team();
		const channelId = await seedVerifiedChannel({ chatId: "801", userId: t.admin.id });

		const list = await app.request("/api/v1/channels", { headers: t.memberCookie });
		expect(((await list.json()) as { channels: unknown[] }).channels).toEqual([]);

		const attempt = async (method: string, path: string, body?: unknown) => {
			const res = await app.request(
				`/api/v1${path}`,
				body === undefined && method === "GET"
					? { headers: t.memberCookie }
					: jsonRequest(method, body ?? {}, t.memberCookie),
			);
			return res.status;
		};
		// Owner-checked in the handler: a channel the caller can't see is a channel that isn't there.
		expect(await attempt("GET", `/channels/${channelId}`)).toBe(404);
		expect(await attempt("GET", `/channels/${channelId}/stats`)).toBe(404);
		expect(await attempt("POST", `/channels/${channelId}/relink`)).toBe(404);
		// Also team-admin routes: the policy gate refuses a member first, for any id, so ids can't be probed.
		for (const [method, path, body] of [
			["DELETE", "", undefined],
			["PATCH", "/config", { askEnabled: false }],
			["POST", "/test", undefined],
		] as const) {
			expect(await attempt(method, `/channels/${channelId}${path}`, body)).toBe(403);
			expect(await attempt(method, `/channels/does-not-exist${path}`, body)).toBe(403);
		}
		expect(await channelsService.getChannel(channelId)).not.toBeNull();
	});

	test("an admin sees every channel, including one owned by another admin and one owned by local", async () => {
		const t = await team();
		const own = await seedVerifiedChannel({ chatId: "802", userId: t.admin.id });
		const other = await seedVerifiedChannel({ chatId: "803", userId: t.adminB.id });
		const local = await seedVerifiedChannel({ chatId: "804", userId: "local" });
		const res = await app.request("/api/v1/channels", { headers: t.adminCookie });
		const ids = ((await res.json()) as { channels: Array<{ id: string }> }).channels.map(
			(c) => c.id,
		);
		expect(new Set(ids)).toEqual(new Set([own, other, local]));
	});

	test("the six channel id routes are exactly the owner-checked ones, and the mutating ones stay team-admin", async () => {
		const registered = new Set(
			app.routes
				.filter((r) => r.path.startsWith("/api/v1/channels/:id"))
				.map((r) => `${r.method} ${r.path.slice("/api/v1".length)}`),
		);
		const expected = new Set([
			"GET /channels/:id",
			"GET /channels/:id/stats",
			"DELETE /channels/:id",
			"PATCH /channels/:id/config",
			"POST /channels/:id/test",
			"POST /channels/:id/relink",
		]);
		expect(registered).toEqual(expected);
		for (const entry of expected) expect(OWNER_CHECKED_ROUTES.has(entry)).toBe(true);
		for (const entry of [
			"DELETE /channels/:id",
			"PATCH /channels/:id/config",
			"POST /channels/:id/test",
		]) {
			expect(TEAM_ADMIN_ROUTES.has(entry)).toBe(true);
		}
	});
});

describe('a channel owned by "local"', () => {
	test("solo mode: it works as before, listed to everyone", async () => {
		const local = await seedVerifiedChannel({ chatId: "805", userId: "local" });
		const member = await seedLocalUser("c-solo", "user");
		const res = await app.request("/api/v1/channels", {
			headers: await cookieHeadersFor(member.id),
		});
		const channels = (
			(await res.json()) as { channels: Array<{ id: string; needsRelink: unknown }> }
		).channels;
		expect(channels.map((c) => c.id)).toEqual([local]);
		expect(channels[0]?.needsRelink).toBeNull();
	});

	test("team mode: its Telegram approvals are refused with the re-link reply, and declining still works", async () => {
		const t = await team();
		const local = await seedVerifiedChannel({ chatId: "806", userId: "local" });
		await seedSession("local-chan");
		const approve = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "local-chan", sessionDisplayName: "local-chan" },
			origin: "web",
			channelId: local,
		});
		const decline = await createActionRequest({
			kind: "session_archive",
			question: "Archive?",
			payload: { sessionId: "local-chan", sessionDisplayName: "local-chan" },
			origin: "web",
			channelId: local,
		});
		await withTelegramApi(async (calls) => {
			await handleTelegramUpdate(tapUpdate({ data: `act:approve:${approve.id}`, chatId: 806 }));
			await handleTelegramUpdate(
				tapUpdate({ data: `act:decline:${decline.id}`, chatId: 806, updateId: 2 }),
			);
			expect(answeredTexts(calls)).toEqual([
				"Re-link this channel to approve from Telegram.",
				"Declined.",
			]);
		});

		// The list tells an admin it needs re-linking; the member can't see it.
		const adminList = await app.request("/api/v1/channels", { headers: t.adminCookie });
		const listed = (
			(await adminList.json()) as { channels: Array<{ id: string; needsRelink: string | null }> }
		).channels.find((c) => c.id === local);
		expect(listed?.needsRelink).toBe("unowned_channel");
	});

	test("team mode: an admin's re-link stamps their id and returns a new code; the channel id is unchanged", async () => {
		const t = await team();
		const local = await seedVerifiedChannel({ chatId: "807", userId: "local" });
		await withTelegramApi(async () => {
			const res = await app.request(
				`/api/v1/channels/${local}/relink`,
				jsonRequest("POST", {}, t.adminCookie),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				channel: { id: string; userId: string; verifiedAt: string | null };
				enrollmentCode: string;
			};
			expect(body.channel.id).toBe(local);
			expect(body.channel.userId).toBe(t.admin.id);
			expect(body.channel.verifiedAt).toBeNull();
			expect(body.enrollmentCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
		});
		expect((await channelsService.getChannel(local))?.userId).toBe(t.admin.id);
	});
});

describe("re-link", () => {
	test("the owner's browser session clears the credential and returns a code; the old chat loses access", async () => {
		const t = await team();
		const id = await seedVerifiedChannel({ chatId: "808", userId: t.admin.id });
		await withTelegramApi(async () => {
			const res = await app.request(
				`/api/v1/channels/${id}/relink`,
				jsonRequest("POST", {}, t.adminCookie),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				channel: { verifiedAt: string | null };
				enrollmentCode: string;
			};
			expect(body.channel.verifiedAt).toBeNull();
			expect(body.enrollmentCode.length).toBe(16);
		});
		expect(await channelsService.getChannelCredential(id)).toBeNull();
		expect(await channelsService.findActiveChannelByChatId("808")).toBeNull();
	});

	test("an API key gets 403 human_required, even an admin's", async () => {
		const t = await team();
		const id = await seedVerifiedChannel({ chatId: "809", userId: t.admin.id });
		const res = await app.request(
			`/api/v1/channels/${id}/relink`,
			jsonRequest("POST", {}, t.adminKey),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("human_required");
		expect(await channelsService.getChannelCredential(id)).not.toBeNull();
	});

	test("a hostile Origin gets 403 bad_origin", async () => {
		const t = await team();
		const id = await seedVerifiedChannel({ chatId: "810", userId: t.admin.id });
		const evil = new Headers(t.adminCookie);
		evil.set("Origin", "https://evil.example");
		const res = await app.request(`/api/v1/channels/${id}/relink`, jsonRequest("POST", {}, evil));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		expect(await channelsService.getChannelCredential(id)).not.toBeNull();
	});

	test("another admin may re-link a channel owned by someone else but a member may not", async () => {
		const t = await team();
		const id = await seedVerifiedChannel({ chatId: "811", userId: t.admin.id });
		const member = await app.request(
			`/api/v1/channels/${id}/relink`,
			jsonRequest("POST", {}, t.memberCookie),
		);
		expect(member.status).toBe(404);
		await withTelegramApi(async () => {
			const other = await app.request(
				`/api/v1/channels/${id}/relink`,
				jsonRequest("POST", {}, t.adminBCookie),
			);
			expect(other.status).toBe(200);
		});
		// Re-linking never changes an owned channel's owner.
		expect((await channelsService.getChannel(id))?.userId).toBe(t.admin.id);
	});

	test("while pending, sending to the channel is skipped", async () => {
		const t = await team();
		const id = await seedVerifiedChannel({ chatId: "812", userId: t.admin.id });
		await channelsService.relinkChannel(id);
		const sendSpy = (await import("bun:test")).spyOn(telegram.telegramAdapter, "send");
		try {
			const result = await dispatchHitlToChannel({
				channelId: id,
				message: {
					hitlId: "h",
					proposalId: "p",
					sessionId: "s",
					sessionDisplayName: null,
					decision: "continue",
					prompt: "Run the tests",
					why: null,
					deliverable: true,
					approvable: true,
					promptSha256: null,
				},
			});
			expect(result.ok).toBe(false);
			expect(sendSpy).not.toHaveBeenCalled();
		} finally {
			sendSpy.mockRestore();
		}
	});

	test("the web UI shape: create stamps the creator's user id in solo mode too", async () => {
		const user = await seedLocalUser("c-solo-creator", "user");
		await withTelegramApi(async () => {
			const res = await app.request(
				"/api/v1/channels",
				jsonRequest("POST", { kind: "telegram" }, await cookieHeadersFor(user.id)),
			);
			expect(res.status).toBe(201);
			const body = (await res.json()) as { channel: { userId: string } };
			expect(body.channel.userId).toBe(user.id);
		});
		const rows = await getDb()
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.userId, user.id));
		expect(rows).toHaveLength(1);
	});

	test("under DISABLE_AUTH the creator is recorded as local", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await withTelegramApi(async () => {
			const res = await app.request("/api/v1/channels", jsonRequest("POST", { kind: "telegram" }));
			expect(res.status).toBe(201);
			expect(((await res.json()) as { channel: { userId: string } }).channel.userId).toBe("local");
		});
	});
});

describe("a channel set up through Ask (add_channel)", () => {
	test("is owned by the approver and the message carries no enrollment code", async () => {
		const { resolveActionRequest } = await import("../services/ai/action-requests-service.js");
		const chat = "900";
		const origin = await seedVerifiedChannel({ chatId: chat, userId: "someone" });
		const request = await createActionRequest({
			kind: "add_channel",
			question: "Add a channel?",
			payload: { channelKind: "telegram", label: "From Ask" },
			origin: "telegram",
			channelId: origin,
		});
		await withTelegramApi(async (calls) => {
			const result = await resolveActionRequest({
				id: request.id,
				decision: "applied",
				resolvedBy: "approver",
				actor: { userId: "approver-1", label: "user" },
			});
			expect(result.ok).toBe(true);
			const text = sentTexts(calls).join("\n");
			expect(text).toContain("Re-link");
			const created = (await getDb().select().from(notificationChannels)).find(
				(c) => c.label === "From Ask",
			);
			expect(created?.userId).toBe("approver-1");
			const stored = (created?.config ?? {}) as Record<string, unknown>;
			expect(typeof stored.enrollmentCode).toBe("string");
			expect(text).not.toContain(String(stored.enrollmentCode));
		});
	});

	test("an approval from a chat (no user id) leaves it owned by local", async () => {
		const { resolveActionRequest } = await import("../services/ai/action-requests-service.js");
		const request = await createActionRequest({
			kind: "add_channel",
			question: "Add a channel?",
			payload: { channelKind: "telegram", label: "From a chat" },
			origin: "web",
		});
		await resolveActionRequest({
			id: request.id,
			decision: "applied",
			resolvedBy: "chat",
			actor: { userId: null, label: "telegram" },
		});
		const created = (await getDb().select().from(notificationChannels)).find(
			(c) => c.label === "From a chat",
		);
		expect(created?.userId).toBe("local");
	});
});
