/**
 * `inbox_changed {at}`: the one signal that the inbox may have changed, sent from
 * the seven places the inbox changes (a decision, a HITL opening, an action request
 * opening, an action request being answered, and the three snooze routes).
 *
 * The message carries a timestamp and nothing else. A dashboard socket always hears
 * it. A respond socket hears it in solo mode, and in team mode only when the change
 * concerns a session its reader may read (an action request: an admin), so one member
 * can't watch another's inbox activity.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	aiActionRequests,
	aiHitlDeliveries,
	aiHitlRequests,
	aiInboxSnoozes,
	events,
	sessions,
	watcherProposals,
} = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { createPendingProposal, completeProposalAsHitl } = await import(
	"../services/ai/proposals-service.js"
);
const { createActionRequest, resolveActionRequest } = await import(
	"../services/ai/action-requests-service.js"
);
const { decideHitl, declineAll } = await import("../services/ai/hitl-decision-service.js");
const { snoozeItem } = await import("../services/ai/inbox-snooze-service.js");
const { handleWsClose, handleWsMessage, handleWsOpen } = await import("./handler.js");
const { awaitInboxBroadcastsForTest } = await import("../services/notifier.js");

beforeAll(() => initializeDatabase(), 60_000);
async function reset() {
	await getDb().delete(aiInboxSnoozes);
	await getDb().delete(aiActionRequests);
	await getDb().delete(aiHitlDeliveries);
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", true, { allowProtected: true });
}, 60_000);
const open: Array<() => void> = [];
afterEach(async () => {
	allSockets.length = 0;
	baseline.clear();
	for (const close of open.splice(0)) close();
	await reset();
	await upsertSetting("ai.enabled", false, { allowProtected: true });
}, 60_000);

interface Frame {
	type: string;
	// biome-ignore lint/suspicious/noExplicitAny: wire payloads are inspected loosely
	data: any;
}
interface FakeSocket {
	changes: () => Frame[];
	unsubscribe: () => Promise<void>;
}

async function openSocket(identity: {
	userId?: string | null;
	keyId?: string | null;
	scopes: string[];
	noWait?: boolean;
}): Promise<FakeSocket> {
	const raw: string[] = [];
	const ws = {
		data: {
			userId: identity.userId ?? null,
			keyId: identity.keyId ?? null,
			scopes: identity.scopes,
			profile: identity.scopes.includes("manage") ? "web" : "mobile",
		},
		send: (message: string) => raw.push(message),
		close: () => undefined,
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	const opened = handleWsOpen(ws as any);
	if (!identity.noWait) await opened;
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	open.push(() => handleWsClose(ws as any));
	const socket: FakeSocket = {
		changes: () => raw.map((m) => JSON.parse(m) as Frame).filter((m) => m.type === "inbox_changed"),
		unsubscribe: () =>
			// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
			handleWsMessage(ws as any, JSON.stringify({ type: "unsubscribe", channels: ["sessions"] })),
	};
	allSockets.push(socket);
	return socket;
}

/** The broadcast is fire-and-forget; wait until every one started has reached its sockets. */
const settle = () => awaitInboxBroadcastsForTest();

/** Frames already counted: opening a request is itself announced, so each test measures from after its setup. */
const baseline = new Map<FakeSocket, number>();
const allSockets: FakeSocket[] = [];
function markAll() {
	for (const socket of allSockets) baseline.set(socket, socket.changes().length);
}

async function seedSession(sessionId: string, ownerUserId: string | null) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", ownerUserId });
}

async function seedHitl(sessionId: string) {
	const proposal = await createPendingProposal({ sessionId, providerId: "p-1" });
	const { hitlId } = await completeProposalAsHitl({
		id: proposal.id,
		decision: "continue",
		nextPrompt: "Keep going.",
		tokensIn: 0,
		tokensOut: 0,
		costCents: 0,
	});
	await settle();
	markAll();
	return { hitlId, proposalId: proposal.id };
}

