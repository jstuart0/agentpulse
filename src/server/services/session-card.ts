/**
 * The card row of the session list (`GET /sessions?view=card`): the fields a
 * phone's list draws, and nothing it doesn't. An allowlist, so a column added to
 * `sessions` later stays off the card until someone chooses to put it there.
 *
 * Left off on purpose: the stored CLAUDE.md, notes, plan, transcript path, the
 * metadata document (it carries the permission wait's tool ids, which a list
 * never needs), the watcher and spend columns, and the reported host (the
 * effective `machine` already says where the session is).
 */
import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { launchRequests } from "../db/schema/index.js";
import { redact } from "./ai/redactor.js";

export const SESSION_CARD_FIELDS = [
	"id",
	"sessionId",
	"displayName",
	"nameSource",
	"nativeName",
	"agentType",
	"status",
	"operationalStatus",
	"cwd",
	"model",
	"projectId",
	"gitBranch",
	"startedAt",
	"lastActivityAt",
	"endedAt",
	"semanticStatus",
	"currentTask",
	"totalToolUses",
	"isWorking",
	"isPinned",
	"isArchived",
	"lastAgentTurnCompletedAt",
	"lastUserAcknowledgedAt",
	"currentTurnStartedAt",
	"ownerUserId",
	"ownerKind",
	"machine",
	"managed",
] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Longest failure reason a card carries, in characters. */
export const FAILURE_REASON_MAX_CHARS = 120;

/**
 * How many permission prompts are open on the session: a count, never the tool
 * ids or inputs behind them. Counts the same way the classifier does.
 */
export function permissionWaitCount(metadata: unknown): number {
	const wait = (metadata as { permissionWait?: { ids?: unknown; anon?: unknown } } | null)
		?.permissionWait;
	if (wait == null || typeof wait !== "object") return 0;
	const ids = Array.isArray(wait.ids) ? wait.ids.length : 0;
	const anon = typeof wait.anon === "number" && wait.anon > 0 ? Math.trunc(wait.anon) : 0;
	return ids + anon;
}

/** A user's home directory in a path (macOS, Linux, Windows): the account name is what it gives away. */
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g;

/**
 * A launch's error as one short, printable line, or null when there is nothing
 * to say. Secrets are redacted first (the same redactor the push path uses, so a
 * token in a clone URL never leaves), home-directory paths are reduced to `~`,
 * whitespace and control characters are collapsed, and the text is cut to
 * FAILURE_REASON_MAX_CHARS whole characters with an ellipsis. Redaction comes
 * before the cut so a secret cut in half is still caught.
 */
export function safeFailureReason(error: string | null | undefined): string | null {
	if (typeof error !== "string") return null;
	const line = redact(error)
		.text.replace(HOME_PATH, "~")
		.replace(CONTROL_CHARACTERS, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (line.length === 0) return null;
	const points = Array.from(line);
	if (points.length <= FAILURE_REASON_MAX_CHARS) return line;
	return `${points
		.slice(0, FAILURE_REASON_MAX_CHARS - 1)
		.join("")
		.trimEnd()}…`;
}

/**
 * Why each of these failed sessions failed: the error of the launch that started
 * it, in one batched read. A session with no launch behind it, or a launch with
 * no error, has no entry.
 */
export async function loadFailureReasons(
	failedSessionIds: readonly string[],
): Promise<Map<string, string>> {
	const reasons = new Map<string, string>();
	if (failedSessionIds.length === 0) return reasons;
	const rows = await getDb()
		.select({ correlationId: launchRequests.launchCorrelationId, error: launchRequests.error })
		.from(launchRequests)
		.where(inArray(launchRequests.launchCorrelationId, [...failedSessionIds]));
	for (const { correlationId, error } of rows) {
		const reason = safeFailureReason(error);
		if (reason) reasons.set(correlationId, reason);
	}
	return reasons;
}

/** One card row from a mapped session (mapSessionDto's output, effective machine and `managed` merged in). */
export function toSessionCard(
	session: Record<string, unknown>,
	extras: { permissionWait: number; failureReason: string | null },
): Record<string, unknown> {
	const card: Record<string, unknown> = {};
	for (const field of SESSION_CARD_FIELDS) card[field] = session[field];
	card.permissionWait = extras.permissionWait;
	card.failureReason = extras.failureReason;
	return card;
}
