import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { managedSessions, sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import { getSearchBackend } from "../search/index.js";
import type { SessionActionIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export type { SessionActionIntent };

export interface HandleSessionActionArgs {
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
}

export interface HandleSessionActionResult {
	replyText: string;
	actionRequestId: string | null;
}

// ---- Session resolution -------------------------------------------------

interface ResolvedSession {
	sessionId: string;
	displayName: string | null;
	status: string;
	agentType: string;
}

/**
 * Ambiguity threshold: if the top two BM25 scores are within 5% of each
 * other we treat the match as ambiguous and ask for clarification rather
 * than silently picking the first hit. Combined with the >1-hit check this
 * protects against wrong-session mutations on non-deterministic FTS tiebreaks.
 */
const AMBIGUITY_SCORE_GAP = 0.05;

async function resolveSession(
	hint: string | null,
): Promise<
	| { ok: true; session: ResolvedSession }
	| { ok: false; reason: "not_found"; replyText: string }
	| { ok: false; reason: "ambiguous"; replyText: string }
> {
	if (hint === null) {
		// Recency fallback: no name hint → most recently active non-archived session.
		const [row] = await db
			.select({
				sessionId: sessions.sessionId,
				displayName: sessions.displayName,
				status: sessions.status,
				agentType: sessions.agentType,
			})
			.from(sessions)
			.where(eq(sessions.isArchived, false))
			.orderBy(sql`last_activity_at DESC`)
			.limit(1);
		if (!row) {
			return { ok: false, reason: "not_found", replyText: "No sessions found." };
		}
		return { ok: true, session: row };
	}

	const backend = getSearchBackend();
	const result = await backend.search({ q: hint, mode: "or", limit: 5 });
	const hits = result.hits;

	if (hits.length === 0) {
		return {
			ok: false,
			reason: "not_found",
			replyText: `I couldn't find a session matching **${hint}** — try a more specific name.`,
		};
	}

	// Deduplicate by sessionId (take highest-score hit per session).
	const bySession = new Map<string, (typeof hits)[number]>();
	for (const h of hits) {
		const existing = bySession.get(h.sessionId);
		if (!existing || h.score > existing.score) {
			bySession.set(h.sessionId, h);
		}
	}
	const unique = Array.from(bySession.values()).sort((a, b) => b.score - a.score);

	// Ambiguous: multiple sessions where the top two scores are within the gap threshold.
	// We ask for clarification rather than silently picking the first.
	if (
		unique.length > 1 &&
		unique[0].score > 0 &&
		(unique[0].score - unique[1].score) / unique[0].score < AMBIGUITY_SCORE_GAP
	) {
		const top = unique.slice(0, 3);
		const candidates = top
			.map((h, i) => `${i + 1}. **${h.sessionDisplayName ?? h.sessionId.slice(0, 8)}**`)
			.join("\n");
		return {
			ok: false,
			reason: "ambiguous",
			replyText: `I found multiple sessions that could match — which one did you mean?\n${candidates}`,
		};
	}

	const best = unique[0];
	// Load full session row to get status + agentType.
	const [row] = await db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			status: sessions.status,
			agentType: sessions.agentType,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, best.sessionId))
		.limit(1);

	if (!row) {
		return {
			ok: false,
			reason: "not_found",
			replyText: `Couldn't load session details for **${best.sessionDisplayName ?? best.sessionId.slice(0, 8)}**.`,
		};
	}
	return { ok: true, session: row };
}

// ---- Public handler ------------------------------------------------------

