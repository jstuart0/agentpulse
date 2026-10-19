/**
 * The one place a person's answer to an agent's request is applied.
 *
 * Every way of deciding a HITL (the proposal route, the inbox decide route, batch
 * decline, the Telegram callback) goes through `decideHitl`, so the rules cannot
 * differ by entry point:
 *
 *  - `custom` text needs a caller allowed to write prompts (`manage`, or a signed-in
 *    human), never a `respond` key;
 *  - the caller must be the session's owner or an admin (team mode);
 *  - an approve may carry the hash of the prompt the person reviewed, and a prompt
 *    that has changed since is refused (`prompt_changed`);
 *  - the request is closed with a guarded write, so two answers to one request
 *    produce one result;
 *  - an approved prompt on a managed session with a connected supervisor becomes a
 *    control action in the same transaction, and a failure at any step before the
 *    commit leaves nothing behind.
 *
 * Telegram never forwards a prompt: it closes the request audit-only, as it always
 * has. `DecisionContext` is built by a route helper from the authenticated request
 * and never from anything the request body says.
 *
 * What happened to the prompt afterwards is not copied anywhere: `ai_hitl_deliveries`
 * names the control action carrying it, and the state a caller sees is that action's
 * own status.
 */
import { and, eq } from "drizzle-orm";
import type { HitlReplyKind } from "../../../shared/types.js";
import { TELEGRAM_ACTOR } from "../../auth/actor.js";
import type { Actor } from "../../auth/actor.js";
import { scopesIncludeManage } from "../../auth/route-scope-policy.js";
import { getDb } from "../../db/client.js";
import {
	aiHitlDeliveries,
	aiHitlRequests,
	controlActions,
	watcherProposals,
} from "../../db/schema/index.js";
import { withTransaction } from "../../db/with-transaction.js";
import { NOT_OWNER_MESSAGE, NotOwnerError, assertCanChangeSessions } from "../authorization.js";
import {
	CONTROL_TIMEOUT_ERROR,
	ControlBusyError,
	EmptyPromptError,
	LaunchMismatchError,
	LaunchNotFoundError,
	SessionNotFoundError,
	SessionNotManagedError,
	expireStaleControlLock,
	queuePromptAction,
} from "../control-actions.js";
import { notifyInboxChanged } from "../notifier.js";
import { getSessionOwnerConnections } from "../session-ownership.js";
import { emitAiEvent } from "./ai-events.js";
import { checkDispatch } from "./dispatch-filter.js";
import {
	type HitlRequestRecord,
	effectiveExpiry,
	getHitlRequest,
	getOpenHitlForProposal,
} from "./hitl-service.js";
import { hashPrompt, proposedPromptText } from "./prompt-hash.js";
import { type ProposalRecord, getProposal } from "./proposals-service.js";

export { hashPrompt };

export type DecisionSource = "api_key" | "session" | "sso" | "telegram";

export interface DecisionContext {
	actor: Actor;
	source: DecisionSource;
	/** The API key the request came in with; null for a person signed in by cookie or SSO. */
	keyId: string | null;
	scopes: readonly string[];
	/** True for `manage` / `*` and for a signed-in human; false for `respond`. Set by the route helper from the authenticated caller. */
	canCustomPrompt: boolean;
}

/** What Telegram decides as: a chat with no identity, never a prompt writer, never forwarding. */
export const TELEGRAM_DECISION_CONTEXT: DecisionContext = Object.freeze({
	actor: Object.freeze({ ...TELEGRAM_ACTOR }),
	source: "telegram",
	keyId: null,
	scopes: Object.freeze([]) as readonly string[],
	canCustomPrompt: false,
});

/** What a Telegram approve tap is answered with: the request stays open for the app. */
export const TELEGRAM_APPROVE_UNSUPPORTED_MESSAGE =
	"Approving from Telegram isn't supported any more. Open AgentPulse to answer.";

export type DecisionTarget =
	| { kind: "proposal"; proposalId: string }
	| { kind: "hitl"; hitlId: string };

