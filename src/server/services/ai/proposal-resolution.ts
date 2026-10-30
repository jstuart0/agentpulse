/**
 * The only way a watcher sends a prompt to an agent.
 *
 * Two entry points:
 *
 *  - dispatchPrompt(sessionId, request, actor, ctx) is the core. It knows
 *    nothing about HITLs. It sanitises and filters the text, then runs one
 *    serialised transaction that re-checks everything that can change (the
 *    kill switches, the confirmed configuration, whether the turn has moved on,
 *    the caps) and only then queues the prompt, counting it, auditing it and
 *    taking the session's control lock in the same transaction. An expected
 *    refusal never rolls anything back: it updates the audit row and commits.
 *  - resolveProposal(...) is a human decision on a HITL: it claims the request
 *    before any side effect, checks the TTL and that the person approved what
 *    the server holds, calls dispatchPrompt, and gives the claim back only on a
 *    refusal that happened before anything was queued.
 *
 * The auto policy calls dispatchPrompt directly. Its request carries no text:
 * the text is looked up from a frozen table of fixed nudges, so model output
 * can never reach an agent unattended.
 *
 * Every statement inside the transaction goes through its own handle, and
 * nothing in it awaits anything but the database (the sanitiser, the filter,
 * hashing and the mode read happen before; event emits after). That is what
 * lets the transaction use the admin lock's discipline (a single connection on
 * SQLite, a pooled connection plus an advisory lock on Postgres) without ever
 * waiting on a second connection.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { HitlReplyKind } from "../../../shared/types.js";
import type { Actor } from "../../auth/actor.js";
import { config } from "../../config.js";
import { withAdminLock } from "../../db/admin-lock.js";
import { getDb } from "../../db/client.js";
import {
	aiHitlRequests,
	controlActions,
	sessions,
	users,
	watcherConfigs,
} from "../../db/schema/index.js";
import { enqueuePromptInTx } from "../control-actions.js";
import { getMode } from "../instance-mode.js";
import { notifyInboxChanged } from "../notifier.js";
import { getSessionOwnerConnections } from "../session-ownership.js";
import { emitAiEvent } from "./ai-events.js";
import {
	AUTO_CONTINUE_KINDS,
	type AutoContinueKind,
	CONTINUE_KINDS,
	type ContinueKind,
} from "./continue-kinds.js";
import {
	type AuditActorKind,
	type AuditIntent,
	configSnapshotOf,
	insertAuditIntent,
	insertFailedAudit,
	insertRefusedAudit,
	markAuditRefused,
	markAuditSent,
	sha256Hex,
} from "./dispatch-audit-service.js";
import { checkDispatch } from "./dispatch-filter.js";
import {
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	AI_WATCHER_AUTO_SEND_PAUSED_KEY,
	interpretAutoSendPaused,
	interpretKillSwitch,
	isAiBuildEnabled,
	readAiFlagUncached,
} from "./feature.js";
import { claimHitl, closeOpenHitl, getHitlRequest, releaseHitlClaim } from "./hitl-service.js";
import { readableCopyOf, sanitizeOutboundPrompt } from "./prompt-sanitiser.js";
import { type ProposalRecord, getProposal } from "./proposals-service.js";
import { getProvider } from "./providers-service.js";
import { isTurnStale } from "./turn-identity.js";
import { getWatcherConfig, incrementContinuations } from "./watcher-config-service.js";

// ── Auto: the fixed nudges ────────────────────────────────────────────────────

export { AUTO_CONTINUE_KINDS, CONTINUE_KINDS };
export type { AutoContinueKind, ContinueKind };

/**
 * A read-only view of the nudge table. The map is private to the instance, so
 * there is nothing to `.set()`; lookups use `has`, so a prototype key such as
 * `__proto__` or `toString` is simply absent.
 */
