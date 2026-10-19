/**
 * The HITL decision service at its seams: the four entry points, who may decide
 * what, the prompt hash, atomicity, the delivery states and the retry race.
 *
 * Runs on both dialects. The Postgres run is what proves the control action and
 * the lock are queued through the decision's own transaction (a second connection
 * would not see the uncommitted rows).
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import "./__test_db.js";
import type { Actor } from "../../auth/actor.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../../test-utils/team-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const {
	aiHitlDeliveries,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	watcherProposals,
} = await import("../../db/schema/index.js");
const { app } = await import("../../app.js");
const { upsertSetting } = await import("../settings-service.js");
const { seedOwnedLaunch } = await import("../../test-utils/owned-launch.js");
const { claimNextControlAction, updateControlAction } = await import("../control-actions.js");
const { createPendingProposal, completeProposalAsHitl } = await import("./proposals-service.js");
const {
	TELEGRAM_DECISION_CONTEXT,
	declineAll,
	decideHitl,
	getDeliveryState,
	hashPrompt,
	moveDeliveryToAction,
	retryDelivery,
} = await import("./hitl-decision-service.js");
const { config } = await import("../../config.js");
const telegram = await import("../channels/telegram.js");
const { getProposal: getProposalRow } = await import("./proposals-service.js");
import { describeSqliteOnly } from "../../test-utils/backend.js";
const { handleTelegramUpdate } = await import("../../routes/channels.js");

async function reset() {
	await getDb().delete(aiHitlDeliveries);
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearInstanceSettings();
}
// Generous timeouts: a loaded Postgres can take longer than bun's 5 s to clear a dozen tables.
const HOOK_TIMEOUT_MS = 60_000;
setDefaultTimeout(HOOK_TIMEOUT_MS);
beforeAll(() => initializeDatabase(), HOOK_TIMEOUT_MS);
beforeEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", true, { allowProtected: true });
}, HOOK_TIMEOUT_MS);
afterEach(async () => {
	await reset();
	await upsertSetting("ai.enabled", false, { allowProtected: true });
}, HOOK_TIMEOUT_MS);

const PROMPT = "Run the full test suite and fix what fails.";
const SUPERVISOR = "sup-1";

async function seedSession(sessionId: string, ownerUserId: string | null = null) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
			ownerUserId,
		})
		.onConflictDoNothing();
}

/** A session a supervisor owns, so an approved prompt can be queued for it. */
async function seedManaged(sessionId: string, opts: { connected?: boolean } = {}) {
	await getDb()
		.insert(supervisors)
		.values({
			id: SUPERVISOR,
			hostName: "host",
			platform: "darwin",
			arch: "arm64",
			version: "1",
			status: opts.connected === false ? "disconnected" : "connected",
		})
		.onConflictDoNothing();
	const { launchId } = await seedOwnedLaunch(sessionId, SUPERVISOR);
	const now = new Date().toISOString();
	await getDb().insert(managedSessions).values({
		sessionId,
		launchRequestId: launchId,
		supervisorId: SUPERVISOR,
		managedState: "managed",
		createdAt: now,
		updatedAt: now,
	});
}

/** A proposal with an open HITL request, as the watcher leaves it. */
async function seedHitl(sessionId: string, nextPrompt: string | null = PROMPT) {
	const proposal = await createPendingProposal({ sessionId, providerId: "p-1" });
	const { hitlId } = await completeProposalAsHitl({
		id: proposal.id,
		decision: "continue",
		nextPrompt,
		tokensIn: 0,
		tokensOut: 0,
		costCents: 0,
	});
	return { proposalId: proposal.id, hitlId };
}

const actor = (over: Partial<Actor> = {}): Actor => ({
	userId: null,
	label: "api_key",
	role: "admin",
	mode: "solo",
	...over,
});
const manageCtx = (over: Partial<Actor> = {}) => ({
	actor: actor(over),
	source: "api_key" as const,
	keyId: "key-manage",
	scopes: ["manage"],
	canCustomPrompt: true,
});
const respondCtx = (over: Partial<Actor> = {}) => ({
	actor: actor({ role: "member", ...over }),
	source: "api_key" as const,
	keyId: "key-respond",
	scopes: ["respond"],
	canCustomPrompt: false,
});

const hitlStatus = async (hitlId: string) =>
	(await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId)))[0]?.status;
const actionsFor = (sessionId: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));
const deliveries = () => getDb().select().from(aiHitlDeliveries);
const eventCategories = async (sessionId: string) =>
	(
		await getDb()
			.select({ category: events.category })
			.from(events)
			.where(eq(events.sessionId, sessionId))
	)
		.map((r) => r.category)
		.sort();

describe("approve", () => {
	test("on a managed session with a connected supervisor queues the prompt in the same step, and says so", async () => {
		await seedSession("s-1");
		await seedManaged("s-1");
		const { proposalId, hitlId } = await seedHitl("s-1");

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.delivery?.state).toBe("queued");
		expect(await hitlStatus(hitlId)).toBe("applied");
		const actions = await actionsFor("s-1");
		expect(actions).toHaveLength(1);
		expect(actions[0]?.status).toBe("queued");
		expect((actions[0]?.metadata as { prompt?: string }).prompt).toBe(PROMPT);
		const [delivery] = await deliveries();
		expect(delivery).toMatchObject({
			proposalId,
			hitlId,
			controlActionId: actions[0]?.id,
			attempt: 1,
			terminalState: null,
			approvedByKeyId: "key-manage",
			promptHash: hashPrompt(PROMPT),
		});
		expect(await eventCategories("s-1")).toEqual(["ai_continue_sent", "ai_hitl_response"]);
	});

	test("on a session no supervisor manages is not_managed, and no continue is announced", async () => {
		await seedSession("s-2");
		const { proposalId } = await seedHitl("s-2");

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(out.ok && out.delivery?.state).toBe("not_managed");
		expect(await actionsFor("s-2")).toHaveLength(0);
		expect(await eventCategories("s-2")).toEqual(["ai_hitl_response"]);
	});

	test("on a managed session whose supervisor is offline is blocked, and queues nothing", async () => {
		await seedSession("s-3");
		await seedManaged("s-3", { connected: false });
		const { proposalId } = await seedHitl("s-3");

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(out.ok && out.delivery?.state).toBe("blocked");
		expect(await actionsFor("s-3")).toHaveLength(0);
		expect(await eventCategories("s-3")).toEqual(["ai_hitl_response"]);
	});

	test("while another control action holds the session: 409 control_busy, the request is still open, nothing is written", async () => {
		await seedSession("s-4");
		await seedManaged("s-4");
		const { proposalId, hitlId } = await seedHitl("s-4");
		const first = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		expect(first.ok).toBe(true);
		const second = await seedHitl("s-4", "Another prompt.");

		const out = await decideHitl(
			{ kind: "proposal", proposalId: second.proposalId },
			"approve",
			{},
			manageCtx(),
		);

		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.refusal).toMatchObject({ code: "control_busy", status: 409 });
		expect(await hitlStatus(second.hitlId)).toBe("awaiting_reply");
		expect(await hitlStatus(hitlId)).toBe("applied");
		expect(await actionsFor("s-4")).toHaveLength(1);
		expect(await deliveries()).toHaveLength(1);
	});

	test("an empty prompt is refused with 400 and the request stays open", async () => {
		await seedSession("s-5");
		const { proposalId, hitlId } = await seedHitl("s-5", null);

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(!out.ok && out.refusal).toMatchObject({ code: "empty_prompt", status: 400 });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});

	test("a prompt the safety filter blocks is refused with delivery blocked, and the request stays open", async () => {
		await seedSession("s-6");
		const { proposalId, hitlId } = await seedHitl("s-6", "please run rm -rf / now");

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.refusal.status).toBe(400);
		expect(out.refusal.body).toMatchObject({
			error: "filter_blocked",
			delivery: { state: "blocked", reason: "filter" },
		});
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});
});

describe("the prompt hash", () => {
	test("a changed prompt is 409 prompt_changed and nothing is written; the right hash passes", async () => {
		await seedSession("h-1");
		await seedManaged("h-1");
		const { proposalId, hitlId } = await seedHitl("h-1");

		const stale = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt("an older prompt") },
			manageCtx(),
		);
		expect(!stale.ok && stale.refusal).toMatchObject({ code: "prompt_changed", status: 409 });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("h-1")).toHaveLength(0);
		expect(await deliveries()).toHaveLength(0);

		const fresh = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt(PROMPT) },
			manageCtx(),
		);
		expect(fresh.ok).toBe(true);
	});

	test("the hash of the prompt as it was is refused once the proposal's prompt has changed", async () => {
		await seedSession("h-2");
		const { proposalId } = await seedHitl("h-2", "first version");
		await getDb()
			.update(watcherProposals)
			.set({ nextPrompt: "second version" })
			.where(eq(watcherProposals.id, proposalId));

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt("first version") },
			manageCtx(),
		);

		expect(!out.ok && out.refusal.code).toBe("prompt_changed");
	});

	test("a decline needs no hash and ignores one", async () => {
		await seedSession("h-3");
		const { proposalId, hitlId } = await seedHitl("h-3");

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"decline",
			{ promptHash: hashPrompt("something else") },
			respondCtx(),
		);

		expect(out.ok).toBe(true);
		expect(await hitlStatus(hitlId)).toBe("declined");
	});
});

