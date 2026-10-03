/**
 * Who may change a session, per mode.
 *
 * Team: archive (it dismisses the owner's ERROR/WAITING), rename (including
 * reset-name), pin, notes, the stored CLAUDE.md (it feeds the owner's AI
 * watcher) and DELETE need the session's owner or an admin; prompt, stop and
 * retry stay open to any member (anyone can open and steer a session). An
 * unowned session is open to any
 * member. A refused request is 403 not_owner and writes nothing. Acknowledge
 * and un-acknowledge: a member only on their own or an unowned session, an
 * admin on any. Solo: nothing changes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, events } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	_resetBucketsForTest();
}
beforeEach(reset);
afterEach(reset);

interface World {
	ownerCookie: Headers;
	otherCookie: Headers;
	adminCookie: Headers;
	adminKey: Headers;
	otherKey: Headers;
	serviceKey: Headers;
	listedServiceKey: Headers;
	ownerId: string;
}

async function world(): Promise<World> {
	const owner = await seedLocalUser("sg-owner");
	const other = await seedLocalUser("sg-other");
	const admin = await seedLocalUser("sg-admin", "admin");
	const adminKey = await seedKey("sg-admin-key", ["manage"], admin.id);
	const otherKey = await seedKey("sg-other-key", ["manage"], other.id);
	const serviceKey = await seedKey("sg-service", ["manage"]);
	const listed = await seedKey("sg-listed", ["manage"]);
	await setAdminServiceKeyList([listed.id]);
	return {
		ownerId: owner.id,
		ownerCookie: await cookieHeadersFor(owner.id),
		otherCookie: await cookieHeadersFor(other.id),
		adminCookie: await cookieHeadersFor(admin.id),
		adminKey: bearerHeaders(adminKey.key),
		otherKey: bearerHeaders(otherKey.key),
		serviceKey: bearerHeaders(serviceKey.key),
		listedServiceKey: bearerHeaders(listed.key),
	};
}

async function seedSession(sessionId: string, ownerUserId: string | null, extra = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			status: "completed",
			displayName: "Original",
			metadata: {},
			ownerUserId,
			...extra,
		});
}

async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}

interface GatedRoute {
	name: string;
	send: (sessionId: string, headers: Headers) => Response | Promise<Response>;
	/** True when the route's effect is visible on the session row. */
	applied: (sessionId: string) => Promise<boolean>;
	seed?: Record<string, unknown>;
}

const base = (id: string) => `/api/v1/sessions/${id}`;

const GATED: GatedRoute[] = [
	{
		name: "archive",
		send: (id, h) => app.request(`${base(id)}/archive`, jsonRequest("PUT", { archived: true }, h)),
		applied: async (id) => (await row(id))?.isArchived === true,
	},
	{
		name: "rename",
		send: (id, h) =>
			app.request(`${base(id)}/rename`, jsonRequest("PUT", { name: "Renamed", source: "user" }, h)),
		applied: async (id) => (await row(id))?.displayName === "Renamed",
	},
	{
		name: "reset-name",
		send: (id, h) => app.request(`${base(id)}/rename`, jsonRequest("PUT", { source: "reset" }, h)),
		applied: async (id) =>
			((await row(id))?.metadata as Record<string, unknown> | undefined)?.renameSource ===
			undefined,
		seed: { metadata: { renameSource: "user" } },
	},
	{
		name: "pin",
		send: (id, h) => app.request(`${base(id)}/pin`, jsonRequest("PUT", { pinned: true }, h)),
		applied: async (id) => (await row(id))?.isPinned === true,
	},
	{
		name: "notes",
		send: (id, h) => app.request(`${base(id)}/notes`, jsonRequest("PUT", { notes: "a note" }, h)),
		applied: async (id) => (await row(id))?.notes === "a note",
	},
	{
		name: "claude-md",
		send: (id, h) =>
			app.request(`${base(id)}/claude-md`, jsonRequest("PUT", { content: "# stored" }, h)),
		applied: async (id) => (await row(id))?.claudeMdContent === "# stored",
	},
	{
		name: "delete",
		send: (id, h) => app.request(base(id), { method: "DELETE", headers: h }),
		applied: async (id) => (await row(id)) === undefined,
	},
];