class ContinueTemplates {
	readonly #templates = new Map<AutoContinueKind, string>([
		["retry_failed_step", "The last step failed. Retry it, and fix the cause if it is clear."],
		["run_tests", "Run the project's tests and fix any failures."],
		["summarize_status", "Summarize what you have done so far and what is left."],
	]);

	has(kind: unknown): kind is AutoContinueKind {
		return typeof kind === "string" && this.#templates.has(kind as AutoContinueKind);
	}

	get(kind: AutoContinueKind): string {
		// Every AutoContinueKind has an entry; `has` is how an untyped value is checked first.
		return this.#templates.get(kind) as string;
	}

	keys(): AutoContinueKind[] {
		return [...this.#templates.keys()];
	}

	values(): string[] {
		return [...this.#templates.values()];
	}
}

export const CONTINUE_TEMPLATES: Readonly<ContinueTemplates> = Object.freeze(
	new ContinueTemplates(),
);

/** The actor recorded for an automatic send. */
export const AI_ACTOR: Actor = { userId: null, label: "ai" };

// ── Caps ─────────────────────────────────────────────────────────────────────

export const AUTO_SENDS_PER_SESSION_PER_HOUR = 6;
export const AUTO_SENDS_GLOBAL_PER_HOUR = 20;
export const HITL_TTL_MS = 20 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A person's custom prompt may be this long. A suggestion is capped to the same length so it can be shown whole. */
export const HUMAN_PROMPT_MAX_CHARS = 1_500;

// ── Types ────────────────────────────────────────────────────────────────────

/** What is to be sent. An auto request carries no text. */
export type DispatchRequest =
	| { kind: "auto"; continueKind: AutoContinueKind }
	| { kind: "human"; text: string };

export interface DispatchContext {
	actorKind: AuditActorKind;
	proposalId: string;
	hitlId?: string | null;
	/** The event the proposal was made for. Null means the proposal can't be tied to a turn, and is stale. */
	triggerEventId: number | null;
	turnKey: string | null;
	telegram?: { fromId: string; chatId: string };
	/**
	 * Runs inside the dispatch transaction right after the prompt is queued, so a record of the
	 * send commits or rolls back with it (the delivery row a phone reads the outcome from).
	 */
	onQueued?: (tx: Tx, queued: { controlActionId: string; prompt: string }) => Promise<void>;
	/** A retry replaces this failed prompt action: it doesn't count as the turn having moved on. */
	supersedesActionId?: string;
}

export type DispatchResult =
	| { ok: true; controlActionId: string; auditId: string; prompt: string }
	| {
			ok: false;
			status: 400 | 404 | 409 | 500;
			code: string;
			reason?: string;
			/** Always false: a refusal never queues anything, so a caller may release a claim. */
			enqueued: false;
	  };

type Refusal = Extract<DispatchResult, { ok: false }>;

function refusal(status: Refusal["status"], code: string, reason?: string): Refusal {
	return { ok: false, status, code, ...(reason ? { reason } : {}), enqueued: false };
}

/** The code stored on the audit row: specific enough to tell two refusals of one kind apart. */
function auditCodeOf(refused: Refusal): string {
	return refused.reason ? `${refused.code}:${refused.reason}` : refused.code;
}

type TxOutcome = { ok: true; controlActionId: string } | Refusal;

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
type Tx = any;

// ── The core ─────────────────────────────────────────────────────────────────

export async function dispatchPrompt(
	sessionId: string,
	request: DispatchRequest,
	actor: Actor,
	ctx: DispatchContext,
): Promise<DispatchResult> {
	if ((request.kind === "auto") !== (ctx.actorKind === "auto")) {
		throw new Error(
			"dispatchPrompt: an auto request needs actorKind 'auto', and only an auto request may have it",
		);
	}

	// Nothing here touches the database except the audit rows of a refusal.
	const baseIntent = await baseIntentFor(sessionId, request, actor, ctx);

	if (request.kind === "auto" && !CONTINUE_TEMPLATES.has(request.continueKind)) {
		return refuseBeforeTransaction(
			sessionId,
			baseIntent,
			refusal(409, "auto_send_blocked", "unknown_kind"),
		);
	}
	const text =
		request.kind === "auto" ? (CONTINUE_TEMPLATES.get(request.continueKind) ?? "") : request.text;

	const sanitised = sanitizeOutboundPrompt(text);
	if (!sanitised.ok) {
		return refuseBeforeTransaction(
			sessionId,
			baseIntent,
			refusal(400, "prompt_unsafe", sanitised.reason),
			text,
		);
	}
	const prompt = sanitised.text;
	const filter = checkDispatch(prompt);
	if (!filter.allowed) {
		return refuseBeforeTransaction(
			sessionId,
			baseIntent,
			refusal(400, "dispatch_blocked", filter.rule),
			prompt,
		);
	}

	const mode = await getMode();
	// Generated now, so the intent row names the action it is about to create.
	const controlActionId = crypto.randomUUID();
	const intent: AuditIntent = {
		...baseIntent,
		promptSha256: sha256Hex(prompt),
		promptText: prompt,
		controlActionId,
	};

	let outcome: TxOutcome;
	let auditId = "";
	try {
		outcome = await withAdminLock(async (tx) => {
			auditId = await insertAuditIntent(tx, intent);
			const result = await runDispatchChecksAndEnqueue(tx, {
				sessionId,
				request,
				prompt,
				actor,
				ctx,
				mode,
				auditId,
				controlActionId,
			});
			if (result.ok) await markAuditSent(tx, auditId);
			else await markAuditRefused(tx, auditId, auditCodeOf(result));
			return result;
		});
	} catch (err) {
		// The transaction rolled back: this row is the only trace.
		console.error(
			JSON.stringify({
				kind: "ai_dispatch_failed",
				level: "error",
				sessionId,
				error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
			}),
		);
		await insertFailedAudit(intent, "dispatch_failed").catch(() => {
			// the audit write failing too is already logged above
		});
		return refusal(500, "dispatch_failed");
	}

	if (!outcome.ok) {
		await emitBlocked(sessionId, outcome, ctx, auditId);
		return outcome;
	}

	// The prompt is queued. Nothing from here on may report failure: a caller
	// that saw one would release its claim and let the same prompt go twice.
	try {
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_continue_sent",
			eventType: "AiContinueSent",
			content: prompt,
			rawPayload: {
				actor_kind: ctx.actorKind,
				actor_user_id: actor.userId,
				control_action_id: outcome.controlActionId,
				proposal_id: ctx.proposalId,
				hitl_id: ctx.hitlId ?? null,
				audit_id: auditId,
			},
		});
	} catch (err) {
		console.error("[ai-watcher] AiContinueSent event failed after a successful send:", err);
	}
	return { ok: true, controlActionId: outcome.controlActionId, auditId, prompt };
}