describe("who may decide what", () => {
	test("a respond key cannot send custom text, even when its owner is an admin; the request stays open", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("dec-admin", "admin");
		await seedSession("c-1", null);
		const { proposalId, hitlId } = await seedHitl("c-1");
		const ctx = respondCtx({ userId: admin.id, role: "admin", mode: "team" });

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"custom",
			{ customPrompt: "do something else entirely" },
			ctx,
		);

		expect(!out.ok && out.refusal).toMatchObject({ code: "insufficient_scope", status: 403 });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("c-1")).toHaveLength(0);
	});

	test("a context that claims canCustomPrompt but carries only a respond scope is still refused", async () => {
		await seedSession("c-2");
		const { proposalId } = await seedHitl("c-2");

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"custom",
			{ customPrompt: "x" },
			{ ...respondCtx(), canCustomPrompt: true },
		);

		expect(!out.ok && out.refusal.code).toBe("insufficient_scope");
	});

	test("a manage key and a signed-in person may send custom text, and it is what is queued", async () => {
		await seedSession("c-3");
		await seedManaged("c-3");
		const { proposalId } = await seedHitl("c-3");

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"custom",
			{ customPrompt: "  use the staging database  " },
			{ ...manageCtx(), source: "session", keyId: null, scopes: [] },
		);

		expect(out.ok).toBe(true);
		const [action] = await actionsFor("c-3");
		expect((action?.metadata as { prompt?: string }).prompt).toBe("use the staging database");
	});

	test("team mode: another member's session is 403 not_owner for approve and decline; an unowned session and the owner and an admin are allowed", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("dec-alice");
		const bob = await seedLocalUser("dec-bob");
		const admin = await seedLocalUser("dec-admin", "admin");
		await seedSession("bobs", bob.id);
		await seedSession("open", null);
		const aliceCtx = respondCtx({ userId: alice.id, mode: "team" });

		const bobsHitl = await seedHitl("bobs");
		for (const action of ["approve", "decline"] as const) {
			const out = await decideHitl(
				{ kind: "proposal", proposalId: bobsHitl.proposalId },
				action,
				{},
				aliceCtx,
			);
			expect(!out.ok && out.refusal).toMatchObject({ code: "not_owner", status: 403 });
		}
		expect(await hitlStatus(bobsHitl.hitlId)).toBe("awaiting_reply");
		expect(await deliveries()).toHaveLength(0);

		const open = await seedHitl("open");
		expect(
			(await decideHitl({ kind: "hitl", hitlId: open.hitlId }, "decline", {}, aliceCtx)).ok,
		).toBe(true);

		const viaAdmin = await decideHitl(
			{ kind: "proposal", proposalId: bobsHitl.proposalId },
			"decline",
			{},
			respondCtx({ userId: admin.id, role: "admin", mode: "team" }),
		);
		expect(viaAdmin.ok).toBe(true);
	});

	test("team mode: the owner of the session may decide it; a key with no owner may not decide anything", async () => {
		await setStoredMode("team");
		const bob = await seedLocalUser("own-bob");
		await seedSession("bobs", bob.id);
		const first = await seedHitl("bobs");
		const looseCtx = respondCtx({ userId: null, mode: "team" });

		const loose = await decideHitl({ kind: "hitl", hitlId: first.hitlId }, "decline", {}, looseCtx);
		expect(!loose.ok && loose.refusal.code).toBe("not_owner");

		const owner = await decideHitl(
			{ kind: "hitl", hitlId: first.hitlId },
			"decline",
			{},
			respondCtx({ userId: bob.id, mode: "team" }),
		);
		expect(owner.ok).toBe(true);
	});

	test("a stranger learns nothing about whether the request is still open", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("probe-alice");
		const bob = await seedLocalUser("probe-bob");
		await seedSession("bobs", bob.id);
		const { hitlId } = await seedHitl("bobs");
		await decideHitl({ kind: "hitl", hitlId }, "decline", {}, manageCtx());

		const out = await decideHitl(
			{ kind: "hitl", hitlId },
			"approve",
			{},
			respondCtx({ userId: alice.id, mode: "team" }),
		);

		expect(!out.ok && out.refusal.code).toBe("not_owner");
	});
});

describe("atomicity", () => {
	test("two concurrent approvals make one delivery and one control action; the loser is 409 already_resolved", async () => {
		await seedSession("r-1");
		await seedManaged("r-1");
		const { proposalId } = await seedHitl("r-1");

		const results = await Promise.all([
			decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx()),
			decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx()),
		]);

		const refusals = results.filter((r) => !r.ok);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(refusals).toHaveLength(1);
		expect(!refusals[0]?.ok && refusals[0]?.refusal.status).toBe(409);
		expect(await deliveries()).toHaveLength(1);
		expect(await actionsFor("r-1")).toHaveLength(1);
	}, 30_000);

	test("a failure after the request was closed rolls the close back: nothing is persisted", async () => {
		await seedSession("r-2");
		await seedManaged("r-2");
		const { proposalId, hitlId } = await seedHitl("r-2");
		// A delivery row already exists for this proposal, so the insert that follows the close fails.
		await getDb().insert(aiHitlDeliveries).values({
			proposalId,
			hitlId,
			sessionId: "r-2",
			createdAt: "x",
			updatedAt: "x",
		});

		await expect(
			decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx()),
		).rejects.toThrow();

		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("r-2")).toHaveLength(0);
		expect(await eventCategories("r-2")).toEqual([]);
	});

	test("a managed row whose launch pointer resolves to nothing commits as blocked (launch_not_found), queues nothing, and reports the reason", async () => {
		await seedSession("r-3");
		await seedManaged("r-3");
		const { proposalId, hitlId } = await seedHitl("r-3");
		await getDb().update(managedSessions).set({ launchRequestId: "no-such-launch" });

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

		expect(out.ok && out.delivery).toMatchObject({ state: "blocked", reason: "launch_not_found" });
		expect(await hitlStatus(hitlId)).toBe("applied");
		expect(await actionsFor("r-3")).toHaveLength(0);
		const read = await getDeliveryState(proposalId, manageCtx());
		expect(read.ok && read.delivery).toMatchObject({
			state: "blocked",
			reason: "launch_not_found",
		});
	});

	test("deciding a request twice: the second is 409 and the first answer stands", async () => {
		await seedSession("r-4");
		const { hitlId } = await seedHitl("r-4");
		await decideHitl({ kind: "hitl", hitlId }, "decline", {}, manageCtx());

		const again = await decideHitl({ kind: "hitl", hitlId }, "approve", {}, manageCtx());

		expect(!again.ok && again.refusal).toMatchObject({ code: "already_resolved", status: 409 });
		expect(await hitlStatus(hitlId)).toBe("declined");
	});
});

