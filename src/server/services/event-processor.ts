import { db } from "../db/client.js";
import { sessions, events } from "../db/schema.js";
import { eq, inArray, sql } from "drizzle-orm";
import type {
	AgentType,
	EventCategory,
	EventSource,
	HookEventPayload,
	SemanticStatusUpdate,
} from "../../shared/types.js";
import {
	EVENT_DUPLICATE_WINDOW_MS,
	areNearInTime,
	getEventSourcePriority,
	normalizeComparableContent,
} from "../../shared/event-authority.js";
import { generateSessionName } from "./name-generator.js";
import { normalizeHookEvent, normalizeStatusEvents, type NormalizedEvent } from "./event-normalizer.js";
import { enrichObservedSession } from "./correlation-enricher.js";

function chooseHigherAuthorityEvent<T extends { source: EventSource | string; createdAt?: string | null }>(left: T, right: T) {
	const leftPriority = getEventSourcePriority(left.source);
	const rightPriority = getEventSourcePriority(right.source);
	if (leftPriority !== rightPriority) return leftPriority > rightPriority ? left : right;
	return (left.createdAt || "") >= (right.createdAt || "") ? left : right;
}

type AuthorityComparableEvent = {
	id?: number;
	category: EventCategory | null;
	source: EventSource | string;
	content: string | null;
	createdAt?: string | null;
};

function isAssistantAuthorityDuplicate(existing: AuthorityComparableEvent, incoming: AuthorityComparableEvent) {
	if (existing.category !== "assistant_message" || incoming.category !== "assistant_message") return false;
	if (!normalizeComparableContent(existing.content) || !normalizeComparableContent(incoming.content)) return false;
	if (normalizeComparableContent(existing.content) !== normalizeComparableContent(incoming.content)) return false;
	if (!areNearInTime(existing.createdAt, incoming.createdAt, EVENT_DUPLICATE_WINDOW_MS)) return false;
	return getEventSourcePriority(existing.source) !== getEventSourcePriority(incoming.source);
}

