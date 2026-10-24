/**
 * What the watcher does with a Continue answer from the model: the checks a
 * suggestion goes through, whether it may be sent without a person, and the
 * request a person decides when it may not.
 *
 * The model proposes; this decides. Order, for a `continue`:
 *   1. a reply to a person rather than an instruction is dropped (noise);
 *   2. the suggestion is cleaned and stored once, hashed as stored;
 *   3. a session that can't take a prompt, the safety filter, the text
 *      tripwire and the risk classes each send it to a person;
 *   4. only then may the `auto` policy send, and it sends a fixed nudge by
 *      kind, never the model's words, after the deterministic human gate.
 */
import { createHash } from "node:crypto";
import type { SessionEvent } from "../../../shared/types.js";
import { dispatchHitlToChannel } from "../channels/dispatch.js";
import { stampWatcherState } from "../managed-session-state.js";
import { emitAiEvent } from "./ai-events.js";
import type { WatcherEligibility } from "./continuability.js";
import { suggestionTripwire } from "./continue-checks.js";
import { AUTO_CONTINUE_KINDS } from "./continue-kinds.js";
import { checkDispatch, isConversationalReply } from "./dispatch-filter.js";
import { eventsOfTurn, needsHuman } from "./human-gate.js";
import type { AskDecision, ContinueDecision } from "./parser.js";
import { promptDeliverability } from "./prompt-deliverability.js";
import { readableCopyOf, sanitizeOutboundPrompt } from "./prompt-sanitiser.js";
import {
	AI_ACTOR,
	HITL_TTL_MS,
	HUMAN_PROMPT_MAX_CHARS,
	dispatchPrompt,
} from "./proposal-resolution.js";
import { cancelOpenHitl, completeProposal, completeProposalAsHitl } from "./proposals-service.js";
import { evaluateRisk, getRiskClasses } from "./risk-classes.js";
import type { WatcherConfigRecord } from "./watcher-config-service.js";

/** A suggestion is shown whole in a Telegram message and a card, so it is held to this. */
export const SUGGESTED_PROMPT_MAX_CHARS = HUMAN_PROMPT_MAX_CHARS;

export interface Completion {
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated: boolean;
}