export interface DecisionInput {
	customPrompt?: string;
	/** SHA-256 (lowercase hex) of the proposed prompt the person reviewed. Checked on approve. */
	promptHash?: string;
	/** Who acted, for a channel that has no identity of its own (a Telegram user id). Audit only. */
	auditNote?: string;
}

/**
 * What a caller sees of a delivery. Never the prompt. `unknown` is an attempt whose lock ran
 * out before the supervisor reported: it may or may not have run, so it is not called failed.
 */
export type DeliveryStateName =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "unknown"
	| "not_managed"
	| "blocked";

export interface DecisionRefusal {
	code:
		| "not_found"
		| "not_awaiting"
		| "already_resolved"
		| "prompt_changed"
		| "control_busy"
		| "insufficient_scope"
		| "not_owner"
		| "empty_prompt"
		| "filter_blocked"
		| "session_not_found"
		| "not_retryable"
		| "not_failed"
		| "retry_conflict"
		| "confirm_required"
		| "expired"
		| "prompt_hash_required"
		| "telegram_approve_unsupported";
	status: 400 | 403 | 404 | 409;
	/** The JSON body to answer with. */
	body: Record<string, unknown>;
}

export type DecisionOutcome =
	| {
			ok: true;
			hitl: HitlRequestRecord | null;
			proposalId: string;
			sessionId: string;
			action: HitlReplyKind;
			/** The prompt that was approved or written; null for a decline. */
			prompt: string | null;
			delivery: { state: DeliveryStateName; deliveryId: string; reason?: string } | null;
	  }
	| { ok: false; refusal: DecisionRefusal };

const refuse = (
	code: DecisionRefusal["code"],
	status: DecisionRefusal["status"],
	body: Record<string, unknown>,
): DecisionOutcome => ({ ok: false, refusal: { code, status, body } });

/** Thrown inside the transaction to roll it back and answer with a refusal. */
class DecisionAbort extends Error {
	constructor(readonly refusal: DecisionRefusal) {
		super(refusal.code);
	}
}

const abort = (
	code: DecisionRefusal["code"],
	status: DecisionRefusal["status"],
	body: Record<string, unknown>,
): never => {
	throw new DecisionAbort({ code, status, body });
};

const notOwnerBody = { error: "not_owner", message: NOT_OWNER_MESSAGE };

interface Loaded {
	hitl: HitlRequestRecord | null;
	proposal: ProposalRecord | null;
	sessionId: string;
	proposalId: string;
	/** Set when the target is no longer open. Answered only after the caller has passed the owner check, so a stranger learns nothing about its state. */
	stale: DecisionOutcome | null;
}

async function loadTarget(target: DecisionTarget): Promise<Loaded | DecisionOutcome> {
	if (target.kind === "proposal") {
		const proposal = await getProposal(target.proposalId);
		if (!proposal)
			return refuse("not_found", 404, { error: "not_found", message: "Proposal not found" });
		const stale =
			proposal.state === "hitl_waiting"
				? null
				: refuse("not_awaiting", 409, {
						error: "not_awaiting",
						state: proposal.state,
						message: `Proposal state is ${proposal.state}, not awaiting a response`,
					});
		// No open request row: a proposal from before the split, still physically hitl_waiting.
		const hitl = await getOpenHitlForProposal(proposal.id);
		return {
			hitl,
			proposal,
			sessionId: proposal.sessionId,
			proposalId: proposal.id,
			stale: stale ?? expiredOutcome(hitl),
		};
	}
	const hitl = await getHitlRequest(target.hitlId);
	if (!hitl) return refuse("not_found", 404, { error: "not_found", message: "hitl not found" });
	const stale =
		hitl.status === "awaiting_reply"
			? expiredOutcome(hitl)
			: refuse("already_resolved", 409, { error: "already_resolved" });
	const proposal = await getProposal(hitl.proposalId);
	return { hitl, proposal, sessionId: hitl.sessionId, proposalId: hitl.proposalId, stale };
}

/** A request past its expiry can't be answered: what it asked is no longer what the agent is doing. */
function expiredOutcome(hitl: HitlRequestRecord | null): DecisionOutcome | null {
	if (!hitl || effectiveExpiry(hitl) > Date.now()) return null;
	return refuse("expired", 409, {
		error: "expired",
		message: "This request has expired. Wait for the agent to ask again.",
	});
}

