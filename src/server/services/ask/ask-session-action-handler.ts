import { eq, sql } from "drizzle-orm";
import type { AskThreadOrigin } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { managedSessions, sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import type { ResolvedSession } from "./ask-resolver.js";
import { resolveSession } from "./ask-resolver.js";
import type { SessionActionIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export type { SessionActionIntent };
// Slice B and Slice C handlers should import resolveSession from ask-resolver.ts directly.

export interface HandleSessionActionArgs {
	origin: AskThreadOrigin;
	threadId: string;
	telegramChatId?: string | null;
}

export interface HandleSessionActionResult {
	replyText: string;
	actionRequestId: string | null;
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
	origin: AskThreadOrigin;
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
