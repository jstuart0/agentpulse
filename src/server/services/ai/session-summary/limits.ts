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
/** SQL reads at most this many characters of a stored response (the writer's own cap is the same). */
export const RESPONSE_SQL_CAP = 2000;
/** A pass summary line is cut here (code points). */
export const PASS_LINE_CAP = 120;
/** Most characters of `tool_input` bytes whose fields one chunk extracts; rows past it are `[not shown]`. */
export const TOOL_INPUT_BYTE_BUDGET = 8_000_000;
/** A Post row with no input is paired with a Pre row of the same call at most this many ids before it. */
export const PAIR_WINDOW_IDS = 200;
/** The ledger builds this many rows, then yields the event loop. */
export const LEDGER_SLICE_ROWS = 100;

/** Characters in the ledger body; over this the oldest entries are dropped. */
export const LEDGER_CHAR_BUDGET = 60_000;
/** The newest this-many entries are never dropped, nor are the first prompts. */
export const LEDGER_PROTECTED_TAIL = 20;
/** Most ids printed for one collapsed entry; the rest are counted, not citeable. */
export const MAX_IDS_PER_ENTRY = 6;
/** Edited files listed in the counts line. */
export const TOP_FILES = 30;

/**
 * What one chunk statement may return into JS. The loader does not enforce it:
 * `substr(..., RESPONSE_SQL_CAP)` and the 350-row cap do, and the fat-body and
 * 300 KB-response tests assert this figure as an oracle.
 */
export const CHUNK_BYTES_CEILING = 1_500_000;

// Tool names (lowercase) by how the ledger treats them (plan D-30). Only names
// with evidence are listed; any other tool renders as its name and a status.
// Evidence: Claude Code's built-in tool names (Read, Glob, Grep, LS, Write, Edit,
// MultiEdit, NotebookEdit, Bash) are the names its own hook payloads carry
// (agents/__fixtures__ and the ingest tests); `apply_patch`, `shell` and
// `exec_command` are Codex's, from the observer (supervisor/services/codex-observer.ts)
// and the Codex fixtures; Copilot's `shell` is in copilot/postToolUse.json.
// `view` and `create` are Copilot CLI's file viewer and creator as its published
// tool list names them; no capture of either is in this tree (SPIKE.md captured
// `shell` only). `view` stays so a Copilot session's file views do not flood the ledger.
// `unknown_tool` (the observer's name after a supervisor restart) is never listed:
// it may be a shell call, so it is name and status only unless the loader pairs
// it with its Pre row.
export const READ_CLASS_TOOLS: readonly string[] = ["read", "glob", "grep", "ls", "view"];
export const EDIT_TOOLS: readonly string[] = [
	"write",
	"edit",
	"multiedit",
	"notebookedit",
	"apply_patch",
	"create",
];
export const SHELL_TOOLS: readonly string[] = ["bash", "shell", "exec_command"];

/** Agents whose hooks include a failure event: for them a PostToolUse row is evidence of success. */
export const FAILURE_EVENT_AGENTS: readonly string[] = ["claude_code", "copilot_cli"];

// The ordinary-failure tail allowlist (ruling R-A.1). Deliberately short: a
// command's failure output is sent only when every segment's head is a tool that
// neither reads files nor interprets code, so its error text cannot be a file's
// contents. Not measured against real sessions. Entries a reviewer may question:
// `docker build` echoes Dockerfile RUN lines; `bun/npm add` run package scripts;
// `kubectl get` is allowed only without -o yaml|json and not for configmaps.
export const FAILURE_TAIL_PLAIN_HEADS: readonly string[] = [
	"ls",
	"mkdir",
	"rm",
	"mv",
	"touch",
	"chmod",
	"cd",
	"pwd",
	"which",
];
/** `git` is allowed for any subcommand except these (they print file or history content or config). */
export const FAILURE_TAIL_GIT_DENIED: readonly string[] = [
	"show",
	"diff",
	"log",
	"config",
	"remote",
	"cat-file",
	"grep",
	"blame",
	"diff-tree",
	"diff-index",
	"difftool",
	"format-patch",
	"whatchanged",
	"archive",
	"bundle",
	"credential",
	"var",
	"notes",
	"reflog",
	"fast-export",
	"show-branch",
];
/** Head -> first operand(s) that are allowed. A two-word entry is `a b`. */
export const FAILURE_TAIL_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
	bun: ["install", "add", "remove", "i"],
	npm: ["install", "ci", "i"],
	pnpm: ["install", "add", "i"],
	yarn: ["install", "add"],
	pip: ["install"],
	pip3: ["install"],
	cargo: ["add"],
	go: ["mod tidy", "mod download"],
	docker: ["build", "pull", "push", "compose up", "compose down"],
	"docker-compose": ["up", "down"],
	kubectl: ["apply", "rollout", "get"],
	gh: ["pr", "issue", "run"],
};