function isOutcome(value: Loaded | DecisionOutcome): value is DecisionOutcome {
	return "ok" in value;
}

/** May this caller write the prompt that goes to the agent? Both the builder's flag and the key's own scopes must agree. */
function mayWritePrompts(ctx: DecisionContext): boolean {
	if (!ctx.canCustomPrompt) return false;
	return ctx.source !== "api_key" || scopesIncludeManage(ctx.scopes);
}

async function refuseUnlessMayChange(
	ctx: DecisionContext,
	sessionId: string,
): Promise<DecisionOutcome | null> {
	try {
		await assertCanChangeSessions(ctx.actor, [sessionId]);
		return null;
	} catch (err) {
		if (err instanceof NotOwnerError) return refuse("not_owner", 403, notOwnerBody);
		throw err;
	}
}

interface Queued {
	deliveryId: string;
	state: DeliveryStateName;
	queued: boolean;
	blockedReason?: string;
}

/**
 * Applies one decision. `target` names a proposal or a HITL request; both end in the
 * same guarded write. Returns a refusal (with the status and body to answer with)
 * rather than throwing for anything a caller can cause.
 */
export async function decideHitl(
	target: DecisionTarget,
	action: HitlReplyKind,
	input: DecisionInput,
	ctx: DecisionContext,
): Promise<DecisionOutcome> {
	const loaded = await loadTarget(target);
	if (isOutcome(loaded)) return loaded;
	const { hitl, proposal, sessionId, proposalId } = loaded;
	const telegram = ctx.source === "telegram" || ctx.actor.label === "telegram";

	if (!telegram) {
		if (action === "custom" && !mayWritePrompts(ctx)) {
			return refuse("insufficient_scope", 403, { error: "insufficient_scope", required: "manage" });
		}
		const refused = await refuseUnlessMayChange(ctx, sessionId);
		if (refused) return refused;
	}
	if (loaded.stale) return loaded.stale;
	if (telegram && action !== "decline") {
		return refuse("telegram_approve_unsupported", 409, {
			error: "telegram_approve_unsupported",
			message: TELEGRAM_APPROVE_UNSUPPORTED_MESSAGE,
		});
	}

	let prompt: string | null = null;
	if (!telegram && action !== "decline") {
		prompt =
			action === "custom"
				? (input.customPrompt ?? "").trim()
				: proposedPromptText(proposal?.nextPrompt);
		if (!prompt) {
			return refuse("empty_prompt", 400, { error: "empty_prompt", message: "Empty prompt" });
		}
		if (action === "approve") {
			// A key that can't write prompts approves only the exact text it was shown.
			if (
				input.promptHash === undefined &&
				ctx.source === "api_key" &&
				!scopesIncludeManage(ctx.scopes)
			) {
				return refuse("prompt_hash_required", 400, {
					error: "prompt_hash_required",
					message: "Approve with the promptHash of the prompt you reviewed.",
				});
			}
			if (input.promptHash !== undefined && input.promptHash !== hashPrompt(prompt)) {
				return refuse("prompt_changed", 409, { error: "prompt_changed" });
			}
		}
		const filter = checkDispatch(prompt);
		if (!filter.allowed) {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_continue_blocked",
				eventType: "AiContinueBlocked",
				content: `Dispatch filter tripped on human-approved prompt: ${filter.reason}`,
				rawPayload: { proposal_id: proposalId, rule: filter.rule },
			});
			return refuse("filter_blocked", 400, {
				error: "filter_blocked",
				rule: filter.rule,
				message: `Prompt rejected by safety filter: ${filter.rule}`,
				delivery: { state: "blocked", reason: "filter" },
			});
		}
	}

	try {
		const committed = await withTransaction((tx) =>
			applyDecision(tx, loaded, action, prompt, telegram, ctx),
		);
		const resolved = hitl ? await getHitlRequest(hitl.id) : null;
		await announce({
			action,
			prompt,
			sessionId,
			proposalId,
			telegram,
			queued: committed?.queued === true,
			blockedReason: committed?.blockedReason,
			actorUserId: ctx.actor.userId,
			keyId: ctx.keyId,
			note: input.auditNote,
		});
		return {
			ok: true,
			hitl: resolved,
			proposalId,
			sessionId,
			action,
			prompt,
			delivery: committed
				? {
						state: committed.state,
						deliveryId: committed.deliveryId,
						...(committed.blockedReason ? { reason: committed.blockedReason } : {}),
					}
				: null,
		};
	} catch (err) {
		if (err instanceof DecisionAbort) return { ok: false, refusal: err.refusal };
		throw err;
	}
}

