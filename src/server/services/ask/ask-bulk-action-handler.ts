import { and, eq, inArray, sql } from "drizzle-orm";
import type { SessionMutationKind } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { managedSessions, sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import type { CachedProject } from "../projects/cache.js";
import { getSearchBackend } from "../search/index.js";
import type { BulkActionIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export interface HandleBulkActionArgs {
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
}

export interface HandleBulkActionResult {
	replyText: string;
	actionRequestId: string | null;
}

interface SessionCandidate {
	sessionId: string;
	displayName: string | null;
	status: string;
	endedAt: string | null;
	isArchived: boolean;
}

interface ExcludedSession {
	sessionId: string;
	name: string;
	reason: string;
}

export interface BulkSessionActionPayload {
	action: SessionMutationKind;
	sessionIds: string[];
	sessionNames: string[];
	exclusions: Array<{ sessionId: string; name: string; reason: string }>;
}

// Cap at 50 targets to prevent unintended mass-mutations from a single approval.
const MAX_TARGETS = 50;
// Show at most 20 names in the preview to stay under Telegram's 4096-char message limit.
const MAX_PREVIEW_NAMES = 20;
// Truncate individual session names to 40 chars for the same reason.
const MAX_NAME_LENGTH = 40;

function truncateName(name: string | null, id: string): string {
	const display = name ?? id.slice(0, 8);
	return display.length > MAX_NAME_LENGTH ? `${display.slice(0, MAX_NAME_LENGTH - 1)}…` : display;
}

async function resolveByAttribute(
	filter: Extract<BulkActionIntent["filter"], { strategy: "attribute" }>,
	projects: CachedProject[],
): Promise<SessionCandidate[]> {
	const conditions = [eq(sessions.isArchived, false)];

	if (filter.status) {
		conditions.push(eq(sessions.status, filter.status));
	}

	if (filter.olderThanDays != null) {
		const cutoff = new Date(Date.now() - filter.olderThanDays * 86_400_000).toISOString();
		// For completed/failed sessions, use endedAt; for others, use lastActivityAt.
		conditions.push(sql`(COALESCE(${sessions.endedAt}, ${sessions.lastActivityAt}) < ${cutoff})`);
	}

	if (filter.projectHint) {
		const matched = projects.find(
			(p) => p.name.toLowerCase() === filter.projectHint?.toLowerCase(),
		);
		if (matched) {
			conditions.push(eq(sessions.projectId, matched.id));
		}
	}

	return db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			status: sessions.status,
			endedAt: sessions.endedAt,
			isArchived: sessions.isArchived,
		})
		.from(sessions)
		.where(and(...conditions));
}

async function resolveByHint(
	filter: Extract<BulkActionIntent["filter"], { strategy: "hint" }>,
	projects: CachedProject[],
): Promise<SessionCandidate[]> {
	const backend = getSearchBackend();
	const result = await backend.search({ q: filter.searchHint, mode: "or", limit: 60 });

	const uniqueIds = Array.from(new Set(result.hits.map((h) => h.sessionId)));
	if (uniqueIds.length === 0) return [];

	let conditions: ReturnType<typeof and>[] = [
		inArray(sessions.sessionId, uniqueIds),
		eq(sessions.isArchived, false),
	];

	if (filter.projectHint) {
		const matched = projects.find(
			(p) => p.name.toLowerCase() === filter.projectHint?.toLowerCase(),
		);
		if (matched) {
			conditions = [...conditions, eq(sessions.projectId, matched.id)];
		}
	}

	return db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			status: sessions.status,
			endedAt: sessions.endedAt,
			isArchived: sessions.isArchived,
		})
		.from(sessions)
		.where(and(...conditions));
}

