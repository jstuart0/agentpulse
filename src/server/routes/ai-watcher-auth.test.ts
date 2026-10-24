/**
 * The watcher config routes: strict validation, owner-or-admin in team mode,
 * human-only fields, the Origin check and the audit line.
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
	captureAuditLines,
	clearSetting,
	enableAiRuntime,
	seedChannel,
	seedProvider,
	seedSession,
} from "../test-utils/watcher-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const { aiHitlRequests, notificationChannels, sessions, watcherConfigs, watcherProposals } = schema;
const { parseWatcherUpdate } = await import("./ai-watcher-validation.js");
const { getWatcherConfig, upsertWatcherConfig } = await import(
	"../services/ai/watcher-config-service.js"
);
const feature = await import("../services/ai/feature.js");

const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(notificationChannels);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearSetting(feature.AI_WATCHER_DEFAULTS_KEY);
	await enableAiRuntime();
}
beforeEach(reset);
afterEach(reset);

const watcherUrl = (sessionId: string) => `/api/v1/ai/sessions/${sessionId}/watcher`;

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("w-alice", "user");
	const bob = await seedLocalUser("w-bob", "user");
	const admin = await seedLocalUser("w-admin", "admin");
	const aliceKey = await seedKey("w-alice-key", ["manage"], alice.id);
	const providerId = await seedProvider();
	await seedSession("alice-session", { ownerUserId: alice.id });
	return {
		alice,
		bob,
		admin,
		providerId,
		aliceCookie: await cookieHeadersFor(alice.id),
		bobCookie: await cookieHeadersFor(bob.id),
		adminCookie: await cookieHeadersFor(admin.id),
		aliceKey: bearerHeaders(aliceKey.key),
	};
}

function put(sessionId: string, body: unknown, headers: Headers) {
	return app.request(watcherUrl(sessionId), jsonRequest("PUT", body, headers));
}

async function errorOf(res: Response): Promise<string | undefined> {
	return ((await res.json()) as { error?: string }).error;
}

describe("strict validation", () => {
	test("every bad body is a 400; the unknown field names itself", async () => {
		const t = await team();
		const bad: Array<[string, unknown, string]> = [
			["unknown key", { bogus: 1 }, "unknown_field"],
			["maxContinuations over 50", { maxContinuations: 51 }, "invalid_field"],
			["negative maxContinuations", { maxContinuations: -1 }, "invalid_field"],
			["fractional maxContinuations", { maxContinuations: 1.5 }, "invalid_field"],
			["unknown policy", { policy: "yolo" }, "invalid_field"],
			["negative daily cap", { maxDailyCents: -5 }, "invalid_field"],
			["string enabled", { enabled: "true" }, "invalid_field"],
			["string notifyEnabled", { notifyEnabled: 1 }, "invalid_field"],
			["system prompt over 4,000", { systemPrompt: "x".repeat(4_001) }, "invalid_field"],
			["system prompt a number", { systemPrompt: 5 }, "invalid_field"],
			["missing provider", { providerId: "missing" }, "invalid_provider"],
			["array body", [1], "invalid_body"],
		];
		for (const [label, body, error] of bad) {
			const res = await put("alice-session", body, t.aliceCookie);
			expect({ label, status: res.status, error: await errorOf(res) }).toEqual({
				label,
				status: 400,
				error,
			});
		}
		expect(await getWatcherConfig("alice-session")).toBeNull();
	});

	test("a body at the limits is accepted", async () => {
		const t = await team();
		const res = await put(
			"alice-session",
			{
				enabled: true,
				providerId: t.providerId,
				policy: "ask_on_risk",
				maxContinuations: 50,
				maxDailyCents: 0,
				systemPrompt: "x".repeat(4_000),
				notifyEnabled: true,
				continueEnabled: false,
			},
			t.aliceCookie,
		);
		expect(res.status).toBe(200);
	});

	test("the bodies the dashboard's AI tab sends pass the validator", () => {
		const bodies: unknown[] = [
			{ enabled: true, providerId: "p", policy: "ask_always", maxContinuations: 10 },
			{ enabled: false },
			{ providerId: "p" },
			{ policy: "ask_on_risk" },
			{ channelId: null },
			{ channelId: "c" },
			{ maxContinuations: 12 },
			{ maxDailyCents: null },
			{ maxDailyCents: 300 },
			{ systemPrompt: null },
			{ systemPrompt: "keep going" },
			{ notifyEnabled: true, continueEnabled: true },
			{ resetContinuations: true },
		];
		for (const body of bodies) {
			expect({ body, ok: parseWatcherUpdate(body).ok }).toEqual({ body, ok: true });
		}
	});
});

describe("ownership in team mode", () => {
	test("a member's PUT on another member's session is 403 not_owner", async () => {
		const t = await team();
		const res = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId },
			t.bobCookie,
		);
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("not_owner");
		expect(await getWatcherConfig("alice-session")).toBeNull();
	});

	test("the owner and an admin may configure; the member may not delete", async () => {
		const t = await team();
		const body = { enabled: true, providerId: t.providerId };
		expect((await put("alice-session", body, t.aliceCookie)).status).toBe(200);
		expect((await put("alice-session", { enabled: false }, t.adminCookie)).status).toBe(200);
		const bobDelete = await app.request(watcherUrl("alice-session"), {
			method: "DELETE",
			headers: t.bobCookie,
		});
		expect(bobDelete.status).toBe(403);
		expect(await getWatcherConfig("alice-session")).not.toBeNull();
		const ownerDelete = await app.request(watcherUrl("alice-session"), {
			method: "DELETE",
			headers: t.aliceCookie,
		});
		expect(ownerDelete.status).toBe(200);
	});

	test("a channel owned by another user is 400 invalid_channel; the owner's own channel is accepted", async () => {
		const t = await team();
		const bobsChannel = await seedChannel({ userId: t.bob.id });
		const alicesChannel = await seedChannel({ userId: t.alice.id });
		const pending = await seedChannel({ userId: t.alice.id, verified: false });
		const inactive = await seedChannel({ userId: t.alice.id, active: false });
		const local = await seedChannel({ userId: "local" });
		for (const channelId of [bobsChannel, pending, inactive, local, "missing-channel"]) {
			const res = await put(
				"alice-session",
				{ enabled: true, providerId: t.providerId, channelId },
				t.aliceCookie,
			);
			expect({ channelId, status: res.status, error: await errorOf(res) }).toEqual({
				channelId,
				status: 400,
				error: "invalid_channel",
			});
		}
		const ok = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId, channelId: alicesChannel },
			t.aliceCookie,
		);
		expect(ok.status).toBe(200);
	});

	test("the decision and inbox routes are owner-checked too", async () => {
		const t = await team();
		await upsertWatcherConfig({
			sessionId: "alice-session",
			providerId: t.providerId,
			enabled: true,
		});
		const proposalId = crypto.randomUUID();
		await getDb().insert(watcherProposals).values({
			id: proposalId,
			sessionId: "alice-session",
			providerId: t.providerId,
			state: "complete",
		});
		const hitlId = crypto.randomUUID();
		await getDb()
			.insert(aiHitlRequests)
			.values({ id: hitlId, proposalId, sessionId: "alice-session", status: "awaiting_reply" });

		const decision = await app.request(
			`/api/v1/ai/proposals/${proposalId}/decision`,
			jsonRequest("POST", { action: "decline" }, t.bobCookie),
		);
		expect(decision.status).toBe(403);
		const inbox = await app.request(
			`/api/v1/ai/inbox/hitl/${hitlId}/decide`,
			jsonRequest("POST", { action: "decline" }, t.bobCookie),
		);
		expect(inbox.status).toBe(403);
		const batchByHitl = await app.request(
			"/api/v1/ai/inbox/batch-decline",
			jsonRequest("POST", { hitlIds: [hitlId] }, t.bobCookie),
		);
		expect(batchByHitl.status).toBe(403);
		const batchBySession = await app.request(
			"/api/v1/ai/inbox/batch-decline",
			jsonRequest("POST", { sessionIds: ["alice-session"] }, t.bobCookie),
		);
		expect(batchBySession.status).toBe(403);
		const [still] = await getDb()
			.select()
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.id, hitlId));
		expect(still?.status).toBe("awaiting_reply");

		// The owner can decline it.
		const ownerBatch = await app.request(
			"/api/v1/ai/inbox/batch-decline",
			jsonRequest("POST", { hitlIds: [hitlId] }, t.aliceCookie),
		);
		expect(ownerBatch.status).toBe(200);
		expect(((await ownerBatch.json()) as { closed: number }).closed).toBe(1);
	});

	test("an inbox decision on a missing HITL is 404", async () => {
		const t = await team();
		const res = await app.request(
			"/api/v1/ai/inbox/hitl/nope/decide",
			jsonRequest("POST", { action: "decline" }, t.aliceCookie),
		);
		expect(res.status).toBe(404);
	});
});

describe("human-only fields", () => {
	test("policy auto from an API key is 403 human_required; from the owner's browser session it is confirmed by them", async () => {
		const t = await team();
		const byKey = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId, policy: "auto" },
			t.aliceKey,
		);
		expect(byKey.status).toBe(403);
		expect(await errorOf(byKey)).toBe("human_required");
		expect(await getWatcherConfig("alice-session")).toBeNull();

		const byCookie = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId, policy: "auto" },
			t.aliceCookie,
		);
		expect(byCookie.status).toBe(200);
		const config = await getWatcherConfig("alice-session");
		expect(config?.policy).toBe("auto");
		expect(config?.autoConfirmedBy).toBe(t.alice.id);
		expect(config?.autoConfirmedAt).not.toBeNull();
	});

	test("resetContinuations from an API key is 403; from the browser session it zeroes the counter", async () => {
		const t = await team();
		await upsertWatcherConfig({
			sessionId: "alice-session",
			providerId: t.providerId,
			enabled: true,
		});
		await getDb()
			.update(watcherConfigs)
			.set({ continuationsUsed: 4 })
			.where(eq(watcherConfigs.sessionId, "alice-session"));
		const byKey = await put("alice-session", { resetContinuations: true }, t.aliceKey);
		expect(byKey.status).toBe(403);
		expect((await getWatcherConfig("alice-session"))?.continuationsUsed).toBe(4);
		const byCookie = await put("alice-session", { resetContinuations: true }, t.aliceCookie);
		expect(byCookie.status).toBe(200);
		expect((await getWatcherConfig("alice-session"))?.continuationsUsed).toBe(0);
	});

	test("an API key may still configure the non-human fields", async () => {
		const t = await team();
		const res = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId, policy: "ask_on_risk", notifyEnabled: true },
			t.aliceKey,
		);
		expect(res.status).toBe(200);
	});

	test("under DISABLE_AUTH the operator counts as a person and is recorded as local", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const providerId = await seedProvider();
		await seedSession("solo-session");
		const res = await put(
			"solo-session",
			{ enabled: true, providerId, policy: "auto" },
			new Headers(),
		);
		expect(res.status).toBe(200);
		expect((await getWatcherConfig("solo-session"))?.autoConfirmedBy).toBe("local");
	});
});

describe("origin", () => {
	test("a hostile Origin on the watcher PUT is 403 bad_origin; with no Origin it is 200", async () => {
		const t = await team();
		const evil = new Headers(t.aliceCookie);
		evil.set("Origin", "https://evil.example");
		const refused = await put("alice-session", { enabled: true, providerId: t.providerId }, evil);
		expect(refused.status).toBe(403);
		expect(await errorOf(refused)).toBe("bad_origin");
		expect(await getWatcherConfig("alice-session")).toBeNull();
		const ok = await put(
			"alice-session",
			{ enabled: true, providerId: t.providerId },
			t.aliceCookie,
		);
		expect(ok.status).toBe(200);
	});

	test("the decision, inbox decision and action-request decision routes check Origin too", async () => {
		const t = await team();
		const evil = new Headers(t.aliceCookie);
		evil.set("Origin", "https://evil.example");
		for (const url of [
			"/api/v1/ai/proposals/any/decision",
			"/api/v1/ai/inbox/hitl/any/decide",
			"/api/v1/ai/action-requests/any/decide",
		]) {
			const res = await app.request(url, jsonRequest("POST", { action: "decline" }, evil));
			expect({ url, status: res.status, error: await errorOf(res) }).toEqual({
				url,
				status: 403,
				error: "bad_origin",
			});
		}
	});
});

describe("audit", () => {
	test("an accepted change logs ai_config_changed with before and after, and the system prompt only as a hash", async () => {
		const t = await team();
		await put("alice-session", { enabled: true, providerId: t.providerId }, t.aliceCookie);
		const capture = captureAuditLines();
		try {
			await put(
				"alice-session",
				{ maxContinuations: 3, systemPrompt: "SECRET-INSTRUCTIONS" },
				t.aliceCookie,
			);
		} finally {
			capture.restore();
		}
		const lines = capture.lines("ai_config_changed");
		expect(lines).toHaveLength(1);
		const line = lines[0] as Record<string, unknown> & {
			before: Record<string, unknown>;
			after: Record<string, unknown>;
		};
		expect(line.sessionId).toBe("alice-session");
		expect(line.by).toBe(t.alice.id);
		expect(line.before.maxContinuations).toBe(10);
		expect(line.after.maxContinuations).toBe(3);
		expect(line.after.systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(line)).not.toContain("SECRET-INSTRUCTIONS");
	});

	test("a delete logs the removed config", async () => {
		const t = await team();
		await put("alice-session", { enabled: true, providerId: t.providerId }, t.aliceCookie);
		const capture = captureAuditLines();
		try {
			await app.request(watcherUrl("alice-session"), { method: "DELETE", headers: t.aliceCookie });
		} finally {
			capture.restore();
		}
		const lines = capture.lines("ai_config_changed");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.after).toBeNull();
	});
});

describe("reads", () => {
	test("GET carries promptDelivery and the session's newest reports, newest first", async () => {
		const t = await team();
		const empty = await app.request(watcherUrl("alice-session"), { headers: t.aliceCookie });
		expect(((await empty.json()) as { reports: unknown }).reports).toEqual([]);

		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		await getDb()
			.insert(schema.aiWatcherReports)
			.values([
				{
					sessionId: "alice-session",
					turnKey: "p:1",
					status: "delivered",
					verdict: "finished",
					why: "old",
					createdAt: ago(120_000),
				},
				{
					sessionId: "alice-session",
					turnKey: "p:2",
					status: "failed",
					failureCode: "parse",
					createdAt: ago(60_000),
				},
			]);
		const res = await app.request(watcherUrl("alice-session"), { headers: t.aliceCookie });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			promptDelivery: unknown;
			reports: Array<{ turnKey: string; status: string }>;
		};
		expect(body.promptDelivery).toEqual({ deliverable: false, reason: "observed" });
		expect(body.reports.map((r) => [r.turnKey, r.status])).toEqual([
			["p:2", "failed"],
			["p:1", "delivered"],
		]);
		await getDb().delete(schema.aiWatcherReports);
	});

	test("a PUT on a session that does not exist is 404", async () => {
		const t = await team();
		const res = await put(
			"no-such-session",
			{ enabled: true, providerId: t.providerId },
			t.adminCookie,
		);
		expect(res.status).toBe(404);
	});
});
