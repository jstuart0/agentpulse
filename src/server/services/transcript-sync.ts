import { readFile, stat } from "fs/promises";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { insertNormalizedEvents } from "./event-processor.js";
import { createAssistantTranscriptEvent, type NormalizedEvent } from "./event-normalizer.js";
import { notifySessionEvents } from "./notifier.js";
import type { AgentType, Session } from "../../shared/types.js";

const TRANSCRIPT_SYNC_INTERVAL_MS = 1000;
const TRANSCRIPT_SYNC_BATCH_SIZE = 10;

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
	if (!session.transcriptPath) return;

	const cursor = getTranscriptCursor(session.metadata);
	const offset = cursor.offset ?? 0;
	let transcriptStat;
	try {
		transcriptStat = await stat(session.transcriptPath);
	} catch {
		return;
	}
	if (transcriptStat.size <= offset) return;

	const buffer = await readFile(session.transcriptPath);
	const text = buffer.subarray(offset).toString("utf8");
	const lines = text.split("\n").filter(Boolean);
	if (lines.length === 0) {
		await db
			.update(sessions)
			.set({
				metadata: {
					...(session.metadata || {}),
					transcriptCursor: { offset: transcriptStat.size },
				},
			})
			.where(eq(sessions.sessionId, session.sessionId));
		return;
	}

	const normalizedEvents = parseTranscriptDelta(session.agentType, lines);
	const insertedEvents = await insertNormalizedEvents(session.sessionId, normalizedEvents);

	if (insertedEvents.length > 0) {
		notifySessionEvents(session.sessionId, insertedEvents);
	}

	await db
		.update(sessions)
		.set({
			metadata: {
				...(session.metadata || {}),
				transcriptCursor: { offset: transcriptStat.size },
			},
		})
		.where(eq(sessions.sessionId, session.sessionId));
}

async function syncTranscriptBatch(batch: SessionWithMetadata[]) {
	const results = await Promise.allSettled(
		batch.map((session) => syncTranscriptForSession(session)),
	);

	for (const result of results) {
		if (result.status === "rejected") {
			console.error("[transcript-sync] Session sync error:", result.reason);
		}
	}
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

			for (let index = 0; index < activeSessions.length; index += TRANSCRIPT_SYNC_BATCH_SIZE) {
				const batch = activeSessions.slice(index, index + TRANSCRIPT_SYNC_BATCH_SIZE) as SessionWithMetadata[];
				await syncTranscriptBatch(batch);
			}
		} catch (err) {
			console.error("[transcript-sync] Error:", err);
		}
	}, TRANSCRIPT_SYNC_INTERVAL_MS);
}
