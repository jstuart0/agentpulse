import {
	getOperationalStatus,
	hasOutstandingPermissionWait,
} from "../../../shared/session-state.js";
import { parseStoredTimestamp } from "../../../shared/timestamp.js";
import type { sessions } from "../../db/schema/index.js";
import type { PushDispatchContext, PushEvent } from "./types.js";

type SessionRow = typeof sessions.$inferSelect;

function pendingPermissionCount(metadata: Record<string, unknown> | null): number {
	const wait = metadata?.permissionWait as { ids?: unknown; anon?: unknown } | null | undefined;
	if (!wait) return 0;
	const ids = Array.isArray(wait.ids) ? wait.ids.length : 0;
	const anon = typeof wait.anon === "number" ? wait.anon : 0;
	return ids + anon;
}

export async function enrichPushEvent(
	event: PushEvent,
	ctx: PushDispatchContext,
): Promise<PushEvent> {
	if (!("sessionId" in event) || !event.sessionId) return event;
	const row = (await ctx.session(event.sessionId)) as SessionRow | null;
	if (!row) return event;
	// A launch names its session by a correlation id. Its labels are used only when that session is the
	// requester's own, so the id can never point a notification at someone else's session.
	if (
		event.type === "launch_status" &&
		(row.ownerUserId ?? null) !== (event.requesterUserId ?? null)
	) {
		return event;
	}

	const filled: Record<string, unknown> = {};
	const fill = (key: string, value: unknown) => {
		if (value === null || value === undefined) return;
		if ((event as Record<string, unknown>)[key] === undefined) filled[key] = value;
	};
	fill("sessionName", row.displayName);
	fill("agent", row.agentType);
	fill("machine", row.reportedHost);
	fill("status", getOperationalStatus(row));
	if (hasOutstandingPermissionWait(row)) fill("pending", pendingPermissionCount(row.metadata));
	if (event.type === "session_failed" || event.type === "session_completed") {
		const start = parseStoredTimestamp(row.startedAt);
		const end = parseStoredTimestamp(row.endedAt) ?? Date.now();
		if (start !== null) fill("durationSec", Math.max(0, Math.round((end - start) / 1000)));
		fill("toolCount", row.totalToolUses);
	}
	return { ...event, ...filled } as PushEvent;
}
