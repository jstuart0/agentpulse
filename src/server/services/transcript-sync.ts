import { readFile, stat } from "node:fs/promises";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { AgentType, Session } from "../../shared/types.js";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { type NormalizedEvent, createAssistantTranscriptEvent } from "./event-normalizer.js";
import { insertNormalizedEvents } from "./event-processor.js";
import { notifySessionEvents } from "./notifier.js";

/**
 * Transcript sync worker (WS3). Scans active-session transcript files
 * out-of-band from the request path, inserts assistant-visible deltas
 * as timeline events, and delegates fanout to the notifier service.
 *
 * Design invariants:
 *   - async IO only — never synchronous readFileSync/statSync
 *   - bounded per-tick work (at most TICK_BUDGET sessions)
 *   - round-robin through active sessions across ticks so one hot
 *     transcript can't starve others
 *   - per-session byte offset stored in session.metadata.transcriptCursor
 *     so we only re-read the delta since last tick
 *   - transcript lag is observable via logs; inserts pass through
 *     insertNormalizedEvents → notifier, never touching the WS handler
 */

const TICK_INTERVAL_MS = 2_000;
const TICK_BUDGET = 3;

type TranscriptCursor = { offset?: number };

type SessionWithMetadata = Pick<Session, "sessionId" | "agentType" | "transcriptPath" | "metadata">;

function getTranscriptCursor(
	metadata: Record<string, unknown> | null | undefined,
): TranscriptCursor {
	if (!metadata || typeof metadata !== "object") return {};
	const value = metadata.transcriptCursor;
	return value && typeof value === "object" ? (value as TranscriptCursor) : {};
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
			if (
				payload?.type !== "agent_message" ||
				typeof payload.message !== "string" ||
				!payload.message.trim()
			) {
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

async function syncTranscriptForSession(session: SessionWithMetadata): Promise<void> {
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
		await persistCursor(session, transcriptStat.size);
		return;
	}

	const normalizedEvents = parseTranscriptDelta(session.agentType, lines);
	const insertedEvents = await insertNormalizedEvents(session.sessionId, normalizedEvents);

	if (insertedEvents.length > 0) {
		notifySessionEvents(session.sessionId, insertedEvents);
	}

	await persistCursor(session, transcriptStat.size);
}

async function persistCursor(session: SessionWithMetadata, offset: number): Promise<void> {
	await db
		.update(sessions)
		.set({
			metadata: {
				...(session.metadata || {}),
				transcriptCursor: { offset },
			},
		})
		.where(eq(sessions.sessionId, session.sessionId));
}

async function loadActiveSessionIds(): Promise<string[]> {
	const rows = await db
		.select({ sessionId: sessions.sessionId })
		.from(sessions)
		.where(
			and(
				isNotNull(sessions.transcriptPath),
				ne(sessions.status, "completed"),
				ne(sessions.status, "archived"),
			),
		);
	return rows.map((r) => r.sessionId);
}

async function loadSessionsByIds(ids: string[]): Promise<SessionWithMetadata[]> {
	if (ids.length === 0) return [];
	const rows = await db
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
	const byId = new Map(rows.map((r) => [r.sessionId, r as SessionWithMetadata]));
	const out: SessionWithMetadata[] = [];
	for (const id of ids) {
		const row = byId.get(id);
		if (row) out.push(row);
	}
	return out;
}

/**
 * Round-robin scheduler state. We walk an ordered list of active
 * session ids, advancing `cursor` TICK_BUDGET slots per tick so no
 * single hot session monopolizes the worker.
 */
class TranscriptSyncWorker {
	private interval: ReturnType<typeof setInterval> | null = null;
	private cursor = 0;
	private busy = false;

	start() {
		if (this.interval) return;
		this.interval = setInterval(() => {
			void this.tick();
		}, TICK_INTERVAL_MS);
		console.log(
			`[transcript-sync] worker started (tick=${TICK_INTERVAL_MS}ms, budget=${TICK_BUDGET})`,
		);
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** Drive a single tick. Exposed so tests can run one iteration. */
	async tick(): Promise<number> {
		if (this.busy) return 0;
		this.busy = true;
		try {
			const ids = await loadActiveSessionIds();
			if (ids.length === 0) return 0;

			if (this.cursor >= ids.length) this.cursor = 0;
			const picked: string[] = [];
			for (let i = 0; i < TICK_BUDGET && picked.length < ids.length; i++) {
				picked.push(ids[(this.cursor + i) % ids.length]);
			}
			this.cursor = (this.cursor + picked.length) % ids.length;

			const batch = await loadSessionsByIds(picked);
			const results = await Promise.allSettled(
				batch.map((session) => syncTranscriptForSession(session)),
			);
			for (const result of results) {
				if (result.status === "rejected") {
					console.error("[transcript-sync] Session sync error:", result.reason);
				}
			}
			return batch.length;
		} catch (err) {
			console.error("[transcript-sync] tick error:", err);
			return 0;
		} finally {
			this.busy = false;
		}
	}
}

export const transcriptSyncWorker = new TranscriptSyncWorker();

export function startTranscriptSync() {
	transcriptSyncWorker.start();
}

export function stopTranscriptSync() {
	transcriptSyncWorker.stop();
}