describe("queuePromptAction runs entirely inside the caller's transaction", () => {
	test("rows created only inside the transaction are visible to every step, and a rollback leaves no action and no lock", async () => {
		const { withTransaction: run } = await import("../../db/with-transaction.js");
		const { queuePromptAction } = await import("../control-actions.js");
		const now = new Date().toISOString();
		class Probe extends Error {}
		await expect(
			run(async (tx) => {
				await tx.insert(sessions).values({
					sessionId: "tx-1",
					agentType: "claude_code",
					status: "active",
					metadata: {},
				});
				await tx
					.insert(supervisors)
					.values({ id: "tx-sup", hostName: "h", platform: "darwin", arch: "arm64", version: "1" });
				const [launch] = await tx
					.insert(launchRequests)
					.values({
						launchCorrelationId: "tx-1",
						agentType: "claude_code",
						cwd: "/tmp/x",
						requestedSupervisorId: "tx-sup",
						claimedBySupervisorId: "tx-sup",
						status: "running",
					})
					.returning();
				await tx.insert(managedSessions).values({
					sessionId: "tx-1",
					launchRequestId: launch.id,
					supervisorId: "tx-sup",
					managedState: "managed",
					createdAt: now,
					updatedAt: now,
				});
				const queued = await queuePromptAction("tx-1", "hello", actor(), tx);
				expect(queued.status).toBe("queued");
				const [locked] = await tx
					.select()
					.from(managedSessions)
					.where(eq(managedSessions.sessionId, "tx-1"));
				expect(locked?.activeControlActionId).toBe(queued.id);
				throw new Probe("roll back");
			}),
		).rejects.toBeInstanceOf(Probe);

		expect(await actionsFor("tx-1")).toHaveLength(0);
		expect(await getDb().select().from(managedSessions)).toHaveLength(0);
	});

	test("an expired lock that exists only inside the transaction is cleared by the same transaction", async () => {
		const { withTransaction: run } = await import("../../db/with-transaction.js");
		const { queuePromptAction } = await import("../control-actions.js");
		const now = new Date().toISOString();
		class Probe extends Error {}
		await expect(
			run(async (tx) => {
				await tx.insert(sessions).values({
					sessionId: "tx-2",
					agentType: "claude_code",
					status: "active",
					metadata: {},
				});
				await tx
					.insert(supervisors)
					.values({ id: "tx-sup", hostName: "h", platform: "darwin", arch: "arm64", version: "1" });
				const [launch] = await tx
					.insert(launchRequests)
					.values({
						launchCorrelationId: "tx-2",
						agentType: "claude_code",
						cwd: "/tmp/x",
						requestedSupervisorId: "tx-sup",
						claimedBySupervisorId: "tx-sup",
						status: "running",
					})
					.returning();
				const [stale] = await tx
					.insert(controlActions)
					.values({
						sessionId: "tx-2",
						launchRequestId: launch.id,
						actionType: "prompt",
						requestedBy: "test",
						status: "running",
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				await tx.insert(managedSessions).values({
					sessionId: "tx-2",
					launchRequestId: launch.id,
					supervisorId: "tx-sup",
					managedState: "managed",
					activeControlActionId: stale.id,
					controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString(),
					createdAt: now,
					updatedAt: now,
				});
				const queued = await queuePromptAction("tx-2", "hello", actor(), tx);
				expect(queued.status).toBe("queued");
				const [old] = await tx.select().from(controlActions).where(eq(controlActions.id, stale.id));
				expect(old?.status).toBe("failed");
				throw new Probe("roll back");
			}),
		).rejects.toBeInstanceOf(Probe);
		expect(await getDb().select().from(controlActions)).toHaveLength(0);
	});

	test("the launch/owner cross-check reads the transaction's own rows: a launch for another host is refused", async () => {
		const { withTransaction: run } = await import("../../db/with-transaction.js");
		const { queuePromptAction, LaunchMismatchError } = await import("../control-actions.js");
		const now = new Date().toISOString();
		class Probe extends Error {}
		let thrown: unknown;
		await expect(
			run(async (tx) => {
				await tx.insert(sessions).values({
					sessionId: "tx-3",
					agentType: "claude_code",
					status: "active",
					metadata: {},
				});
				await tx.insert(supervisors).values({
					id: "tx-sup-b",
					hostName: "h",
					platform: "darwin",
					arch: "arm64",
					version: "1",
				});
				// The launch was requested for host A but never claimed; the managed row says host B owns the session.
				const [launch] = await tx
					.insert(launchRequests)
					.values({
						launchCorrelationId: "tx-3",
						agentType: "claude_code",
						cwd: "/tmp/x",
						requestedSupervisorId: "tx-sup-a",
						status: "running",
					})
					.returning();
				await tx.insert(managedSessions).values({
					sessionId: "tx-3",
					launchRequestId: launch.id,
					supervisorId: "tx-sup-b",
					managedState: "managed",
					createdAt: now,
					updatedAt: now,
				});
				try {
					await queuePromptAction("tx-3", "hello", actor(), tx);
				} catch (err) {
					thrown = err;
				}
				throw new Probe("roll back");
			}),
		).rejects.toBeInstanceOf(Probe);
		expect(thrown).toBeInstanceOf(LaunchMismatchError);
	});
});

/** Runs a statement the schema layer has no builder for: a trigger that makes one write fail. */
async function rawExec(statement: string): Promise<void> {
	if (config.dialect === "postgres") {
		await (getDb() as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
			sql.raw(statement),
		);
	} else {
		const { getSqlite } = await import("../../db/client.js");
		getSqlite().exec(statement);
	}
}

async function failEveryDeliveryUpdate(): Promise<() => Promise<void>> {
	if (config.dialect === "postgres") {
		await rawExec(
			"CREATE OR REPLACE FUNCTION tmp_fail_delivery_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql",
		);
		await rawExec(
			"CREATE TRIGGER tmp_fail_delivery_update BEFORE UPDATE ON ai_hitl_deliveries FOR EACH ROW EXECUTE FUNCTION tmp_fail_delivery_update()",
		);
		return async () => {
			await rawExec("DROP TRIGGER IF EXISTS tmp_fail_delivery_update ON ai_hitl_deliveries");
			await rawExec("DROP FUNCTION IF EXISTS tmp_fail_delivery_update()");
		};
	}
	await rawExec(
		"CREATE TRIGGER tmp_fail_delivery_update BEFORE UPDATE ON ai_hitl_deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
	);
	return () => rawExec("DROP TRIGGER IF EXISTS tmp_fail_delivery_update");
}

describe("a failure after the prompt was queued undoes the queueing too", () => {
	test("the close, the delivery, the control action and the session lock all roll back together", async () => {
		await seedSession("f-1");
		await seedManaged("f-1");
		const { proposalId, hitlId } = await seedHitl("f-1");
		const undo = await failEveryDeliveryUpdate();
		try {
			await expect(
				decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx()),
			).rejects.toThrow();
		} finally {
			await undo();
		}

		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await deliveries()).toHaveLength(0);
		expect(await actionsFor("f-1")).toHaveLength(0);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "f-1"));
		expect(managed?.activeControlActionId).toBeNull();
		expect(await eventCategories("f-1")).toEqual([]);
	});
});

describe("racing for a session's control lock", () => {
	test("of two prompts queued at once for a free session exactly one gets it; the other is ControlBusyError and leaves nothing", async () => {
		const { queuePromptAction, ControlBusyError } = await import("../control-actions.js");
		await seedSession("l-1");
		await seedManaged("l-1");

		const results = await Promise.allSettled([
			queuePromptAction("l-1", "first", actor()),
			queuePromptAction("l-1", "second", actor()),
		]);

		const won = results.filter((r) => r.status === "fulfilled");
		const lost = results.filter((r) => r.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ControlBusyError);
		const actions = await actionsFor("l-1");
		expect(actions).toHaveLength(1);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "l-1"));
		expect(managed?.activeControlActionId).toBe(actions[0]?.id);
	}, 30_000);
});

describe("a stop takes the session's control lock the same guarded way a prompt does", () => {
	test("a stop and a prompt queued at once for a free session: exactly one gets it, the other is ControlBusyError", async () => {
		const { queuePromptAction, queueStopAction, ControlBusyError } = await import(
			"../control-actions.js"
		);
		await seedSession("sp-1");
		await seedManaged("sp-1");

		const results = await Promise.allSettled([
			queueStopAction("sp-1", actor()),
			queuePromptAction("sp-1", "hello", actor()),
		]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect(lost.reason).toBeInstanceOf(ControlBusyError);
		const actions = await actionsFor("sp-1");
		expect(actions).toHaveLength(1);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "sp-1"));
		expect(managed?.activeControlActionId).toBe(actions[0]?.id as string);
	});

	test("a stop on a session that already has an action running is ControlBusyError and leaves nothing", async () => {
		const { queuePromptAction, queueStopAction, ControlBusyError } = await import(
			"../control-actions.js"
		);
		await seedSession("sp-2");
		await seedManaged("sp-2");
		await queuePromptAction("sp-2", "first", actor());

		await expect(queueStopAction("sp-2", actor())).rejects.toBeInstanceOf(ControlBusyError);
		expect(await actionsFor("sp-2")).toHaveLength(1);
	});
});

describe("moving a delivery to a new attempt", () => {
	test("works only while the delivery still follows the action the caller saw", async () => {
		await seedSession("m-1");
		await getDb().insert(aiHitlDeliveries).values({
			id: "dlv-1",
			proposalId: "prop-1",
			hitlId: "h-1",
			sessionId: "m-1",
			controlActionId: "action-A",
			createdAt: "x",
			updatedAt: "x",
		});
		const move = (from: string, to: string, attempt: number) =>
			moveDeliveryToAction(getDb(), {
				deliveryId: "dlv-1",
				fromActionId: from,
				toActionId: to,
				attempt,
			});

		expect(await move("action-A", "action-B", 2)).toBe(true);
		// a second caller that also saw action-A finds it already moved
		expect(await move("action-A", "action-C", 2)).toBe(false);
		const [row] = await deliveries();
		expect(row).toMatchObject({ controlActionId: "action-B", attempt: 2 });
	});
});

