import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import type { DispatchConfigSnapshot } from "../../db/schema/ai/ai-dispatch-audit.js";
import { aiDispatchAudit } from "../../db/schema/index.js";
import { parseDbTimestamp } from "../util/db-time.js";
/**
 * The append-only trail of every attempt to type a prompt into an agent on a
 * watcher's behalf (table `ai_dispatch_audit`, with no foreign keys so it
 * outlives its session). The database refuses any update but the outcome
 * transitions this module makes, and any delete.
 *
 * A dispatch writes an intent row (`pending`, carrying the control action id
 * it is about to create) as the first statement of its transaction and turns
 * it into `sent` or `refused` in that same transaction, so a committed
 * `pending` row means something unexpected happened (the startup sweep
 * reconciles it). A refusal before the transaction is one `refused` row.
 *
 * Every function takes the handle to write through: a dispatch passes its
 * transaction, everything else `getDb()`. This module imports only the
 * schema, so the control-actions queue can use it without a cycle.
 */
import { redact } from "./redactor.js";
import type { WatcherConfigRecord } from "./watcher-config-service.js";

export type AuditActorKind = "user" | "telegram" | "auto";

export interface AuditIntent {
	sessionId: string;
	sessionName: string | null;
	actorKind: AuditActorKind;
	actorUserId: string | null;
	actorLabel: string;
	telegramFromId?: string | null;
	telegramChatId?: string | null;
	promptSha256: string | null;
	promptText: string | null;
	continueKind?: string | null;
	proposalId?: string | null;
	hitlId?: string | null;
	turnKey?: string | null;
	providerId?: string | null;
	model?: string | null;
	controlActionId?: string | null;
	configSnapshot?: DispatchConfigSnapshot | null;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The configuration a send was judged under, with the system prompt only as a hash. */
export function configSnapshotOf(
	config: WatcherConfigRecord | null,
): DispatchConfigSnapshot | null {
	if (!config) return null;
	return {
		policy: config.policy,
		autoConfirmedAt: config.autoConfirmedAt,
		autoConfirmedBy: config.autoConfirmedBy,
		continueEnabled: config.continueEnabled,
		maxContinuations: config.maxContinuations,
		continuationsUsed: config.continuationsUsed,
		systemPromptSha256: config.systemPrompt === null ? null : sha256Hex(config.systemPrompt),
	};
}

function toRow(intent: AuditIntent) {
	return {
		sessionId: intent.sessionId,
		sessionName: intent.sessionName,
		actorKind: intent.actorKind,
		actorUserId: intent.actorUserId,
		actorLabel: intent.actorLabel,
		telegramFromId: intent.telegramFromId ?? null,
		telegramChatId: intent.telegramChatId ?? null,
		promptSha256: intent.promptSha256,
		// Redacted: the hash is of what was sent, the stored copy must not keep a secret a person typed.
		promptText: intent.promptText === null ? null : redact(intent.promptText).text,
		continueKind: intent.continueKind ?? null,
		proposalId: intent.proposalId ?? null,
		hitlId: intent.hitlId ?? null,
		turnKey: intent.turnKey ?? null,
		providerId: intent.providerId ?? null,
		model: intent.model ?? null,
		controlActionId: intent.controlActionId ?? null,
		configSnapshot: intent.configSnapshot ?? null,
	};
}

/** The first statement of a dispatch transaction: what is about to be attempted. */
export async function insertAuditIntent(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	intent: AuditIntent,
): Promise<string> {
	const [row] = await db
		.insert(aiDispatchAudit)
		.values({ ...toRow(intent), outcome: "pending", createdAt: new Date().toISOString() })
		.returning({ id: aiDispatchAudit.id });
	return row.id as string;
}

/** The intent row's outcome: sent. */
export async function markAuditSent(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	auditId: string,
): Promise<void> {
	await db
		.update(aiDispatchAudit)
		.set({ outcome: "sent", completedAt: new Date().toISOString() })
		.where(and(eq(aiDispatchAudit.id, auditId), eq(aiDispatchAudit.outcome, "pending")));
}

/** The intent row's outcome: refused, with the code the caller was told. */
export async function markAuditRefused(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	auditId: string,
	refusalCode: string,
): Promise<void> {
	await db
		.update(aiDispatchAudit)
		.set({ outcome: "refused", refusalCode, completedAt: new Date().toISOString() })
		.where(and(eq(aiDispatchAudit.id, auditId), eq(aiDispatchAudit.outcome, "pending")));
}

/** A refusal decided before any transaction: one row, already `refused`. */
export async function insertRefusedAudit(
	intent: AuditIntent,
	refusalCode: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any = getDb(),
): Promise<string> {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(aiDispatchAudit)
		.values({
			...toRow(intent),
			outcome: "refused",
			refusalCode,
			createdAt: now,
			completedAt: now,
		})
		.returning({ id: aiDispatchAudit.id });
	return row.id as string;
}

/** An unexpected failure: the transaction rolled back, so this is the only trace. */
export async function insertFailedAudit(
	intent: AuditIntent,
	failureCode: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any = getDb(),
): Promise<string> {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(aiDispatchAudit)
		.values({
			...toRow(intent),
			outcome: "failed",
			refusalCode: failureCode,
			createdAt: now,
			completedAt: now,
		})
		.returning({ id: aiDispatchAudit.id });
	return row.id as string;
}

/**
 * The prompt was queued but the supervisor never took it: `sent` becomes
 * `failed` with `expired_unclaimed`, the one transition out of `sent` the
 * database allows.
 */
export async function markAuditExpiredUnclaimed(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	db: any,
	controlActionId: string,
): Promise<void> {
	await db
		.update(aiDispatchAudit)
		.set({
			outcome: "failed",
			refusalCode: "expired_unclaimed",
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(aiDispatchAudit.controlActionId, controlActionId),
				eq(aiDispatchAudit.outcome, "sent"),
			),
		);
}

/**
 * The prompts the watcher itself sent to a session, by exact text, with when
 * each was first sent (ms). The transcript uses it to label a prompt the
 * watcher typed as WATCHER-SENT rather than as the human's, and the tripwire's
 * "URLs the user typed" set leaves them out.
 */
export async function loadWatcherSentPrompts(sessionId: string): Promise<Map<string, number>> {
	const rows = await getDb()
		.select({
			text: aiDispatchAudit.promptText,
			createdAt: aiDispatchAudit.createdAt,
			completedAt: aiDispatchAudit.completedAt,
		})
		.from(aiDispatchAudit)
		.where(and(eq(aiDispatchAudit.sessionId, sessionId), eq(aiDispatchAudit.outcome, "sent")))
		.limit(500);
	const sent = new Map<string, number>();
	for (const row of rows) {
		if (!row.text) continue;
		const at = parseDbTimestamp(row.completedAt ?? row.createdAt);
		if (at === null) continue;
		const earlier = sent.get(row.text);
		if (earlier === undefined || at < earlier) sent.set(row.text, at);
	}
	return sent;
}