export async function handleSessionAction(
	intent: SessionActionIntent,
	args: HandleSessionActionArgs,
): Promise<HandleSessionActionResult> {
	const { origin, threadId, telegramChatId } = args;

	const resolution = await resolveSession(intent.sessionHint);
	if (!resolution.ok) {
		return { replyText: resolution.replyText, actionRequestId: null };
	}

	const session = resolution.session;
	const name = session.displayName ?? session.sessionId.slice(0, 8);

	// ---- Non-destructive: direct execute --------------------------------

	if (intent.action === "pin") {
		await db
			.update(sessions)
			.set({ isPinned: true })
			.where(eq(sessions.sessionId, session.sessionId));
		return { replyText: `Pinned **${name}**.`, actionRequestId: null };
	}

	if (intent.action === "unpin") {
		await db
			.update(sessions)
			.set({ isPinned: false })
			.where(eq(sessions.sessionId, session.sessionId));
		return { replyText: `Unpinned **${name}**.`, actionRequestId: null };
	}

	if (intent.action === "add_note") {
		const noteContent = intent.noteText?.trim() || "(no content)";
		// Append semantics: existing notes are preserved. New note gets a
		// datetime prefix so the user can tell entries apart in the UI.
		await db
			.update(sessions)
			.set({
				notes: sql`CASE
          WHEN COALESCE(notes, '') = '' THEN ${noteContent}
          ELSE notes || char(10) || ${noteContent}
        END`,
			})
			.where(eq(sessions.sessionId, session.sessionId));
		return { replyText: `Note appended to **${name}**.`, actionRequestId: null };
	}

	if (intent.action === "rename") {
		const newName = intent.newName?.trim();
		if (!newName) {
			return {
				replyText: `I need a new name to rename **${name}** — try "rename ${name} to <new-name>".`,
				actionRequestId: null,
			};
		}
		const oldName = name;
		await db
			.update(sessions)
			.set({ displayName: newName })
			.where(eq(sessions.sessionId, session.sessionId));

		// Mirror the existing rename route: also update managed session title if present.
		const [managed] = await db
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, session.sessionId))
			.limit(1);
		if (managed) {
			await db
				.update(managedSessions)
				.set({
					desiredThreadTitle: newName,
					providerSyncState: "pending",
					providerSyncError: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(managedSessions.sessionId, session.sessionId));
		}

		return {
			replyText: `Renamed **${oldName}** → **${newName}**. To undo, ask me to rename it back to **${oldName}**.`,
			actionRequestId: null,
		};
	}

	// ---- Destructive: action_request required ---------------------------

	if (intent.action === "stop") {
		// Pre-flight: verify the session has a managed_sessions row.
		// queueStopAction would throw for hook-only sessions — we surface a
		// clear message here so no action_request is ever created for them.
		const [managed] = await db
			.select({ sessionId: managedSessions.sessionId })
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, session.sessionId))
			.limit(1);

		if (!managed) {
			return {
				replyText: `**${name}** is observed via hooks but isn't a managed launch — stop control isn't available for hook-only sessions.`,
				actionRequestId: null,
			};
		}

		return createSessionActionRequest({
			kind: "session_stop",
			session,
			question: `Stop session **${name}**?`,
			contextLabel: "Stop session request",
			origin,
			threadId,
			telegramChatId,
			successReply: `Queued a stop for **${name}** — approve in inbox.`,
		});
	}

	if (intent.action === "archive") {
		return createSessionActionRequest({
			kind: "session_archive",
			session,
			question: `Archive session **${name}**?`,
			contextLabel: "Archive session request",
			origin,
			threadId,
			telegramChatId,
			successReply: `Queued archive for **${name}** — approve in inbox.`,
		});
	}

	if (intent.action === "delete") {
		return createSessionActionRequest({
			kind: "session_delete",
			session,
			question: `Permanently delete session **${name}**? This cannot be undone.`,
			contextLabel: "Delete session request",
			origin,
			threadId,
			telegramChatId,
			successReply: `Queued delete for **${name}** — approve in inbox.`,
		});
	}

	// Exhaustive — TypeScript ensures all actions are handled above.
	return { replyText: "Unknown action requested.", actionRequestId: null };
}

// ---- Helper: create destructive action_request --------------------------

async function createSessionActionRequest(opts: {
	kind: "session_stop" | "session_archive" | "session_delete";
	session: ResolvedSession;
	question: string;
	contextLabel: string;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	successReply: string;
}): Promise<HandleSessionActionResult> {
	const { kind, session, question, contextLabel, origin, threadId, telegramChatId, successReply } =
		opts;

	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	const actionRequest = await createActionRequest({
		kind,
		question,
		origin,
		channelId,
		askThreadId: threadId,
		payload: {
			sessionId: session.sessionId,
			sessionDisplayName: session.displayName,
		},
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, contextLabel);
	}

	return { replyText: successReply, actionRequestId: actionRequest.id };
}
