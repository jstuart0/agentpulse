import type { AlertRuleType, AskThreadOrigin } from "../../../shared/types.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { getCachedProjects } from "../projects/cache.js";
import type { AlertRuleIntent } from "./launch-intent-detector.js";

export interface CreateAlertRulePayload {
	projectId: string;
	projectName: string;
	ruleType: AlertRuleType;
	thresholdMinutes: number | null;
	channelId: string | null;
}

export interface CreateFreeformAlertRulePayload {
	projectId: string;
	projectName: string;
	condition: string;
	dailyTokenBudget: number;
	sampleRate: number;
	eventTypesFilter: string[];
}

const DEFAULT_FREEFORM_EVENT_TYPES = [
	"ToolUseResult",
	"UserPromptSubmit",
	"AssistantMessage",
	"Stop",
];
const MIN_DAILY_TOKEN_BUDGET = 1000;

export async function handleAlertRuleRequest(
	intent: AlertRuleIntent & { kind: "create_alert_rule" },
	args: {
		origin: AskThreadOrigin;
		threadId: string;
		telegramChatId?: string | null;
	},
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const projects = getCachedProjects();

	// Resolve project from projectHint (case-insensitive).
	const matched =
		intent.projectHint !== null
			? (projects.find((p) => p.name.toLowerCase() === (intent.projectHint ?? "").toLowerCase()) ??
				null)
			: null;

	if (!matched) {
		const knownList =
			projects.length > 0
				? projects.map((p) => `**${p.name}**`).join(", ")
				: "(no projects registered yet)";
		const hint = intent.projectHint
			? ` I didn't find a project named **${intent.projectHint}**.`
			: "";
		return {
			replyText: `I need to know which project to watch.${hint} Known projects: ${knownList}. Which one did you mean?`,
			actionRequestId: null,
		};
	}

	const ruleLabels: Record<string, string> = {
		status_failed: "session fails",
		status_stuck: "session gets stuck",
		status_completed: "session completes",
		no_activity_minutes: `session has no activity for ${intent.thresholdMinutes ?? "N"} minutes`,
	};
	const ruleLabel = ruleLabels[intent.ruleType] ?? intent.ruleType;

	const payload: CreateAlertRulePayload = {
		projectId: matched.id,
		projectName: matched.name,
		ruleType: intent.ruleType,
		thresholdMinutes: intent.thresholdMinutes ?? null,
		channelId: null,
	};

	const actionRequest = await createActionRequest({
		kind: "create_alert_rule",
		question: `Create alert rule for **${matched.name}**: notify when a ${ruleLabel}.`,
		payload: payload as unknown as Record<string, unknown>,
		origin: args.origin,
		channelId: null,
		askThreadId: args.threadId,
	});

	return {
		replyText: `Queued an alert rule for **${matched.name}** — notify when a ${ruleLabel}. Approve it in your inbox to activate.`,
		actionRequestId: actionRequest.id,
	};
}

export async function handleFreeformAlertRuleRequest(
	intent: AlertRuleIntent & { kind: "create_freeform_alert_rule" },
	args: {
		origin: AskThreadOrigin;
		threadId: string;
		telegramChatId?: string | null;
	},
): Promise<{ replyText: string; actionRequestId: string | null }> {
	// Ask follow-up if the user didn't state a budget.
	if (intent.dailyTokenBudget === null) {
		return {
			replyText:
				"What daily token budget should this rule use? For example, '5000 tokens/day' or '10000 tokens/day'. A lower budget reduces cost but may miss some events.",
			actionRequestId: null,
		};
	}

	const budget = Math.max(MIN_DAILY_TOKEN_BUDGET, intent.dailyTokenBudget);

	const projects = getCachedProjects();
	const matched =
		intent.projectHint !== null
			? (projects.find((p) => p.name.toLowerCase() === (intent.projectHint ?? "").toLowerCase()) ??
				null)
			: null;

	if (!matched) {
		const knownList =
			projects.length > 0
				? projects.map((p) => `**${p.name}**`).join(", ")
				: "(no projects registered yet)";
		const hint = intent.projectHint
			? ` I didn't find a project named **${intent.projectHint}**.`
			: "";
		return {
			replyText: `I need to know which project to watch.${hint} Known projects: ${knownList}. Which one did you mean?`,
			actionRequestId: null,
		};
	}

	const condition = intent.condition.slice(0, 500);

	const payload: CreateFreeformAlertRulePayload = {
		projectId: matched.id,
		projectName: matched.name,
		condition,
		dailyTokenBudget: budget,
		sampleRate: intent.sampleRate ?? 1.0,
		eventTypesFilter: DEFAULT_FREEFORM_EVENT_TYPES,
	};

	const actionRequest = await createActionRequest({
		kind: "create_freeform_alert_rule",
		question: `Create freeform alert rule for **${matched.name}**: notify when "${condition}" (budget: ${budget} tokens/day).`,
		payload: payload as unknown as Record<string, unknown>,
		origin: args.origin,
		channelId: null,
		askThreadId: args.threadId,
	});

	return {
		replyText: `Queued a freeform alert rule for **${matched.name}** — will notify when: "${condition}". Budget: ${budget} tokens/day. Approve it in your inbox to activate.`,
		actionRequestId: actionRequest.id,
	};
}