async function baseIntentFor(
	sessionId: string,
	request: DispatchRequest,
	actor: Actor,
	ctx: DispatchContext,
): Promise<AuditIntent> {
	const [session] = await getDb()
		.select({ displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const watcher = await getWatcherConfig(sessionId);
	const provider = watcher ? await getProvider(watcher.providerId) : null;
	return {
		sessionId,
		sessionName: session?.displayName ?? null,
		actorKind: ctx.actorKind,
		actorUserId: actor.userId,
		actorLabel: actor.label,
		telegramFromId: ctx.telegram?.fromId ?? null,
		telegramChatId: ctx.telegram?.chatId ?? null,
		promptSha256: null,
		promptText: null,
		continueKind: request.kind === "auto" ? String(request.continueKind) : null,
		proposalId: ctx.proposalId,
		hitlId: ctx.hitlId ?? null,
		turnKey: ctx.turnKey,
		providerId: watcher?.providerId ?? null,
		model: provider?.model ?? null,
		configSnapshot: configSnapshotOf(watcher),
	};
}

/** A refusal decided before the transaction: one `refused` audit row and one event. */
async function refuseBeforeTransaction(
	sessionId: string,
	intent: AuditIntent,
	refused: Refusal,
	text?: string,
): Promise<Refusal> {
	// The attempted text is kept for the trail, made readable: a refused prompt may
	// hold control characters a text column should not be asked to store.
	const withText: AuditIntent =
		text === undefined
			? intent
			: { ...intent, promptSha256: sha256Hex(text), promptText: readableCopyOf(text) };
	const auditId = await insertRefusedAudit(withText, auditCodeOf(refused));
	await emitBlocked(sessionId, refused, undefined, auditId, intent);
	return refused;
}

async function emitBlocked(
	sessionId: string,
	refused: Refusal,
	ctx: DispatchContext | undefined,
	auditId: string,
	intent?: AuditIntent,
): Promise<void> {
	try {
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_continue_blocked",
			eventType: "AiContinueBlocked",
			content: `Prompt not sent: ${auditCodeOf(refused)}`,
			rawPayload: {
				code: refused.code,
				reason: refused.reason ?? null,
				audit_id: auditId,
				proposal_id: ctx?.proposalId ?? intent?.proposalId ?? null,
			},
		});
	} catch (err) {
		console.error("[ai-watcher] AiContinueBlocked event failed:", err);
	}
}

