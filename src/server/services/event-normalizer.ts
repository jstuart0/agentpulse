import type {
	AgentType,
	EventCategory,
	EventSource,
	HookEventPayload,
	SemanticStatus,
	SemanticStatusUpdate,
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

// Hook-body char caps (F29, F40, F56, F76). The stored `toolResponse`
// column is kept short since it's read on every list/detail render; the
// rawPayload copy (shapeHookRawPayload below) gets a wider budget since
// it's the one place an operator can still see the fuller body. Both run
// through the same serializeToolResponse step so a string response and a
// JSON-stringified object response are capped identically.
export const TOOL_RESPONSE_COLUMN_CHAR_CAP = 2000;
export const TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP = 4096;

// Placeholder content for a hook Stop event with no per-line message
// (normalizeSystemEvent below). Exported so the embedding backfill (D14,
// F34) can recognize and skip this synthetic marker instead of embedding
// a near-duplicate of it for every turn in every session.
export const SYNTHETIC_STOP_CONTENT = "Turn completed";

// F128 (codex r2): content for the stub row ingest.ts builds when a hook
// delivery exceeded the body cap. tool_input/tool_response were never
// parsed for an oversize delivery, so there is no real content to render.
export const OVERSIZE_STUB_CONTENT = "Payload exceeded 16 MiB and was dropped";

// F140 (D21): a display-only marker written into a stub row's stored
// rawPayload so it's visibly distinguishable after the fact. It plays no
// part in any decision — the oversize-stub decision itself is the
// `isOversizeStub` parameter below (server-set, via HookDeliveryContext),
// never anything read off the payload. Before D21, event-dedup.ts read this
// same key off rawPayload to choose the `o:` key namespace, which meant a
// client posting a normal-size body with this key could forge stub
// semantics for a real row (F140).
export const OVERSIZE_STUB_MARKER = "agentpulse_oversize";

/**
 * Same category mapping normalizeHookEvent uses for a real payload, applied
 * to whatever hook_event_name an oversize delivery's identity prefix
 * recovered — so the stub row still lands in the timeline grouping a real
 * event of that type would use. Dedup identity is separate (F131b): stubs
 * always key on the `o:` namespace, never `t:`/`d:`, regardless of category.
 */
function categorizeOversizeEventType(eventType: string): EventCategory {
	if (eventType === "UserPromptSubmit") return "prompt";
	if (
		eventType === "PreToolUse" ||
		eventType === "PostToolUse" ||
		eventType === "PostToolUseFailure"
	) {
		return "tool_event";
	}
	if (eventType === "PermissionRequest" || eventType === "PermissionDenied")
		return "permission_event";
	if (
		eventType === "TaskCreated" ||
		eventType === "TaskCompleted" ||
		eventType === "SubagentStart" ||
		eventType === "SubagentStop"
	) {
		return "progress_update";
	}
	return "system_event";
}

function serializeToolResponse(toolResponse: unknown): string | null {
	if (!toolResponse) return null;
	return typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
}

function stringifyToolResponse(toolResponse: unknown): string | null {
	const serialized = serializeToolResponse(toolResponse);
	return serialized === null ? null : serialized.slice(0, TOOL_RESPONSE_COLUMN_CHAR_CAP);
}

/**
 * Shapes rawPayload for a stored hook tool/permission row (F29, F56, F76):
 * drops `tool_input` — the `toolInput` column already carries it, and
 * storing both doubled hook-row growth — and caps `tool_response`'s raw
 * copy at a wider limit than the DB column. Never mutates `payload`: the
 * delivery-id body digest (Phase 7, D2) reads it uncapped, and the
 * permission-wait code reads it directly on the same call.
 */
export function shapeHookRawPayload(
	payload: HookEventPayload,
	eventType: string,
): Record<string, unknown> {
	const shaped: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) };

	if ("tool_input" in shaped) {
		// Not `delete` (Biome noDelete): assigning undefined is enough — the
		// JSON column serializer drops undefined-valued keys, so the stored
		// rawPayload still has no tool_input key.
		shaped.tool_input = undefined;
		shaped.tool_input_in_column = true;
	}

	if (eventType === "PostToolUse" || eventType === "PostToolUseFailure") {
		const serialized = serializeToolResponse(payload.tool_response);
		if (serialized !== null) {
			if (serialized.length > TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP) {
				shaped.tool_response = serialized.slice(0, TOOL_RESPONSE_RAW_PAYLOAD_CHAR_CAP);
				shaped.tool_response_truncated = true;
				shaped.tool_response_chars = serialized.length;
			} else {
				shaped.tool_response = serialized;
			}
		}
	}

	return shaped;
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
	if (eventType === "PostToolUseFailure") return `Failed: ${toolName}`;
	return null;
}

