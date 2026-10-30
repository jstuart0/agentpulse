/**
 * The decision routes (the AI tab's and the inbox's) are thin adapters over
 * resolveProposal: they authorize on the HITL's own session, take the shown
 * prompt's hash from the body, and answer with what really happened.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	cookieHeadersFor,
	jsonRequest,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";
import {
	clearSetting,
	enableAiRuntime,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProposalWithHitl,
	seedProvider,
	seedSession,
	sha256,
} from "../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	watcherProposals,
} = schema;
const feature = await import("../services/ai/feature.js");

const originalDisableAuth = config.disableAuth;
const PROMPT = "Run the failing test and fix it";
let providerId = "";
let n = 0;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await resetIdentityState();
	await clearSetting(feature.AI_KILL_SWITCH_KEY);
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

async function world(options: { ownerUserId?: string; prompt?: string; managed?: boolean } = {}) {
	n += 1;
	const sessionId = `dec-${n}-${crypto.randomUUID().slice(0, 6)}`;
	if (options.managed === false) await seedSession(sessionId, { ownerUserId: options.ownerUserId });
	else await seedLiveManagedSession(sessionId, { ownerUserId: options.ownerUserId });
	const turn = await seedFinishedTurn(sessionId);
	const prompt = options.prompt ?? PROMPT;
	const ids = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
	return { sessionId, prompt, ...turn, ...ids };
}

async function actions(sessionId: string) {
	return getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));
}

async function solo() {
	const user = await seedLocalUser("dec-user", "user");
	return { user, cookie: await cookieHeadersFor(user.id) };
}

describe("POST /ai/proposals/:id/decision", () => {
	test("approve with the shown hash really sends: dispatched is true and carries the control action id", async () => {
		const w = await world();
		const { cookie } = await solo();
		const res = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "approve", promptSha256: sha256(w.prompt) }, cookie),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dispatched: boolean;
			controlActionId: string;
			prompt: string;
		};
		expect(body.dispatched).toBe(true);
		expect(body.prompt).toBe(w.prompt);
		const rows = await actions(w.sessionId);
		expect(rows.map((r) => r.id)).toEqual([body.controlActionId]);
	});

	test("an observed session is a 409 prompt_not_deliverable, never dispatched:true", async () => {
		const w = await world({ managed: false });
		const { cookie } = await solo();
		const res = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "approve", promptSha256: sha256(w.prompt) }, cookie),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "prompt_not_deliverable", reason: "observed" });
		expect(await actions(w.sessionId)).toHaveLength(0);
	});

	test("decline resolves without sending; a hash that doesn't match is 409 prompt_changed", async () => {
		const w = await world();
		const { cookie } = await solo();
		const changed = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "approve", promptSha256: sha256("other") }, cookie),
		);
		expect(changed.status).toBe(409);
		expect(((await changed.json()) as { error: string }).error).toBe("prompt_changed");
		const declined = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "decline" }, cookie),
		);
		expect(declined.status).toBe(200);
		expect(await declined.json()).toEqual({ ok: true, dispatched: false });
	});

	test("a filter-tripping custom prompt is 400 dispatch_blocked and an unknown action is 400", async () => {
		const w = await world();
		const { cookie } = await solo();
		await getDb()
			.update(aiHitlRequests)
			.set({ approvable: false })
			.where(eq(aiHitlRequests.id, w.hitlId));
		const blocked = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "custom", customPrompt: "Wipe it with rm -rf / now" }, cookie),
		);
		expect(blocked.status).toBe(400);
		expect(((await blocked.json()) as { error: string }).error).toBe("dispatch_blocked");
		const unknown = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "launch" }, cookie),
		);
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toBe("invalid_action");
	});

	test("team mode: a member who doesn't own the session is 403, the owner is allowed", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("dec-owner", "user");
		const other = await seedLocalUser("dec-other", "user");
		const w = await world({ ownerUserId: owner.id });
		const refused = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "decline" }, await cookieHeadersFor(other.id)),
		);
		expect(refused.status).toBe(403);
		const allowed = await app.request(
			`/api/v1/ai/proposals/${w.proposalId}/decision`,
			jsonRequest("POST", { action: "decline" }, await cookieHeadersFor(owner.id)),
		);
		expect(allowed.status).toBe(200);
	});

	test("an unknown proposal is 404 and a body that isn't JSON is 400", async () => {
		const { cookie } = await solo();
		const missing = await app.request(
			"/api/v1/ai/proposals/nope/decision",
			jsonRequest("POST", { action: "decline" }, cookie),
		);
		expect(missing.status).toBe(404);
		const bad = await app.request("/api/v1/ai/proposals/nope/decision", {
			method: "POST",
			headers: cookie,
			body: "not json",
		});
		expect(bad.status).toBe(400);
	});
});

describe("POST /ai/inbox/hitl/:id/decide", () => {
	test("approve sends and answers with the control action; the card's hash is what is checked", async () => {
		const w = await world();
		const { cookie } = await solo();
		const res = await app.request(
			`/api/v1/ai/inbox/hitl/${w.hitlId}/decide`,
			jsonRequest("POST", { action: "approve", promptSha256: sha256(w.prompt) }, cookie),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			hitl: { id: string; status: string };
			controlActionId: string;
		};
		expect(body.hitl).toMatchObject({ id: w.hitlId, status: "applied" });
		expect((await actions(w.sessionId)).map((r) => r.id)).toEqual([body.controlActionId]);
	});

	test("a prompt that trips the filter is 400 (it used to be 200 and resolve the request)", async () => {
		const prompt = "Clean up with rm -rf / when done";
		const w = await world({ prompt });
		const { cookie } = await solo();
		const res = await app.request(
			`/api/v1/ai/inbox/hitl/${w.hitlId}/decide`,
			jsonRequest("POST", { action: "approve", promptSha256: sha256(prompt) }, cookie),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("dispatch_blocked");
		const [row] = await getDb()
			.select()
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.id, w.hitlId));
		expect(row?.status).toBe("awaiting_reply");
	});

	test("an action that isn't approve, decline or custom is 400 invalid_action", async () => {
		const w = await world();
		const { cookie } = await solo();
		const res = await app.request(
			`/api/v1/ai/inbox/hitl/${w.hitlId}/decide`,
			jsonRequest("POST", { action: "launch" }, cookie),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_action");
	});

	test("the session is the HITL's own: a body naming another session changes nothing about who may decide", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("dec-hitl-owner", "user");
		const other = await seedLocalUser("dec-hitl-other", "user");
		const mine = await world({ ownerUserId: other.id });
		const theirs = await world({ ownerUserId: owner.id });
		const res = await app.request(
			`/api/v1/ai/inbox/hitl/${theirs.hitlId}/decide`,
			jsonRequest(
				"POST",
				{ action: "decline", sessionId: mine.sessionId },
				await cookieHeadersFor(other.id),
			),
		);
		expect(res.status).toBe(403);
		const [row] = await getDb()
			.select()
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.id, theirs.hitlId));
		expect(row?.status).toBe("awaiting_reply");
	});
});

describe("POST /ai/inbox/batch-decline", () => {
	test("declines through the same path: events are emitted and a send is never made", async () => {
		const a = await world();
		const b = await world();
		const { cookie } = await solo();
		const res = await app.request(
			"/api/v1/ai/inbox/batch-decline",
			jsonRequest("POST", { hitlIds: [a.hitlId, b.hitlId] }, cookie),
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { closed: number }).closed).toBe(2);
		for (const w of [a, b]) {
			expect(await actions(w.sessionId)).toHaveLength(0);
			const [row] = await getDb()
				.select()
				.from(aiHitlRequests)
				.where(eq(aiHitlRequests.id, w.hitlId));
			expect(row?.status).toBe("declined");
		}
		expect(
			await getDb()
				.select()
				.from(aiDispatchAudit)
				.where(eq(aiDispatchAudit.sessionId, a.sessionId)),
		).toHaveLength(0);
	});
});