interface DispatchChecks {
	sessionId: string;
	request: DispatchRequest;
	prompt: string;
	actor: Actor;
	ctx: DispatchContext;
	mode: "solo" | "team";
	auditId: string;
	controlActionId: string;
}

/**
 * Everything that can change between a decision and a send, judged on the
 * transaction's own connection. The order is fixed: the kill switches first,
 * then the configuration an unattended send relies on, then whether the turn
 * has moved on, then the caps, and only then the enqueue.
 */
async function runDispatchChecksAndEnqueue(tx: Tx, input: DispatchChecks): Promise<TxOutcome> {
	const { sessionId, request, prompt, actor, ctx, mode, controlActionId } = input;
	const isAuto = request.kind === "auto";

	// 1. Kill switches, read uncached so a flip is never delayed.
	if (!isAiBuildEnabled()) return refusal(409, "ai_paused");
	const enabled = await readAiFlagUncached(tx, AI_RUNTIME_ENABLED_KEY);
	if (!enabled.ok || enabled.value !== true) return refusal(409, "ai_paused");
	const killed = await readAiFlagUncached(tx, AI_KILL_SWITCH_KEY);
	if (!killed.ok || interpretKillSwitch(killed.value)) return refusal(409, "ai_paused");

	const [session] = await tx
		.select({
			displayName: sessions.displayName,
			agentType: sessions.agentType,
			ownerUserId: sessions.ownerUserId,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return refusal(404, "session_missing");

	// 2. For auto: paused? still enabled, still confirmed, by someone still allowed?
	let watcher: typeof watcherConfigs.$inferSelect | undefined;
	if (isAuto) {
		const paused = await readAiFlagUncached(tx, AI_WATCHER_AUTO_SEND_PAUSED_KEY);
		if (!paused.ok || interpretAutoSendPaused(paused.value)) {
			return refusal(409, "auto_send_blocked", "paused");
		}
		[watcher] = await tx
			.select()
			.from(watcherConfigs)
			.where(eq(watcherConfigs.sessionId, sessionId))
			.limit(1);
		if (
			!watcher ||
			!watcher.enabled ||
			!watcher.continueEnabled ||
			watcher.policy !== "auto" ||
			watcher.autoConfirmedAt === null
		) {
			return refusal(409, "auto_send_blocked", "config_changed");
		}
		if (!(await confirmerStillAllowed(tx, watcher.autoConfirmedBy, session.ownerUserId, mode))) {
			// Both columns are cleared in this transaction: the confirmation is spent.
			await tx
				.update(watcherConfigs)
				.set({ autoConfirmedAt: null, autoConfirmedBy: null, updatedAt: new Date().toISOString() })
				.where(eq(watcherConfigs.sessionId, sessionId));
			return refusal(409, "auto_send_blocked", "confirmer_lapsed");
		}
	}

	// 3. Has the turn moved on? A proposal that can't be tied to a turn is stale by definition.
	if (ctx.triggerEventId === null || ctx.turnKey === null) return refusal(409, "stale_proposal");
	const stale = await isTurnStale(
		tx,
		{ sessionId, agentType: session.agentType },
		ctx.turnKey,
		{ id: ctx.triggerEventId },
		{ ignoreActionId: ctx.supersedesActionId },
	);
	if (stale) return refusal(409, "stale_proposal");

	// 4. Caps: automatic sends only. A person is never refused for them.
	if (isAuto && watcher) {
		if (watcher.continuationsUsed >= watcher.maxContinuations) {
			return refusal(409, "auto_send_blocked", "continuation_cap");
		}
		const since = new Date(Date.now() - HOUR_MS).toISOString();
		const forSession = await countAutoSends(tx, since, sessionId);
		const global = await countAutoSends(tx, since, null);
		if (forSession >= AUTO_SENDS_PER_SESSION_PER_HOUR || global >= AUTO_SENDS_GLOBAL_PER_HOUR) {
			return refusal(409, "auto_send_blocked", "hourly_cap");
		}
		// An unattended send needs the supervisor to be there to take it.
		const live = (await getSessionOwnerConnections([sessionId], Date.now(), tx)).get(sessionId);
		if (live === false) return refusal(409, "prompt_not_deliverable", "supervisor_offline");
	}

	// 5. Queue it. The conditional lock inside decides a race with any other sender.
	const queued = await enqueuePromptInTx(tx, { sessionId, prompt, actor, controlActionId });
	if (!queued.ok) return refusalForEnqueue(queued.reason);
	await ctx.onQueued?.(tx, { controlActionId, prompt });

	if (isAuto) await incrementContinuations(sessionId, tx);
	return { ok: true, controlActionId };
}

function refusalForEnqueue(reason: string): Refusal {
	switch (reason) {
		case "not_managed":
			return refusal(409, "prompt_not_deliverable", "observed");
		case "session_missing":
			return refusal(404, "session_missing");
		case "launch_missing":
			return refusal(409, "launch_missing");
		case "launch_mismatch":
			return refusal(409, "prompt_not_deliverable", "launch_mismatch");
		default:
			return refusal(409, "prompt_not_deliverable", "control_busy");
	}
}

async function countAutoSends(tx: Tx, sinceIso: string, sessionId: string | null): Promise<number> {
	const filters = [
		eq(controlActions.requestedBy, "ai"),
		eq(controlActions.actionType, "prompt"),
		gte(controlActions.createdAt, sinceIso),
	];
	if (sessionId !== null) filters.push(eq(controlActions.sessionId, sessionId));
	const [row] = await tx
		.select({ n: sql<number>`count(*)` })
		.from(controlActions)
		.where(and(...filters));
	return Number(row?.n ?? 0);
}

/**
 * Is whoever confirmed `auto` still someone who could? Under DISABLE_AUTH the
 * operator ("local") always is. Otherwise they must still exist and be
 * enabled, and in team mode be an admin or the session's owner.
 */
async function confirmerStillAllowed(
	tx: Tx,
	confirmedBy: string | null,
	sessionOwnerUserId: string | null,
	mode: "solo" | "team",
): Promise<boolean> {
	if (confirmedBy === null) return false;
	if (config.disableAuth && confirmedBy === "local") return true;
	const [user] = await tx
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, confirmedBy))
		.limit(1);
	if (!user || user.disabledAt !== null) return false;
	if (mode === "solo") return true;
	return user.role === "admin" || confirmedBy === sessionOwnerUserId;
}

