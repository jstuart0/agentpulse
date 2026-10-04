import type { OperationalStatus } from "../../../../shared/session-state.js";
import type {
	SessionSummary,
	StoredEvidenceFact,
	StoredSessionSummary,
	SummaryAdjustment,
	SummaryDraft,
	SummarySuspectReason,
} from "../../../../shared/session-summary.js";

export interface LedgerFactForVerify {
	kind: string;
	at: string | null;
	result?: string;
	count?: number;
	observed?: boolean;
}

export interface LedgerForVerify {
	ids: ReadonlyMap<string, LedgerFactForVerify>;
}

export interface SessionStateForVerify {
	operational: OperationalStatus;
	permissionWaitOutstanding: boolean;
	lifecycleStatus: string;
}

export interface VerifyInput {
	draft: SummaryDraft;
	ledger: LedgerForVerify;
	session: SessionStateForVerify;
	userPromptUrls: ReadonlySet<string>;
	nonce: string;
}

export interface VerifyResult {
	summary: SessionSummary;
	adjustments: SummaryAdjustment[];
	suspect: boolean;
	suspectReasons: SummarySuspectReason[];
	evidence: Record<string, StoredEvidenceFact>;
}

export function verifySummary(_input: VerifyInput): VerifyResult {
	throw new Error("not implemented");
}

export interface StoredSummaryInput {
	verified: VerifyResult;
	promptVersion: string;
	provider: { kind: string; model: string };
	usage: { inputTokens: number; outputTokens: number; estimated: boolean };
	costCents: number;
	calls: number;
	redactionHits: number;
	coverage: {
		status: "full" | "partial";
		eventsTotal: number;
		eventsRead: number;
		eventsRepresented: number;
		droppedByCap: number;
		droppedByBudget: number;
		cutoffAt: string | null;
	};
	firstEventId: number | null;
}

export function buildStoredSummary(_input: StoredSummaryInput): StoredSessionSummary {
	throw new Error("not implemented");
}
