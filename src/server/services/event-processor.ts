import { db } from "../db/client.js";
import { sessions, events } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { AgentType, HookEventPayload, SemanticStatusUpdate } from "../../shared/types.js";
import { generateSessionName } from "./name-generator.js";
import { normalizeHookEvent, normalizeStatusEvents } from "./event-normalizer.js";

type NormalizedInsertEvent = ReturnType<typeof normalizeHookEvent>[number];

async function insertNormalizedEvents(sessionId: string, normalizedEvents: NormalizedInsertEvent[]) {
	if (normalizedEvents.length === 0) return;

	const recentEvents = await db
		.select({
			eventType: events.eventType,
			category: events.category,
			content: events.content,
			providerEventType: events.providerEventType,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(sql`${events.id} DESC`)
		.limit(10);

	const seen = new Set(
		recentEvents.map((event) =>
			[
				event.eventType || "",
				event.category || "",
				event.content || "",
				event.providerEventType || "",
			].join("::"),
		),
	);

	const deduped = normalizedEvents.filter((event) => {
		const key = [
			event.eventType || "",
			event.category || "",
			event.content || "",
			event.providerEventType || "",
		].join("::");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (deduped.length === 0) return;

	await db.insert(events).values(
		deduped.map((event) => ({
			sessionId,
			eventType: event.eventType,
			category: event.category,
			content: event.content,
			isNoise: event.isNoise,
			providerEventType: event.providerEventType,
			toolName: event.toolName,
			toolInput: event.toolInput,
			toolResponse: event.toolResponse,
			rawPayload: event.rawPayload,
		})),
	);
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
