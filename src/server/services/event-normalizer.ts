import type {
	AgentType,
	EventCategory,
	EventSource,
	HookEventPayload,
	SemanticStatusUpdate,
	SemanticStatus,
} from "../../shared/types.js";

export interface NormalizedEvent {
	eventType: string;
	category: EventCategory;
	source: EventSource;
	content: string | null;
	isNoise: boolean;
	providerEventType: string | null;
	toolName: string | null;
	toolInput: Record<string, unknown> | null;
	toolResponse: string | null;
	rawPayload: Record<string, unknown>;
}

function stringifyToolResponse(toolResponse: unknown): string | null {
	if (!toolResponse) return null;
	return typeof toolResponse === "string"
		? toolResponse.slice(0, 2000)
		: JSON.stringify(toolResponse).slice(0, 2000);
}

function getToolCommand(payload: HookEventPayload): string {
	const command = payload.tool_input?.command;
	return typeof command === "string" ? command : "";
}

function isNoisyTool(toolName: string | undefined, payload: HookEventPayload): boolean {
	const name = toolName || "";
	const command = getToolCommand(payload).toLowerCase();

	if (["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"].includes(name)) {
		return true;
	}

	if (name === "Bash") {
		return [
			"cat ",
			"ls",
			"find ",
			"grep ",
			"rg ",
			"sed ",
			"head ",
			"tail ",
			"pwd",
			"git status",
		].some((prefix) => command.includes(prefix));
	}

	return false;
}

function formatToolContent(eventType: string, toolName: string | undefined): string | null {
	if (!toolName) return null;
	if (eventType === "PreToolUse") return `Running ${toolName}`;
	if (eventType === "PostToolUse") return `Completed ${toolName}`;
	return null;
}

function normalizeSystemEvent(payload: HookEventPayload, agentType: AgentType): string | null {
	switch (payload.hook_event_name) {
		case "SessionStart":
			return `${agentType === "codex_cli" ? "Codex" : "Claude"} session started`;
		case "SessionEnd":
			return "Session ended";
		case "TaskCreated":
			return payload.task_subject ? `Task created: ${payload.task_subject}` : "Task created";
		case "TaskCompleted":
			return payload.task_subject ? `Task completed: ${payload.task_subject}` : "Task completed";
		case "SubagentStart":
			return payload.agent_id ? `Subagent started: ${payload.agent_id}` : "Subagent started";
		case "SubagentStop":
			return payload.agent_id ? `Subagent stopped: ${payload.agent_id}` : "Subagent stopped";
		case "Stop":
			return "Turn completed";
		default:
			return null;
	}
}

export function normalizeHookEvent(
	payload: HookEventPayload,
	agentType: AgentType,
): NormalizedEvent[] {
	const eventType = payload.hook_event_name;
	const toolResponse = stringifyToolResponse(payload.tool_response);
	const normalized: NormalizedEvent[] = [];

	if (eventType === "UserPromptSubmit" && payload.prompt) {
		normalized.push({
			eventType,
			category: "prompt",
			source: "observed_hook",
			content: payload.prompt,
			isNoise: false,
			providerEventType: eventType,
			toolName: payload.tool_name || null,
			toolInput: payload.tool_input || null,
			toolResponse,
			rawPayload: payload as unknown as Record<string, unknown>,
		});
	} else if (eventType === "PreToolUse" || eventType === "PostToolUse") {
		normalized.push({
			eventType,
			category: "tool_event",
			source: "observed_hook",
			content: formatToolContent(eventType, payload.tool_name),
			isNoise: isNoisyTool(payload.tool_name, payload),
			providerEventType: eventType,
			toolName: payload.tool_name || null,
			toolInput: payload.tool_input || null,
			toolResponse,
			rawPayload: payload as unknown as Record<string, unknown>,
		});
	} else {
		normalized.push({
			eventType,
			category:
				eventType === "TaskCreated" ||
				eventType === "TaskCompleted" ||
				eventType === "SubagentStart" ||
				eventType === "SubagentStop"
					? "progress_update"
					: "system_event",
			source: "observed_hook",
			content: normalizeSystemEvent(payload, agentType),
			isNoise: false,
			providerEventType: eventType,
			toolName: payload.tool_name || null,
			toolInput: payload.tool_input || null,
			toolResponse,
			rawPayload: payload as unknown as Record<string, unknown>,
		});
	}

	const assistantMessage = payload.last_assistant_message?.trim();
	if (assistantMessage) {
		normalized.push({
			eventType: "AssistantMessage",
			category: "assistant_message",
			source: "observed_hook",
			content: assistantMessage,
			isNoise: false,
			providerEventType: eventType,
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload: {
				source_event_type: eventType,
				message: assistantMessage,
				agent_type: agentType,
			},
		});
	}

	return normalized;
}

export function normalizeStatusEvents(update: SemanticStatusUpdate): NormalizedEvent[] {
	const normalized: NormalizedEvent[] = [];
	const rawPayload = update as unknown as Record<string, unknown>;

	if (update.status) {
		normalized.push({
			eventType: "SemanticStatusUpdate",
			category: "status_update",
			source: "observed_status",
			content: formatSemanticStatus(update.status),
			isNoise: false,
			providerEventType: "semantic_status",
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload,
		});
	}

	if (update.task?.trim()) {
		normalized.push({
			eventType: "TaskStatusUpdate",
			category: "progress_update",
			source: "observed_status",
			content: update.task.trim(),
			isNoise: false,
			providerEventType: "semantic_task",
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload,
		});
	}

	if (update.plan?.length) {
		normalized.push({
			eventType: "PlanSummaryUpdate",
			category: "plan_update",
			source: "observed_status",
			content: update.plan.join("\n"),
			isNoise: false,
			providerEventType: "semantic_plan",
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload,
		});
	}

	return normalized;
}

export function createAssistantTranscriptEvent(
	content: string,
	rawPayload: Record<string, unknown>,
	providerEventType: string,
): NormalizedEvent {
	return {
		eventType: "TranscriptAssistantMessage",
		category: "assistant_message",
		source: "observed_transcript",
		content,
		isNoise: false,
		providerEventType,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload,
	};
}

function formatSemanticStatus(status: SemanticStatus): string {
	return `Status: ${status}`;
}
