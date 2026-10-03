/**
 * Session detail says which API key reported a session: the key's display name
 * and whether it is an explicit service key. In a team it is for an admin, the
 * session's owner and the key's owner only (a key's label can name a person's
 * machine); on a solo instance every signed-in caller sees it. Never for an
 * observe-scoped key, and never as the key id, which stays out of the detail,
 * the list rows and the WebSocket payloads alike.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { sessionBus, notifySessionUpdated } = await import("../services/notifier.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function keyName(id: string): Promise<string> {
	const [row] = await getDb()
		.select({ name: apiKeys.name })
		.from(apiKeys)
		.where(eq(apiKeys.id, id));
	return row?.name as string;
}

async function seedSession(
	sessionId: string,
	ingestKeyId: string | null,
	ownerUserId: string | null = null,
) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			ingestKeyId,
			ownerUserId,
		} as never);
}

async function detail(sessionId: string, headers: Headers) {
	const res = await app.request(`/api/v1/sessions/${sessionId}`, { headers });
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
}

describe("reportedByKey on GET /sessions/:id", () => {
	test("a manage-scoped key sees the reporting key's name, and that it is not a service key", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("rbk-owner");
		const reporting = await seedKey("rbk-reporter", ["ingest"], owner.id);
		const manage = await seedKey("rbk-manage", ["manage"], owner.id);
		await seedSession("rbk-1", reporting.id);
		const body = await detail("rbk-1", bearerHeaders(manage.key));
		expect(body.reportedByKey).toEqual({ name: await keyName(reporting.id), serviceKey: false });
	});

	test("a signed-in dashboard user sees it too", async () => {
		await setStoredMode("team");
		const user = await seedLocalUser("rbk-user");
		const reporting = await seedKey("rbk-reporter", ["ingest"], user.id);
		await seedSession("rbk-2", reporting.id);
		const body = await detail("rbk-2", await cookieHeadersFor(user.id));
		expect(body.reportedByKey).toEqual({ name: await keyName(reporting.id), serviceKey: false });
	});

	test("an ownerless key an admin listed as a service key reads serviceKey: true; an unlisted one false", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("rbk-admin", "admin");
		const listed = await seedKey("rbk-listed", ["ingest"], null);
		const unlisted = await seedKey("rbk-unlisted", ["ingest"], null);
		await setServiceKeyList([listed.id]);
		await seedSession("rbk-3", listed.id);
		await seedSession("rbk-4", unlisted.id);
		const headers = await cookieHeadersFor(admin.id);
		expect((await detail("rbk-3", headers)).reportedByKey).toEqual({
			name: await keyName(listed.id),
			serviceKey: true,
		});
		expect((await detail("rbk-4", headers)).reportedByKey).toEqual({
			name: await keyName(unlisted.id),
			serviceKey: false,
		});
	});

	test("a session no key reported reads null", async () => {
		await setStoredMode("team");
		const user = await seedLocalUser("rbk-none");
		await seedSession("rbk-5", null, user.id);
		expect((await detail("rbk-5", await cookieHeadersFor(user.id))).reportedByKey).toBeNull();
	});

	test("a reporting key that no longer exists reads null", async () => {
		await setStoredMode("team");
		const user = await seedLocalUser("rbk-gone");
		await seedSession("rbk-6", "key-that-was-deleted", user.id);
		expect((await detail("rbk-6", await cookieHeadersFor(user.id))).reportedByKey).toBeNull();
	});

	test("an observe-scoped key never sees it, and the key id is nowhere in the body", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("rbk-obs-owner");
		const reporting = await seedKey("rbk-reporter", ["ingest"], owner.id);
		const observe = await seedKey("rbk-observe", ["observe"], owner.id);
		await seedSession("rbk-7", reporting.id);
		const res = await app.request("/api/v1/sessions/rbk-7", {
			headers: bearerHeaders(observe.key),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain("reportedByKey");
		expect(text).not.toContain(reporting.id);
		expect(text).not.toContain("ingestKeyId");
	});
});

describe("who sees reportedByKey in a team", () => {
	async function team() {
		await setStoredMode("team");
		const sessionOwner = await seedLocalUser("rbk-session-owner");
		const keyOwner = await seedLocalUser("rbk-key-owner");
		const stranger = await seedLocalUser("rbk-stranger");
		const admin = await seedLocalUser("rbk-team-admin", "admin");
		const reporting = await seedKey("rbk-team-reporter", ["ingest"], keyOwner.id);
		await seedSession("rbk-team", reporting.id, sessionOwner.id);
		return { sessionOwner, keyOwner, stranger, admin, reporting };
	}

	async function seen(sessionId: string, headers: Headers): Promise<unknown> {
		const body = await detail(sessionId, headers);
		return "reportedByKey" in body ? body.reportedByKey : "omitted";
	}

	test("an admin, the session's owner and the key's owner see the key's name", async () => {
		const t = await team();
		const expected = { name: await keyName(t.reporting.id), serviceKey: false };
		for (const user of [t.admin, t.sessionOwner, t.keyOwner]) {
			expect(await seen("rbk-team", await cookieHeadersFor(user.id))).toEqual(expected);
		}
	});

	test("another member does not, and the field is absent rather than null", async () => {
		const t = await team();
		expect(await seen("rbk-team", await cookieHeadersFor(t.stranger.id))).toBe("omitted");
	});

	test("a manage key follows its owner's standing: the session owner's key sees it, a stranger's does not", async () => {
		const t = await team();
		const ownerManage = await seedKey("rbk-owner-manage", ["manage"], t.sessionOwner.id);
		const strangerManage = await seedKey("rbk-stranger-manage", ["manage"], t.stranger.id);
		expect(await seen("rbk-team", bearerHeaders(ownerManage.key))).toEqual({
			name: await keyName(t.reporting.id),
			serviceKey: false,
		});
		expect(await seen("rbk-team", bearerHeaders(strangerManage.key))).toBe("omitted");
	});

	test("a key with no user id never sees the reporter of an ownerless session (no match on null)", async () => {
		await setStoredMode("team");
		const ownerlessReporter = await seedKey("rbk-ownerless-reporter", ["ingest"], null);
		const ownerlessManage = await seedKey("rbk-ownerless-manage", ["manage"], null);
		await seedSession("rbk-ownerless", ownerlessReporter.id, null);
		expect(await seen("rbk-ownerless", bearerHeaders(ownerlessManage.key))).toBe("omitted");
	});

	test("a session no key reported is absent for a stranger too, so the field does not say whether one exists", async () => {
		const t = await team();
		await seedSession("rbk-team-none", null, t.sessionOwner.id);
		expect(await seen("rbk-team-none", await cookieHeadersFor(t.stranger.id))).toBe("omitted");
	});

	test("on a solo instance every signed-in caller sees it, as before", async () => {
		await setStoredMode("solo");
		const user = await seedLocalUser("rbk-solo");
		const other = await seedLocalUser("rbk-solo-other");
		const reporting = await seedKey("rbk-solo-reporter", ["ingest"], other.id);
		await seedSession("rbk-solo-1", reporting.id, other.id);
		expect(await seen("rbk-solo-1", await cookieHeadersFor(user.id))).toEqual({
			name: await keyName(reporting.id),
			serviceKey: false,
		});
	});
});

describe("the key never rides on the list or the broadcasts", () => {
	test("list rows carry neither reportedByKey nor the key id", async () => {
		await setStoredMode("team");
		const user = await seedLocalUser("rbk-list");
		const reporting = await seedKey("rbk-reporter", ["ingest"], user.id);
		await seedSession("rbk-8", reporting.id);
		const res = await app.request("/api/v1/sessions", { headers: await cookieHeadersFor(user.id) });
		const text = await res.text();
		expect(text).toContain("rbk-8");
		expect(text).not.toContain("reportedByKey");
		expect(text).not.toContain(reporting.id);
	});

	test("a session update broadcast carries neither", async () => {
		const received = new Promise<Record<string, unknown>>((resolve) => {
			sessionBus.once("session_updated", (session) => resolve(session as never));
		});
		notifySessionUpdated({
			id: "1",
			sessionId: "rbk-9",
			displayName: "rbk-9",
			metadata: {},
			ingestKeyId: "some-key-id",
		});
		const emitted = await received;
		expect(JSON.stringify(emitted)).not.toContain("some-key-id");
		expect("reportedByKey" in emitted).toBe(false);
	});
});
