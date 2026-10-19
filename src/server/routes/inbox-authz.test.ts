/**
 * Who sees and who can suppress what in the operator inbox.
 *
 * Team mode: an item belongs to its session's owner (anyone identified, for an
 * unowned session) and to admins. A member sees only their items, cannot snooze or
 * unsnooze anyone else's, and never sees action requests (an admin's). Solo is
 * unchanged. The web team-member inbox regression is pinned here: before this a
 * signed-in member saw every member's items.
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
	bearerHeaders,
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
const { createPendingProposal, completeProposalAsHitl, failProposal } = await import(
	"../services/ai/proposals-service.js"
);
const { createActionRequest } = await import("../services/ai/action-requests-service.js");
const { snoozeItem } = await import("../services/ai/inbox-snooze-service.js");

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
afterEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", false, { allowProtected: true });
}, 60_000);

async function seedSession(sessionId: string, ownerUserId: string | null) {
	await getDb().insert(sessions).values({
		sessionId,
		displayName: sessionId,
		agentType: "claude_code",
		status: "completed",
		lastActivityAt: new Date().toISOString(),
		metadata: {},
		ownerUserId,
	});
}

async function seedHitl(sessionId: string) {
	const proposal = await createPendingProposal({ sessionId, providerId: "p-1" });
	const { hitlId } = await completeProposalAsHitl({
		id: proposal.id,
		decision: "continue",
		nextPrompt: `Next step for ${sessionId}`,
		tokensIn: 0,
		tokensOut: 0,
		costCents: 0,
	});
	return { hitlId, proposalId: proposal.id };
}

async function seedFailedProposal(sessionId: string) {
	const proposal = await createPendingProposal({ sessionId, providerId: "p-1" });
	await failProposal({ id: proposal.id, errorSubType: "llm", errorMessage: "boom" });
	return proposal.id;
}

/** Alice, Bob and an admin, each with a session of their own plus an unowned one, each with an open HITL. */
async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("ix-alice");
	const bob = await seedLocalUser("ix-bob");
	const admin = await seedLocalUser("ix-admin", "admin");
	await seedSession("s-alice", alice.id);
	await seedSession("s-bob", bob.id);
	await seedSession("s-open", null);
	const hitl = {
		alice: await seedHitl("s-alice"),
		bob: await seedHitl("s-bob"),
		open: await seedHitl("s-open"),
	};
	return { alice, bob, admin, hitl };
}

const get = (path: string, headers: Headers) => app.request(`/api/v1${path}`, { headers });
const send = (method: string, path: string, headers: Headers, body?: unknown) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body ?? {}, headers));

type Item = { kind: string; id: string; sessionId: string | null };
async function inboxItems(headers: Headers): Promise<Item[]> {
	const res = await get("/ai/inbox?kinds=hitl,failed_proposal,action_session_stop", headers);
	expect(res.status).toBe(200);
	return ((await res.json()) as { items: Item[] }).items;
}
const ids = (items: Item[]) => items.map((i) => i.id).sort();
const snoozeRows = () => getDb().select().from(aiInboxSnoozes);