async function applyPreflightExclusions(
	candidates: SessionCandidate[],
	action: SessionMutationKind,
): Promise<{ included: SessionCandidate[]; excluded: ExcludedSession[] }> {
	const included: SessionCandidate[] = [];
	const excluded: ExcludedSession[] = [];

	if (action === "stop") {
		// Exclude hook-only sessions (no managed_sessions row) at handler-time
		// so the inbox card preview accurately reflects what will be acted on.
		if (candidates.length === 0) return { included, excluded };

		const managedRows = await db
			.select({ sessionId: managedSessions.sessionId })
			.from(managedSessions)
			.where(
				inArray(
					managedSessions.sessionId,
					candidates.map((c) => c.sessionId),
				),
			);
		const managedSet = new Set(managedRows.map((r) => r.sessionId));

		for (const c of candidates) {
			if (!managedSet.has(c.sessionId)) {
				excluded.push({
					sessionId: c.sessionId,
					name: truncateName(c.displayName, c.sessionId),
					reason: "hook-only",
				});
			} else {
				included.push(c);
			}
		}
	} else if (action === "delete") {
		// Exclude active sessions at handler-time — deleting a running agent
		// would remove the session row while the agent may still be sending events.
		const activeStatuses = ["active", "idle"];
		for (const c of candidates) {
			if (!c.endedAt && activeStatuses.includes(c.status)) {
				excluded.push({
					sessionId: c.sessionId,
					name: truncateName(c.displayName, c.sessionId),
					reason: "active — stop or archive first",
				});
			} else {
				included.push(c);
			}
		}
	} else {
		// archive: no exclusions — archive is just a flag and does not terminate the agent.
		included.push(...candidates);
	}

	return { included, excluded };
}

function buildPreviewText(
	action: SessionMutationKind,
	included: SessionCandidate[],
	excluded: ExcludedSession[],
): string {
	const n = included.length;
	const preview = included
		.slice(0, MAX_PREVIEW_NAMES)
		.map((s) => truncateName(s.displayName, s.sessionId));

	const lines: string[] = [
		`Found ${n} session${n !== 1 ? "s" : ""} matching your query. Approve in inbox to ${action} them.`,
		"",
		...preview.map((name) => `• ${name}`),
	];

	if (n > MAX_PREVIEW_NAMES) {
		lines.push(`…and ${n - MAX_PREVIEW_NAMES} more`);
	}

	if (excluded.length > 0) {
		lines.push("");
		lines.push(
			`${excluded.length} session${excluded.length !== 1 ? "s" : ""} excluded from this action (not shown in preview).`,
		);
	}

	return lines.join("\n");
}

export async function handleBulkAction(
	intent: BulkActionIntent,
	projects: CachedProject[],
	args: HandleBulkActionArgs,
): Promise<HandleBulkActionResult> {
	const { action, filter } = intent;
	const { origin, threadId, telegramChatId } = args;

	const candidates =
		filter.strategy === "attribute"
			? await resolveByAttribute(filter, projects)
			: await resolveByHint(filter, projects);

	const { included, excluded } = await applyPreflightExclusions(candidates, action);

	if (included.length === 0) {
		return {
			replyText: "No sessions matched that description.",
			actionRequestId: null,
		};
	}

	// Cap at 50 — above this the blast radius is too large to approve via a single click.
	if (included.length > MAX_TARGETS) {
		return {
			replyText: `That matches ${included.length} sessions — too broad to bulk-${action} safely. Can you narrow this down?`,
			actionRequestId: null,
		};
	}

	const sessionNames = included.map((s) => truncateName(s.displayName, s.sessionId));

	const payload: BulkSessionActionPayload = {
		action,
		sessionIds: included.map((s) => s.sessionId),
		sessionNames,
		exclusions: excluded,
	};

	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	const question = `Bulk ${action}: ${included.length} session${included.length !== 1 ? "s" : ""}${excluded.length > 0 ? ` (${excluded.length} excluded)` : ""}`;

	const actionRequest = await createActionRequest({
		kind: "bulk_session_action",
		question,
		origin,
		channelId,
		askThreadId: threadId,
		payload: payload as unknown as Record<string, unknown>,
	});

	if (origin === "telegram" && telegramChatId) {
		const previewNames = sessionNames.slice(0, MAX_PREVIEW_NAMES).join(", ");
		const telegramText = `Bulk ${action}: ${included.length} sessions${sessionNames.length > MAX_PREVIEW_NAMES ? ` (${previewNames}, +${sessionNames.length - MAX_PREVIEW_NAMES} more)` : ` (${previewNames})`}`;
		await sendTelegramActionRequest(
			telegramChatId,
			actionRequest.id,
			telegramText,
			`Bulk ${action}`,
		);
	}

	return {
		replyText: buildPreviewText(action, included, excluded),
		actionRequestId: actionRequest.id,
	};
}