describe("the entry points all go through the service", () => {
	const authedRoute = (path: string, body: unknown, key: string) =>
		app.request(`/api/v1${path}`, jsonRequest("POST", body, bearerHeaders(key)));

	test("the proposal route queues the prompt and answers with the delivery", async () => {
		await seedSession("e-1");
		await seedManaged("e-1");
		const { proposalId } = await seedHitl("e-1");
		const key = (await seedKey("e-manage", ["manage"])).key;

		const res = await authedRoute(
			`/ai/proposals/${proposalId}/decision`,
			{ action: "approve" },
			key,
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			dispatched: boolean;
			delivery: { state: string; deliveryId: string };
		};
		expect(body).toMatchObject({ ok: true, dispatched: true, delivery: { state: "queued" } });
		expect(await actionsFor("e-1")).toHaveLength(1);
	});

	test("the inbox decide route queues the prompt too", async () => {
		await seedSession("e-2");
		await seedManaged("e-2");
		const { hitlId } = await seedHitl("e-2");
		const key = (await seedKey("e-manage", ["manage"])).key;

		const res = await authedRoute(`/ai/inbox/hitl/${hitlId}/decide`, { action: "approve" }, key);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			hitl: { id: string; status: string };
			delivery: { state: string };
		};
		expect(body.hitl).toMatchObject({ id: hitlId, status: "applied" });
		expect(body.delivery.state).toBe("queued");
		expect(await actionsFor("e-2")).toHaveLength(1);
	});

	test("batch decline by hitlIds and by sessionIds only declines, and answers {closed}", async () => {
		await seedSession("e-3");
		await seedSession("e-4");
		await seedManaged("e-3");
		const a = await seedHitl("e-3");
		await seedHitl("e-4");
		const key = (await seedKey("e-manage", ["manage"])).key;

		const byId = await authedRoute("/ai/inbox/batch-decline", { hitlIds: [a.hitlId] }, key);
		expect(await byId.json()).toEqual({ closed: 1 });
		expect(await hitlStatus(a.hitlId)).toBe("declined");

		const bySession = await authedRoute("/ai/inbox/batch-decline", { sessionIds: ["e-4"] }, key);
		expect(await bySession.json()).toEqual({ closed: 1 });

		expect(await actionsFor("e-3")).toHaveLength(0);
		expect(await deliveries()).toHaveLength(0);
	});

	test("batch decline is all or none for the owner check", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("b-alice");
		const bob = await seedLocalUser("b-bob");
		await seedSession("mine", alice.id);
		await seedSession("bobs", bob.id);
		const mine = await seedHitl("mine");
		const bobs = await seedHitl("bobs");
		const key = (await seedKey("b-respond", ["manage"], alice.id)).key;

		const res = await authedRoute(
			"/ai/inbox/batch-decline",
			{ hitlIds: [mine.hitlId, bobs.hitlId] },
			key,
		);

		expect(res.status).toBe(403);
		expect(await hitlStatus(mine.hitlId)).toBe("awaiting_reply");
		expect(await hitlStatus(bobs.hitlId)).toBe("awaiting_reply");
	});

	/** Gives a request the channel the chat taps belong to; without one no chat may answer it. */
	const bindToChat = (hitlId: string) =>
		getDb()
			.update(aiHitlRequests)
			.set({ channelId: "tg-chan" })
			.where(eq(aiHitlRequests.id, hitlId));
	const tap = async (
		hitlId: string,
		action: "approve" | "decline",
		chatId = 555,
		channelOf: (chat: string) => { id: string } | null = () => ({ id: "tg-chan" }),
	) => {
		const answers: string[] = [];
		const spy = spyOn(telegram, "answerCallbackQuery").mockImplementation(async (_id, text) => {
			answers.push(text ?? "");
		});
		const channels = await import("../channels/channels-service.js");
		const finder = spyOn(channels, "findActiveChannelByChatId").mockImplementation((async (
			chat: string,
		) => channelOf(chat)) as never);
		try {
			await handleTelegramUpdate({
				update_id: 1,
				callback_query: {
					id: "cb-1",
					from: { id: 555 },
					data: `hitl:${hitlId}:${action}`,
					message: { chat: { id: chatId } },
				},
			} as never);
		} finally {
			spy.mockRestore();
			finder.mockRestore();
		}
		return answers;
	};

	test("Telegram approve leaves the request open, says so, queues nothing and writes no event", async () => {
		await seedSession("e-5");
		await seedManaged("e-5");
		const { hitlId } = await seedHitl("e-5");
		await bindToChat(hitlId);

		const answers = await tap(hitlId, "approve");

		expect(answers).toEqual([
			"Approving from Telegram isn't supported any more. Open AgentPulse to answer.",
		]);
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("e-5")).toHaveLength(0);
		expect(await deliveries()).toHaveLength(0);
		expect(await eventCategories("e-5")).toEqual([]);
	});

	test("a request with no channel can't be answered from any chat: Not authorized, nothing changes", async () => {
		await seedSession("e-5c");
		const { hitlId } = await seedHitl("e-5c");
		for (const action of ["approve", "decline"] as const) {
			expect(await tap(hitlId, action)).toEqual(["Not authorized."]);
		}
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await eventCategories("e-5c")).toEqual([]);
	});

	test("Telegram decline closes the request audit-only with the Telegram user recorded, and never writes ai_continue_sent", async () => {
		await seedSession("e-5b");
		await seedManaged("e-5b");
		const { hitlId } = await seedHitl("e-5b");
		await bindToChat(hitlId);

		const answers = await tap(hitlId, "decline");

		expect(answers).toEqual(["Declined ✗"]);
		expect(await hitlStatus(hitlId)).toBe("declined");
		expect(await actionsFor("e-5b")).toHaveLength(0);
		expect(await eventCategories("e-5b")).toEqual(["ai_hitl_response"]);
		const [event] = await getDb().select().from(events).where(eq(events.sessionId, "e-5b"));
		expect(JSON.stringify(event?.rawPayload)).toContain("telegram:555");
		const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId));
		expect(row?.replyText).toBeNull();
	});

	test("team mode: a chat bound to the request's channel may decline another member's session; a chat from another channel may not", async () => {
		await setStoredMode("team");
		const bob = await seedLocalUser("tg-bob");
		await seedSession("bobs", bob.id);
		const { hitlId } = await seedHitl("bobs");
		// Pin today's rule: the chat is the credential, and it is checked against the request's channel only.
		await getDb()
			.update(aiHitlRequests)
			.set({ channelId: "chan-1" })
			.where(eq(aiHitlRequests.id, hitlId));
		const channelOf = (chat: string) =>
			chat === "555" ? { id: "chan-1" } : chat === "777" ? { id: "chan-2" } : null;
		expect(await tap(hitlId, "decline", 777, channelOf)).toEqual(["Not authorized."]);
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await tap(hitlId, "decline", 555, channelOf)).toEqual(["Declined ✗"]);
		expect(await hitlStatus(hitlId)).toBe("declined");
	});

	test("Telegram never forwards, whatever the action: custom is refused too, and a telegram actor smuggled into another context is still Telegram", async () => {
		await seedSession("e-6");
		await seedManaged("e-6");
		const { hitlId } = await seedHitl("e-6");

		const out = await decideHitl(
			{ kind: "hitl", hitlId },
			"custom",
			{ customPrompt: "run this instead" },
			TELEGRAM_DECISION_CONTEXT,
		);
		expect(!out.ok && out.refusal.code).toBe("telegram_approve_unsupported");
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("e-6")).toHaveLength(0);

		await seedSession("e-7");
		await seedManaged("e-7");
		const other = await seedHitl("e-7");
		const sneaky = { ...manageCtx(), actor: { userId: null, label: "telegram" as const } };
		const refused = await decideHitl({ kind: "hitl", hitlId: other.hitlId }, "approve", {}, sneaky);
		expect(!refused.ok && refused.refusal.code).toBe("telegram_approve_unsupported");
		expect(await actionsFor("e-7")).toHaveLength(0);
	});

	test("the Telegram context is frozen: it can't be widened by a caller", () => {
		expect(Object.isFrozen(TELEGRAM_DECISION_CONTEXT)).toBe(true);
		expect(Object.isFrozen(TELEGRAM_DECISION_CONTEXT.actor)).toBe(true);
		expect(Object.isFrozen(TELEGRAM_DECISION_CONTEXT.scopes)).toBe(true);
		expect(() => {
			(TELEGRAM_DECISION_CONTEXT as { canCustomPrompt: boolean }).canCustomPrompt = true;
		}).toThrow();
	});

	test("a respond key may approve and decline through the proposal route, never custom", async () => {
		await seedSession("e-8");
		await seedManaged("e-8");
		const approved = await seedHitl("e-8");
		await seedSession("e-9");
		const custom = await seedHitl("e-9");
		const key = (await seedKey("e-respond", ["respond"])).key;

		const customRes = await authedRoute(
			`/ai/proposals/${custom.proposalId}/decision`,
			{ action: "custom", customPrompt: "x" },
			key,
		);
		expect(customRes.status).toBe(403);
		expect(await customRes.json()).toEqual({ error: "insufficient_scope", required: "manage" });

		const bare = await authedRoute(
			`/ai/proposals/${approved.proposalId}/decision`,
			{ action: "approve" },
			key,
		);
		expect(bare.status).toBe(400);
		expect(await bare.json()).toMatchObject({ error: "prompt_hash_required" });
		expect(await hitlStatus(approved.hitlId)).toBe("awaiting_reply");

		const approveRes = await authedRoute(
			`/ai/proposals/${approved.proposalId}/decision`,
			{ action: "approve", promptHash: hashPrompt(PROMPT) },
			key,
		);
		expect(approveRes.status).toBe(200);
		expect(await hitlStatus(approved.hitlId)).toBe("applied");
	});

	test("a respond key is refused the inbox decide route (manage-only), which is why phones decide through the proposal route", async () => {
		await seedSession("e-10");
		const { hitlId } = await seedHitl("e-10");
		const key = (await seedKey("e-respond", ["respond"])).key;

		const res = await authedRoute(`/ai/inbox/hitl/${hitlId}/decide`, { action: "decline" }, key);

		expect(res.status).toBe(403);
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});

	test("a signed-in person (cookie) may send custom text", async () => {
		await seedSession("e-11");
		const { proposalId } = await seedHitl("e-11");
		const user = await seedLocalUser("e-person", "admin");
		const cookie = await cookieHeadersFor(user.id);

		const res = await app.request(
			`/api/v1/ai/proposals/${proposalId}/decision`,
			jsonRequest("POST", { action: "custom", customPrompt: "do it differently" }, cookie),
		);

		expect(res.status).toBe(200);
	});

	test("a malformed hash is 400 before anything else happens", async () => {
		await seedSession("e-12");
		const { proposalId, hitlId } = await seedHitl("e-12");
		const key = (await seedKey("e-manage", ["manage"])).key;

		const res = await authedRoute(
			`/ai/proposals/${proposalId}/decision`,
			{ action: "approve", promptHash: "not-a-hash" },
			key,
		);

		expect(res.status).toBe(400);
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});
});