/** Everything that must happen together or not at all. */
async function applyDecision(
	// biome-ignore lint/suspicious/noExplicitAny: the transaction handle is dialect-typed (see withTransaction)
	tx: any,
	loaded: Loaded,
	action: HitlReplyKind,
	prompt: string | null,
	telegram: boolean,
	ctx: DecisionContext,
): Promise<Queued | null> {
	const { hitl, proposal, sessionId, proposalId } = loaded;
	const now = new Date().toISOString();
	const declined = action === "decline";

	if (hitl) {
		const closed = await tx
			.update(aiHitlRequests)
			.set({
				status: declined ? "declined" : "applied",
				replyKind: action,
				replyText: prompt,
				updatedAt: now,
			})
			.where(and(eq(aiHitlRequests.id, hitl.id), eq(aiHitlRequests.status, "awaiting_reply")))
			.returning({ id: aiHitlRequests.id });
		if (closed.length === 0) abort("already_resolved", 409, { error: "already_resolved" });
	} else if (proposal) {
		const closed = await tx
			.update(watcherProposals)
			.set({ state: declined ? "hitl_declined" : "hitl_applied", updatedAt: now })
			.where(and(eq(watcherProposals.id, proposal.id), eq(watcherProposals.state, "hitl_waiting")))
			.returning({ id: watcherProposals.id });
		if (closed.length === 0) abort("already_resolved", 409, { error: "already_resolved" });
	}
	if (declined || telegram) return null;

	const deliveryId = crypto.randomUUID();
	const sent = prompt;
	await tx.insert(aiHitlDeliveries).values({
		id: deliveryId,
		proposalId,
		hitlId: hitl?.id ?? `legacy:${proposalId}`,
		sessionId,
		controlActionId: null,
		attempt: 1,
		terminalState: null,
		approvedByUserId: ctx.actor.userId,
		approvedByKeyId: ctx.keyId,
		promptHash: sent ? hashPrompt(sent) : null,
		createdAt: now,
		updatedAt: now,
	});
	if (sent === null) return { deliveryId, state: "not_managed", queued: false };
	return forward(tx, { deliveryId, sessionId, prompt: sent, actor: ctx.actor });
}

