import { readFileSync, statSync, existsSync } from "fs";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { insertNormalizedEvents } from "./event-processor.js";
import { createAssistantTranscriptEvent, type NormalizedEvent } from "./event-normalizer.js";
import { broadcastToSession } from "../ws/handler.js";
import type { AgentType, Session } from "../../shared/types.js";

type TranscriptCursor = {
	offset?: number;
};

type SessionWithMetadata = Pick<
	Session,
	"sessionId" | "agentType" | "transcriptPath" | "metadata"
>;

function getTranscriptCursor(metadata: Record<string, unknown> | null | undefined): TranscriptCursor {
	if (!metadata || typeof metadata !== "object") return {};
	const value = metadata.transcriptCursor;
	return value && typeof value === "object" ? value as TranscriptCursor : {};
}

function parseClaudeTranscriptDelta(lines: string[]): NormalizedEvent[] {
	const events: NormalizedEvent[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type !== "assistant") continue;
			const message = entry.message as Record<string, unknown> | undefined;
			const content = Array.isArray(message?.content) ? message.content : [];
			for (const block of content) {
				const item = block as Record<string, unknown>;
				if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
					events.push(
						createAssistantTranscriptEvent(
							item.text.trim(),
							{
								transcript_uuid: entry.uuid,
								transcript_timestamp: entry.timestamp,
								transcript_type: "assistant",
							},
							"claude_transcript_text",
						),
					);
				}
			}
		} catch {
			// Ignore malformed lines.
		}
	}

	return events;
}

function parseCodexTranscriptDelta(lines: string[]): NormalizedEvent[] {
	const events: NormalizedEvent[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type !== "event_msg") continue;
			const payload = entry.payload as Record<string, unknown> | undefined;
			if (payload?.type !== "agent_message" || typeof payload.message !== "string" || !payload.message.trim()) {
				continue;
			}
			events.push(
				createAssistantTranscriptEvent(
					payload.message.trim(),
					{
						transcript_timestamp: entry.timestamp,
						transcript_type: "agent_message",
						phase: payload.phase,
					},
					"codex_transcript_agent_message",
				),
			);
		} catch {
			// Ignore malformed lines.
		}
	}

	return events;
}

function parseTranscriptDelta(agentType: AgentType, lines: string[]): NormalizedEvent[] {
	return agentType === "claude_code"
		? parseClaudeTranscriptDelta(lines)
		: parseCodexTranscriptDelta(lines);
}

async function syncTranscriptForSession(session: SessionWithMetadata) {
	if (!session.transcriptPath || !existsSync(session.transcriptPath)) return;

	const cursor = getTranscriptCursor(session.metadata);
	const offset = cursor.offset ?? 0;
	const stat = statSync(session.transcriptPath);
	if (stat.size <= offset) return;

	const buffer = readFileSync(session.transcriptPath);
	const text = buffer.subarray(offset).toString("utf8");
	const lines = text.split("\n").filter(Boolean);
	if (lines.length === 0) {
		await db
			.update(sessions)
			.set({
				metadata: {
					...(session.metadata || {}),
					transcriptCursor: { offset: stat.size },
				},
			})
			.where(eq(sessions.sessionId, session.sessionId));
		return;
	}

	const normalizedEvents = parseTranscriptDelta(session.agentType, lines);
	const insertedEvents = await insertNormalizedEvents(session.sessionId, normalizedEvents);

	if (insertedEvents.length > 0) {
		for (const event of insertedEvents) {
			broadcastToSession(session.sessionId, "new_event", event);
		}
	}

	await db
		.update(sessions)
		.set({
			metadata: {
				...(session.metadata || {}),
				transcriptCursor: { offset: stat.size },
			},
		})
		.where(eq(sessions.sessionId, session.sessionId));
}

export function startTranscriptSync() {
	setInterval(async () => {
		try {
			const activeSessions = await db
				.select({
					sessionId: sessions.sessionId,
					agentType: sessions.agentType,
					transcriptPath: sessions.transcriptPath,
					metadata: sessions.metadata,
				})
				.from(sessions)
				.where(
					and(
						isNotNull(sessions.transcriptPath),
						ne(sessions.status, "completed"),
						ne(sessions.status, "archived"),
					),
				);

			for (const session of activeSessions) {
				await syncTranscriptForSession(session as SessionWithMetadata);
			}
		} catch (err) {
			console.error("[transcript-sync] Error:", err);
		}
	}, 1000);
}
