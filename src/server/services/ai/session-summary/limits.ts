/**
 * AGEN-69: every limit the session-summary evidence path uses, in one file
 * (plan D-19). The loader reads within these, the ledger caps within these.
 */

/** Events per chunk statement, and the most chunks one scan reads. */
export const CHUNK_SIZE = 5000;
export const MAX_CHUNKS = 10;

/** Rows kept: narrative rows (prompts, agent messages, one-liners) and tool rows. */
export const SPINE_ROW_CAP = 300;
export const ACTION_ROW_CAP = 800;
/** Most tool rows one chunk statement returns (D-34): the newest 800 span at least three chunks. */
export const ACTION_ROWS_PER_CHUNK = 350;

/** The first prompts are read from the oldest this-many ids of the session. */
export const FIRST_PROMPT_COUNT = 3;
export const FIRST_PROMPT_WINDOW = CHUNK_SIZE;

/** Characters per field in the ledger (code points). */
export const PROMPT_CAP = 1500;
export const FIRST_PROMPT_CAP = 4000;
export const AGENT_MESSAGE_CAP = 1200;
export const LAST_AGENT_MESSAGE_CAP = 3000;
export const COMMAND_CAP = 300;
export const PATH_CAP = 300;
export const DESCRIPTION_CAP = 120;
export const ONE_LINER_CAP = 200;
export const OUTPUT_HEAD = 300;
export const OUTPUT_TAIL = 300;

/** SQL reads this many characters past a cap so redaction sees a secret that straddles the cap. */
export const SQL_REDACTION_MARGIN = 256;
/** `tool_input` fields are cut in SQL here; a command this long is not classified (fail closed). */
export const TOOL_INPUT_FIELD_SQL_CAP = 556;
/** Stored `tool_response` is at most this many characters (event-normalizer). */
export const FULL_RESPONSE_CHARS = 2000;

/** Characters in the ledger body; over this the oldest entries are dropped. */
export const LEDGER_CHAR_BUDGET = 60_000;
/** The newest this-many entries are never dropped, nor are the first prompts. */
export const LEDGER_PROTECTED_TAIL = 20;
/** Most ids printed for one collapsed entry; the rest are counted, not citeable. */
export const MAX_IDS_PER_ENTRY = 6;
/** Edited files listed in the counts line. */
export const TOP_FILES = 30;

/** Rows and bytes one chunk statement may return into JS (asserted per statement). */
export const CHUNK_BYTES_CEILING = 1_500_000;

// Tool names (lowercase) by how the ledger treats them (plan D-30). Claude Code
// names, Codex's `apply_patch`, and Copilot's `view`/`create`/`shell` are listed
// because `canonicalize.ts` does not rename tools. Anything else is "other".
export const READ_CLASS_TOOLS: readonly string[] = [
	"read",
	"glob",
	"grep",
	"ls",
	"notebookread",
	"view",
	"list",
	"find",
	"search",
	"read_file",
	"list_dir",
];
export const EDIT_TOOLS: readonly string[] = [
	"write",
	"edit",
	"multiedit",
	"notebookedit",
	"create",
	"str_replace",
	"str_replace_editor",
	"str_replace_based_edit_tool",
	"apply_patch",
	"edit_file",
	"write_file",
];
export const SHELL_TOOLS: readonly string[] = [
	"bash",
	"shell",
	"sh",
	"run_command",
	"run_shell_command",
	"exec_command",
	"local_shell",
	"execute_bash",
	"powershell",
	"terminal",
];