/** Queues the approved prompt for the session's supervisor, or records why it was not. Runs inside the decision's transaction. */
async function forward(
	// biome-ignore lint/suspicious/noExplicitAny: the transaction handle is dialect-typed (see withTransaction)
	tx: any,
	args: { deliveryId: string; sessionId: string; prompt: string; actor: Actor },
): Promise<Queued> {
	const { deliveryId, sessionId, prompt, actor } = args;
	const setTerminal = async (state: "not_managed" | "blocked", blockedReason?: string) => {
		await tx
			.update(aiHitlDeliveries)
			.set({
				terminalState: blockedReason ? `${state}:${blockedReason}` : state,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(aiHitlDeliveries.id, deliveryId));
		return { deliveryId, state, queued: false, blockedReason } satisfies Queued;
	};

	const connected = (await getSessionOwnerConnections([sessionId], tx)).get(sessionId);
	if (connected === undefined) return setTerminal("not_managed");
	if (connected === false) return setTerminal("blocked", "supervisor_offline");
	try {
		const queued = await queuePromptAction(sessionId, prompt, actor, tx);
		await tx
			.update(aiHitlDeliveries)
			.set({ controlActionId: queued.id, updatedAt: new Date().toISOString() })
			.where(eq(aiHitlDeliveries.id, deliveryId));
		return { deliveryId, state: "queued", queued: true };
	} catch (err) {
		if (err instanceof ControlBusyError) abort("control_busy", 409, { error: "control_busy" });
		if (err instanceof SessionNotManagedError) return setTerminal("not_managed");
		if (err instanceof LaunchMismatchError) return setTerminal("blocked", "launch_mismatch");
		if (err instanceof LaunchNotFoundError) return setTerminal("blocked", "launch_not_found");
		if (err instanceof SessionNotFoundError)
			abort("session_not_found", 404, { error: "not_found", message: "Session not found" });
		if (err instanceof EmptyPromptError)
			abort("empty_prompt", 400, { error: "empty_prompt", message: "Empty prompt" });
		throw err;
	}
}

/**
 * The audit trail and the inbox signal, after the decision is durable. A failure here
 * is logged, not thrown: the answer has been recorded and must not be reported as lost.
 */
async function announce(args: {
	action: HitlReplyKind;
	prompt: string | null;
	sessionId: string;
	proposalId: string;
	telegram: boolean;
	queued: boolean;
	blockedReason?: string;
	actorUserId: string | null;
	keyId: string | null;
	note?: string;
}): Promise<void> {
	const { action, prompt, sessionId, proposalId, telegram, queued, blockedReason } = args;
	const by = { actor_user_id: args.actorUserId, key_id: args.keyId };
	try {
		if (telegram) {
			// Only a decline reaches here: an approve from Telegram is refused before anything is written.
			await emitAiEvent({
				sessionId,
				source: "observed_hook",
				category: "ai_hitl_response",
				eventType: "AiHitlResponse",
				content: "Declined via Telegram.",
				rawPayload: {
					proposal_id: proposalId,
					action,
					channel: "telegram",
					...(args.note ? { by: args.note } : {}),
				},
			});
		} else {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_hitl_response",
				eventType: "AiHitlResponse",
				content:
					action === "decline"
						? "Declined by user."
						: action === "custom"
							? `Custom: ${prompt}`
							: "Approved.",
				rawPayload: {
					proposal_id: proposalId,
					action,
					...by,
					...(blockedReason ? { delivery_blocked: blockedReason } : {}),
				},
			});
			if (queued) {
				await emitAiEvent({
					sessionId,
					source: "managed_control",
					category: "ai_continue_sent",
					eventType: "AiContinueSent",
					content: prompt ?? "",
					rawPayload: { proposal_id: proposalId, action, ...by },
				});
			}
		}
	} catch (err) {
		console.error(
			"[hitl-decision] audit event failed",
			err instanceof Error ? err.name : "unknown",
		);
	}
	notifyInboxChanged({ sessionId });
}

/**
 * Batch decline, the only batch action: declines each named request and closes every
 * open request on each named session. All or none for the owner check: if the caller may
 * not change one of the sessions involved, nothing is closed.
 */
export async function declineAll(args: {
	hitlIds: readonly string[];
	sessionIds: readonly string[];
	ctx: DecisionContext;
}): Promise<{ ok: true; closed: number } | { ok: false; refusal: DecisionRefusal }> {
	const { hitlIds, sessionIds, ctx } = args;
	const named = (await Promise.all(hitlIds.map((id) => getHitlRequest(id)))).filter(
		(h): h is HitlRequestRecord => h !== null,
	);
	const involved = [...new Set([...named.map((h) => h.sessionId), ...sessionIds])];
	const refused = await refuseUnlessMayChangeAll(ctx, involved);
	if (refused) return { ok: false, refusal: refused };

	let closed = 0;
	for (const hitl of named) {
		const outcome = await decideHitl({ kind: "hitl", hitlId: hitl.id }, "decline", {}, ctx);
		if (outcome.ok) closed += 1;
		// already answered meanwhile: nothing left to close
	}
	for (const sessionId of sessionIds) closed += await supersedeOpenForSession(sessionId, ctx);
	return { ok: true, closed };
}

async function refuseUnlessMayChangeAll(
	ctx: DecisionContext,
	sessionIds: readonly string[],
): Promise<DecisionRefusal | null> {
	try {
		await assertCanChangeSessions(ctx.actor, sessionIds);
		return null;
	} catch (err) {
		if (err instanceof NotOwnerError) return { code: "not_owner", status: 403, body: notOwnerBody };
		throw err;
	}
}