describe("the inbox in team mode", () => {
	test("a signed-in member sees their own items and the unowned ones, never another member's (the web regression)", async () => {
		const t = await team();
		const items = await inboxItems(await cookieHeadersFor(t.alice.id));
		expect(ids(items)).toEqual([t.hitl.alice.hitlId, t.hitl.open.hitlId].sort());
		expect(items.some((i) => i.sessionId === "s-bob")).toBe(false);
	});

	test("a respond key sees what its owner would", async () => {
		const t = await team();
		const key = (await seedKey("ix-alice-respond", ["respond"], t.alice.id)).key;
		const items = await inboxItems(bearerHeaders(key));
		expect(ids(items)).toEqual([t.hitl.alice.hitlId, t.hitl.open.hitlId].sort());
	});

	test("an admin sees every member's items", async () => {
		const t = await team();
		const items = await inboxItems(await cookieHeadersFor(t.admin.id));
		expect(ids(items)).toEqual([t.hitl.alice.hitlId, t.hitl.bob.hitlId, t.hitl.open.hitlId].sort());
	});

	test("a key with no owner is a member with no identity: it sees no item, not even an unowned session's", async () => {
		const t = await team();
		const key = (await seedKey("ix-loose", ["respond"], null)).key;
		expect(ids(await inboxItems(bearerHeaders(key)))).toEqual([]);
		const raw = (await (await get("/ai/inbox?kinds=hitl", bearerHeaders(key))).json()) as {
			notice?: string;
		};
		expect(raw.notice).toContain("no owner");
		expect(t.hitl.open.hitlId).toBeTruthy();
	});

	test("failed proposals follow their session's owner", async () => {
		const t = await team();
		const bobsFailed = await seedFailedProposal("s-bob");
		const alicesFailed = await seedFailedProposal("s-alice");
		const items = await inboxItems(await cookieHeadersFor(t.alice.id));
		expect(items.filter((i) => i.kind === "failed_proposal").map((i) => i.id)).toEqual([
			alicesFailed,
		]);
		const adminItems = await inboxItems(await cookieHeadersFor(t.admin.id));
		expect(
			adminItems
				.filter((i) => i.kind === "failed_proposal")
				.map((i) => i.id)
				.sort(),
		).toEqual([alicesFailed, bobsFailed].sort());
	});

	test("action requests are an admin's: a member sees none, an admin sees them", async () => {
		const t = await team();
		await createActionRequest({
			kind: "session_stop",
			question: "Stop it?",
			payload: { sessionId: "s-alice", sessionDisplayName: "s-alice" } as never,
			origin: "web",
		});
		const member = await inboxItems(await cookieHeadersFor(t.alice.id));
		expect(member.some((i) => i.kind.startsWith("action_"))).toBe(false);
		const admin = await inboxItems(await cookieHeadersFor(t.admin.id));
		expect(admin.some((i) => i.kind === "action_session_stop")).toBe(true);
	});

	test("solo mode is unchanged: everything is visible to everyone who can read", async () => {
		await setStoredMode("solo");
		const alice = await seedLocalUser("ix-solo-alice");
		await seedSession("s-bob", "someone-else");
		await seedSession("s-open", null);
		const bob = await seedHitl("s-bob");
		const open = await seedHitl("s-open");
		await createActionRequest({
			kind: "session_stop",
			question: "Stop it?",
			payload: { sessionId: "s-bob", sessionDisplayName: "s-bob" } as never,
			origin: "web",
		});
		const items = await inboxItems(await cookieHeadersFor(alice.id));
		expect(ids(items.filter((i) => i.kind === "hitl"))).toEqual([bob.hitlId, open.hitlId].sort());
		expect(items.some((i) => i.kind === "action_session_stop")).toBe(true);
	});
});

