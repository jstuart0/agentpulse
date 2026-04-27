import { createActionRequest } from "../ai/action-requests-service.js";
import { getCachedProjects } from "../projects/cache.js";
import type { AlertRuleIntent } from "./launch-intent-detector.js";

export interface CreateAlertRulePayload {
	projectId: string;
	projectName: string;
	ruleType: "status_failed" | "status_stuck" | "status_completed" | "no_activity_minutes";
	thresholdMinutes: number | null;
	channelId: string | null;
}

export async function handleAlertRuleRequest(
	intent: AlertRuleIntent & { kind: "create_alert_rule" },
	args: {
		origin: "web" | "telegram";
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
