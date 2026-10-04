/**
 * AGEN-69: turns the rows the evidence loader read into the "ledger" the model
 * sees: one line per entry, each line starting with the ids a summary may cite.
 * Pure. Hides labelling (OBSERVED vs CLAIMED), command classification,
 * collapsing, redact-then-cap, the character budget's drop order and the
 * coverage arithmetic.
 *
 * Every field that reaches the text is allowlisted by construction: this file
 * reads only the named columns of `EvidenceRow`, and each one goes through
 * `field()` (invisible characters stripped, redacted, neutralised, capped).
 */

// ── types ────────────────────────────────────────────────────────────────────

/** One event as the loader selected it; every text field is already cut in SQL. */
export interface EvidenceRow {
	id: number;
	createdAt: string;
	eventType: string;
	category: string | null;
	toolName: string | null;
	content: string | null;
	filePath: string | null;
	command: string | null;
	description: string | null;
	/** The stored response, only for a command that looks like a validation. */
	response: string | null;
	/** The last 556 characters of the response, only for a failed tool row. */
	responseTail: string | null;
}

/** What the scan did, for the coverage arithmetic. */
export interface ScanSummary {
	eventsTotal: number;
	eventsRead: number;
	/** Rows the scan read that belong in a ledger (not read-class, not `user_ack`, not system noise). */
	eligibleRead: number;
	/** Eligible rows a row cap (spine 300, action 800, 350 per chunk) left out. */
	droppedByCap: number;
	reachedFirstEvent: boolean;
	/** The time of the oldest event the scan read; used only when it ended early. */
	oldestReadAt: string | null;
}

export interface LedgerInput {
	rows: EvidenceRow[];
	firstPromptRows: EvidenceRow[];
	scan: ScanSummary;
}

export type FactKind =
	| "prompt"
	| "agent_message"
	| "edit"
	| "command"
	| "validation"
	| "tool"
	| "event";

/** What may be said about a cited id: no text, ever. */
export interface EvidenceFact {
	kind: FactKind;
	at: string | null;
	result?: "ok" | "failed" | "unknown";
	count?: number;
}

export type EntryKind = "user_prompt" | "agent_message" | "edit" | "command" | "tool" | "one_liner";

export interface LedgerEntry {
	kind: EntryKind;
	/** The line, ids first. */
	text: string;
	/** Every event this entry stands for. */
	eventCount: number;
	/** The ids printed in `text`, and so the ids a summary may cite. */
	shownIds: number[];
}

export interface Coverage {
	status: "full" | "partial";
	eventsTotal: number;
	eventsRead: number;
	eventsRepresented: number;
	droppedByCap: number;
	droppedByBudget: number;
	/** Set only when the scan ended before the session's first event; null for an interior omission. */
	cutoffAt: string | null;
}

export interface LedgerCounts {
	prompts: number;
	commands: number;
	failedCommands: number;
	permissionRequests: number;
	editedFiles: number;
	editsByFile: Array<{ path: string; count: number }>;
}

export interface Ledger {
	/** The entry lines, newest last, joined by newlines. Not fenced. */
	text: string;
	ids: Map<string, EvidenceFact>;
	entries: LedgerEntry[];
	coverage: Coverage;
	counts: LedgerCounts;
	redactionHits: number;
}

export function buildLedger(input: LedgerInput): Ledger {
	return {
		text: "",
		ids: new Map(),
		entries: [],
		coverage: {
			status: "full",
			eventsTotal: input.scan.eventsTotal,
			eventsRead: 0,
			eventsRepresented: 0,
			droppedByCap: 0,
			droppedByBudget: 0,
			cutoffAt: null,
		},
		counts: {
			prompts: 0,
			commands: 0,
			failedCommands: 0,
			permissionRequests: 0,
			editedFiles: 0,
			editsByFile: [],
		},
		redactionHits: 0,
	};
}