describe("batch decline closes by session without answering", () => {
	test("sessionIds supersede the open request and leave no delivery", async () => {
		await seedSession("d-1");
		const { hitlId } = await seedHitl("d-1");

		const out = await declineAll({ hitlIds: [], sessionIds: ["d-1"], ctx: manageCtx() });

		expect(out).toEqual({ ok: true, closed: 1 });
		expect(await hitlStatus(hitlId)).toBe("superseded");
		expect(await deliveries()).toHaveLength(0);
	});
});

describe("delivery", () => {
	const authedGet = (path: string, key: string) =>
		app.request(`/api/v1${path}`, { headers: bearerHeaders(key) });

	async function approvedAndQueued(sessionId: string) {
		await seedSession(sessionId);
		await seedManaged(sessionId);
		const hitl = await seedHitl(sessionId);
		const out = await decideHitl(
			{ kind: "proposal", proposalId: hitl.proposalId },
			"approve",
			{},
			manageCtx(),
		);
		expect(out.ok).toBe(true);
		return hitl;
	}

	test("follows the control action through queued, running and succeeded, and never carries the prompt", async () => {
		const { proposalId } = await approvedAndQueued("v-1");
		const key = (await seedKey("v-respond", ["respond"])).key;
		const read = async () => {
			const res = await authedGet(`/ai/proposals/${proposalId}/delivery`, key);
			expect(res.status).toBe(200);
			return (await res.json()) as Record<string, unknown>;
		};

		expect((await read()).state).toBe("queued");

		const claimed = await claimNextControlAction(SUPERVISOR);
		expect(claimed?.status).toBe("running");
		const running = await read();
		expect(running.state).toBe("running");

		await updateControlAction({
			actionId: claimed?.id as string,
			supervisorId: SUPERVISOR,
			status: "succeeded",
		});
		const done = await read();
		expect(done.state).toBe("succeeded");
		expect(Object.keys(done).sort()).toEqual(["state", "updatedAt"]);
		expect(JSON.stringify(done)).not.toContain(PROMPT);
	});

	test("a failure the supervisor reports reads as failed", async () => {
		const { proposalId } = await approvedAndQueued("v-2");
		const claimed = await claimNextControlAction(SUPERVISOR);
		await updateControlAction({
			actionId: claimed?.id as string,
			supervisorId: SUPERVISOR,
			status: "failed",
			error: "boom",
		});

		const state = await getDeliveryState(proposalId, manageCtx());

		expect(state.ok && state.delivery.state).toBe("failed");
	});

	test("an action that ran out its lock reads as unknown (it may have run) without anyone else noticing first", async () => {
		const { proposalId } = await approvedAndQueued("v-3");
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });

		const state = await getDeliveryState(proposalId, manageCtx());

		expect(state.ok && state.delivery.state).toBe("unknown");
	});

	test("not_managed and blocked are read back from the recorded terminal state", async () => {
		await seedSession("v-4");
		const plain = await seedHitl("v-4");
		await decideHitl(
			{ kind: "proposal", proposalId: plain.proposalId },
			"approve",
			{},
			manageCtx(),
		);

		const state = await getDeliveryState(plain.proposalId, manageCtx());

		expect(state.ok && state.delivery.state).toBe("not_managed");
	});

	test("team mode: another member's delivery is 403 and a declined proposal has none (404)", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("v-alice");
		const bob = await seedLocalUser("v-bob");
		await seedSession("bobs", bob.id);
		await seedManaged("bobs");
		const hitl = await seedHitl("bobs");
		await decideHitl(
			{ kind: "proposal", proposalId: hitl.proposalId },
			"approve",
			{},
			manageCtx({ userId: bob.id, role: "member", mode: "team" }),
		);
		const aliceKey = (await seedKey("v-alice-key", ["respond"], alice.id)).key;

		const res = await authedGet(`/ai/proposals/${hitl.proposalId}/delivery`, aliceKey);
		expect(res.status).toBe(403);

		const missing = await authedGet("/ai/proposals/no-such-proposal/delivery", aliceKey);
		expect(missing.status).toBe(404);
	});

	describe("retry", () => {
		async function failedByTimeout(sessionId: string) {
			const hitl = await approvedAndQueued(sessionId);
			await getDb()
				.update(managedSessions)
				.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
			return hitl;
		}

		test("is allowed only from failed: a queued delivery is 409 not_failed", async () => {
			const { proposalId } = await approvedAndQueued("t-1");

			const out = await retryDelivery(proposalId, manageCtx());

			expect(!out.ok && out.refusal).toMatchObject({ code: "not_failed", status: 409 });
		});

		test("after a timeout a retry queues the same prompt as a new attempt and the delivery follows it", async () => {
			const { proposalId } = await failedByTimeout("t-2");

			const out = await retryDelivery(proposalId, manageCtx(), { confirm: true });

			expect(out.ok && out.state).toBe("queued");
			const [delivery] = await deliveries();
			expect(delivery?.attempt).toBe(2);
			const actions = await actionsFor("t-2");
			expect(actions).toHaveLength(2);
			const newer = actions.find((a) => a.id === delivery?.controlActionId);
			expect(newer?.status).toBe("queued");
			expect((newer?.metadata as { prompt?: string }).prompt).toBe(PROMPT);
			const state = await getDeliveryState(proposalId, manageCtx());
			expect(state.ok && state.delivery.state).toBe("queued");
		});

		test("a timed-out attempt needs confirm: without it nothing is queued and the answer says why", async () => {
			const { proposalId } = await failedByTimeout("t-2b");

			const out = await retryDelivery(proposalId, manageCtx());

			expect(!out.ok && out.refusal).toMatchObject({ code: "confirm_required", status: 409 });
			expect(await actionsFor("t-2b")).toHaveLength(1);
			expect((await deliveries())[0]?.attempt).toBe(1);
		});

		test("an attempt the supervisor reported as failed retries without confirm", async () => {
			const { proposalId } = await approvedAndQueued("t-2c");
			const claimed = await claimNextControlAction(SUPERVISOR);
			await updateControlAction({
				actionId: claimed?.id as string,
				supervisorId: SUPERVISOR,
				status: "failed",
				error: "boom",
			});

			const out = await retryDelivery(proposalId, manageCtx());

			expect(out.ok && out.state).toBe("queued");
		});

		test("an attempt that finished after its lock ran out stays succeeded: expiry doesn't turn it into a failure", async () => {
			const { proposalId } = await approvedAndQueued("t-2d");
			const claimed = await claimNextControlAction(SUPERVISOR);
			await updateControlAction({
				actionId: claimed?.id as string,
				supervisorId: SUPERVISOR,
				status: "succeeded",
			});
			// The lock is gone with the completion; put a stale one back as a racing expiry would have seen it.
			await getDb()
				.update(managedSessions)
				.set({
					activeControlActionId: claimed?.id as string,
					controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString(),
				});

			const state = await getDeliveryState(proposalId, manageCtx());

			expect(state.ok && state.delivery.state).toBe("succeeded");
			const [action] = await getDb()
				.select()
				.from(controlActions)
				.where(eq(controlActions.id, claimed?.id as string));
			expect(action?.status).toBe("succeeded");
		});

		test("a retry whose recorded prompt was tampered with is not_retryable", async () => {
			const { proposalId } = await failedByTimeout("t-2e");
			const [action] = await actionsFor("t-2e");
			await getDb()
				.update(controlActions)
				.set({ metadata: { ...(action?.metadata as object), prompt: "something else entirely" } })
				.where(eq(controlActions.id, action?.id as string));

			const out = await retryDelivery(proposalId, manageCtx(), { confirm: true });

			expect(!out.ok && out.refusal.code).toBe("not_retryable");
			expect(await actionsFor("t-2e")).toHaveLength(1);
		});

		test("two concurrent retries: exactly one wins, the other is 409, one new action exists", async () => {
			const { proposalId } = await failedByTimeout("t-3");

			const results = await Promise.all([
				retryDelivery(proposalId, manageCtx(), { confirm: true }),
				retryDelivery(proposalId, manageCtx(), { confirm: true }),
			]);

			expect(results.filter((r) => r.ok)).toHaveLength(1);
			const lost = results.find((r) => !r.ok);
			expect(!lost?.ok && lost?.refusal.status).toBe(409);
			expect(await actionsFor("t-3")).toHaveLength(2);
			expect((await deliveries())[0]?.attempt).toBe(2);
		}, 30_000);

		test("a timed-out attempt that finishes late can't clear the retry's lock, and the delivery follows the retry", async () => {
			await approvedAndQueued("t-4");
			const proposalId = (await deliveries())[0]?.proposalId as string;
			const claimed = await claimNextControlAction(SUPERVISOR); // attempt A is running
			await getDb()
				.update(managedSessions)
				.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
			const retried = await retryDelivery(proposalId, manageCtx(), { confirm: true }); // A times out; B is queued
			expect(retried.ok).toBe(true);
			const [afterRetry] = await deliveries();
			expect(afterRetry?.controlActionId).not.toBe(claimed?.id);

			// A reports success, late.
			await updateControlAction({
				actionId: claimed?.id as string,
				supervisorId: SUPERVISOR,
				status: "succeeded",
			});

			const [managed] = await getDb()
				.select()
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, "t-4"));
			expect(managed?.activeControlActionId).toBe(afterRetry?.controlActionId);
			const state = await getDeliveryState(proposalId, manageCtx());
			expect(state.ok && state.delivery.state).toBe("queued");
		});

		test("team mode: another member can't retry, and a respond key can retry its own", async () => {
			await setStoredMode("team");
			const alice = await seedLocalUser("t-alice");
			const bob = await seedLocalUser("t-bob");
			await seedSession("alices", alice.id);
			await seedManaged("alices");
			const hitl = await seedHitl("alices");
			await decideHitl(
				{ kind: "proposal", proposalId: hitl.proposalId },
				"approve",
				{},
				manageCtx({ userId: alice.id, role: "member", mode: "team" }),
			);
			await getDb()
				.update(managedSessions)
				.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });

			const bobTries = await retryDelivery(
				hitl.proposalId,
				respondCtx({ userId: bob.id, mode: "team" }),
			);
			expect(!bobTries.ok && bobTries.refusal.code).toBe("not_owner");

			const aliceKey = (await seedKey("t-alice-key", ["respond"], alice.id)).key;
			const unconfirmed = await app.request(
				`/api/v1/ai/proposals/${hitl.proposalId}/delivery/retry`,
				jsonRequest("POST", {}, bearerHeaders(aliceKey)),
			);
			expect(unconfirmed.status).toBe(409);
			expect(await unconfirmed.json()).toMatchObject({ error: "confirm_required" });
			const res = await app.request(
				`/api/v1/ai/proposals/${hitl.proposalId}/delivery/retry`,
				jsonRequest("POST", { confirm: true }, bearerHeaders(aliceKey)),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ state: "queued" });
		});
	});
});