export interface ContinueRoutingInput {
	sessionId: string;
	proposalId: string;
	decision: ContinueDecision | AskDecision;
	responseText: string;
	completion: Completion;
	watchConfig: WatcherConfigRecord;
	session: { displayName: string | null; cwd: string | null };
	/** The boundary event the run was woken for, and the key of the turn it ended. */
	trigger: SessionEvent;
	turnKey: string;
	recent: SessionEvent[];
	eligibility: WatcherEligibility;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Escalation {
	/** The text a person is shown, when the model's own suggestion isn't what they decide on. */
	askProposal: string | null;
	why: string;
}

/** The sentence for an automatic send that was refused, as the HITL's reason. Null: nothing for a person to decide. */
function autoRefusalWhy(
	refused: { code: string; reason?: string },
	config: WatcherConfigRecord,
): string | null {
	if (refused.code === "ai_paused" || refused.code === "stale_proposal") return null;
	switch (refused.reason) {
		case "paused":
			return "Auto-send is paused.";
		case "hourly_cap":
			return "Auto-send limit reached.";
		case "continuation_cap":
			return `Auto cap reached (${config.continuationsUsed} of ${config.maxContinuations}).`;
		case "config_changed":
		case "confirmer_lapsed":
			return "Auto-send needs a new confirmation.";
		case "supervisor_offline":
		case "observed":
		case "managed_state":
		case "control_busy":
			return `This session can't receive prompts (${refused.reason}).`;
		default:
			return refused.code === "prompt_not_deliverable" && refused.reason
				? `This session can't receive prompts (${refused.reason}).`
				: "Auto-send was refused, so this waits for you.";
	}
}

export async function routeContinueOrAsk(input: ContinueRoutingInput): Promise<void> {
	const { sessionId, proposalId, decision, watchConfig } = input;

	if (decision.decision === "continue" && isConversationalReply(decision.nextPrompt)) {
		await rejectConversational(input);
		return;
	}

	// The text a person decides on, cleaned once and kept as it was stored.
	let stored: string | null = null;
	let approvable = false;
	if (decision.decision === "continue") {
		const raw = decision.nextPrompt.trim();
		const cleaned = sanitizeOutboundPrompt(raw);
		stored = cleaned.ok ? cleaned.text : readableCopyOf(raw);
		approvable = cleaned.ok && cleaned.text === raw;
	}

	let nextPrompt: string | null = null; // cleared to send without a person
	let escalation: Escalation | null = null;

	if (decision.decision === "ask") {
		escalation = { askProposal: decision.proposal, why: decision.why ?? "" };
	} else if (stored !== null && stored.length > SUGGESTED_PROMPT_MAX_CHARS) {
		escalation = {
			askProposal: `${stored.slice(0, SUGGESTED_PROMPT_MAX_CHARS)}…`,
			why: "Suggested prompt too long to review.",
		};
		stored = null;
	} else if (stored !== null) {
		escalation = await escalationFor(input, stored);
		if (!escalation) nextPrompt = approvable ? stored : null;
		if (!escalation && !approvable) {
			escalation = {
				askProposal: stored,
				why: "Hidden or unsafe characters were removed from the suggestion.",
			};
		}
	}

	// Unattended: a fixed nudge by kind, only when nothing above objected.
	if (
		decision.decision === "continue" &&
		stored !== null &&
		nextPrompt !== null &&
		watchConfig.policy === "auto" &&
		isAutoKind(decision.continueKind)
	) {
		const riskConfig = await getRiskClasses();
		const gate = needsHuman(eventsOfTurn(input.recent, input.trigger.id), riskConfig);
		if (gate.hold) {
			escalation = { askProposal: stored, why: gate.why };
			nextPrompt = null;
		} else {
			const sent = await dispatchPrompt(
				sessionId,
				{ kind: "auto", continueKind: decision.continueKind },
				AI_ACTOR,
				{
					actorKind: "auto",
					proposalId,
					triggerEventId: input.trigger.id,
					turnKey: input.turnKey,
				},
			);
			if (sent.ok) {
				await completeProposal({
					id: proposalId,
					decision: "continue",
					nextPrompt: null,
					rawResponse: {
						raw: input.responseText,
						decision,
						auto: true,
						control_action_id: sent.controlActionId,
						continue_kind: decision.continueKind,
					},
					suggestedPrompt: stored,
					continueKind: decision.continueKind,
					...input.completion,
				});
				await stampWatcherState(sessionId, "idle");
				return;
			}
			const why = autoRefusalWhy(sent, watchConfig);
			if (why === null) {
				// Paused, or the turn moved on: there is nothing for a person to decide.
				await completeProposal({
					id: proposalId,
					decision: "continue",
					rawResponse: { raw: input.responseText, decision, auto_refused: sent.code },
					suggestedPrompt: stored,
					continueKind: decision.continueKind,
					...input.completion,
				});
				await stampWatcherState(sessionId, "idle");
				return;
			}
			escalation = { askProposal: stored, why };
			nextPrompt = null;
		}
	}

	await openRequest(input, { stored, approvable, nextPrompt, escalation });
}

function isAutoKind(kind: string | null): kind is (typeof AUTO_CONTINUE_KINDS)[number] {
	return kind !== null && (AUTO_CONTINUE_KINDS as readonly string[]).includes(kind);
}

/** Why this suggestion goes to a person, or null when nothing objects to it. */
async function escalationFor(
	input: ContinueRoutingInput,
	stored: string,
): Promise<Escalation | null> {
	const { sessionId, proposalId, eligibility, watchConfig } = input;
	if (!eligibility.eligibleToContinue) {
		return {
			askProposal: stored,
			why: `Session is ${eligibility.reason}; proposed prompt shown for manual paste.`,
		};
	}
	const filter = checkDispatch(stored);
	if (!filter.allowed) {
		await blocked(sessionId, "AiContinueBlocked", `Dispatch filter tripped: ${filter.reason}`, {
			proposal_id: proposalId,
			rule: filter.rule,
		});
		return {
			askProposal: stored,
			why: `Blocked by the safety filter (${filter.rule}); edit it to send.`,
		};
	}
	const tripped = suggestionTripwire(stored, input.recent);
	if (tripped.length > 0) {
		const why = `Held back by the text check: ${tripped.join(", ")}.`;
		await blocked(sessionId, "AiContinueBlocked", why, {
			proposal_id: proposalId,
			tripwire: tripped,
		});
		return { askProposal: stored, why };
	}
	if (watchConfig.policy === "ask_on_risk" || watchConfig.policy === "auto") {
		const hits = evaluateRisk(await getRiskClasses(), {
			proposedPrompt: stored,
			recentToolEvents: input.recent.map((e) => ({
				category: e.category,
				toolResponse: e.toolResponse,
				source: e.source,
				eventType: e.eventType,
			})),
		});
		if (hits.length > 0) {
			const why = `Risk class(es) matched: ${hits.map((h) => h.label).join(", ")}`;
			await blocked(sessionId, "AiRiskBlocked", why, {
				proposal_id: proposalId,
				risk_hits: hits,
			});
			return { askProposal: stored, why };
		}
	}
	return null;
}

async function blocked(
	sessionId: string,
	eventType: string,
	content: string,
	rawPayload: Record<string, unknown>,
): Promise<void> {
	await emitAiEvent({
		sessionId,
		source: "managed_control",
		category: "ai_continue_blocked",
		eventType,
		content,
		rawPayload,
	});
}

async function rejectConversational(input: ContinueRoutingInput): Promise<void> {
	await completeProposal({
		id: input.proposalId,
		decision: "wait",
		rawResponse: { raw: input.responseText, rejected: "conversational" },
		...input.completion,
	});
	await blocked(
		input.sessionId,
		"ContinueRejected",
		"The suggestion was a reply to a person, not an instruction, so it was dropped.",
		{ proposal_id: input.proposalId },
	);
	await stampWatcherState(input.sessionId, "cooling_down");
}

/** Open the HITL a person decides, tell the channel, and write the timeline. */
async function openRequest(
	input: ContinueRoutingInput,
	plan: {
		stored: string | null;
		approvable: boolean;
		nextPrompt: string | null;
		escalation: Escalation | null;
	},
): Promise<void> {
	const { sessionId, proposalId, decision, watchConfig } = input;
	const { stored, nextPrompt, escalation } = plan;
	const askProposal = escalation?.askProposal ?? null;
	const askWhy = escalation?.why || undefined;
	const hasSuggestion = decision.decision === "continue" && stored !== null;

	// Any prior open HITL is superseded when a newer one opens.
	await cancelOpenHitl(sessionId, "superseded");

	const opened = await completeProposalAsHitl({
		id: proposalId,
		decision: decision.decision,
		nextPrompt,
		reportSummary: null,
		rawResponse: { raw: input.responseText, decision },
		...input.completion,
		channelId: watchConfig.channelId ?? null,
		expiresAt: new Date(Date.now() + HITL_TTL_MS).toISOString(),
		turnKey: input.turnKey,
		triggerEventId: input.trigger.id,
		promptSha256: hasSuggestion ? sha256(stored) : null,
		approvable: hasSuggestion ? plan.approvable : false,
		suggestedPrompt: hasSuggestion ? stored : null,
		continueKind: decision.decision === "continue" ? decision.continueKind : null,
	});

	const shown = nextPrompt ?? (hasSuggestion ? stored : askProposal) ?? "";

	if (watchConfig.channelId) {
		const delivery = await dispatchHitlToChannel({
			channelId: watchConfig.channelId,
			message: {
				hitlId: opened.hitlId,
				proposalId,
				sessionId,
				sessionDisplayName: input.session.displayName,
				decision: decision.decision === "continue" ? "continue" : "ask",
				prompt: shown,
				why: askWhy ?? null,
				deliverable: (await promptDeliverability(sessionId)).deliverable,
				approvable: hasSuggestion ? plan.approvable : false,
				promptSha256: hasSuggestion ? sha256(stored) : null,
				sessionCwd: input.session.cwd,
			},
		});
		if (!delivery.ok && !delivery.skipped) {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "ChannelDeliveryFailed",
				content: `Channel delivery failed: ${delivery.error ?? "unknown"}`,
				rawPayload: {
					sub_type: "channel_delivery_failed",
					proposal_id: proposalId,
					channel_id: watchConfig.channelId,
				},
			});
		}
	}

	await emitAiEvent({
		sessionId,
		source: "managed_control",
		category: "ai_proposal",
		eventType: "AiProposal",
		content: shown,
		rawPayload: { proposal_id: proposalId, decision: decision.decision, why: askWhy ?? null },
	});
	await emitAiEvent({
		sessionId,
		source: "managed_control",
		category: "ai_hitl_request",
		eventType: "AiHitlRequest",
		content: shown,
		rawPayload: { proposal_id: proposalId, why: askWhy ?? null, can_dispatch: nextPrompt !== null },
	});
	await stampWatcherState(sessionId, "awaiting_human");
}
