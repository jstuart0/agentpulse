import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { watcherProposals } from "../../db/schema.js";
import type { WatcherDecision } from "./parser.js";

export type ProposalState =
	| "pending"
	| "complete"
	| "hitl_waiting"
	| "hitl_applied"
	| "hitl_declined"
	| "cancelled"
	| "failed";

export interface ProposalRecord {
	id: string;
	sessionId: string;
	providerId: string;
	state: ProposalState;
	decision: WatcherDecision["decision"] | null;
	nextPrompt: string | null;
	reportSummary: string | null;
	rawResponse: Record<string, unknown> | null;
	triggerEventId: string | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated: boolean;
	errorSubType: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof watcherProposals.$inferSelect): ProposalRecord {
	return {
		id: row.id,
		sessionId: row.sessionId,
		providerId: row.providerId,
		state: row.state as ProposalState,
		decision: (row.decision as ProposalRecord["decision"]) ?? null,
		nextPrompt: row.nextPrompt,
		reportSummary: row.reportSummary,
		rawResponse: row.rawResponse ?? null,
		triggerEventId: row.triggerEventId,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		costCents: row.costCents,
		usageEstimated: row.usageEstimated,
		errorSubType: row.errorSubType,
		errorMessage: row.errorMessage,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function createPendingProposal(input: {
	sessionId: string;
	providerId: string;
	triggerEventId?: string | null;
}): Promise<ProposalRecord> {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(watcherProposals)
		.values({
			sessionId: input.sessionId,
			providerId: input.providerId,
			state: "pending",
			triggerEventId: input.triggerEventId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

export interface CompleteProposalInput {
	id: string;
	decision: WatcherDecision["decision"];
	nextPrompt?: string | null;
	reportSummary?: string | null;
	rawResponse?: Record<string, unknown> | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated?: boolean;
	state?: ProposalState;
}

export async function completeProposal(input: CompleteProposalInput): Promise<ProposalRecord | null> {
	const now = new Date().toISOString();
	await db
		.update(watcherProposals)
		.set({
			decision: input.decision,
			nextPrompt: input.nextPrompt ?? null,
			reportSummary: input.reportSummary ?? null,
			rawResponse: input.rawResponse ?? null,
			tokensIn: input.tokensIn,
			tokensOut: input.tokensOut,
			costCents: input.costCents,
			usageEstimated: input.usageEstimated ?? false,
			state: input.state ?? "complete",
			updatedAt: now,
		})
		.where(eq(watcherProposals.id, input.id));
	return getProposal(input.id);
}

export async function failProposal(input: {
	id: string;
	errorSubType: string;
	errorMessage: string;
}): Promise<ProposalRecord | null> {
	const now = new Date().toISOString();
	await db
		.update(watcherProposals)
		.set({
			state: "failed",
			errorSubType: input.errorSubType,
			errorMessage: input.errorMessage,
			updatedAt: now,
		})
		.where(eq(watcherProposals.id, input.id));
	return getProposal(input.id);
}

export async function setProposalState(id: string, state: ProposalState): Promise<void> {
	await db
		.update(watcherProposals)
		.set({ state, updatedAt: new Date().toISOString() })
		.where(eq(watcherProposals.id, id));
}

export async function getProposal(id: string): Promise<ProposalRecord | null> {
	const [row] = await db.select().from(watcherProposals).where(eq(watcherProposals.id, id)).limit(1);
	return row ? toRecord(row) : null;
}

export async function listProposalsForSession(
	sessionId: string,
	limit = 30,
): Promise<ProposalRecord[]> {
	const rows = await db
		.select()
		.from(watcherProposals)
		.where(eq(watcherProposals.sessionId, sessionId))
		.orderBy(desc(watcherProposals.createdAt))
		.limit(limit);
	return rows.map(toRecord);
}

export async function getOpenHitlProposal(sessionId: string): Promise<ProposalRecord | null> {
	const [row] = await db
		.select()
		.from(watcherProposals)
		.where(and(eq(watcherProposals.sessionId, sessionId), eq(watcherProposals.state, "hitl_waiting")))
		.orderBy(desc(watcherProposals.createdAt))
		.limit(1);
	return row ? toRecord(row) : null;
}

/**
 * Cancel any open HITL requests for a session. Called when the user disables
 * the watcher, when the global kill switch fires, or when a newer trigger
 * supersedes the previous one.
 */
export async function cancelOpenHitl(sessionId: string, reason = "cancelled"): Promise<number> {
	const now = new Date().toISOString();
	const res = await db
		.update(watcherProposals)
		.set({ state: "cancelled", errorMessage: reason, updatedAt: now })
		.where(and(eq(watcherProposals.sessionId, sessionId), inArray(watcherProposals.state, ["hitl_waiting", "pending"])))
		.returning();
	return res.length;
}