/** Alice, Bob and an admin with respond sockets, and a dashboard socket; one session each. */
async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("ic-alice");
	const bob = await seedLocalUser("ic-bob");
	const admin = await seedLocalUser("ic-admin", "admin");
	const keys = {
		alice: await seedKey("ic-alice-key", ["respond"], alice.id),
		bob: await seedKey("ic-bob-key", ["respond"], bob.id),
		admin: await seedKey("ic-admin-key", ["respond"], admin.id),
	};
	await seedSession("s-alice", alice.id);
	await seedSession("s-bob", bob.id);
	const sockets = {
		alice: await openSocket({ userId: alice.id, keyId: keys.alice.id, scopes: ["respond"] }),
		bob: await openSocket({ userId: bob.id, keyId: keys.bob.id, scopes: ["respond"] }),
		admin: await openSocket({ userId: admin.id, keyId: keys.admin.id, scopes: ["respond"] }),
		web: await openSocket({ scopes: ["manage"] }),
	};
	return { alice, bob, admin, sockets };
}

const heard = (t: Awaited<ReturnType<typeof team>>) =>
	Object.fromEntries(
		Object.entries(t.sockets).map(([name, socket]) => [
			name,
			socket.changes().length - (baseline.get(socket) ?? 0),
		]),
	);
const actionPayload = { sessionId: "s-alice", sessionDisplayName: "s-alice" } as never;

