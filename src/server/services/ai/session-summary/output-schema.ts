import type { SummaryDraft } from "../../../../shared/session-summary.js";
import type { LlmStopReason } from "../llm/types.js";

export type ParseResult = { ok: true; draft: SummaryDraft } | { ok: false; path: string };

export function parseAnswer(_raw: string, _nonce: string): ParseResult {
	throw new Error("not implemented");
}

export type RepairKind = { kind: "parse"; path: string } | { kind: "truncated" };

export function repairTrailer(_repair: RepairKind): string {
	throw new Error("not implemented");
}

export function classifyStopReason(
	_stop: LlmStopReason | undefined,
): "refusal" | "length" | "parse" {
	throw new Error("not implemented");
}