// ── The human decision ───────────────────────────────────────────────────────

/** What a person is shown, copied and approves: the stored suggestion, else the older cleared prompt. */
export function proposalPrompt(
	p: Pick<ProposalRecord, "suggestedPrompt" | "nextPrompt">,
): string | null {
	return p.suggestedPrompt ?? p.nextPrompt ?? null;
}

export type ResolveAction = HitlReplyKind;

export interface ResolveInput {
	/** Resolve by the HITL's id, or by its proposal's. The session always comes from the HITL row, never the request. */
	hitlId?: string;
	proposalId?: string;
	action: unknown;
	customPrompt?: string;
	/** The hash of the prompt the person was shown (the in-app Approve). A Telegram tap passes the stored hash. */
	promptSha256?: string;
	actor: Actor;
	actorKind: Extract<AuditActorKind, "user" | "telegram">;
	telegram?: { fromId: string; chatId: string };
	/** The API key the decision came in with, for the timeline only; null for a person signed in by cookie or SSO. */
	keyId?: string | null;
	/** See DispatchContext.onQueued. Only an approve or a custom prompt reaches it. */
	onQueued?: DispatchContext["onQueued"];
}

export type ResolveResult =
	| { ok: true; action: "declined" }
	| { ok: true; action: "applied"; controlActionId: string; prompt: string; auditId: string }
	| {
			ok: false;
			status: 400 | 404 | 409 | 500;
			code: string;
			reason?: string;
	  };

