/**
 * The owner-only record of what each fork tool call ran (AGEN-123). Reserved by Track 0: the DTO, the
 * retention window, the per-item cap and the server feature name, so the host, server, web and MCP vendored
 * types read one source before the table exists.
 */

/** The server feature the host reads from `register`/`heartbeat` before it sends call detail. */
export const FORK_TOOL_DETAIL = "fork_tool_detail";

/** Detail is kept this long, or the positive event-retention window when that is shorter. */
export const FORK_TOOL_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Input and output are each cut to this many UTF-8 bytes when stored. */
export const FORK_TOOL_DETAIL_CAP_BYTES = 16_384;

/** The numbers both ends of the detail path share, so the host's batching and the server's limits can't drift. */
export const FORK_TOOL_DETAIL_LIMITS = {
	/** The host cuts each text to this many bytes (at a code point) and flags the cut. */
	hostFieldCapBytes: 64 * 1024,
	/** The server drops this many trailing bytes of a text the host cut (a token cut at the cap can't escape redaction). */
	hostCutDropBytes: 1024,
	/** A body from the host is split below this many serialised bytes. */
	batchBytes: 240 * 1024,
	/** The server's body limit for the host's POST. */
	reportBodyBytes: 256 * 1024,
	/** A host sends what it holds after this long, or earlier at `batchBytes`. */
	debounceMs: 1000,
	/** Reports a host may make a minute. */
	reportsPerMinute: 300,
	/** Calls in one report. */
	callsPerReport: 100,
	/** Rows kept per session; the oldest go first. */
	rowsPerSession: 2000,
	/** Calls stored an hour per session (in memory, per replica). */
	callsPerHourPerSession: 1200,
	/** The list route's page size. */
	listMax: 100,
} as const;

/** One call as the host reports it. Texts are the host's, up to its cap, and are redacted and cut by the server. */
export interface ForkToolCallReport {
	toolUseId: string;
	/** The control action of the turn the call belongs to, or null when the host doesn't know it. */
	turnActionId: string | null;
	/** One of the fork's six tools, `Agent` when subagents are applied, or `mcp` for any MCP tool. */
	tool: string;
	/** A `FORK_CALL_OUTCOMES` value. */
	outcome: string;
	fromSubagent: boolean;
	input: string | null;
	/** The host cut the input at its cap. */
	inputTruncated: boolean;
	output: string | null;
	outputTruncated: boolean;
}

export interface ForkToolCallsReportBody {
	v: 1;
	calls: ForkToolCallReport[];
}

export interface ForkToolCallsReportResponse {
	stored: number;
	/** Calls not stored: over a cap, or a text that couldn't be made safe. */
	dropped: number;
}

export interface ForkToolCallList {
	v: 1;
	calls: ForkToolCallDto[];
	/** The `toolUseId` to pass as `beforeId` for the next page, or null at the end. */
	nextBeforeId: string | null;
}

export interface ForkToolCallDto {
	toolUseId: string;
	tool: string;
	outcome: string;
	fromSubagent: boolean;
	input: string | null;
	inputTruncated: boolean;
	output: string | null;
	outputTruncated: boolean;
	/** Something that looked like a secret was hidden from the text. */
	redacted: boolean;
	createdAt: string;
}

/** One call in the index view: everything but the text. The `input` and `output` keys are absent, not null. */
export type ForkToolCallIndexEntry = Omit<ForkToolCallDto, "input" | "output">;

/** `GET /sessions/:id/tool-calls?view=index`: what exists, with no text and nothing decrypted. */
export interface ForkToolCallIndexList {
	v: 1;
	calls: ForkToolCallIndexEntry[];
	nextBeforeId: string | null;
}
