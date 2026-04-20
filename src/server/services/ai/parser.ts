export type DecisionKind = "continue" | "ask" | "report" | "stop" | "wait";

export interface ContinueDecision {
	decision: "continue";
	nextPrompt: string;
}

export interface AskDecision {
	decision: "ask";
	proposal: string;
	why?: string;
}

export interface ReportDecision {
	decision: "report";
	summary: string;
	status: "success" | "error" | "partial";
	highlights?: string[];
}

export interface StopDecision {
	decision: "stop";
	why?: string;
}

export interface WaitDecision {
	decision: "wait";
}

export type WatcherDecision =
	| ContinueDecision
	| AskDecision
	| ReportDecision
	| StopDecision
	| WaitDecision;

export interface ParseSuccess {
	ok: true;
	decision: WatcherDecision;
}

export interface ParseFailure {
	ok: false;
	error: string;
	/** True when the failure is explicitly a schema mismatch, not a JSON
	 * syntax error — useful for routing to the parser's one-retry path. */
	schemaViolation: boolean;
}

export type ParseResult = ParseSuccess | ParseFailure;

const MAX_NEXT_PROMPT_CHARS = 4000;

/**
 * Parse a decision string from the LLM. The model is instructed to emit
 * exactly one JSON object matching the schema; anything else is rejected.
 *
 * Tolerates:
 * - Leading/trailing whitespace
 * - A single markdown code fence around the JSON (```json ... ```)
 *
 * Does NOT tolerate:
 * - Free-form prose around the JSON (on purpose — that's the injection vector)
 * - Multiple JSON objects
 * - Missing required fields per the declared decision kind
 */
export function parseDecision(raw: string): ParseResult {
	if (typeof raw !== "string" || !raw.trim()) {
		return { ok: false, error: "Empty response from model", schemaViolation: false };
	}

	const cleaned = stripCodeFence(raw.trim());
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		return {
			ok: false,
			error: `Invalid JSON: ${(err as Error).message}`,
			schemaViolation: false,
		};
	}

	if (!isObject(parsed)) {
		return { ok: false, error: "Response was not a JSON object", schemaViolation: true };
	}

	const decision = parsed.decision;
	if (typeof decision !== "string") {
		return { ok: false, error: "Missing 'decision' field", schemaViolation: true };
	}

	switch (decision) {
		case "continue": {
			const nextPrompt = parsed.nextPrompt;
			if (typeof nextPrompt !== "string" || !nextPrompt.trim()) {
				return {
					ok: false,
					error: "'continue' requires a non-empty nextPrompt",
					schemaViolation: true,
				};
			}
			if (nextPrompt.length > MAX_NEXT_PROMPT_CHARS) {
				return {
					ok: false,
					error: `nextPrompt exceeds ${MAX_NEXT_PROMPT_CHARS} chars`,
					schemaViolation: true,
				};
			}
			return { ok: true, decision: { decision: "continue", nextPrompt } };
		}
		case "ask": {
			const proposal = parsed.proposal;
			if (typeof proposal !== "string" || !proposal.trim()) {
				return {
					ok: false,
					error: "'ask' requires a non-empty proposal",
					schemaViolation: true,
				};
			}
			return {
				ok: true,
				decision: {
					decision: "ask",
					proposal,
					why: typeof parsed.why === "string" ? parsed.why : undefined,
				},
			};
		}
		case "report": {
			const summary = parsed.summary;
			const status = parsed.status;
			if (typeof summary !== "string" || !summary.trim()) {
				return {
					ok: false,
					error: "'report' requires a non-empty summary",
					schemaViolation: true,
				};
			}
			if (status !== "success" && status !== "error" && status !== "partial") {
				return {
					ok: false,
					error: "'report.status' must be success | error | partial",
					schemaViolation: true,
				};
			}
			const highlights = Array.isArray(parsed.highlights)
				? parsed.highlights.filter((h): h is string => typeof h === "string")
				: undefined;
			return {
				ok: true,
				decision: { decision: "report", summary, status, highlights },
			};
		}
		case "stop": {
			return {
				ok: true,
				decision: {
					decision: "stop",
					why: typeof parsed.why === "string" ? parsed.why : undefined,
				},
			};
		}
		case "wait": {
			return { ok: true, decision: { decision: "wait" } };
		}
		default:
			return {
				ok: false,
				error: `Unknown decision '${decision}'`,
				schemaViolation: true,
			};
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFence(input: string): string {
	if (!input.startsWith("```")) return input;
	// ```json\n...\n``` or ```\n...\n```
	const fenceMatch = input.match(/^```(?:json)?\n?([\s\S]*?)\n?```$/);
	if (fenceMatch) return fenceMatch[1];
	return input;
}