async function supersedeOpenForSession(sessionId: string, ctx: DecisionContext): Promise<number> {
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status: "superseded", updatedAt: new Date().toISOString() })
		.where(
			and(eq(aiHitlRequests.sessionId, sessionId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.returning({ id: aiHitlRequests.id, proposalId: aiHitlRequests.proposalId });
	for (const row of rows) {
		try {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_hitl_response",
				eventType: "AiHitlResponse",
				content: "Declined by user.",
				rawPayload: {
					proposal_id: row.proposalId,
					action: "decline",
					via: "batch_session",
					actor_user_id: ctx.actor.userId,
					key_id: ctx.keyId,
				},
			});
		} catch (err) {
			console.error(
				"[hitl-decision] audit event failed",
				err instanceof Error ? err.name : "unknown",
			);
		}
	}
	if (rows.length > 0) notifyInboxChanged({ sessionId });
	return rows.length;
}

// ---------------------------------------------------------------------------
// Delivery: derived, never mirrored
// ---------------------------------------------------------------------------

type DeliveryRow = typeof aiHitlDeliveries.$inferSelect;

const TERMINAL_STATES: ReadonlySet<string> = new Set(["not_managed", "blocked"]);

export type DeliveryView = { state: DeliveryStateName; updatedAt: string; reason?: string };
export type DeliveryOutcome =
	| { ok: true; delivery: DeliveryView }
	| { ok: false; refusal: DecisionRefusal };

async function deliveryFor(proposalId: string): Promise<DeliveryRow | null> {
	const [row] = await getDb()
		.select()
		.from(aiHitlDeliveries)
		.where(eq(aiHitlDeliveries.proposalId, proposalId))
		.limit(1);
	return row ?? null;
}

/**
 * The delivery's state: the terminal state if one was recorded (an `audit_only` Telegram
 * decision reads as `not_managed`: nothing was sent), else the status of the control action
 * the delivery is linked to now. An action whose lock has run out is failed first, so a
 * timed-out attempt reads as failed without waiting for another request to notice. A late
 * result from an attempt that has since been replaced is invisible: only the linked action counts.
 */
async function deriveDelivery(row: DeliveryRow): Promise<DeliveryView> {
	if (row.terminalState === "audit_only") return { state: "not_managed", updatedAt: row.updatedAt };
	if (row.terminalState) {
		const [state, reason] = row.terminalState.split(":") as [string, string | undefined];
		if (TERMINAL_STATES.has(state)) {
			return {
				state: state as DeliveryStateName,
				updatedAt: row.updatedAt,
				...(reason ? { reason } : {}),
			};
		}
	}
	await expireStaleControlLock(row.sessionId);
	const [action] = row.controlActionId
		? await getDb()
				.select()
				.from(controlActions)
				.where(eq(controlActions.id, row.controlActionId))
				.limit(1)
		: [];
	if (!action) return { state: "failed", updatedAt: row.updatedAt };
	if (action.status === "queued" || action.status === "running" || action.status === "succeeded") {
		return { state: action.status, updatedAt: action.updatedAt };
	}
	// A lock that ran out says nothing about whether the supervisor ran the prompt.
	const state = action.error === CONTROL_TIMEOUT_ERROR ? "unknown" : "failed";
	return { state, updatedAt: action.updatedAt };
}

export async function getDeliveryState(
	proposalId: string,
	ctx: DecisionContext,
): Promise<DeliveryOutcome> {
	const row = await deliveryFor(proposalId);
	if (!row)
		return {
			ok: false,
			refusal: {
				code: "not_found",
				status: 404,
				body: { error: "not_found", message: "delivery not found" },
			},
		};
	const refused = await refuseUnlessMayChange(ctx, row.sessionId);
	if (refused && !refused.ok) return { ok: false, refusal: refused.refusal };
	return { ok: true, delivery: await deriveDelivery(row) };
}

/**
 * Points a delivery at a new control action, only if it still follows `fromActionId`. The guard is
 * what makes two retries that both saw the same failed attempt end with one winner: the second
 * finds the delivery already moved and gets false.
 */