describe("team mode: archive, rename, reset-name, pin, notes, CLAUDE.md and delete need the owner or an admin", () => {
	for (const route of GATED) {
		test(`${route.name}: the owner, an admin cookie, an admin-owned key and a kept service key are let in`, async () => {
			await setStoredMode("team");
			const w = await world();
			const callers = [w.ownerCookie, w.adminCookie, w.adminKey, w.listedServiceKey];
			for (const [i, headers] of callers.entries()) {
				const id = `sg-${route.name}-ok-${i}`;
				await seedSession(id, w.ownerId, route.seed);
				const res = await route.send(id, headers);
				expect({ i, status: res.status }).toEqual({ i, status: 200 });
				expect(await route.applied(id)).toBe(true);
			}
		});

		test(`${route.name}: another member, a member's key and an unlisted service key get 403 not_owner and nothing is written`, async () => {
			await setStoredMode("team");
			const w = await world();
			const callers = [w.otherCookie, w.otherKey, w.serviceKey];
			for (const [i, headers] of callers.entries()) {
				const id = `sg-${route.name}-no-${i}`;
				await seedSession(id, w.ownerId, route.seed);
				const res = await route.send(id, headers);
				expect(res.status).toBe(403);
				expect(await res.json()).toEqual({ error: "not_owner" });
				expect(await route.applied(id)).toBe(false);
			}
		});

		test(`${route.name}: an unowned session is open to any member`, async () => {
			await setStoredMode("team");
			const w = await world();
			const id = `sg-${route.name}-unowned`;
			await seedSession(id, null, route.seed);
			const res = await route.send(id, w.otherCookie);
			expect(res.status).toBe(200);
			expect(await route.applied(id)).toBe(true);
		});

		test(`${route.name}: solo is unchanged, another member may`, async () => {
			const w = await world();
			const id = `sg-${route.name}-solo`;
			await seedSession(id, w.ownerId, route.seed);
			const res = await route.send(id, w.otherCookie);
			expect(res.status).toBe(200);
			expect(await route.applied(id)).toBe(true);
		});
	}
});

describe("team mode: prompt, stop and retry stay open to any member", () => {
	test("prompt, stop and retry are not refused for ownership (an unmanaged session answers 400 for its own reasons)", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("sg-steer", w.ownerId);
		for (const [path, body] of [
			["prompt", { prompt: "hello" }],
			["stop", {}],
			["retry", {}],
		] as const) {
			const res = await app.request(
				`${base("sg-steer")}/${path}`,
				jsonRequest("POST", body, w.otherCookie),
			);
			expect({ path, forbidden: res.status === 403 }).toEqual({ path, forbidden: false });
		}
	});
});

describe("claude-md body validation", () => {
	test("a content that is not a string is 400 invalid_body and writes nothing", async () => {
		const w = await world();
		await seedSession("sg-md-body", w.ownerId);
		for (const body of [{ content: 5 }, { content: null }, {}, { content: "x", path: 7 }]) {
			const res = await app.request(
				`${base("sg-md-body")}/claude-md`,
				jsonRequest("PUT", body, w.ownerCookie),
			);
			expect({ body, status: res.status }).toEqual({ body, status: 400 });
			expect(await res.json()).toEqual({ error: "invalid_body" });
		}
		expect((await row("sg-md-body"))?.claudeMdContent).toBeNull();
	});
});