describe("snooze in team mode", () => {
	test("a member can't hide another member's HITL, and nothing is written", async () => {
		const t = await team();
		const alice = await cookieHeadersFor(t.alice.id);

		const res = await send("POST", "/ai/inbox/snooze", alice, {
			kind: "hitl",
			targetId: t.hitl.bob.hitlId,
			durationMs: 60_000,
		});

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "not_owner" });
		expect(await snoozeRows()).toHaveLength(0);
		const bobs = await inboxItems(await cookieHeadersFor(t.bob.id));
		expect(bobs.map((i) => i.id)).toContain(t.hitl.bob.hitlId);
	});

	test("a respond key can snooze its owner's item and an unowned one, and the item leaves the inbox", async () => {
		const t = await team();
		const key = bearerHeaders((await seedKey("ix-alice-respond", ["respond"], t.alice.id)).key);

		for (const hitlId of [t.hitl.alice.hitlId, t.hitl.open.hitlId]) {
			const res = await send("POST", "/ai/inbox/snooze", key, {
				kind: "hitl",
				targetId: hitlId,
				durationMs: 60_000,
			});
			expect(res.status).toBe(200);
		}
		expect(await inboxItems(key)).toEqual([]);
		expect((await snoozeRows())[0]?.createdBy).toBe(t.alice.id);
	});

	test("a member can't unsnooze another member's item, by id or by target", async () => {
		const t = await team();
		await snoozeItem({
			kind: "hitl",
			targetId: t.hitl.bob.hitlId,
			until: new Date(Date.now() + 3_600_000),
		});
		const [row] = await snoozeRows();
		const alice = await cookieHeadersFor(t.alice.id);

		const byId = await send("DELETE", `/ai/inbox/snooze/${row?.id}`, alice);
		expect(byId.status).toBe(403);
		const byTarget = await send(
			"DELETE",
			`/ai/inbox/snooze?kind=hitl&targetId=${t.hitl.bob.hitlId}`,
			alice,
		);
		expect(byTarget.status).toBe(403);
		expect(await snoozeRows()).toHaveLength(1);

		const bob = await cookieHeadersFor(t.bob.id);
		const own = await send("DELETE", `/ai/inbox/snooze/${row?.id}`, bob);
		expect(own.status).toBe(200);
		expect(await snoozeRows()).toHaveLength(0);
	});

	test("the snooze list shows a member only the snoozes of items they could see", async () => {
		const t = await team();
		for (const hitlId of [t.hitl.alice.hitlId, t.hitl.bob.hitlId]) {
			await snoozeItem({ kind: "hitl", targetId: hitlId, until: new Date(Date.now() + 3_600_000) });
		}
		const mine = (await (
			await get("/ai/inbox/snoozes", await cookieHeadersFor(t.alice.id))
		).json()) as {
			snoozes: Array<{ targetId: string }>;
		};
		expect(mine.snoozes.map((s) => s.targetId)).toEqual([t.hitl.alice.hitlId]);
		const all = (await (
			await get("/ai/inbox/snoozes", await cookieHeadersFor(t.admin.id))
		).json()) as {
			snoozes: unknown[];
		};
		expect(all.snoozes).toHaveLength(2);
	});

	test("a stuck or risky target resolves to its session's owner", async () => {
		const t = await team();
		const alice = await cookieHeadersFor(t.alice.id);
		const foreign = await send("POST", "/ai/inbox/snooze", alice, {
			kind: "stuck",
			targetId: "stuck:s-bob",
			durationMs: 60_000,
		});
		expect(foreign.status).toBe(403);
		const mine = await send("POST", "/ai/inbox/snooze", alice, {
			kind: "risky",
			targetId: "risky:s-alice",
			durationMs: 60_000,
		});
		expect(mine.status).toBe(200);
	});

	test("a target that is not a session's is an admin's: a member is refused, an admin may", async () => {
		const t = await team();
		const body = { kind: "hitl", targetId: "no-such-hitl", durationMs: 60_000 };
		expect(
			(await send("POST", "/ai/inbox/snooze", await cookieHeadersFor(t.alice.id), body)).status,
		).toBe(403);
		expect(
			(await send("POST", "/ai/inbox/snooze", await cookieHeadersFor(t.admin.id), body)).status,
		).toBe(200);
	});

	test("solo mode is unchanged: anyone can snooze anything", async () => {
		await setStoredMode("solo");
		const alice = await seedLocalUser("ix-solo");
		await seedSession("s-bob", "someone-else");
		const bob = await seedHitl("s-bob");
		const res = await send("POST", "/ai/inbox/snooze", await cookieHeadersFor(alice.id), {
			kind: "hitl",
			targetId: bob.hitlId,
			durationMs: 60_000,
		});
		expect(res.status).toBe(200);
	});

	test("a snooze that doesn't exist is still 404 for the one who asks", async () => {
		const t = await team();
		const res = await send(
			"DELETE",
			"/ai/inbox/snooze/no-such",
			await cookieHeadersFor(t.alice.id),
		);
		expect(res.status).toBe(404);
		expect(
			(await getDb().select().from(aiInboxSnoozes).where(eq(aiInboxSnoozes.id, "no-such"))).length,
		).toBe(0);
	});

	test("the limit counts what the member can see: bob's newer request doesn't push alice's out of limit=1", async () => {
		const t = await team();
		// team() seeds alice's, bob's and an unowned request in that order, so bob's and the unowned are newer.
		const alice = await cookieHeadersFor(t.alice.id);
		const res = await get("/ai/inbox?kinds=hitl&limit=1", alice);
		const body = (await res.json()) as { items: Item[] };
		expect(body.items).toHaveLength(1);
		expect(["s-alice", "s-open"]).toContain(body.items[0]?.sessionId as string);

		// a request only alice can see, older than three of bob's
		await getDb().delete(aiHitlRequests);
		await getDb().delete(watcherProposals);
		const mine = await seedHitl("s-alice");
		await new Promise((r) => setTimeout(r, 15));
		for (let i = 0; i < 3; i++) {
			await getDb().delete(aiHitlRequests).where(eq(aiHitlRequests.sessionId, "s-bob"));
			await seedHitl("s-bob");
			await new Promise((r) => setTimeout(r, 5));
		}
		const only = await get("/ai/inbox?kinds=hitl&limit=1", alice);
		const items = ((await only.json()) as { items: Item[] }).items;
		expect(items.map((i) => i.id)).toEqual([mine.hitlId]);
	});

	test("the limit holds for failed proposals too", async () => {
		const t = await team();
		const mine = await seedFailedProposal("s-alice");
		await new Promise((r) => setTimeout(r, 15));
		for (let i = 0; i < 25; i++) await seedFailedProposal("s-bob");
		const res = await get(
			"/ai/inbox?kinds=failed_proposal&limit=1",
			await cookieHeadersFor(t.alice.id),
		);
		const items = ((await res.json()) as { items: Item[] }).items;
		expect(items.map((i) => i.id)).toEqual([mine]);
	});

	test("a failed proposal's snooze follows its session: another member's is 403, one's own is 200", async () => {
		const t = await team();
		const bobs = await seedFailedProposal("s-bob");
		const alices = await seedFailedProposal("s-alice");
		const alice = await cookieHeadersFor(t.alice.id);
		const body = (targetId: string) => ({ kind: "failed_proposal", targetId, durationMs: 60_000 });

		expect((await send("POST", "/ai/inbox/snooze", alice, body(bobs))).status).toBe(403);
		expect((await send("POST", "/ai/inbox/snooze", alice, body(alices))).status).toBe(200);
		expect(await snoozeRows()).toHaveLength(1);
	});

	test("action requests: a member's list is empty in team mode, an admin's is not, and a refused decision doesn't echo the request", async () => {
		const t = await team();
		const request = await createActionRequest({
			kind: "session_stop",
			question: "Stop it?",
			payload: { sessionId: "s-bob", sessionDisplayName: "s-bob" } as never,
			origin: "web",
		});
		const member = await get("/ai/action-requests", await cookieHeadersFor(t.alice.id));
		expect(await member.json()).toEqual({ actionRequests: [] });
		const admin = await get("/ai/action-requests", await cookieHeadersFor(t.admin.id));
		expect(((await admin.json()) as { actionRequests: unknown[] }).actionRequests).toHaveLength(1);

		const refused = await send(
			"POST",
			`/ai/action-requests/${request.id}/decide`,
			await cookieHeadersFor(t.alice.id),
			{
				decision: "applied",
			},
		);
		expect(refused.status).toBe(403);
		const refusal = (await refused.json()) as Record<string, unknown>;
		expect(refusal.error).toBe("admin_required");
		expect(refusal).not.toHaveProperty("actionRequest");
	});
});