function resolveRefusal(
	status: 400 | 404 | 409 | 500,
	code: string,
	reason?: string,
): ResolveResult {
	return { ok: false, status, code, ...(reason ? { reason } : {}) };
}

export async function resolveProposal(input: ResolveInput): Promise<ResolveResult> {
	const { action } = input;
	if (action !== "approve" && action !== "decline" && action !== "custom") {
		return resolveRefusal(400, "invalid_action");
	}

	const hitl = await loadHitl(input);
	if (!hitl) {
		// A proposal from before HITL rows existed has no trigger to bind to: it sends nothing.
		if (input.proposalId && (await getProposal(input.proposalId))) {
			return resolveRefusal(409, "stale_proposal");
		}
		return resolveRefusal(404, "hitl_not_found");
	}
	const proposal = await getProposal(hitl.proposalId);
	if (!proposal) return resolveRefusal(404, "proposal_not_found");
	if (proposal.state !== "hitl_waiting") return resolveRefusal(409, "already_resolved");

	if (action !== "decline" && (hitl.triggerEventId === null || hitl.promptSha256 === null)) {
		// Made before this release: it can't be tied to a turn or to what was shown, so it sends nothing.
		return resolveRefusal(409, "stale_proposal");
	}

	let prompt = "";
	if (action === "approve") {
		if (hitl.approvable !== true) return resolveRefusal(409, "not_approvable");
		prompt = proposalPrompt(proposal) ?? "";
		if (prompt === "") return resolveRefusal(400, "empty_prompt");
		const shown = sha256Hex(prompt);
		if (shown !== hitl.promptSha256 || shown !== input.promptSha256) {
			return resolveRefusal(409, "prompt_changed");
		}
	} else if (action === "custom") {
		prompt = (input.customPrompt ?? "").trim();
		if (prompt === "") return resolveRefusal(400, "empty_prompt");
		if (prompt.length > HUMAN_PROMPT_MAX_CHARS) return resolveRefusal(400, "prompt_too_long");
	}

	// Claim before any side effect: of two concurrent decisions, exactly one gets the row.
	const claim = await claimHitl({
		id: hitl.id,
		status: action === "decline" ? "declined" : "applied",
		replyKind: action,
		replyText: action === "custom" ? prompt : null,
	});
	if (!claim) {
		const fresh = await getHitlRequest(hitl.id);
		if (fresh?.status === "awaiting_reply") {
			// Still open, so the claim failed on the TTL.
			await closeOpenHitl(hitl.id, "timed_out");
			return resolveRefusal(409, "expired");
		}
		return resolveRefusal(409, "already_resolved");
	}

	if (action === "decline") {
		await emitHitlResponse(hitl.sessionId, proposal.id, "decline", "Declined.", input);
		notifyInboxChanged({ sessionId: hitl.sessionId });
		return { ok: true, action: "declined" };
	}

	const result = await dispatchPrompt(
		hitl.sessionId,
		{ kind: "human", text: prompt },
		input.actor,
		{
			actorKind: input.actorKind,
			proposalId: proposal.id,
			hitlId: hitl.id,
			triggerEventId: hitl.triggerEventId,
			turnKey: hitl.turnKey,
			telegram: input.telegram,
			onQueued: input.onQueued,
		},
	);

	if (!result.ok) {
		// Only a refusal that queued nothing may give the claim back. If the turn
		// moved on while we were deciding, the request is closed instead.
		if (!result.enqueued) await releaseOrClose(hitl, claim.claimedAt);
		return resolveRefusal(result.status, result.code, result.reason);
	}

	await emitHitlResponse(
		hitl.sessionId,
		proposal.id,
		action,
		action === "custom" ? "Custom prompt sent." : "Approved and sent.",
		input,
	);
	notifyInboxChanged({ sessionId: hitl.sessionId });
	return {
		ok: true,
		action: "applied",
		controlActionId: result.controlActionId,
		prompt: result.prompt,
		auditId: result.auditId,
	};
}