describe("acknowledge and un-acknowledge", () => {
	const finishedTurn = { lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z" };
	const acknowledged = {
		lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
		lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
	};

	async function ack(sessionId: string, headers: Headers) {
		return app.request(`${base(sessionId)}/acknowledge`, { method: "POST", headers });
	}
	async function unack(sessionId: string, headers: Headers) {
		return app.request(`${base(sessionId)}/acknowledge`, { method: "DELETE", headers });
	}

	test("team: an admin acknowledges and un-acknowledges any session", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("sg-ack-admin", w.ownerId, finishedTurn);
		for (const headers of [w.adminCookie, w.adminKey]) {
			const res = await ack("sg-ack-admin", headers);
			expect(await res.json()).toEqual({ acknowledged: true });
			expect((await row("sg-ack-admin"))?.lastUserAcknowledgedAt).not.toBeNull();
			const undone = await unack("sg-ack-admin", headers);
			expect(await undone.json()).toEqual({ unacknowledged: true });
			expect((await row("sg-ack-admin"))?.lastUserAcknowledgedAt).toBeNull();
		}
	});

	test("team: a member does so on their own or an unowned session, never on someone else's", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("sg-ack-mine", w.ownerId, finishedTurn);
		await seedSession("sg-ack-free", null, finishedTurn);
		await seedSession("sg-ack-theirs", w.ownerId, finishedTurn);

		expect(await (await ack("sg-ack-mine", w.ownerCookie)).json()).toEqual({ acknowledged: true });
		expect(await (await ack("sg-ack-free", w.otherCookie)).json()).toEqual({ acknowledged: true });
		expect(await (await ack("sg-ack-theirs", w.otherCookie)).json()).toEqual({
			acknowledged: false,
			reason: "not_owner",
		});
		expect((await row("sg-ack-theirs"))?.lastUserAcknowledgedAt).toBeNull();
		expect(await (await ack("sg-ack-theirs", w.serviceKey)).json()).toEqual({
			acknowledged: false,
			reason: "not_owner",
		});
	});

	test("team: un-acknowledge has the same rule", async () => {
		await setStoredMode("team");
		const w = await world();
		await seedSession("sg-unack-theirs", w.ownerId, acknowledged);
		expect(await (await unack("sg-unack-theirs", w.otherCookie)).json()).toEqual({
			unacknowledged: false,
			reason: "not_owner",
		});
		expect((await row("sg-unack-theirs"))?.lastUserAcknowledgedAt).not.toBeNull();
		expect(await (await unack("sg-unack-theirs", w.ownerCookie)).json()).toEqual({
			unacknowledged: true,
		});
	});

	test("solo is unchanged: only the owner (or anyone for an unowned session), admin or not", async () => {
		const w = await world();
		await seedSession("sg-ack-solo", w.ownerId, finishedTurn);
		expect(await (await ack("sg-ack-solo", w.adminCookie)).json()).toEqual({
			acknowledged: false,
			reason: "not_owner",
		});
		expect(await (await ack("sg-ack-solo", w.ownerCookie)).json()).toEqual({ acknowledged: true });
	});

	test("the REST rule and the hook-path rule agree for every (owner, caller) pair without an admin override", async () => {
		const { canAcknowledgeOwnedSession } = await import("../services/session-attribution.js");
		const { acknowledgeSession } = await import("../services/session-tracker.js");
		const pairs: Array<[string | null, string | null]> = [
			[null, "u1"],
			[null, null],
			["u1", "u1"],
			["u1", "u2"],
			["u1", null],
		];
		for (const mode of ["solo", "team"] as const) {
			if (mode === "team") await setStoredMode("team");
			for (const [i, [owner, caller]] of pairs.entries()) {
				const id = `sg-agree-${mode}-${i}`;
				await seedSession(id, owner, finishedTurn);
				const rest = await acknowledgeSession(id, {
					userId: caller,
					label: "user",
					role: "member",
					mode,
				});
				const viaRest = rest.found && rest.acknowledged;
				const viaHook = canAcknowledgeOwnedSession(
					{ ownerUserId: owner },
					{ ownerUserId: caller, ingestKeyId: null },
				);
				expect({ mode, owner, caller, viaRest }).toEqual({ mode, owner, caller, viaRest: viaHook });
			}
		}
	});
});