export async function moveDeliveryToAction(
	// biome-ignore lint/suspicious/noExplicitAny: the transaction handle is dialect-typed (see withTransaction)
	tx: any,
	args: { deliveryId: string; fromActionId: string; toActionId: string; attempt: number },
): Promise<boolean> {
	const moved = await tx
		.update(aiHitlDeliveries)
		.set({
			controlActionId: args.toActionId,
			attempt: args.attempt,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(aiHitlDeliveries.id, args.deliveryId),
				eq(aiHitlDeliveries.controlActionId, args.fromActionId),
			),
		)
		.returning({ id: aiHitlDeliveries.id });
	return moved.length > 0;
}

/**
 * Sends the approved prompt again after an attempt failed. A guarded write moves the
 * delivery from the failed action to a new one, in the same transaction that queues it,
 * so of two concurrent retries one wins and the other gets 409.
 */
export async function retryDelivery(
	proposalId: string,
	ctx: DecisionContext,
	options: { confirm?: boolean } = {},
): Promise<
	| { ok: true; state: DeliveryStateName; deliveryId: string }
	| { ok: false; refusal: DecisionRefusal }
> {
	const first = await deliveryFor(proposalId);
	if (!first)
		return {
			ok: false,
			refusal: {
				code: "not_found",
				status: 404,
				body: { error: "not_found", message: "delivery not found" },
			},
		};
	const refused = await refuseUnlessMayChange(ctx, first.sessionId);
	if (refused && !refused.ok) return { ok: false, refusal: refused.refusal };

	try {
		return await withTransaction(async (tx) => {
			const [row] = await tx
				.select()
				.from(aiHitlDeliveries)
				.where(eq(aiHitlDeliveries.proposalId, proposalId))
				.limit(1);
			if (!row || row.terminalState || !row.controlActionId) {
				return abort("not_retryable", 409, { error: "not_retryable" });
			}
			// An approval is only good for as long as a request is answerable: an older delivery is not re-sent.
			if (effectiveExpiry({ expiresAt: null, createdAt: row.createdAt }) <= Date.now()) {
				return abort("not_retryable", 409, { error: "not_retryable" });
			}
			await expireStaleControlLock(row.sessionId, tx);
			const [previous] = await tx
				.select()
				.from(controlActions)
				.where(eq(controlActions.id, row.controlActionId))
				.limit(1);
			if (previous && previous.status !== "failed") {
				return abort("not_failed", 409, { error: "not_failed" });
			}
			if (previous?.error === CONTROL_TIMEOUT_ERROR && options.confirm !== true) {
				// It may have run: sending again could do the work twice, so the person has to say so.
				return abort("confirm_required", 409, {
					error: "confirm_required",
					message: "The first attempt may have run. Retry with confirm: true to send it again.",
				});
			}
			const prompt = (previous?.metadata as { prompt?: unknown } | null)?.prompt;
			if (
				typeof prompt !== "string" ||
				!prompt ||
				(row.promptHash && hashPrompt(prompt) !== row.promptHash)
			) {
				return abort("not_retryable", 409, { error: "not_retryable" });
			}
			try {
				const queued = await queuePromptAction(row.sessionId, prompt, ctx.actor, tx);
				const moved = await moveDeliveryToAction(tx, {
					deliveryId: row.id,
					fromActionId: row.controlActionId,
					toActionId: queued.id,
					attempt: row.attempt + 1,
				});
				if (!moved) return abort("retry_conflict", 409, { error: "retry_conflict" });
				return { ok: true as const, state: "queued" as const, deliveryId: row.id };
			} catch (err) {
				if (err instanceof ControlBusyError)
					return abort("control_busy", 409, { error: "control_busy" });
				if (
					err instanceof SessionNotManagedError ||
					err instanceof LaunchMismatchError ||
					err instanceof LaunchNotFoundError
				) {
					return abort("not_retryable", 409, { error: "not_retryable" });
				}
				throw err;
			}
		});
	} catch (err) {
		if (err instanceof DecisionAbort) return { ok: false, refusal: err.refusal };
		throw err;
	}
}
