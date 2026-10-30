/**
 * The one place a person's answer to an agent's request is judged for a signed-in caller.
 *
 * Every way of deciding a HITL from the dashboard or a phone (the proposal route, the inbox
 * decide route, batch decline) goes through `decideHitl`. It decides who may answer and with
 * what, then hands the answer to `resolveProposal`, which owns the claim, the safety checks,
 * the dispatch audit and the queueing of the prompt. Nothing here sends a prompt itself.
 *
 *  - `custom` text needs a caller allowed to write prompts (`manage`, or a signed-in
 *    human), never a `respond` key;
 *  - the caller must be the session's owner or an admin (team mode);
 *  - an approve carries the hash of the prompt the person reviewed, and a prompt that has
 *    changed since is refused (`prompt_changed`);
 *  - an approved prompt becomes a control action in the dispatch transaction, and the
 *    `ai_hitl_deliveries` row naming it commits with it.
 *
 * Telegram does not come through here: a chat tap goes to `resolveProposal` from the channel
 * route, after the route has judged the chat. `DecisionContext` is built by a route helper from
 * the authenticated request and never from anything the request body says.
 *
 * What happened to the prompt afterwards is not copied anywhere: `ai_hitl_deliveries` names the
 * control action carrying it, and the state a caller sees is that action's own status.
 */
import { and, eq } from "drizzle-orm";
import type { HitlReplyKind } from "../../../shared/types.js";
import type { Actor } from "../../auth/actor.js";
import { scopesIncludeManage } from "../../auth/route-scope-policy.js";
import { getDb } from "../../db/client.js";
import { aiHitlDeliveries, aiHitlRequests, controlActions } from "../../db/schema/index.js";
import { NOT_OWNER_MESSAGE, NotOwnerError, assertCanChangeSessions } from "../authorization.js";
import { CONTROL_TIMEOUT_ERROR, expireStaleControlLock } from "../control-actions.js";
import { notifyInboxChanged } from "../notifier.js";
import { emitAiEvent } from "./ai-events.js";
import {
	type HitlRequestRecord,
	effectiveExpiry,
	getHitlRequest,
	getOpenHitlForProposal,
} from "./hitl-service.js";
import { hashPrompt } from "./prompt-hash.js";
import { dispatchPrompt, resolveProposal } from "./proposal-resolution.js";
import { type ProposalRecord, getProposal } from "./proposals-service.js";

export { hashPrompt };

export type DecisionSource = "api_key" | "session" | "sso";

export interface DecisionContext {
	actor: Actor;
	source: DecisionSource;
	/** The API key the request came in with; null for a person signed in by cookie or SSO. */
	keyId: string | null;
	scopes: readonly string[];
	/** True for `manage` / `*` and for a signed-in human; false for `respond`. Set by the route helper from the authenticated caller. */
	canCustomPrompt: boolean;
}

export type DecisionTarget =
	| { kind: "proposal"; proposalId: string }
	| { kind: "hitl"; hitlId: string };

export interface DecisionInput {
	customPrompt?: string;
	/** SHA-256 (lowercase hex) of the proposed prompt the person reviewed. Checked on approve. */
	promptHash?: string;
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
	/** A code of this service's own, or the one `resolveProposal` refused with. */
	code: string;
	status: 400 | 403 | 404 | 409 | 500;
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
			controlActionId: string | null;
			delivery: { state: DeliveryStateName; deliveryId: string; reason?: string } | null;
	  }
	| { ok: false; refusal: DecisionRefusal };

const refuse = (
	code: DecisionRefusal["code"],
	status: DecisionRefusal["status"],
	body: Record<string, unknown>,
): DecisionOutcome => ({ ok: false, refusal: { code, status, body } });

/** A dispatch refusal as the routes answer it: the code `resolveProposal` refused with, and its reason. */
function refuseWith(result: {
	status: 400 | 404 | 409 | 500;
	code: string;
	reason?: string;
}): DecisionOutcome {
	return refuse(result.code, result.status, {
		error: result.code,
		...(result.reason ? { reason: result.reason } : {}),
	});
}

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

/**
 * Applies one decision. `target` names a proposal or a HITL request. Returns a refusal (with the
 * status and body to answer with) rather than throwing for anything a caller can cause.
 */
export async function decideHitl(
	target: DecisionTarget,
	action: HitlReplyKind,
	input: DecisionInput,
	ctx: DecisionContext,
): Promise<DecisionOutcome> {
	const loaded = await loadTarget(target);
	if (isOutcome(loaded)) return loaded;
	const { hitl, sessionId, proposalId } = loaded;

	if (action === "custom" && !mayWritePrompts(ctx)) {
		return refuse("insufficient_scope", 403, { error: "insufficient_scope", required: "manage" });
	}
	const refused = await refuseUnlessMayChange(ctx, sessionId);
	if (refused) return refused;
	if (loaded.stale) return loaded.stale;
	if (action === "approve" && input.promptHash === undefined) {
		return refuse("prompt_hash_required", 400, {
			error: "prompt_hash_required",
			message: "Approve with the promptHash of the prompt you reviewed.",
		});
	}

	let deliveryId: string | null = null;
	const result = await resolveProposal({
		hitlId: hitl?.id,
		proposalId,
		action,
		customPrompt: input.customPrompt,
		promptSha256: input.promptHash,
		actor: ctx.actor,
		actorKind: "user",
		keyId: ctx.keyId,
		onQueued: async (tx, queued) => {
			deliveryId = await recordDelivery(tx, {
				proposalId,
				hitlId: hitl?.id ?? `legacy:${proposalId}`,
				sessionId,
				controlActionId: queued.controlActionId,
				prompt: queued.prompt,
				ctx,
			});
		},
	});
	if (!result.ok) return refuseWith(result);

	const resolved = hitl ? await getHitlRequest(hitl.id) : null;
	if (result.action === "declined" || deliveryId === null) {
		return {
			ok: true,
			hitl: resolved,
			proposalId,
			sessionId,
			action,
			prompt: null,
			controlActionId: null,
			delivery: null,
		};
	}
	return {
		ok: true,
		hitl: resolved,
		proposalId,
		sessionId,
		action,
		prompt: result.prompt,
		controlActionId: result.controlActionId,
		delivery: { state: "queued", deliveryId },
	};
}

