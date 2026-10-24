/**
 * The send path: dispatchPrompt (the core, also used by the auto policy) and
 * resolveProposal (a person's decision on a HITL). Real database, nothing
 * stubbed but the event emit where a test needs to inject a failure.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { and, eq } from "drizzle-orm";
import "./__test_db.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import { seedLocalUser, setStoredMode } from "../../test-utils/team-fixtures.js";
import {
	clearSetting,
	enableAiRuntime,
	seedAutoConfig,
	seedEvent,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProposalWithHitl,
	seedProvider,
	seedSession,
	setSetting,
	sha256,
} from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { config } = await import("../../config.js");
const schema = await import("../../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	users,
	watcherConfigs,
	watcherProposals,
} = schema;
const aiEvents = await import("./ai-events.js");
const feature = await import("./feature.js");
const { checkDispatch } = await import("./dispatch-filter.js");
const { sanitizeOutboundPrompt } = await import("./prompt-sanitiser.js");
const resolution = await import("./proposal-resolution.js");
const { AI_ACTOR, CONTINUE_TEMPLATES, dispatchPrompt, resolveProposal } = resolution;

const originalDisableAuth = config.disableAuth;
const USER_ACTOR = { userId: null, label: "user" } as const;
const PROMPT = "Run the failing test and fix it";

let providerId = "";
let counter = 0;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await resetIdentityState();
	for (const key of [
		feature.AI_KILL_SWITCH_KEY,
		feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY,
		feature.AI_WATCHER_DEFAULTS_KEY,
	]) {
		await clearSetting(key);
	}
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

interface World {
	sessionId: string;
	promptId: number;
	stopId: number;
	turnKey: string;
	proposalId: string;
	hitlId: string;
}

/** A managed session with a finished turn and an open HITL for the suggestion `prompt`. */
async function world(
	options: {
		prompt?: string;
		managed?: boolean;
		supervisor?: "live" | "offline";
		approvable?: boolean | null;
		ownerUserId?: string;
	} = {},
): Promise<World> {
	counter += 1;
	const sessionId = `pr-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	if (options.managed === false) {
		await seedSession(sessionId, { ownerUserId: options.ownerUserId });
	} else {
		await seedLiveManagedSession(sessionId, {
			supervisor: options.supervisor,
			ownerUserId: options.ownerUserId,
		});
	}
	const turn = await seedFinishedTurn(sessionId);
	const prompt = options.prompt ?? PROMPT;
	const { proposalId, hitlId } = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
		approvable: options.approvable,
	});
	return { sessionId, ...turn, proposalId, hitlId };
}

const approve = (w: World, over: Partial<Parameters<typeof resolveProposal>[0]> = {}) =>
	resolveProposal({
		hitlId: w.hitlId,
		action: "approve",
		promptSha256: sha256(PROMPT),
		actor: USER_ACTOR,
		actorKind: "user",
		...over,
	});

async function promptActions(sessionId: string) {
	return getDb()
		.select()
		.from(controlActions)
		.where(and(eq(controlActions.sessionId, sessionId), eq(controlActions.actionType, "prompt")));
}
async function auditRows(sessionId: string) {
	return getDb().select().from(aiDispatchAudit).where(eq(aiDispatchAudit.sessionId, sessionId));
}
async function hitlStatus(id: string) {
	const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, id));
	return row?.status;
}
async function eventsOfType(sessionId: string, eventType: string) {
	return getDb()
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.eventType, eventType)));
}
async function counterOf(sessionId: string) {
	const [row] = await getDb()
		.select()
		.from(watcherConfigs)
		.where(eq(watcherConfigs.sessionId, sessionId));
	return row?.continuationsUsed;
}

describe("a person approves", () => {
	test("exactly one prompt is queued, nothing is counted, and the send is audited and put on the timeline", async () => {
		const w = await world();
		await seedAutoConfig({ sessionId: w.sessionId, providerId, continuationsUsed: 3 });
		const result = await approve(w);
		expect(result.ok).toBe(true);

		const actions = await promptActions(w.sessionId);
		expect(actions).toHaveLength(1);
		expect((actions[0]?.metadata as { prompt: string }).prompt).toBe(PROMPT);
		expect(actions[0]?.requestedBy).toBe("user");
		// A person's send never consumes the automatic-send cap.
		expect(await counterOf(w.sessionId)).toBe(3);

		const audit = await auditRows(w.sessionId);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			outcome: "sent",
			actorKind: "user",
			promptText: PROMPT,
			promptSha256: sha256(PROMPT),
			controlActionId: actions[0]?.id,
			hitlId: w.hitlId,
			proposalId: w.proposalId,
			turnKey: w.turnKey,
		});

		const sent = await eventsOfType(w.sessionId, "AiContinueSent");
		expect(sent).toHaveLength(1);
		const payload = sent[0]?.rawPayload as Record<string, unknown>;
		expect(payload).toMatchObject({
			actor_kind: "user",
			control_action_id: actions[0]?.id,
			proposal_id: w.proposalId,
			hitl_id: w.hitlId,
			audit_id: audit[0]?.id,
		});
		expect(await hitlStatus(w.hitlId)).toBe("applied");
	});

	test("S3: a secret in a custom prompt is sent as typed but stored redacted in the audit row", async () => {
		const w = await world();
		const key = `sk-ant-api03-${"A1b2C3d4E5".repeat(8)}`;
		const text = `Use ${key} to log in and run the tests`;
		const result = await approve(w, {
			action: "custom",
			customPrompt: text,
			promptSha256: undefined,
		});
		expect(result.ok).toBe(true);
		const [action] = await promptActions(w.sessionId);
		expect((action?.metadata as { prompt: string }).prompt).toBe(text);
		const [audit] = await auditRows(w.sessionId);
		expect(audit?.promptText).not.toContain(key);
		expect(audit?.promptText).toContain("REDACTED");
		expect(audit?.promptSha256).toBe(sha256(text));
	});

	test("an observed session can't take a prompt: 409, the request reopens, no action, one refused audit row", async () => {
		const w = await world({ managed: false });
		const result = await approve(w);
		expect(result).toMatchObject({
			ok: false,
			status: 409,
			code: "prompt_not_deliverable",
			reason: "observed",
		});
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		const audit = await auditRows(w.sessionId);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			outcome: "refused",
			refusalCode: "prompt_not_deliverable:observed",
		});
		expect(await eventsOfType(w.sessionId, "AiContinueBlocked")).toHaveLength(1);
		expect(await eventsOfType(w.sessionId, "AiContinueSent")).toHaveLength(0);
	});

	test("bob round-3 Low: a refusal on a request whose turn has moved on leaves it superseded, not reopened", async () => {
		const w = await world({ managed: false });
		await seedEvent(w.sessionId, {
			eventType: "UserPromptSubmit",
			category: "prompt",
			content: "next",
		});
		const result = await approve(w);
		expect(result.ok).toBe(false);
		expect(await hitlStatus(w.hitlId)).toBe("superseded");
	});

	test("a stale tap: a later prompt, tool start or permission event gives stale_proposal and queues nothing", async () => {
		for (const later of [
			{ eventType: "UserPromptSubmit", category: "prompt" },
			{ eventType: "PreToolUse", category: "tool_event" },
			{ eventType: "PermissionRequest", category: "permission_event" },
		]) {
			const w = await world();
			await seedEvent(w.sessionId, later);
			const result = await approve(w);
			expect({ later: later.eventType, ...result }).toMatchObject({
				later: later.eventType,
				ok: false,
				status: 409,
				code: "stale_proposal",
			});
			expect(await promptActions(w.sessionId)).toHaveLength(0);
		}
	});

	test("a request with no trigger event is stale; one past its expiry is expired and closed", async () => {
		const noTrigger = await world();
		await getDb()
			.update(aiHitlRequests)
			.set({ triggerEventId: null })
			.where(eq(aiHitlRequests.id, noTrigger.hitlId));
		expect(await approve(noTrigger)).toMatchObject({ ok: false, code: "stale_proposal" });

		const expired = await world();
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, expired.hitlId));
		expect(await approve(expired)).toMatchObject({ ok: false, status: 409, code: "expired" });
		expect(await hitlStatus(expired.hitlId)).toBe("timed_out");
		expect(await promptActions(expired.sessionId)).toHaveLength(0);
	});

	test("xander round-3 M3: on a hookless session, a human prompt created after the trigger makes approve stale, in any status", async () => {
		for (const status of ["queued", "failed", "completed"]) {
			const w = await world();
			await getDb()
				.insert(controlActions)
				.values({
					sessionId: w.sessionId,
					actionType: "prompt",
					requestedBy: "user",
					status,
					metadata: { prompt: "something else" },
					createdAt: new Date(Date.now() + 5_000).toISOString(),
				});
			const result = await approve(w);
			expect({ planted: status, ...result }).toMatchObject({
				planted: status,
				ok: false,
				code: "stale_proposal",
			});
			expect(await promptActions(w.sessionId)).toHaveLength(1); // only the planted one
		}
	});

	test("bob round-3 M1: a request from the old runner can't be approved or sent with Custom, but can be declined", async () => {
		const w = await world();
		await getDb()
			.update(aiHitlRequests)
			.set({ triggerEventId: null, promptSha256: null })
			.where(eq(aiHitlRequests.id, w.hitlId));
		const custom = await resolveProposal({
			hitlId: w.hitlId,
			action: "custom",
			customPrompt: "Run the tests",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(custom).toMatchObject({ ok: false, status: 409, code: "stale_proposal" });
		expect(await approve(w)).toMatchObject({ ok: false, code: "stale_proposal" });
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");

		const decline = await resolveProposal({
			hitlId: w.hitlId,
			action: "decline",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(decline).toEqual({ ok: true, action: "declined" });
		expect(await hitlStatus(w.hitlId)).toBe("declined");
	});

	test("M4: a suggestion that isn't approvable refuses Approve, and Custom with clean text still sends", async () => {
		const w = await world({ approvable: false });
		expect(await approve(w)).toMatchObject({ ok: false, status: 409, code: "not_approvable" });
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		const custom = await resolveProposal({
			hitlId: w.hitlId,
			action: "custom",
			customPrompt: "Run the tests",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(custom.ok).toBe(true);
		const actions = await promptActions(w.sessionId);
		expect((actions[0]?.metadata as { prompt: string }).prompt).toBe("Run the tests");
	});

	test("H5: approving a hash that isn't the stored prompt's, or none, is prompt_changed and sends nothing", async () => {
		const w = await world();
		for (const promptSha256 of [sha256("something else"), undefined]) {
			const result = await approve(w, { promptSha256 });
			expect(result).toMatchObject({ ok: false, status: 409, code: "prompt_changed" });
		}
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
	});

	test("a prompt that trips the safety filter or the sanitiser is refused with 400 and the request stays open", async () => {
		const w = await world({ approvable: false });
		const blocked = await resolveProposal({
			hitlId: w.hitlId,
			action: "custom",
			customPrompt: "Clean up with rm -rf / when done",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(blocked).toMatchObject({ ok: false, status: 400, code: "dispatch_blocked" });
		const unsafe = await resolveProposal({
			hitlId: w.hitlId,
			action: "custom",
			customPrompt: "/compact",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(unsafe).toMatchObject({
			ok: false,
			status: 400,
			code: "prompt_unsafe",
			reason: "bad_first_character",
		});
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		const audit = await auditRows(w.sessionId);
		expect(audit.map((a) => a.outcome)).toEqual(["refused", "refused"]);
	});

	test("an unknown action is 400, an empty custom prompt is 400, and a too-long one is refused", async () => {
		const w = await world();
		expect(
			await resolveProposal({
				hitlId: w.hitlId,
				action: "launch",
				actor: USER_ACTOR,
				actorKind: "user",
			}),
		).toMatchObject({ ok: false, status: 400, code: "invalid_action" });
		expect(
			await resolveProposal({
				hitlId: w.hitlId,
				action: "custom",
				customPrompt: "  ",
				actor: USER_ACTOR,
				actorKind: "user",
			}),
		).toMatchObject({ ok: false, status: 400, code: "empty_prompt" });
		expect(
			await resolveProposal({
				hitlId: w.hitlId,
				action: "custom",
				customPrompt: `Run ${"x".repeat(1_600)}`,
				actor: USER_ACTOR,
				actorKind: "user",
			}),
		).toMatchObject({ ok: false, status: 400, code: "prompt_too_long" });
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
	});

	test("an unknown request is 404, and a proposal from before requests existed is stale", async () => {
		expect(
			await resolveProposal({
				hitlId: "missing",
				action: "decline",
				actor: USER_ACTOR,
				actorKind: "user",
			}),
		).toMatchObject({ ok: false, status: 404 });
		const w = await world();
		await getDb().delete(aiHitlRequests).where(eq(aiHitlRequests.id, w.hitlId));
		expect(
			await resolveProposal({
				proposalId: w.proposalId,
				action: "decline",
				actor: USER_ACTOR,
				actorKind: "user",
			}),
		).toMatchObject({ ok: false, status: 409, code: "stale_proposal" });
	});

	test("bob M3: a refusal while a newer request is open leaves the old one superseded, so exactly one stays open", async () => {
		const w = await world({ managed: false });
		const newer = crypto.randomUUID();
		const original = aiEvents.emitAiEvent;
		const emit = spyOn(aiEvents, "emitAiEvent").mockImplementation(async (params) => {
			if (params.eventType === "AiContinueBlocked") {
				// A newer request opens in the middle of the refusal.
				await getDb().insert(aiHitlRequests).values({
					id: newer,
					proposalId: "p-newer",
					sessionId: w.sessionId,
					status: "awaiting_reply",
				});
			}
			return original(params);
		});
		try {
			expect((await approve(w)).ok).toBe(false);
		} finally {
			emit.mockRestore();
		}
		expect(await hitlStatus(w.hitlId)).toBe("superseded");
		const open = (
			await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.sessionId, w.sessionId))
		).filter((h) => h.status === "awaiting_reply");
		expect(open.map((h) => h.id)).toEqual([newer]);
	});

	test("a failure after the send (the timeline emit throws) still reports success and keeps the request applied", async () => {
		const w = await world();
		const emit = spyOn(aiEvents, "emitAiEvent").mockImplementation(async () => {
			throw new Error("timeline down");
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await approve(w)).ok).toBe(true);
		} finally {
			emit.mockRestore();
			quiet.mockRestore();
		}
		expect(await promptActions(w.sessionId)).toHaveLength(1);
		expect(await hitlStatus(w.hitlId)).toBe("applied");
	});

	test("with the kill switch set directly and the flag cache warm, a person's approve is refused ai_paused", async () => {
		const w = await world();
		expect(await feature.isKillSwitchActive()).toBe(false); // warm the cache with "not killed"
		const now = new Date().toISOString();
		await getDb()
			.insert(schema.settings)
			.values({ key: feature.AI_KILL_SWITCH_KEY, value: true, updatedAt: now })
			.onConflictDoUpdate({ target: schema.settings.key, set: { value: true, updatedAt: now } });
		expect(await feature.isKillSwitchActive()).toBe(false); // still cached
		const result = await approve(w);
		expect(result).toMatchObject({ ok: false, status: 409, code: "ai_paused" });
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await hitlStatus(w.hitlId)).toBe("awaiting_reply");
	});

	test("a person is never refused for the automatic-send cap", async () => {
		const w = await world();
		await seedAutoConfig({
			sessionId: w.sessionId,
			providerId,
			maxContinuations: 2,
			continuationsUsed: 2,
		});
		expect((await approve(w)).ok).toBe(true);
		expect(await counterOf(w.sessionId)).toBe(2);
	});

	test("declining sends nothing and is audited by the event, not as a send", async () => {
		const w = await world();
		const result = await resolveProposal({
			hitlId: w.hitlId,
			action: "decline",
			actor: USER_ACTOR,
			actorKind: "user",
		});
		expect(result).toEqual({ ok: true, action: "declined" });
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await auditRows(w.sessionId)).toHaveLength(0);
		expect(await eventsOfType(w.sessionId, "AiHitlResponse")).toHaveLength(1);
	});

	test("a second decision on a resolved request is already_resolved", async () => {
		const w = await world();
		expect((await approve(w)).ok).toBe(true);
		expect(await approve(w)).toMatchObject({ ok: false, status: 409, code: "already_resolved" });
		expect(await promptActions(w.sessionId)).toHaveLength(1);
	});
});

describe("dispatchPrompt for the auto policy", () => {
	function autoCtx(w: World) {
		return {
			actorKind: "auto" as const,
			proposalId: w.proposalId,
			triggerEventId: w.stopId,
			turnKey: w.turnKey,
		};
	}
	const auto = (w: World, continueKind: unknown = "run_tests") =>
		dispatchPrompt(
			w.sessionId,
			{ kind: "auto", continueKind } as Parameters<typeof dispatchPrompt>[1],
			AI_ACTOR,
			autoCtx(w),
		);

	async function readyWorld(
		over: { confirmedBy?: string; maxContinuations?: number; continuationsUsed?: number } = {},
	) {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const w = await world();
		await seedAutoConfig({ sessionId: w.sessionId, providerId, ...over });
		return w;
	}

	test("sends exactly the template, counts once, and audits it with the kind and the config it was judged under", async () => {
		const w = await readyWorld();
		const result = await auto(w);
		expect(result.ok).toBe(true);
		const actions = await promptActions(w.sessionId);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.requestedBy).toBe("ai");
		expect((actions[0]?.metadata as { prompt: string }).prompt).toBe(
			CONTINUE_TEMPLATES.get("run_tests"),
		);
		expect(await counterOf(w.sessionId)).toBe(1);
		const [audit] = await auditRows(w.sessionId);
		expect(audit).toMatchObject({
			outcome: "sent",
			actorKind: "auto",
			continueKind: "run_tests",
			actorLabel: "ai",
			controlActionId: actions[0]?.id,
		});
		expect(audit?.configSnapshot).toMatchObject({
			policy: "auto",
			autoConfirmedBy: "local",
			continueEnabled: true,
		});
		const sent = await eventsOfType(w.sessionId, "AiContinueSent");
		expect((sent[0]?.rawPayload as { actor_kind: string }).actor_kind).toBe("auto");
	});

	test("a request with proceed, __proto__ or toString is refused unknown_kind and nothing is rendered or sent", async () => {
		const w = await readyWorld();
		for (const continueKind of ["proceed", "__proto__", "toString", "constructor", "", 5, null]) {
			const result = await auto(w, continueKind);
			expect({ continueKind, ...result }).toMatchObject({
				continueKind,
				ok: false,
				code: "auto_send_blocked",
				reason: "unknown_kind",
			});
		}
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect(await counterOf(w.sessionId)).toBe(0);
	});

	test("the template table has exactly the three kinds, is frozen, and every value passes the sanitiser and the filter", () => {
		expect(new Set(CONTINUE_TEMPLATES.keys())).toEqual(
			new Set(["retry_failed_step", "run_tests", "summarize_status"]),
		);
		expect(Object.isFrozen(CONTINUE_TEMPLATES)).toBe(true);
		expect(CONTINUE_TEMPLATES.has("proceed")).toBe(false);
		expect((CONTINUE_TEMPLATES as unknown as { set?: unknown }).set).toBeUndefined();
		for (const text of CONTINUE_TEMPLATES.values()) {
			expect(sanitizeOutboundPrompt(text)).toEqual({ ok: true, text });
			expect(checkDispatch(text).allowed).toBe(true);
		}
	});

	test("paused (the default) or not confirmed or switched off between decision and send: refused, nothing sent", async () => {
		const w = await readyWorld();
		await clearSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY);
		expect(await auto(w)).toMatchObject({ ok: false, code: "auto_send_blocked", reason: "paused" });
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);

		await getDb()
			.update(watcherConfigs)
			.set({ autoConfirmedAt: null })
			.where(eq(watcherConfigs.sessionId, w.sessionId));
		expect(await auto(w)).toMatchObject({ ok: false, reason: "config_changed" });
		await getDb()
			.update(watcherConfigs)
			.set({ autoConfirmedAt: new Date().toISOString(), continueEnabled: false })
			.where(eq(watcherConfigs.sessionId, w.sessionId));
		expect(await auto(w)).toMatchObject({ ok: false, reason: "config_changed" });
		await getDb()
			.update(watcherConfigs)
			.set({ continueEnabled: true, policy: "ask_always" })
			.where(eq(watcherConfigs.sessionId, w.sessionId));
		expect(await auto(w)).toMatchObject({ ok: false, reason: "config_changed" });
		await getDb()
			.update(watcherConfigs)
			.set({ policy: "auto", enabled: false })
			.where(eq(watcherConfigs.sessionId, w.sessionId));
		expect(await auto(w)).toMatchObject({ ok: false, reason: "config_changed" });
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("the kill switch stops an auto send even with the flag cache warm", async () => {
		const w = await readyWorld();
		expect(await feature.isKillSwitchActive()).toBe(false);
		const now = new Date().toISOString();
		await getDb()
			.insert(schema.settings)
			.values({ key: feature.AI_KILL_SWITCH_KEY, value: true, updatedAt: now })
			.onConflictDoUpdate({ target: schema.settings.key, set: { value: true, updatedAt: now } });
		expect(await auto(w)).toMatchObject({ ok: false, status: 409, code: "ai_paused" });
		expect(await promptActions(w.sessionId)).toHaveLength(0);
	});

	test("bob round-3 M2: at the cap an auto send is refused continuation_cap, a person's approve still works, under the cap an auto send moves the counter by one", async () => {
		const w = await readyWorld({ maxContinuations: 2, continuationsUsed: 2 });
		expect(await auto(w)).toMatchObject({
			ok: false,
			code: "auto_send_blocked",
			reason: "continuation_cap",
		});
		expect(await promptActions(w.sessionId)).toHaveLength(0);
		expect((await approve(w)).ok).toBe(true);
		expect(await counterOf(w.sessionId)).toBe(2);

		const under = await readyWorld({ maxContinuations: 5, continuationsUsed: 1 });
		expect((await auto(under)).ok).toBe(true);
		expect(await counterOf(under.sessionId)).toBe(2);
	});

	test("the hourly cap counts prompt actions by the AI, not events: 6 in the last hour refuse, 6 older than an hour do not, forged events do not count", async () => {
		const w = await readyWorld();
		const plant = async (ageMs: number, n: number) => {
			for (let i = 0; i < n; i += 1) {
				await getDb()
					.insert(controlActions)
					.values({
						sessionId: w.sessionId,
						actionType: "prompt",
						requestedBy: "ai",
						status: "completed",
						createdAt: new Date(Date.now() - ageMs).toISOString(),
					});
			}
		};
		for (let i = 0; i < 6; i += 1) {
			await seedEvent(w.sessionId, { eventType: "AiContinueSent", category: "ai_continue_sent" });
		}
		await plant(61 * 60_000, 6);
		expect((await auto(w)).ok).toBe(true);

		await getDb().delete(controlActions);
		const capped = await readyWorld();
		for (let i = 0; i < 6; i += 1) {
			await getDb()
				.insert(controlActions)
				.values({
					sessionId: capped.sessionId,
					actionType: "prompt",
					requestedBy: "ai",
					status: "failed",
					// Earlier in the hour, but before this turn ended: a later one would make the turn stale.
					createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				});
		}
		expect(await auto(capped)).toMatchObject({
			ok: false,
			code: "auto_send_blocked",
			reason: "hourly_cap",
		});
		const [refused] = (await auditRows(capped.sessionId)).filter((a) => a.outcome === "refused");
		expect(refused?.refusalCode).toBe("auto_send_blocked:hourly_cap");
	});

	test("the global cap: with 19 sends in the last hour across sessions one more passes, the next is refused", async () => {
		const other = await world();
		for (let i = 0; i < 19; i += 1) {
			await getDb().insert(controlActions).values({
				sessionId: other.sessionId,
				actionType: "prompt",
				requestedBy: "ai",
				status: "completed",
				createdAt: new Date().toISOString(),
			});
		}
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const a = await world();
		await seedAutoConfig({ sessionId: a.sessionId, providerId });
		const b = await world();
		await seedAutoConfig({ sessionId: b.sessionId, providerId });
		expect((await auto(a)).ok).toBe(true);
		expect(await auto(b)).toMatchObject({ ok: false, reason: "hourly_cap" });
	});

	test("L3 at dispatch: a confirmer who has been disabled refuses the send and spends the confirmation", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const confirmer = await seedLocalUser("pr-confirmer", "admin");
		const w = await world();
		await seedAutoConfig({ sessionId: w.sessionId, providerId, confirmedBy: confirmer.id });
		expect((await auto(w)).ok).toBe(true);
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, confirmer.id));
		const second = await world();
		await seedAutoConfig({ sessionId: second.sessionId, providerId, confirmedBy: confirmer.id });
		expect(await auto(second)).toMatchObject({
			ok: false,
			code: "auto_send_blocked",
			reason: "confirmer_lapsed",
		});
		expect(await promptActions(second.sessionId)).toHaveLength(0);
		const [row] = await getDb()
			.select()
			.from(watcherConfigs)
			.where(eq(watcherConfigs.sessionId, second.sessionId));
		expect(row?.autoConfirmedAt).toBeNull();
		expect(row?.autoConfirmedBy).toBeNull();
	});

	test("team mode: a confirmer who is neither an admin nor the session's owner has lapsed; the owner and an admin have not", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		await setStoredMode("team");
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const owner = await seedLocalUser("pr-owner", "user");
		const stranger = await seedLocalUser("pr-stranger", "user");
		const admin = await seedLocalUser("pr-admin2", "admin");
		const results: Record<string, boolean> = {};
		for (const [label, confirmer] of [
			["owner", owner],
			["stranger", stranger],
			["admin", admin],
		] as const) {
			const w = await world({ ownerUserId: owner.id });
			await seedAutoConfig({ sessionId: w.sessionId, providerId, confirmedBy: confirmer.id });
			results[label] = (await auto(w)).ok;
		}
		expect(results).toEqual({ owner: true, stranger: false, admin: true });
	});

	test("an offline supervisor refuses an unattended send, and a stale turn refuses it too", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const offline = await world({ supervisor: "offline" });
		await seedAutoConfig({ sessionId: offline.sessionId, providerId });
		expect(await auto(offline)).toMatchObject({
			ok: false,
			code: "prompt_not_deliverable",
			reason: "supervisor_offline",
		});

		const moved = await world();
		await seedAutoConfig({ sessionId: moved.sessionId, providerId });
		await seedEvent(moved.sessionId, { eventType: "UserPromptSubmit", category: "prompt" });
		expect(await auto(moved)).toMatchObject({ ok: false, code: "stale_proposal" });
	});

	test("a mismatch between the request and the actor kind is a programming error, not a refusal", async () => {
		const w = await readyWorld();
		await expect(
			dispatchPrompt(w.sessionId, { kind: "human", text: PROMPT }, AI_ACTOR, autoCtx(w)),
		).rejects.toThrow(/actorKind/);
	});
});

describe("drift guards", () => {
	const SERVER = join(import.meta.dir, "../..");
	function* walk(dir: string): Generator<string> {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) yield* walk(full);
			else if (/\.ts$/.test(name)) yield full;
		}
	}
	function productionFiles(): Array<{ rel: string; text: string }> {
		const out: Array<{ rel: string; text: string }> = [];
		for (const full of walk(SERVER)) {
			const rel = relative(SERVER, full);
			// Tests, their helpers and child-process fixtures are not production code.
			if (/\.(test|fixture)\.ts$/.test(rel) || rel.startsWith("test-utils/")) continue;
			out.push({ rel, text: readFileSync(full, "utf8") });
		}
		return out;
	}
	const callers = (marker: string) =>
		new Set(
			productionFiles()
				.filter((f) => f.text.includes(marker))
				.map((f) => f.rel),
		);

	test("queuePromptAction( is called from the human prompt route only; enqueuePromptInTx( from the queue and the dispatch", () => {
		const queueCallers = callers("queuePromptAction(");
		// The definition lives in control-actions.ts; the callers are the routes.
		expect(queueCallers.has("routes/sessions.ts")).toBe(true);
		expect(
			[...queueCallers].filter(
				(f) => f !== "services/control-actions.ts" && f !== "routes/sessions.ts",
			),
		).toEqual([]);
		expect(callers("enqueuePromptInTx(")).toEqual(
			new Set(["services/control-actions.ts", "services/ai/proposal-resolution.ts"]),
		);
	});

	test("no control lock is taken unconditionally", () => {
		const text = readFileSync(join(SERVER, "services/control-actions.ts"), "utf8");
		expect(text.includes("activeControlActionId: action.id")).toBe(false);
		const conditional = text.match(/isNull\(managedSessions\.activeControlActionId\)/g) ?? [];
		expect(conditional).toHaveLength(1); // the one shared helper both enqueues call
		expect(text.match(/takeControlLock\(/g)?.length).toBe(3); // definition + stop + prompt
	});

	test("AiContinueSent is written, and HITLs are resolved, only by the dispatch (and the definitions)", () => {
		const allowed = new Set([
			"services/ai/proposal-resolution.ts",
			"services/ai/proposals-service.ts",
			"services/ai/hitl-service.ts",
		]);
		const offenders: string[] = [];
		for (const f of productionFiles()) {
			if (allowed.has(f.rel)) continue;
			if (/"AiContinueSent"|resolveProposalHitl\(|resolveHitlRequest\(/.test(f.text)) {
				offenders.push(f.rel);
			}
		}
		expect(offenders).toEqual([]);
		const resolutionText = readFileSync(join(SERVER, "services/ai/proposal-resolution.ts"), "utf8");
		expect(resolutionText).toContain("enqueuePromptInTx(");
		expect(resolutionText).toContain('"AiContinueSent"');
		// Floor: the definition files are really there.
		expect(productionFiles().filter((f) => allowed.has(f.rel))).toHaveLength(3);
	});

	test("nothing inside a dispatch or enqueue transaction reaches for an ordinary handle", () => {
		const text = readFileSync(join(SERVER, "services/ai/proposal-resolution.ts"), "utf8");
		const start = text.indexOf("async function runDispatchChecksAndEnqueue(");
		const end = text.indexOf("function refusalForEnqueue(");
		expect(start).toBeGreaterThan(-1);
		expect(text.slice(start, end)).not.toMatch(/\bgetDb\(/);

		const named: Array<[string, string, string]> = [
			[
				"services/control-actions.ts",
				"export async function enqueueStopInTx(",
				"export async function queueStopAction(",
			],
			[
				"services/control-actions.ts",
				"export async function enqueuePromptInTx(",
				"export async function queuePromptAction(",
			],
			[
				"services/control-actions.ts",
				"export async function expireStaleControlLock(",
				"async function expireStaleControlLocksForSupervisor(",
			],
			[
				"services/control-actions.ts",
				"async function resolveManagedLaunch(",
				"async function launchOwnedBySessionOwner(",
			],
			[
				"services/control-actions.ts",
				"async function launchOwnedBySessionOwner(",
				"/** The throwing form",
			],
			[
				"services/ai/feature.ts",
				"export async function readAiFlagUncached(",
				"async function readCachedFlagOrUnreadable(",
			],
			[
				"services/ai/turn-identity.ts",
				"export async function computeTurnKey(",
				"/**\n * Has the turn moved on?",
			],
			["services/ai/turn-identity.ts", "export async function isTurnStale(", "\n}\n"],
			["services/session-ownership.ts", "export async function resolveSessionOwner(", "\n}\n"],
			[
				"services/session-ownership.ts",
				"export async function getSessionOwnerConnections(",
				"\n}\n",
			],
			[
				"services/session-ownership.ts",
				"export async function findLaunchRowByCorrelationId(",
				"\n}\n",
			],
			["services/control-actions.ts", "export async function takeControlLock(", "\n}\n"],
			[
				"services/ai/watcher-config-service.ts",
				"export async function incrementContinuations(",
				"export async function deleteWatcherConfig(",
			],
		];
		for (const [file, from, to] of named) {
			const source = readFileSync(join(SERVER, file), "utf8");
			const a = source.indexOf(from);
			expect(a, `${file}: ${from}`).toBeGreaterThan(-1);
			const b = source.indexOf(to, a + from.length);
			const body = source.slice(a, b === -1 ? undefined : b);
			// A default parameter (`db: any = getDb()`) is the one place the ordinary handle may appear.
			expect(body.replace(/\b\w+: any = getDb\(\)/g, "")).not.toMatch(/\bgetDb\(/);
		}
	});
});
