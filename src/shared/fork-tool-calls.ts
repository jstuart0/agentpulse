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