/** The row a phone reads an approved prompt's outcome from. Written in the dispatch transaction. */
async function recordDelivery(
	// biome-ignore lint/suspicious/noExplicitAny: the transaction handle is dialect-typed (see withAdminLock)
	tx: any,
	args: {
		proposalId: string;
		hitlId: string;
		sessionId: string;
		controlActionId: string;
		prompt: string;
		ctx: DecisionContext;
	},
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await tx.insert(aiHitlDeliveries).values({
		id,
		proposalId: args.proposalId,
		hitlId: args.hitlId,
		sessionId: args.sessionId,
		controlActionId: args.controlActionId,
		attempt: 1,
		terminalState: null,
		approvedByUserId: args.ctx.actor.userId,
		approvedByKeyId: args.ctx.keyId,
		promptHash: hashPrompt(args.prompt),
		createdAt: now,
		updatedAt: now,
	});
	return id;
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

const deliveryNotFound: DecisionRefusal = {
	code: "not_found",
	status: 404,
	body: { error: "not_found", message: "delivery not found" },
};

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
	await expireStaleControlLock(getDb(), row.sessionId);
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
	if (!row) return { ok: false, refusal: deliveryNotFound };
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
	// biome-ignore lint/suspicious/noExplicitAny: the transaction handle is dialect-typed (see withAdminLock)
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
 * Sends the approved prompt again after an attempt failed. The prompt goes out through the same
 * dispatch as the first one (its checks, its audit row), and a guarded write moves the delivery
 * from the failed action to the new one in the dispatch transaction, so of two concurrent retries
 * one wins and the other is refused 409 (`stale_proposal`: the winner's prompt moved the turn on).
 */
export async function retryDelivery(
	proposalId: string,
	ctx: DecisionContext,
	options: { confirm?: boolean } = {},
): Promise<
	| { ok: true; state: DeliveryStateName; deliveryId: string }
	| { ok: false; refusal: DecisionRefusal }
> {
	const row = await deliveryFor(proposalId);
	if (!row) return { ok: false, refusal: deliveryNotFound };
	const refused = await refuseUnlessMayChange(ctx, row.sessionId);
	if (refused && !refused.ok) return { ok: false, refusal: refused.refusal };

	const notRetryable = () => refuse("not_retryable", 409, { error: "not_retryable" });
	const failure = (outcome: DecisionOutcome) => {
		if (outcome.ok) throw new Error("retryDelivery: a refusal was expected");
		return { ok: false as const, refusal: outcome.refusal };
	};

	if (row.terminalState || !row.controlActionId) return failure(notRetryable());
	// An approval is only good for as long as a request is answerable: an older delivery is not re-sent.
	if (effectiveExpiry({ expiresAt: null, createdAt: row.createdAt }) <= Date.now()) {
		return failure(notRetryable());
	}
	await expireStaleControlLock(getDb(), row.sessionId);
	const [previous] = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, row.controlActionId))
		.limit(1);
	if (previous && previous.status !== "failed") {
		return failure(refuse("not_failed", 409, { error: "not_failed" }));
	}
	if (previous?.error === CONTROL_TIMEOUT_ERROR && options.confirm !== true) {
		// It may have run: sending again could do the work twice, so the person has to say so.
		return failure(
			refuse("confirm_required", 409, {
				error: "confirm_required",
				message: "The first attempt may have run. Retry with confirm: true to send it again.",
			}),
		);
	}
	const prompt = (previous?.metadata as { prompt?: unknown } | null)?.prompt;
	if (
		typeof prompt !== "string" ||
		!prompt ||
		(row.promptHash && hashPrompt(prompt) !== row.promptHash)
	) {
		return failure(notRetryable());
	}
	const hitl = await getHitlRequest(row.hitlId);
	if (!hitl) return failure(notRetryable());

	const failedActionId = row.controlActionId;
	const result = await dispatchPrompt(row.sessionId, { kind: "human", text: prompt }, ctx.actor, {
		actorKind: "user",
		proposalId,
		hitlId: hitl.id,
		triggerEventId: hitl.triggerEventId,
		turnKey: hitl.turnKey,
		supersedesActionId: failedActionId,
		onQueued: async (tx, queued) => {
			const moved = await moveDeliveryToAction(tx, {
				deliveryId: row.id,
				fromActionId: failedActionId,
				toActionId: queued.controlActionId,
				attempt: row.attempt + 1,
			});
			// The dispatch's own turn check already refuses a second retry; if the delivery moved anyway,
			// throwing undoes this send with the transaction.
			if (!moved) throw new Error("delivery already moved");
		},
	});
	if (!result.ok) {
		return failure(refuseWith(result));
	}
	return { ok: true, state: "queued", deliveryId: row.id };
}