function buildDedupKey(event: {
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	rawPayload?: Record<string, unknown>;
}) {
	const transcriptId = typeof event.rawPayload?.transcript_uuid === "string"
		? event.rawPayload.transcript_uuid
		: typeof event.rawPayload?.transcript_timestamp === "string"
			? event.rawPayload.transcript_timestamp
			: "";
	return [
		event.eventType || "",
		event.category || "",
		event.source || "",
		event.content || "",
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

export async function insertNormalizedEvents(sessionId: string, normalizedEvents: NormalizedEvent[]) {
	if (normalizedEvents.length === 0) return [];
	const nowIso = new Date().toISOString();

	const recentEvents = await db
		.select({
			id: events.id,
			eventType: events.eventType,
			category: events.category,
			source: events.source,
			content: events.content,
			providerEventType: events.providerEventType,
			createdAt: events.createdAt,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(sql`${events.id} DESC`)
		.limit(50);

	const seen = new Set(
		recentEvents.map((event) => buildDedupKey({ ...event })),
	);
	const deleteIds = new Set<number>();
	const retained: Array<NormalizedEvent & { createdAt: string }> = [];
	const authorityPool: AuthorityComparableEvent[] = recentEvents.map((event) => ({
		...event,
		category: event.category as EventCategory | null,
		source: event.source as EventSource,
		createdAt: event.createdAt,
	}));

	for (const event of normalizedEvents) {
		const normalizedEvent = { ...event, createdAt: nowIso };
		const key = buildDedupKey(event);
		if (seen.has(key)) continue;

		const strongerExisting = authorityPool.find((existing) => {
			if (!isAssistantAuthorityDuplicate(existing, normalizedEvent)) return false;
			return chooseHigherAuthorityEvent(existing, normalizedEvent) === existing;
		});
		if (strongerExisting) continue;

		for (const existing of authorityPool) {
			if (!existing.id) continue;
			if (!isAssistantAuthorityDuplicate(existing, normalizedEvent)) continue;
			if (chooseHigherAuthorityEvent(existing, normalizedEvent) === normalizedEvent) {
				deleteIds.add(existing.id);
			}
		}

		seen.add(key);
		retained.push(normalizedEvent);
		authorityPool.push({
			id: 0,
			category: normalizedEvent.category,
			source: normalizedEvent.source,
			content: normalizedEvent.content,
			createdAt: normalizedEvent.createdAt,
		});
	}

	if (deleteIds.size > 0) {
		await db.delete(events).where(inArray(events.id, Array.from(deleteIds)));
	}

	if (retained.length === 0) return [];

	await db.insert(events).values(
		retained.map((event) => ({
			sessionId,
			eventType: event.eventType,
			category: event.category,
			source: event.source,
			content: event.content,
			isNoise: event.isNoise,
			providerEventType: event.providerEventType,
			toolName: event.toolName,
			toolInput: event.toolInput,
			toolResponse: event.toolResponse,
			rawPayload: event.rawPayload,
		})),
	);

	return retained.map((event) => ({
		id: 0,
		sessionId,
		eventType: event.eventType,
		category: event.category,
		source: event.source,
		content: event.content,
		isNoise: event.isNoise,
		providerEventType: event.providerEventType,
		toolName: event.toolName,
		toolInput: event.toolInput,
		toolResponse: event.toolResponse,
		rawPayload: event.rawPayload,
		createdAt: event.createdAt,
	}));
}

// Detect agent type from headers or payload
export function detectAgentType(
	headerAgentType: string | undefined,
	payload: HookEventPayload,
): AgentType {
	if (headerAgentType === "claude_code") return "claude_code";
	if (headerAgentType === "codex_cli") return "codex_cli";

	// Auto-detect: Codex payloads include turn_id, Claude Code doesn't
	if (payload.turn_id) return "codex_cli";
	return "claude_code";
}

// Process an incoming hook event
export async function processHookEvent(
	payload: HookEventPayload,
	agentType: AgentType,
): Promise<{ sessionId: string; isNew: boolean }> {
	const sessionId = payload.session_id;
	const eventType = payload.hook_event_name;
	const now = new Date().toISOString();

	// Check if session exists
	const existing = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	const isNew = existing.length === 0;

	if (isNew) {
		// Create new session with a friendly display name
		await db.insert(sessions).values({
			sessionId,
			displayName: generateSessionName(),
			agentType,
			status: "active",
			cwd: payload.cwd || null,
			transcriptPath: payload.transcript_path || null,
			model: payload.model || null,
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
		});
	}

	// Update session based on event type
	const updates: Record<string, unknown> = {
		lastActivityAt: now,
		status: "active",
	};

	if (payload.cwd) updates.cwd = payload.cwd;
	if (payload.model) updates.model = payload.model;

	// Handle session end events
	if (eventType === "SessionEnd") {
		updates.status = "completed";
		updates.endedAt = now;
		updates.isWorking = false;
	}

	// Track working state: agent is working between prompt/tool start and Stop
	if (eventType === "UserPromptSubmit" || eventType === "PreToolUse") {
		updates.isWorking = true;
	}
	if (eventType === "Stop") {
		updates.isWorking = false;
	}

	// Increment tool use count for tool events
	if (eventType === "PostToolUse" || eventType === "PreToolUse") {
		if (eventType === "PostToolUse") {
			await db
				.update(sessions)
				.set({ totalToolUses: sql`${sessions.totalToolUses} + 1` })
				.where(eq(sessions.sessionId, sessionId));
		}
	}

	// Extract current task from task events
	if (eventType === "TaskCreated" && payload.task_subject) {
		updates.currentTask = payload.task_subject;
	}

	// Try to extract git branch from tool responses
	if (eventType === "PostToolUse" && payload.tool_name === "Bash" && payload.tool_response) {
		const response = typeof payload.tool_response === "string"
			? payload.tool_response
			: JSON.stringify(payload.tool_response);
		const input = payload.tool_input as Record<string, unknown> | undefined;
		const command = typeof input?.command === "string" ? input.command : "";

		// Match "git branch", "git status", etc. responses that contain branch info
		if (command.includes("git") && (command.includes("branch") || command.includes("status") || command.includes("rev-parse"))) {
			const branchMatch = response.match(/(?:On branch |^\* |HEAD -> )([^\s,)]+)/m);
			if (branchMatch) {
				updates.gitBranch = branchMatch[1];
			}
		}
	}

	await db.update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));

	if (isNew || eventType === "SessionStart") {
		await enrichObservedSession(sessionId);
	}

	// Store normalized timeline events
	const normalizedEvents = normalizeHookEvent(payload, agentType);
	await insertNormalizedEvents(sessionId, normalizedEvents);

	return { sessionId, isNew };
}

// Process a semantic status update from CLAUDE.md snippet
export async function processStatusUpdate(update: SemanticStatusUpdate): Promise<boolean> {
	const existing = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, update.session_id))
		.limit(1);

	if (existing.length === 0) {
		return false; // Session not found
	}

	const updates: Record<string, unknown> = {
		lastActivityAt: new Date().toISOString(),
		status: "active",
	};

	if (update.status) updates.semanticStatus = update.status;
	if (update.task) updates.currentTask = update.task;
	if (update.plan) updates.planSummary = update.plan;

	await db.update(sessions).set(updates).where(eq(sessions.sessionId, update.session_id));

	const normalizedEvents = normalizeStatusEvents(update);
	await insertNormalizedEvents(update.session_id, normalizedEvents);

	return true;
}