describe("the prompt hash against a known oracle", () => {
	const fixture = JSON.parse(
		readFileSync(join(import.meta.dir, "__fixtures__", "prompt-hash-vectors.json"), "utf8"),
	) as { vectors: Array<{ name: string; text: string; sha256: string }> };

	test("hashPrompt matches shasum -a 256 for every vector", () => {
		expect(fixture.vectors).toHaveLength(5);
		for (const v of fixture.vectors) {
			expect({ name: v.name, hash: hashPrompt(v.text) }).toEqual({ name: v.name, hash: v.sha256 });
		}
	});

	test("NFC and NFD spellings of the same word hash differently: no Unicode normalization is applied", () => {
		const nfc = fixture.vectors.find((v) => v.name === "café, NFC");
		const nfd = fixture.vectors.find((v) => v.name === "café, NFD");
		expect(nfc?.text).not.toBe(nfd?.text);
		expect(nfc?.text.normalize("NFC")).toBe(nfd?.text.normalize("NFC"));
		expect(hashPrompt(nfc?.text as string)).not.toBe(hashPrompt(nfd?.text as string));
	});

	test("approve with the literal hash of the stored prompt is 200; one character off is 409 prompt_changed", async () => {
		const literal = "4d43c48e2ed117498f546bbc902aec050ce7142aa40ea3546bbcafd3cc6ed2c6";
		await seedSession("o-1");
		const { proposalId, hitlId } = await seedHitl("o-1", PROMPT);
		const off = `${literal.slice(0, -1)}${literal.endsWith("6") ? "7" : "6"}`;

		const wrong = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: off },
			manageCtx(),
		);
		expect(!wrong.ok && wrong.refusal).toMatchObject({ code: "prompt_changed", status: 409 });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");

		const right = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: literal },
			manageCtx(),
		);
		expect(right.ok).toBe(true);
	});

	test("a prompt with spaces and a newline around it is stored trimmed, so the hash of the trimmed text is the one that works", async () => {
		await seedSession("o-2");
		const { proposalId } = await seedHitl("o-2", `  ${PROMPT}\n`);
		const stored = await getProposalRow(proposalId);
		expect(stored?.nextPrompt).toBe(PROMPT);
		expect(stored?.promptHash).toBe(
			"4d43c48e2ed117498f546bbc902aec050ce7142aa40ea3546bbcafd3cc6ed2c6",
		);

		const untrimmed = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt(`  ${PROMPT}\n`) },
			manageCtx(),
		);
		expect(!untrimmed.ok && untrimmed.refusal.code).toBe("prompt_changed");
		const trimmed = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt(PROMPT) },
			manageCtx(),
		);
		expect(trimmed.ok).toBe(true);
	});

	test("a legacy proposal stored with untrimmed text is still sent, hashed and shown trimmed", async () => {
		await seedSession("o-3");
		const { proposalId } = await seedHitl("o-3", PROMPT);
		await getDb()
			.update(watcherProposals)
			.set({ nextPrompt: `  ${PROMPT}  ` })
			.where(eq(watcherProposals.id, proposalId));
		expect((await getProposalRow(proposalId))?.promptHash).toBe(hashPrompt(PROMPT));
		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: hashPrompt(PROMPT) },
			manageCtx(),
		);
		expect(out.ok && out.prompt).toBe(PROMPT);
	});

	test("custom ignores the hash entirely", async () => {
		await seedSession("o-4");
		const { proposalId } = await seedHitl("o-4");
		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"custom",
			{ customPrompt: "do this instead", promptHash: hashPrompt("nothing like it") },
			manageCtx(),
		);
		expect(out.ok).toBe(true);
	});

	test("the hash the runner pushes for a new request is accepted by decide", async () => {
		const { hitlOpenedEvent } = await import("./runner.js");
		await seedSession("o-5");
		const { proposalId, hitlId } = await seedHitl("o-5", `  ${PROMPT}\n`);
		const event = hitlOpenedEvent("o-5", hitlId, proposalId, `  ${PROMPT}\n`);
		expect(event.promptHash).toBe(hashPrompt(PROMPT));
		expect(hitlOpenedEvent("o-5", hitlId, proposalId, null)).not.toHaveProperty("promptHash");

		const out = await decideHitl(
			{ kind: "proposal", proposalId },
			"approve",
			{ promptHash: event.promptHash },
			respondCtx(),
		);
		expect(out.ok).toBe(true);
	});
});

describe("a key without manage must carry the hash to approve", () => {
	test("approve without promptHash is 400 prompt_hash_required for a respond key, and nothing is written", async () => {
		await seedSession("k-1");
		await seedManaged("k-1");
		const { proposalId, hitlId } = await seedHitl("k-1");

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, respondCtx());

		expect(!out.ok && out.refusal).toMatchObject({ code: "prompt_hash_required", status: 400 });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		expect(await deliveries()).toHaveLength(0);
		expect(await actionsFor("k-1")).toHaveLength(0);
	});

	test("manage keys and signed-in people may omit it; a respond key may decline without it", async () => {
		await seedSession("k-2");
		const first = await seedHitl("k-2");
		expect(
			(await decideHitl({ kind: "hitl", hitlId: first.hitlId }, "approve", {}, manageCtx())).ok,
		).toBe(true);

		await seedSession("k-3");
		const second = await seedHitl("k-3");
		const person = { ...manageCtx(), source: "session" as const, keyId: null, scopes: [] };
		expect(
			(await decideHitl({ kind: "hitl", hitlId: second.hitlId }, "approve", {}, person)).ok,
		).toBe(true);

		await seedSession("k-4");
		const third = await seedHitl("k-4");
		expect(
			(await decideHitl({ kind: "hitl", hitlId: third.hitlId }, "decline", {}, respondCtx())).ok,
		).toBe(true);
	});

	test("a request with no prompt is not approvable: the proposal says so and Approve is 400 empty_prompt, not a hash demand", async () => {
		await seedSession("k-5");
		const { proposalId } = await seedHitl("k-5", null);
		const row = await getProposalRow(proposalId);
		expect(row).toMatchObject({ approvable: false, promptHash: null });

		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, respondCtx());

		expect(!out.ok && out.refusal.code).toBe("empty_prompt");
	});
});