async function loadHitl(input: ResolveInput) {
	if (input.hitlId) return getHitlRequest(input.hitlId);
	if (!input.proposalId) return null;
	const [row] = await getDb()
		.select({ id: aiHitlRequests.id })
		.from(aiHitlRequests)
		.where(eq(aiHitlRequests.proposalId, input.proposalId))
		.orderBy(sql`${aiHitlRequests.createdAt} desc`)
		.limit(1);
	return row ? getHitlRequest(row.id) : null;
}

async function releaseOrClose(
	hitl: NonNullable<Awaited<ReturnType<typeof getHitlRequest>>>,
	claimedAt: string,
): Promise<void> {
	const [session] = await getDb()
		.select({ agentType: sessions.agentType })
		.from(sessions)
		.where(eq(sessions.sessionId, hitl.sessionId))
		.limit(1);
	const moved =
		hitl.turnKey !== null && hitl.triggerEventId !== null && session
			? await isTurnStale(
					getDb(),
					{ sessionId: hitl.sessionId, agentType: session.agentType },
					hitl.turnKey,
					{ id: hitl.triggerEventId },
				)
			: true;
	const released = moved
		? false
		: await releaseHitlClaim({ id: hitl.id, sessionId: hitl.sessionId, claimedAt });
	if (!released) {
		// Close it for the right reason: a request that was given back and
		// displaced is superseded; the claim itself is still `applied`, so mark it.
		await getDb()
			.update(aiHitlRequests)
			.set({ status: "superseded", updatedAt: new Date().toISOString() })
			.where(and(eq(aiHitlRequests.id, hitl.id), eq(aiHitlRequests.status, "applied")));
	}
}

async function emitHitlResponse(
	sessionId: string,
	proposalId: string,
	action: ResolveAction,
	content: string,
	input: ResolveInput,
): Promise<void> {
	try {
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_hitl_response",
			eventType: "AiHitlResponse",
			content,
			rawPayload: {
				proposal_id: proposalId,
				action,
				actor_kind: input.actorKind,
				actor_user_id: input.actor.userId,
				...(input.keyId ? { key_id: input.keyId } : {}),
				...(input.actorKind === "telegram" ? { channel: "telegram" } : {}),
			},
		});
	} catch (err) {
		console.error("[ai-watcher] AiHitlResponse event failed:", err);
	}
}