describe("the seven emit sites", () => {
	test("1. a decision: the session's owner, an admin and the dashboard hear it; another member does not", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-alice");

		const out = await decideHitl(
			{ kind: "hitl", hitlId },
			"decline",
			{},
			{
				actor: { userId: t.admin.id, label: "user", role: "admin", mode: "team" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		);
		await settle();

		expect(out.ok).toBe(true);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
		const [frame] = t.sockets.alice.changes();
		expect(Object.keys(frame?.data).sort()).toEqual(["at"]);
		expect(Number.isNaN(Date.parse(frame?.data.at))).toBe(false);
	});

	test("2. a HITL opening (where the watcher's proposal becomes a request) announces the change for its session", async () => {
		const t = await team();
		const proposal = await createPendingProposal({ sessionId: "s-alice", providerId: "p-1" });
		markAll();

		await completeProposalAsHitl({
			id: proposal.id,
			decision: "continue",
			nextPrompt: "Keep going.",
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
		});
		await settle();

		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("3. an action request opening: admins and the dashboard hear it, members do not", async () => {
		const t = await team();

		await createActionRequest({
			kind: "session_stop",
			question: "Stop it?",
			payload: actionPayload,
			origin: "web",
		});
		await settle();

		expect(heard(t)).toEqual({ alice: 0, bob: 0, admin: 1, web: 1 });
	});

	test("4. an action request being answered: admins and the dashboard hear it, members do not", async () => {
		const t = await team();
		const request = await createActionRequest({
			kind: "session_stop",
			question: "Stop it?",
			payload: actionPayload,
			origin: "web",
		});
		await settle();
		const before = heard(t);

		await resolveActionRequest({
			id: request.id,
			decision: "declined",
			resolvedBy: "admin",
			actor: { userId: t.admin.id, label: "user", role: "admin", mode: "team" },
		});
		await settle();

		const after = heard(t);
		expect({
			alice: (after.alice ?? 0) - (before.alice ?? 0),
			admin: (after.admin ?? 0) - (before.admin ?? 0),
			web: (after.web ?? 0) - (before.web ?? 0),
		}).toEqual({ alice: 0, admin: 1, web: 1 });
	});

	test("5. snooze: the owner's snooze is heard by the owner, an admin and the dashboard", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-alice");
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			"/api/v1/ai/inbox/snooze",
			jsonRequest("POST", { kind: "hitl", targetId: hitlId, durationMs: 60_000 }, alice),
		);
		await settle();

		expect(res.status).toBe(200);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("6. unsnooze by id", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-alice");
		const snooze = await snoozeItem({
			kind: "hitl",
			targetId: hitlId,
			until: new Date(Date.now() + 3_600_000),
		});
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			`/api/v1/ai/inbox/snooze/${snooze.id}`,
			jsonRequest("DELETE", {}, alice),
		);
		await settle();

		expect(res.status).toBe(200);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("7. unsnooze by target", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-alice");
		await snoozeItem({ kind: "hitl", targetId: hitlId, until: new Date(Date.now() + 3_600_000) });
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			`/api/v1/ai/inbox/snooze?kind=hitl&targetId=${hitlId}`,
			jsonRequest("DELETE", {}, alice),
		);
		await settle();

		expect(res.status).toBe(200);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});
});

describe("who hears it", () => {
	test("a refused snooze announces nothing", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-bob");
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			"/api/v1/ai/inbox/snooze",
			jsonRequest("POST", { kind: "hitl", targetId: hitlId, durationMs: 60_000 }, alice),
		);
		await settle();

		expect(res.status).toBe(403);
		expect(heard(t)).toEqual({ alice: 0, bob: 0, admin: 0, web: 0 });
	});

	test("a socket that has left the sessions channel hears nothing", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("ic-quiet-alice");
		const key = await seedKey("ic-quiet-key", ["respond"], alice.id);
		await seedSession("s-alice", alice.id);
		const left = await openSocket({ userId: alice.id, keyId: key.id, scopes: ["respond"] });
		await left.unsubscribe();
		const { hitlId } = await seedHitl("s-alice");
		await decideHitl(
			{ kind: "hitl", hitlId },
			"decline",
			{},
			{
				actor: { userId: alice.id, label: "user", role: "member", mode: "team" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		);
		await settle();

		expect(left.changes()).toEqual([]);
	});

	test("solo mode: a respond socket hears every change", async () => {
		await setStoredMode("solo");
		const alice = await seedLocalUser("ic-solo");
		const key = await seedKey("ic-solo-key", ["respond"], alice.id);
		await seedSession("s-other", "someone-else");
		const socket = await openSocket({ userId: alice.id, keyId: key.id, scopes: ["respond"] });
		const { hitlId } = await seedHitl("s-other");

		await decideHitl(
			{ kind: "hitl", hitlId },
			"decline",
			{},
			{
				actor: { userId: null, label: "user", role: "admin", mode: "solo" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		);
		await settle();

		expect(socket.changes().length - (baseline.get(socket) ?? 0)).toBe(1);
	});

	test("a refused or rolled-back decision announces nothing: already answered, busy session, expired, wrong owner", async () => {
		const t = await team();
		const ctx = (userId: string, role: "member" | "admin") => ({
			actor: { userId, label: "user" as const, role, mode: "team" as const },
			source: "session" as const,
			keyId: null,
			scopes: [] as string[],
			canCustomPrompt: true,
		});
		const done = await seedHitl("s-alice");
		await decideHitl(
			{ kind: "hitl", hitlId: done.hitlId },
			"decline",
			{},
			ctx(t.admin.id, "admin"),
		);
		await settle();
		markAll();

		const again = await decideHitl(
			{ kind: "hitl", hitlId: done.hitlId },
			"decline",
			{},
			ctx(t.admin.id, "admin"),
		);
		const foreign = await seedHitl("s-bob");
		const wrongOwner = await decideHitl(
			{ kind: "hitl", hitlId: foreign.hitlId },
			"decline",
			{},
			ctx(t.alice.id, "member"),
		);
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, foreign.hitlId));
		const expired = await decideHitl(
			{ kind: "hitl", hitlId: foreign.hitlId },
			"decline",
			{},
			ctx(t.admin.id, "admin"),
		);
		await settle();

		expect([again.ok, wrongOwner.ok, expired.ok]).toEqual([false, false, false]);
		expect(heard(t)).toEqual({ alice: 0, bob: 0, admin: 0, web: 0 });
	});

	test("the supersede site: closing a session's requests by session id announces to who can read that session", async () => {
		const t = await team();
		await seedHitl("s-bob");
		const out = await declineAll({
			hitlIds: [],
			sessionIds: ["s-bob"],
			ctx: {
				actor: { userId: t.admin.id, label: "user", role: "admin", mode: "team" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		});
		await settle();

		expect(out).toEqual({ ok: true, closed: 1 });
		expect(heard(t)).toEqual({ alice: 0, bob: 1, admin: 1, web: 1 });
	});

	test("the watcher being removed supersedes its open request and announces it", async () => {
		const t = await team();
		await seedHitl("s-alice");
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			"/api/v1/ai/sessions/s-alice/watcher",
			jsonRequest("DELETE", {}, alice),
		);
		await settle();

		// no watcher was configured, so the route answers 404 after superseding what it found
		expect(res.status).toBe(404);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("a snooze of something that isn't a session's is an admin's: only admins and the dashboard hear it", async () => {
		const t = await team();
		const admin = await cookieHeadersFor(t.admin.id);

		const res = await app.request(
			"/api/v1/ai/inbox/snooze",
			jsonRequest("POST", { kind: "hitl", targetId: "no-such-hitl", durationMs: 60_000 }, admin),
		);
		await settle();

		expect(res.status).toBe(200);
		expect(heard(t)).toEqual({ alice: 0, bob: 0, admin: 1, web: 1 });
	});

	test("a key with no owner and a socket on an unowned session: the ownerless socket hears nothing in team mode, a member's hears the unowned change", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("ic-un-alice");
		const aliceKey = await seedKey("ic-un-alice-key", ["respond"], alice.id);
		const looseKey = await seedKey("ic-un-loose-key", ["respond"], null);
		await seedSession("s-open", null);
		const member = await openSocket({ userId: alice.id, keyId: aliceKey.id, scopes: ["respond"] });
		const loose = await openSocket({ userId: null, keyId: looseKey.id, scopes: ["respond"] });
		await seedHitl("s-open");
		const { hitlId } = await seedHitl("s-open");

		await decideHitl(
			{ kind: "hitl", hitlId },
			"decline",
			{},
			{
				actor: { userId: alice.id, label: "user", role: "member", mode: "team" },
				source: "session",
				keyId: null,
				scopes: [],
				canCustomPrompt: true,
			},
		);
		await settle();

		expect(member.changes().length - (baseline.get(member) ?? 0)).toBe(1);
		expect(loose.changes().length - (baseline.get(loose) ?? 0)).toBe(0);
	});

	test("a decision made through the real route with a cookie is heard like any other", async () => {
		const t = await team();
		const { proposalId } = await seedHitl("s-alice");
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await app.request(
			`/api/v1/ai/proposals/${proposalId}/decision`,
			jsonRequest("POST", { action: "decline" }, alice),
		);
		await settle();

		expect(res.status).toBe(200);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("the sweep that closes overdue requests announces each to who can read its session (the ninth emit site)", async () => {
		const t = await team();
		const { hitlId } = await seedHitl("s-alice");
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, hitlId));
		const { expireOverdueHitl } = await import("../services/ai/hitl-service.js");

		const closed = await expireOverdueHitl();
		await settle();

		expect(closed).toBe(1);
		expect(heard(t)).toEqual({ alice: 1, bob: 0, admin: 1, web: 1 });
	});

	test("a sweep with nothing overdue announces nothing", async () => {
		const t = await team();
		await seedHitl("s-alice");
		const { expireOverdueHitl } = await import("../services/ai/hitl-service.js");

		expect(await expireOverdueHitl()).toBe(0);
		await settle();

		expect(heard(t)).toEqual({ alice: 0, bob: 0, admin: 0, web: 0 });
	});
});