describe("what the routes refuse before anything else", () => {
	const post = (path: string, body: unknown, key: string) =>
		app.request(`/api/v1${path}`, jsonRequest("POST", body, bearerHeaders(key)));
	const BODIES: Array<[string, unknown, string]> = [
		["an unknown action", { action: "nuke" }, "invalid_action"],
		["an empty body", {}, "invalid_action"],
		["the wrong field", { decision: "approve" }, "invalid_action"],
		[
			"a hash in capitals",
			{ action: "approve", promptHash: "A".repeat(64) },
			"invalid_prompt_hash",
		],
		["a hash one short", { action: "approve", promptHash: "a".repeat(63) }, "invalid_prompt_hash"],
		["a hash one long", { action: "approve", promptHash: "a".repeat(65) }, "invalid_prompt_hash"],
	];

	for (const [name, body, code] of BODIES) {
		test(`${name}: 400 ${code} on both decide routes, and the request stays open`, async () => {
			await seedSession("x-1");
			const { proposalId, hitlId } = await seedHitl("x-1");
			const key = (await seedKey("x-manage", ["manage"])).key;

			for (const path of [
				`/ai/proposals/${proposalId}/decision`,
				`/ai/inbox/hitl/${hitlId}/decide`,
			]) {
				const res = await post(path, body, key);
				expect({ path, status: res.status }).toEqual({ path, status: 400 });
				expect(await res.json()).toMatchObject({ error: code });
			}
			expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
		});
	}

	test("batch decline: 200 ids in each list is fine, 201 is 400, and non-arrays and non-strings are 400", async () => {
		const key = (await seedKey("x-manage", ["manage"])).key;
		const ids = (n: number) => Array.from({ length: n }, (_, i) => `no-such-${i}`);
		for (const field of ["hitlIds", "sessionIds"] as const) {
			const ok = await post("/ai/inbox/batch-decline", { [field]: ids(200) }, key);
			expect({ field, status: ok.status }).toEqual({ field, status: 200 });
			expect(await ok.json()).toEqual({ closed: 0 });
			for (const bad of [ids(201), [1], "x", { a: 1 }, [null]]) {
				const res = await post("/ai/inbox/batch-decline", { [field]: bad }, key);
				expect({ field, bad: JSON.stringify(bad).slice(0, 20), status: res.status }).toEqual({
					field,
					bad: JSON.stringify(bad).slice(0, 20),
					status: 400,
				});
				expect(await res.json()).toMatchObject({ error: "invalid_ids" });
			}
		}
	});

	test("a second inbox decide on the same request is 409 already_resolved and the first answer stands", async () => {
		await seedSession("x-2");
		const { hitlId } = await seedHitl("x-2");
		const key = (await seedKey("x-manage", ["manage"])).key;

		const first = await post(`/ai/inbox/hitl/${hitlId}/decide`, { action: "decline" }, key);
		const second = await post(`/ai/inbox/hitl/${hitlId}/decide`, { action: "approve" }, key);

		expect(first.status).toBe(200);
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ error: "already_resolved" });
		expect(await hitlStatus(hitlId)).toBe("declined");
	});

	test("a custom prompt of only spaces is 400 empty_prompt", async () => {
		await seedSession("x-3");
		const { proposalId, hitlId } = await seedHitl("x-3");
		const key = (await seedKey("x-manage", ["manage"])).key;

		const res = await post(
			`/ai/proposals/${proposalId}/decision`,
			{ action: "custom", customPrompt: "   " },
			key,
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "empty_prompt" });
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});

	test("unknown ids answer not_found codes with a sentence in message", async () => {
		const key = (await seedKey("x-manage", ["manage"])).key;
		const proposal = await post("/ai/proposals/nope/decision", { action: "decline" }, key);
		expect(proposal.status).toBe(404);
		expect(await proposal.json()).toEqual({ error: "not_found", message: "Proposal not found" });
		const hitl = await post("/ai/inbox/hitl/nope/decide", { action: "decline" }, key);
		expect(await hitl.json()).toEqual({ error: "not_found", message: "hitl not found" });
	});

	test("reply_text keeps the prompt for approve and custom, and stays empty for a decline and for Telegram", async () => {
		const replyOf = async (hitlId: string) =>
			(await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId)))[0]
				?.replyText;
		await seedSession("x-4");
		const a = await seedHitl("x-4");
		await decideHitl({ kind: "hitl", hitlId: a.hitlId }, "approve", {}, manageCtx());
		expect(await replyOf(a.hitlId)).toBe(PROMPT);

		await seedSession("x-5");
		const b = await seedHitl("x-5");
		await decideHitl(
			{ kind: "hitl", hitlId: b.hitlId },
			"custom",
			{ customPrompt: " use staging " },
			manageCtx(),
		);
		expect(await replyOf(b.hitlId)).toBe("use staging");

		await seedSession("x-6");
		const c = await seedHitl("x-6");
		await decideHitl({ kind: "hitl", hitlId: c.hitlId }, "decline", {}, manageCtx());
		expect(await replyOf(c.hitlId)).toBeNull();

		await seedSession("x-7");
		const d = await seedHitl("x-7");
		await decideHitl({ kind: "hitl", hitlId: d.hitlId }, "decline", {}, TELEGRAM_DECISION_CONTEXT);
		expect(await replyOf(d.hitlId)).toBeNull();
	});
});

describe("a request past its expiry", () => {
	test("can't be answered: 409 expired, from either target, and nothing is written", async () => {
		await seedSession("ex-1");
		const { proposalId, hitlId } = await seedHitl("ex-1");
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, hitlId));

		for (const target of [
			{ kind: "proposal", proposalId },
			{ kind: "hitl", hitlId },
		] as const) {
			const out = await decideHitl(target, "decline", {}, manageCtx());
			expect(!out.ok && out.refusal).toMatchObject({ code: "expired", status: 409 });
		}
		expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
	});

	test("a stranger is told nothing about the expiry either", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("ex-alice");
		const bob = await seedLocalUser("ex-bob");
		await seedSession("bobs", bob.id);
		const { hitlId } = await seedHitl("bobs");
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, hitlId));
		const out = await decideHitl(
			{ kind: "hitl", hitlId },
			"decline",
			{},
			respondCtx({ userId: alice.id, mode: "team" }),
		);
		expect(!out.ok && out.refusal.code).toBe("not_owner");
	});
});

describe("a request past its expiry", () => {
	const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
	const setTimes = (hitlId: string, expiresAt: string | null, createdAt?: string) =>
		getDb()
			.update(aiHitlRequests)
			.set({ expiresAt, ...(createdAt ? { createdAt } : {}) })
			.where(eq(aiHitlRequests.id, hitlId));
	const DAY = 24 * 60 * 60 * 1000;

	test("the moment before expiry it can still be answered; the moment after, 409 expired (approve included)", async () => {
		await seedSession("ex-b1");
		await seedManaged("ex-b1");
		const first = await seedHitl("ex-b1");
		await setTimes(first.hitlId, new Date(Date.now() + 30_000).toISOString());
		const ok = await decideHitl(
			{ kind: "proposal", proposalId: first.proposalId },
			"approve",
			{},
			manageCtx(),
		);
		expect(ok.ok).toBe(true);

		await seedSession("ex-b2");
		await seedManaged("ex-b2");
		const second = await seedHitl("ex-b2");
		await setTimes(second.hitlId, ago(1));
		const late = await decideHitl(
			{ kind: "proposal", proposalId: second.proposalId },
			"approve",
			{},
			manageCtx(),
		);
		expect(!late.ok && late.refusal).toMatchObject({ code: "expired", status: 409 });
		expect(await hitlStatus(second.hitlId)).toBe("awaiting_reply");
		expect(await actionsFor("ex-b2")).toHaveLength(0);
	});

	test("a request opened before expiry existed (no expiresAt) is answerable for a day after it was created, and not after", async () => {
		await seedSession("ex-l1");
		const young = await seedHitl("ex-l1");
		await setTimes(young.hitlId, null, ago(DAY - 60_000));
		expect(
			(await decideHitl({ kind: "hitl", hitlId: young.hitlId }, "decline", {}, manageCtx())).ok,
		).toBe(true);

		await seedSession("ex-l2");
		const old = await seedHitl("ex-l2");
		await setTimes(old.hitlId, null, ago(DAY + 60_000));
		const out = await decideHitl({ kind: "hitl", hitlId: old.hitlId }, "decline", {}, manageCtx());
		expect(!out.ok && out.refusal.code).toBe("expired");
	});

	test("a legacy created_at written by the database (a space, not a T) is read the same way", async () => {
		await seedSession("ex-l3");
		const { hitlId } = await seedHitl("ex-l3");
		const old = new Date(Date.now() - DAY - 3_600_000).toISOString().replace("T", " ").slice(0, 19);
		await setTimes(hitlId, null, old);
		const out = await decideHitl({ kind: "hitl", hitlId }, "decline", {}, manageCtx());
		expect(!out.ok && out.refusal.code).toBe("expired");
	});

	test("the inbox stops offering an overdue request before the sweep has closed it; the sweep closes both kinds and leaves the rest", async () => {
		const { listAllOpenHitl, expireOverdueHitl } = await import("./hitl-service.js");
		const ids: Record<string, string> = {};
		for (const [name, expiresAt, created] of [
			["explicit-past", ago(1_000), undefined],
			["explicit-future", new Date(Date.now() + 60_000).toISOString(), undefined],
			["legacy-old", null, ago(DAY + 60_000)],
			["legacy-young", null, ago(60_000)],
		] as const) {
			await seedSession(`sw-${name}`);
			const { hitlId } = await seedHitl(`sw-${name}`);
			await setTimes(hitlId, expiresAt, created);
			ids[name] = hitlId;
		}

		const offered = (await listAllOpenHitl()).map((h) => h.id).sort();
		expect(offered).toEqual([ids["explicit-future"], ids["legacy-young"]].sort());
		expect(await expireOverdueHitl()).toBe(2);
		expect(await hitlStatus(ids["explicit-past"] as string)).toBe("timed_out");
		expect(await hitlStatus(ids["legacy-old"] as string)).toBe("timed_out");
		expect(await hitlStatus(ids["explicit-future"] as string)).toBe("awaiting_reply");
		expect(await hitlStatus(ids["legacy-young"] as string)).toBe("awaiting_reply");
	});
});

