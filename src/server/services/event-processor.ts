import { db } from "../db/client.js";
import { sessions, events } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import type { AgentType, HookEventPayload, SemanticStatusUpdate } from "../../shared/types.js";
import { generateSessionName } from "./name-generator.js";

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

	await db.update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));

	// Store the event
	const toolResponse = payload.tool_response
		? typeof payload.tool_response === "string"
			? payload.tool_response.slice(0, 2000) // Truncate large responses
			: JSON.stringify(payload.tool_response).slice(0, 2000)
		: null;

	await db.insert(events).values({
		sessionId,
		eventType,
		toolName: payload.tool_name || null,
		toolInput: payload.tool_input || null,
		toolResponse,
		rawPayload: payload as unknown as Record<string, unknown>,
	});

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

	return true;
}