function formatPermissionContent(
	eventType: "PermissionRequest" | "PermissionDenied",
	toolName: string | undefined,
): string {
	const name = toolName || "a tool";
	return eventType === "PermissionRequest"
		? `Permission requested: ${name}`
		: `Permission denied: ${name}`;
}

// Log-once per unknown hook event name so the tolerant else-branch (F4)
// is visible without spamming logs. Module-level and independent of any
// other log-once set in the codebase (e.g. the pricing fallback set) —
// deliberately not shared via a helper.
const warnedUnknownEvents = new Set<string>();

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
			return SYNTHETIC_STOP_CONTENT;
		case "Notification":
			return payload.message ? payload.message : "Notification";
		case "PreCompact":
			return payload.trigger
				? `Context compaction started (${payload.trigger})`
				: "Context compaction started";
		case "PostCompact":
			return payload.trigger
				? `Context compaction completed (${payload.trigger})`
				: "Context compaction completed";
		default:
			if (!warnedUnknownEvents.has(payload.hook_event_name)) {
				warnedUnknownEvents.add(payload.hook_event_name);
				console.warn(
					JSON.stringify({ kind: "unknown_hook_event", eventName: payload.hook_event_name }),
				);
			}
			return null;
	}
}

/**
 * F140 (D21): `isOversizeStub` is the ONLY signal that decides stub
 * semantics, and it's an explicit parameter, never read off `payload`.
 * ingest.ts's handleOversizeHookDelivery is the only caller that passes
 * `true`, from its own server-built HookDeliveryContext.oversizeStub — a
 * client posting a normal-size body can no longer set a payload field to
 * swap real content for the placeholder (F140 was exactly that: the
 * previous version branched on `payload.agentpulse_oversize`, which came
 * straight from client JSON).
 */
export function normalizeHookEvent(
	payload: HookEventPayload,
	agentType: AgentType,
	isOversizeStub = false,
): NormalizedEvent[] {
	const eventType = payload.hook_event_name;
	const toolResponse = stringifyToolResponse(payload.tool_response);
	const normalized: NormalizedEvent[] = [];

	// F128 (codex r2): the minimal synthetic payload ingest.ts builds for an
	// oversize delivery. There's no real prompt/tool_input/tool_response to
	// render (the body was dropped before JSON.parse), so a single
	// informative stub row stands in — categorized like a real event of this
	// type for timeline grouping, but always keyed in the `o:` dedup
	// namespace (F131b; see event-dedup.ts), never `t:`/`d:`.
	if (isOversizeStub) {
		normalized.push({
			eventType,
			category: categorizeOversizeEventType(eventType),
			source: "observed_hook",
			content: OVERSIZE_STUB_CONTENT,
			isNoise: false,
			providerEventType: eventType,
			toolName: payload.tool_name || null,
			toolInput: null,
			toolResponse: null,
			rawPayload: {
				[OVERSIZE_STUB_MARKER]: true,
				hook_event_name: eventType,
				tool_use_id: payload.tool_use_id,
				cwd: payload.cwd,
				transcript_path: payload.transcript_path,
			},
		});
		return normalized;
	}

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
	} else if (
		eventType === "PreToolUse" ||
		eventType === "PostToolUse" ||
		eventType === "PostToolUseFailure"
	) {
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
			rawPayload: shapeHookRawPayload(payload, eventType),
		});
	} else if (eventType === "PermissionRequest" || eventType === "PermissionDenied") {
		normalized.push({
			eventType,
			category: "permission_event",
			source: "observed_hook",
			content: formatPermissionContent(eventType, payload.tool_name),
			isNoise: false,
			providerEventType: eventType,
			toolName: payload.tool_name || null,
			toolInput: payload.tool_input || null,
			toolResponse,
			rawPayload: shapeHookRawPayload(payload, eventType),
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
