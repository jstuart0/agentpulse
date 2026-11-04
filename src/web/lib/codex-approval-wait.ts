/**
 * Reading a Codex approval off a session row (AGEN-87). The server holds an open
 * approval in `metadata.permissionWait.ids` under an `approval:` id, so a list row
 * can say "Codex is asking" without a query. Small on purpose: the dashboard and
 * the session header load it.
 */
import { APPROVAL_WAIT_ID_PREFIX } from "../../shared/codex-approvals.js";

export const CODEX_APPROVAL_NOTE_CAN_ANSWER =
	"Codex is asking for approval. Open the session to answer.";

export const CHUNK_LOAD_FAILED_COPY =
	"Codex is asking for approval, but this part of the page didn't load. Reload to answer.";

/**
 * The note on a card whose acknowledge control the viewer doesn't have; `owner` is a display name,
 * or null when there is none. An admin can answer someone else's request, so the note says where.
 */
export function codexApprovalNoteOtherOwner(owner: string | null, canAnswer = false): string {
	const asking = `Codex is asking ${owner?.trim() || "the session's owner"} for approval.`;
	return canAnswer ? `${asking} Open the session to answer.` : asking;
}

/** The approval ids a session row says are open, in the order the server wrote them. */
export function codexApprovalWaitIds(
	metadata: Record<string, unknown> | null | undefined,
): string[] {
	const ids = (metadata?.permissionWait as { ids?: unknown } | null | undefined)?.ids;
	if (!Array.isArray(ids)) return [];
	return ids
		.filter((id): id is string => typeof id === "string" && id.startsWith(APPROVAL_WAIT_ID_PREFIX))
		.map((id) => id.slice(APPROVAL_WAIT_ID_PREFIX.length));
}

export function hasPendingCodexApproval(session: {
	metadata?: Record<string, unknown> | null;
}): boolean {
	return codexApprovalWaitIds(session.metadata).length > 0;
}

/** The approval card is for a managed Codex session only; every other session never asks for approvals. */
export function showsApprovalCard(session: {
	agentType: string;
	managedSession?: unknown;
}): boolean {
	return session.agentType === "codex_cli" && Boolean(session.managedSession);
}
