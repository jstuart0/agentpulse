/**
 * Cross-branch hook-delivery literals (AGEN-16). Constants only — no
 * runtime logic, so this is safe to import from both the supervisor
 * process (src/supervisor/**) and the server (src/server/**) without
 * creating a dependency between them.
 *
 * DELIVERY_ID_HEADER / ORIGIN_HEADER / ORIGIN_CODEX_OBSERVER: the
 * codex-observer stamps these on every POST /api/v1/hooks request; the
 * server reads them to build durable dedup identity and to distinguish
 * observer-origin deliveries from native agent hooks and relay-forwarded
 * ones.
 *
 * CODEX_NATIVE_MARKER_DIR: the Codex command-hook shim writes an empty
 * marker file at `$HOME/<CODEX_NATIVE_MARKER_DIR>/<session_id>` before its
 * curl call, so the observer (via isNativeCovered()) can stand down for
 * sessions native hooks already cover. `$HOME`, not `$AGENTPULSE_DIR`:
 * the Codex-spawned shim and the supervisor process don't share an
 * environment, so the path must be fixed.
 */

export const DELIVERY_ID_HEADER = "X-AgentPulse-Delivery-Id";
export const ORIGIN_HEADER = "X-AgentPulse-Origin";
export const ORIGIN_CODEX_OBSERVER = "codex-observer";
export const CODEX_NATIVE_MARKER_DIR = ".agentpulse/codex-native";

/**
 * Exclude-rule literals: a user can list directories whose sessions should
 * never be reported, checked locally on their own machine before anything
 * is sent. Every evaluator (src/shared/exclude-rules.ts, the generated
 * shell/PowerShell snippets, the supervisor's report gate) reads the same
 * three paths and the same header name, so a rename or path change only
 * needs to happen here.
 *
 * SKIP_HEADER: carries the caller's AGENTPULSE_SKIP value across process
 * boundaries that don't share an environment (a Claude Code HTTP hook, or
 * a relay-forwarded request) — isSkipValue() in exclude-rules.ts is the one
 * place that decides whether a given value counts as "skip".
 *
 * EXCLUDE_RULES_RELATIVE_PATH: the user-edited rules file, one directory
 * prefix per line. Relative to $HOME/%USERPROFILE%, never to cwd.
 *
 * EXCLUDE_INVALID_MARKER_RELATIVE_PATH: an empty file any evaluator creates
 * the moment it fails closed and removes on the next valid evaluation.
 * Deliberately empty — it carries no session data, only "something here
 * failed closed".
 *
 * SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH: written by an exclude-aware
 * supervisor on every rules scan, so a local check can tell a *running*
 * supervisor is actually enforcing rules, not just that one is installed.
 * A later phase writes it; the name is reserved here so it can't drift.
 */
export const SKIP_HEADER = "X-AgentPulse-Skip";
/** The longest skip header value any receiver looks at; a longer one is "not set" (a header is untrusted input, and no allowlisted value needs padding). */
export const SKIP_HEADER_MAX_LENGTH = 64;
export const EXCLUDE_RULES_RELATIVE_PATH = ".agentpulse/exclude";
export const EXCLUDE_INVALID_MARKER_RELATIVE_PATH = ".agentpulse/exclude.invalid";
/** More rules than this and every evaluator treats the file as invalid: every hook event checks every rule, so a long list is a per-event cost. */
export const EXCLUDE_MAX_RULES = 500;
/** The installed check every hook command runs when a rules file is present (sh, and its PowerShell twin). */
export const EXCLUDE_SCRIPT_RELATIVE_PATH = ".agentpulse/exclude-check.sh";
export const EXCLUDE_SCRIPT_PS_RELATIVE_PATH = ".agentpulse/exclude-check.ps1";
/**
 * The one exit status that means "send". The installed check ends in it only
 * when it positively decided the event is not excluded; the hook command
 * sends on exactly this status, so an empty, truncated or header-only script
 * (which exits 0), a syntax error (2) or any other failure sends nothing.
 */
export const EXCLUDE_SCRIPT_SEND_STATUS = 42;
export const SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH =
	".agentpulse/supervisor-exclude-state.json";

/**
 * Lines the installers print about the exclude rules and the Codex approval
 * (the approve line on a fresh install, the re-approve line when an update
 * changed hooks Codex had already approved). The shell, PowerShell
 * and TypeScript installers each carry the literal text (they can't import
 * this file); the installer tests pin every copy to these constants.
 */
export const EXCLUDE_CHECK_HINT =
	"After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check";
export const CODEX_APPROVE_LINE = "Codex needs you to approve these hooks: run /hooks in Codex.";
export const CODEX_REAPPROVE_LINE =
	"Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more.";
export const STATUSLINE_OFFER_LINE =
	"Statusline: re-run with --statusline to add the AgentPulse statusline to Claude Code (it shows when rules are invalid or AGENTPULSE_SKIP is set).";
