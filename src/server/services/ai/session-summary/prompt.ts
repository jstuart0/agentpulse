import type { OperationalStatusInput } from "../../../../shared/session-state.js";
import type { LlmRequest } from "../llm/types.js";
import type { RepairKind } from "./output-schema.js";

export const PROMPT_VERSION = "";
export const SESSION_SUMMARY_SYSTEM_PROMPT = "";
export const SESSION_SUMMARY_SYSTEM_PROMPT_SHA256 = "";

export interface SessionForPrompt extends Omit<OperationalStatusInput, "metadata"> {
	displayName: string | null;
	agentType: string | null;
	model: string | null;
	cwd: string | null;
	gitBranch: string | null;
	currentTask: string | null;
	planSummary: string[] | string | null;
	notes: string | null;
	startedAt: string | null;
	metadata?: { permissionWait?: unknown } | null;
}

export interface LedgerForPrompt {
	text: string;
	coverage: {
		status: "full" | "partial";
		eventsTotal: number;
		eventsRead: number;
		eventsRepresented: number;
		droppedByCap: number;
		droppedByBudget: number;
		cutoffAt: string | null;
	};
	counts: {
		prompts: number;
		commands: number;
		failedCommands: number;
		permissionRequests: number;
		editedFiles: number;
		editsByFile: Array<{ path: string; count: number }>;
	};
	redactionHits: number;
}

export interface BuiltSummaryPrompt {
	systemPrompt: string;
	transcriptPrompt: string;
	nonce: string;
	redactionHits: number;
}

export function buildSummaryPrompt(
	_session: SessionForPrompt,
	_ledger: LedgerForPrompt,
): BuiltSummaryPrompt {
	throw new Error("not implemented");
}

export function buildSummaryLlmRequest(
	_built: BuiltSummaryPrompt,
	_model: string,
	_repair?: RepairKind,
): LlmRequest {
	throw new Error("not implemented");
}