describe("retrying a delivery", () => {
	test("a delivery older than a request's lifetime is not re-sent, confirmed or not", async () => {
		await seedSession("ra-1");
		await seedManaged("ra-1");
		const { proposalId } = await seedHitl("ra-1");
		await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
		await getDb()
			.update(aiHitlDeliveries)
			.set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });

		const out = await retryDelivery(proposalId, manageCtx(), { confirm: true });

		expect(!out.ok && out.refusal.code).toBe("not_retryable");
		expect(await actionsFor("ra-1")).toHaveLength(1);
	});

	test("the service itself confirms only on the literal true, whatever a caller hands it", async () => {
		await seedSession("ra-3");
		await seedManaged("ra-3");
		const { proposalId } = await seedHitl("ra-3");
		await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
		for (const confirm of ["true", 1, {}]) {
			const out = await retryDelivery(proposalId, manageCtx(), { confirm: confirm as never });
			expect(!out.ok && out.refusal.code).toBe("confirm_required");
		}
		expect(await actionsFor("ra-3")).toHaveLength(1);
	});

	test("only the literal true confirms: the string 'true' and the number 1 are refused", async () => {
		await seedSession("ra-2");
		await seedManaged("ra-2");
		const { proposalId } = await seedHitl("ra-2");
		await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });
		const key = (await seedKey("ra-manage", ["manage"])).key;

		for (const confirm of ["true", 1, "yes", null]) {
			const res = await app.request(
				`/api/v1/ai/proposals/${proposalId}/delivery/retry`,
				jsonRequest("POST", { confirm }, bearerHeaders(key)),
			);
			expect({ confirm, status: res.status }).toEqual({ confirm, status: 409 });
			expect(await res.json()).toMatchObject({ error: "confirm_required" });
		}
		expect(await actionsFor("ra-2")).toHaveLength(1);
		const ok = await app.request(
			`/api/v1/ai/proposals/${proposalId}/delivery/retry`,
			jsonRequest("POST", { confirm: true }, bearerHeaders(key)),
		);
		expect(ok.status).toBe(200);
	});
});

describe("authentication switched off", () => {
	test("a request with no authenticated caller at all (auth off) is a person who may write prompts; with auth on it is a bare key that may not", async () => {
		const { config } = await import("../../config.js");
		const { decisionContextFor } = await import("../../routes/decision-context.js");
		const bare = { get: () => undefined } as never;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			expect(await decisionContextFor(bare)).toMatchObject({
				source: "session",
				canCustomPrompt: true,
				keyId: null,
			});
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
		expect(await decisionContextFor(bare)).toMatchObject({ canCustomPrompt: false });
	});

	test("the operator can approve without a hash and send a custom prompt (there is no key to hold back)", async () => {
		const { config } = await import("../../config.js");
		await seedSession("da-1");
		const first = await seedHitl("da-1");
		await seedSession("da-2");
		const second = await seedHitl("da-2");
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const approve = await app.request(
				`/api/v1/ai/proposals/${first.proposalId}/decision`,
				jsonRequest("POST", { action: "approve" }),
			);
			const custom = await app.request(
				`/api/v1/ai/proposals/${second.proposalId}/decision`,
				jsonRequest("POST", { action: "custom", customPrompt: "do it differently" }),
			);
			expect([approve.status, custom.status]).toEqual([200, 200]);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});
});

describe("batch decline by session", () => {
	test("writes an ai_hitl_response audit event naming the actor and the key, for every request it closes", async () => {
		await seedSession("bs-1");
		const { hitlId } = await seedHitl("bs-1");
		await declineAll({ hitlIds: [], sessionIds: ["bs-1"], ctx: manageCtx({ userId: "u-1" }) });

		expect(await hitlStatus(hitlId)).toBe("superseded");
		const [event] = await getDb().select().from(events).where(eq(events.sessionId, "bs-1"));
		expect(event?.category).toBe("ai_hitl_response");
		expect(event?.rawPayload).toMatchObject({
			action: "decline",
			actor_user_id: "u-1",
			key_id: "key-manage",
		});
	});

	test("a decline by id carries the actor and the key too", async () => {
		await seedSession("bs-2");
		const { hitlId } = await seedHitl("bs-2");
		await decideHitl({ kind: "hitl", hitlId }, "decline", {}, manageCtx({ userId: "u-2" }));
		const [event] = await getDb().select().from(events).where(eq(events.sessionId, "bs-2"));
		expect(event?.rawPayload).toMatchObject({ actor_user_id: "u-2", key_id: "key-manage" });
	});

	test("session ids with no row are skipped: nothing is closed and no event is written, in solo and for a member in team mode", async () => {
		const solo = await declineAll({
			hitlIds: [],
			sessionIds: ["no-such-session"],
			ctx: manageCtx(),
		});
		expect(solo).toEqual({ ok: true, closed: 0 });

		await setStoredMode("team");
		const alice = await seedLocalUser("bs-alice");
		const team = await declineAll({
			hitlIds: [],
			sessionIds: ["no-such-session"],
			ctx: respondCtx({ userId: alice.id, mode: "team" }),
		});
		expect(team).toEqual({ ok: true, closed: 0 });
		expect(await getDb().select().from(events)).toHaveLength(0);
	});
});

describe("delivery states and reasons", () => {
	test("a supervisor offline is blocked with reason supervisor_offline, in the decision and when read back", async () => {
		await seedSession("dr-1");
		await seedManaged("dr-1", { connected: false });
		const { proposalId } = await seedHitl("dr-1");
		const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		expect(out.ok && out.delivery).toMatchObject({
			state: "blocked",
			reason: "supervisor_offline",
		});
		const read = await getDeliveryState(proposalId, manageCtx());
		expect(read.ok && read.delivery).toMatchObject({
			state: "blocked",
			reason: "supervisor_offline",
		});
	});

	test("reading a delivery works while the watcher is paused (200), but retry still needs AI active", async () => {
		await seedSession("dr-2");
		await seedManaged("dr-2");
		const { proposalId } = await seedHitl("dr-2");
		await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());
		const key = (await seedKey("dr-manage", ["manage"])).key;
		await upsertSetting("ai.enabled", false, { allowProtected: true });

		const read = await app.request(`/api/v1/ai/proposals/${proposalId}/delivery`, {
			headers: bearerHeaders(key),
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ state: "queued" });
		const retry = await app.request(
			`/api/v1/ai/proposals/${proposalId}/delivery/retry`,
			jsonRequest("POST", {}, bearerHeaders(key)),
		);
		expect(retry.status).toBe(409);
	});
});

describeSqliteOnly(
	"a session that vanished under a decision (SQLite: Postgres cascades the managed row away first)",
	() => {
		test("SessionNotFoundError is 404 and the whole decision rolls back", async () => {
			await seedSession("sn-1");
			await seedManaged("sn-1");
			const { proposalId, hitlId } = await seedHitl("sn-1");
			const { getSqlite } = await import("../../db/client.js");
			getSqlite().exec("PRAGMA foreign_keys = OFF");
			try {
				await getDb().delete(sessions).where(eq(sessions.sessionId, "sn-1"));

				const out = await decideHitl({ kind: "proposal", proposalId }, "approve", {}, manageCtx());

				expect(!out.ok && out.refusal).toMatchObject({ code: "session_not_found", status: 404 });
				expect(await hitlStatus(hitlId)).toBe("awaiting_reply");
				expect(await deliveries()).toHaveLength(0);
				expect(await actionsFor("sn-1")).toHaveLength(0);
			} finally {
				getSqlite().exec("PRAGMA foreign_keys = ON");
			}
		});
	},
);

describe("pattern parity: no human resolution outside the decision service", () => {
	function sourceFiles(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) return sourceFiles(full);
			return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
		});
	}
	// Any mention, call or not: a reference passed around or imported is as good as a call.
	const mentions = (file: string, name: string) =>
		(readFileSync(file, "utf8").match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
	const SERVER = join(import.meta.dir, "..", "..");

	test("no route mentions resolveHitlRequest, resolveProposalHitl or supersedeOpenHitl", () => {
		const routes = sourceFiles(join(SERVER, "routes"));
		expect(routes.length).toBeGreaterThan(10);
		for (const file of routes) {
			for (const name of ["resolveHitlRequest", "resolveProposalHitl", "supersedeOpenHitl"]) {
				expect({ file, name, mentions: mentions(file, name) }).toEqual({ file, name, mentions: 0 });
			}
		}
	});

	test("the old resolvers are gone: resolveHitlRequest and resolveProposalHitl are mentioned nowhere in server source", () => {
		const users = sourceFiles(SERVER).filter((file) =>
			["resolveHitlRequest", "resolveProposalHitl"].some((name) => mentions(file, name) > 0),
		);
		expect(users.map((f) => f.slice(SERVER.length + 1))).toEqual([]);
	});

	test("supersedeOpenHitl is mentioned only by the HITL and proposal services (the watcher opening and cancelling requests)", () => {
		const users = sourceFiles(SERVER)
			.filter((file) => mentions(file, "supersedeOpenHitl") > 0)
			.map((file) => file.slice(SERVER.length + 1))
			.sort();
		expect(users).toEqual(["services/ai/hitl-service.ts", "services/ai/proposals-service.ts"]);
	});

	test("the guard is not vacuous: the scan does see a mention it should", () => {
		expect(
			mentions(join(SERVER, "services/ai/hitl-service.ts"), "supersedeOpenHitl"),
		).toBeGreaterThan(0);
	});
});

describe("the resolved record", () => {
	test("hitl decide returns the record after the answer", async () => {
		await seedSession("z-1");
		const { hitlId } = await seedHitl("z-1");
		const out = await decideHitl({ kind: "hitl", hitlId }, "decline", {}, manageCtx());
		expect(out.ok && out.hitl).toMatchObject({
			id: hitlId,
			status: "declined",
			replyKind: "decline",
		});
		await getDb()
			.select()
			.from(aiHitlRequests)
			.where(and(eq(aiHitlRequests.id, hitlId), eq(aiHitlRequests.status, "declined")));
	});
});
