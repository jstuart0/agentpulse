/**
 * D12/D13 shared hook-command generators (2026-09-28-deliver-agent-cli-parity,
 * Phase 5). One TypeScript source of truth for the detached shell command
 * every command-hook installer emits, and for the Codex hooks.json shape.
 *
 * scripts/setup-hooks.sh, scripts/setup-relay.sh, and the /setup.sh template
 * served by src/server/routes/setup.ts each carry a byte-parity bash
 * transcription (`ap_hook_cmd` / `ap_codex_hooks_json`, delimited by
 * `# >>> agentpulse-hook-cmd` / `# <<< agentpulse-hook-cmd`); scripts/install-local.ps1
 * carries the PowerShell transcription (`New-ApHookCommand` /
 * `New-ApCodexHooksFile`). All are verified byte-identical to this module's
 * output by scripts/hook-command-parity.test.ts. bin/cli.ts and
 * src/web/pages/SetupPage.tsx import this module directly.
 *
 * D13 safety constraints (xander, binding — see the plan's D12
 * "synchronous-hook safety constraints"):
 *   1. Bounded, millisecond shim: only mktemp + `cat > "$t"` are synchronous;
 *      the network call is forked into a detached subshell and the parent
 *      exits immediately.
 *   2. Never fail closed: every exit path is `exit 0`.
 *   3. No stdout/stderr channel: the subshell's streams are all redirected;
 *      an observer can never steer the agent through hook output.
 *   4. No synchronous redaction or payload processing: the shim never
 *      parses/filters/transforms the payload on the *synchronous* path.
 *
 * Cross-campaign requirement: the Codex command-hook shim additionally
 * writes an empty native-coverage marker file
 * at `$HOME/.agentpulse/codex-native/<session_id>` *inside the detached
 * subshell, before the curl* — off the synchronous path, exactly like the
 * POST — so a sibling campaign's supervisor-side reader can tell a native
 * Codex hook actually fired. Only ever written when the session_id extracted
 * from the drained payload matches `^[A-Za-z0-9-]{1,128}$`; never deleted.
 */

import {
	EXCLUDE_INVALID_MARKER_RELATIVE_PATH,
	EXCLUDE_MAX_RULES,
	EXCLUDE_RULES_RELATIVE_PATH,
	EXCLUDE_SCRIPT_SEND_STATUS,
} from "./hook-headers.js";

const BASE_URL_HOST_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const BASE_URL_IPV6_RE = /^https?:\/\/\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$/;

// EXCLUDE_RULES_RELATIVE_PATH/EXCLUDE_INVALID_MARKER_RELATIVE_PATH are
// always forward-slash-separated literal templates (not real filesystem
// paths being manipulated), so a plain split is enough and avoids any
// platform-dependent behavior from node:path's dirname/basename.
const EXCLUDE_DIR_NAME = EXCLUDE_RULES_RELATIVE_PATH.split("/")[0];
const EXCLUDE_RULES_FILE_NAME = EXCLUDE_RULES_RELATIVE_PATH.split("/")[1];
const EXCLUDE_MARKER_FILE_NAME = EXCLUDE_INVALID_MARKER_RELATIVE_PATH.split("/")[1];

/** D13/F41: throws on anything but a bare `scheme://host[:port]` origin. */
export function assertValidHookBaseUrl(baseUrl: string): void {
	if (!BASE_URL_HOST_RE.test(baseUrl) && !BASE_URL_IPV6_RE.test(baseUrl)) {
		throw new Error(`invalid AgentPulse base URL for a hook command: ${JSON.stringify(baseUrl)}`);
	}
}

export interface HookCommandOptions {
	/** e.g. "http://localhost:4000" or "https://agentpulse.example.com" — no trailing slash, no path. */
	baseUrl: string;
	/** true = direct install (reads ~/.agentpulse/hook-auth-header); false = relay (no auth header sent). */
	direct: boolean;
	/** X-Agent-Type header value, e.g. "codex_cli" or "copilot_cli". */
	agent: string;
	/** The hook event name, sent as ?event=<event>. */
	event: string;
}

/**
 * The sh piece that extracts `session_id` from the already-drained payload
 * file ($t) and, only when it matches the safe charset/length, writes the
 * native-coverage marker. Pure shell built-ins plus one `grep -o` — no `cat`,
 * `echo`, `printf`, `tee`, or `jq`, and no stdout of its own (every operation
 * either writes to a file or is silenced with 2>/dev/null).
 *
 * Extraction is deliberately narrow: `grep -o` only matches a value already
 * restricted to `[A-Za-z0-9-]`, so a malformed or malicious session_id (e.g.
 * containing `/` or `..`) simply fails to match and `$sid` stays empty — the
 * `case` below is defense-in-depth for the length bound grep can't express.
 *
 * The marker is created, never rewritten: a link at the marker's directory
 * or file is left alone (builtin test), and the create itself is exclusive
 * (`set -C`: O_EXCL, which a planted link cannot satisfy), so a hostile
 * link can't redirect the write. The redirect sits on a brace group, so a
 * failed create doesn't end the shell the way it would on a special
 * built-in. `set -C` is switched back off straight after.
 */
export const CODEX_MARKER_SH_PIECE =
	'sid=$(grep -o \'"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"\' "$t" | head -n1); sid=${sid%\\"}; sid=${sid##*\\"}; case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ ${#sid} -le 128 ] && [ ! -L "$HOME/.agentpulse/codex-native" ]; then mkdir -p "$HOME/.agentpulse/codex-native" 2>/dev/null; set -C; { :; } 2>/dev/null >"$HOME/.agentpulse/codex-native/$sid"; set +C; fi ;; esac; ';

/**
 * The whole POSIX command with three holes: the Codex marker, the gate and the
 * send. install-local.ps1 carries this text and fills the same holes, so the
 * Windows installer's Copilot bash handler can't drift from this generator.
 *
 * The EXIT trap removes the temp payload (it holds prompt text) on every way
 * out, including a kill: a signal trap that only ran `rm` would resume the
 * script, so the signals run `exit`, which fires the EXIT trap.
 */
export const SH_COMMAND_TEMPLATE =
	't=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( trap \'rm -f "$t"\' EXIT; trap \'exit 1\' HUP INT TERM; @@AP_MARKER@@@@AP_GATE@@@@AP_SEND@@ ) </dev/null >/dev/null 2>&1 & exit 0';

/** Fills `@@AP_*@@` holes by plain substitution (a replacement function, so `$&` and friends in a value are never special). */
function fillTemplate(template: string, values: Record<string, string>): string {
	let out = template;
	for (const [hole, value] of Object.entries(values)) {
		out = out.split(hole).join(value);
	}
	return out;
}

/** The one printf the hook command contains: it builds the whitespace set (space, tab, CR, LF, then a dot that keeps the substitution from eating the trailing newline) the skip check trims. A built-in in sh, dash, bash and zsh; the no-output guard allows exactly this text. */
export const SH_TRIM_SET_PRINTF = "$(printf ' \\t\\r\\n.')";

/**
 * The gate, spliced in before the send. Only constructs that mean the same
 * thing in sh, dash, bash and zsh (the agent runs the command as
 * `<login shell> -lc <string>`, which on macOS is zsh): case patterns, quoted
 * parameter expansion, and no reliance on word splitting. In order:
 *
 *  a. AGENTPULSE_SKIP, trimmed of space/tab/CR/LF (the set built with the one
 *     printf, a built-in in all four shells) and matched against the
 *     allowlist: send nothing.
 *  b. no rules file, and ~/.agentpulse is searchable (or absent from a
 *     searchable HOME): fall through to the send, with no extra program.
 *  c. otherwise (a rules file, a directory that can't be searched, a link
 *     that points nowhere, an empty HOME) the installed check decides. It is
 *     run only when one `ls -ldn` of the directory and the script and one
 *     `id -u` show both owned by this user, neither group/world-writable,
 *     the directory a directory and the script a regular file (not a link);
 *     it is run as `/bin/sh <script>`, never the login shell. A missing,
 *     untrusted or failing script sends nothing. The columns of the `ls`
 *     line are cut by parameter expansion and compared by case pattern.
 *
 * A trust check done by name and then a run is not atomic; the window is the
 * one every script run from a directory its owner controls has, and the
 * directory is not writable by anyone else (that is what is checked).
 */
export const SH_GATE_PIECE = [
	`w=${SH_TRIM_SET_PRINTF}; `,
	'w=${w%.}; x=${AGENTPULSE_SKIP:-}; y=${x%%[!"$w"]*}; x=${x#"$y"}; y=${x##*[!"$w"]}; x=${x%"$y"}; case $x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; ',
	'd=$HOME/.agentpulse; g=0; if [ -n "$HOME" ] && [ ! -e "$d/exclude" ] && [ ! -L "$d/exclude" ] && [ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]; then if [ -d "$d" ] && [ -x "$d" ]; then g=1; elif [ ! -e "$d" ] && [ ! -L "$d" ] && [ -d "$HOME" ] && [ -x "$HOME" ]; then g=1; fi; fi; ',
	'if [ "$g" != 1 ]; then ',
	'l=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$d/" "$d/exclude-check.sh" 2>/dev/null) || exit 0; u=$(id -u 2>/dev/null); ',
	'ap_f() { y=${x%%[!" "]*}; x=${x#"$y"}; y=${x%%" "*}; x=${x#"$y"}; }; ',
	'ap_v() { x=$1; ap_f; k=${y%[@+.]}; ap_f; ap_f; [ -n "$y" ] && [ "$y" = "$u" ] && case $k in $2[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; ',
	`n=\${w#???}; ap_v "\${l%%"$n"*}" d && ap_v "\${l#*"$n"}" - && { /bin/sh "$d/exclude-check.sh"; [ $? = ${EXCLUDE_SCRIPT_SEND_STATUS} ]; } || exit 0; fi; `,
].join("");

function curlInvocation(
	baseUrl: string,
	event: string,
	agent: string,
	authHeaderArg: string,
): string {
	return `curl -sS --max-time 2 -o /dev/null -X POST '${baseUrl}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'${authHeaderArg} --data-binary "@$t"`;
}

/**
 * D13's detached POSIX `sh` command. Synchronous work is `mktemp` + draining
 * stdin into the temp file; everything else — the Codex native-coverage
 * marker, the exclusion gate and the network call — runs in a backgrounded
 * subshell with stdin/stdout/stderr all redirected, so the parent can
 * `exit 0` immediately and the agent's turn is never blocked on it.
 *
 * The exclusion check itself is not in this text: it lives in one installed
 * script (buildBashExcludeScript), which the gate runs only when a rules
 * file exists. With no rules file this command sends exactly what it did
 * before the check existed.
 */
export function buildBashHookCommand(opts: HookCommandOptions): string {
	assertValidHookBaseUrl(opts.baseUrl);
	const marker = opts.agent === "codex_cli" ? CODEX_MARKER_SH_PIECE : "";
	let send: string;
	if (opts.direct) {
		const withHeader = curlInvocation(opts.baseUrl, opts.event, opts.agent, ' -H "@$f"');
		const withoutHeader = curlInvocation(opts.baseUrl, opts.event, opts.agent, "");
		send = `f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then ${withHeader}; else ${withoutHeader}; fi`;
	} else {
		send = curlInvocation(opts.baseUrl, opts.event, opts.agent, "");
	}

	return fillTemplate(SH_COMMAND_TEMPLATE, {
		"@@AP_MARKER@@": marker,
		"@@AP_GATE@@": SH_GATE_PIECE,
		"@@AP_SEND@@": send,
	});
}

/**
 * D13's PowerShell equivalent (r6, detached). `Start-Process` launches
 * `curl.exe` hidden and disowned, so the parent process (Codex's synchronous
 * hook runner) returns immediately after queuing it. Stale temp files older
 * than 5 minutes are swept on every invocation, then the script exits 0 with
 * no stdout.
 */
export function buildPowerShellHookCommand(opts: HookCommandOptions): string {
	assertValidHookBaseUrl(opts.baseUrl);
	// D13: only direct-mode reads the key file; relay mode never sends auth.
	const headerFile = opts.direct
		? "$f = Join-Path $HOME '.agentpulse\\hook-auth-header'"
		: "$f = $null";
	// Marker extraction/write runs INSIDE the Start-Job block, reading from the
	// temp file there — the synchronous (parent-process) path is stdin-drain +
	// temp-file-write only. The job's
	// script block runs in an isolated runspace with no access to parent
	// variables beyond what -ArgumentList passes in, and its location is not
	// the agent's: the parent passes its own current location and the skip
	// variable (two in-memory reads, no I/O) for the gate.
	const marker = opts.agent === "codex_cli" ? `  ${PS_CODEX_MARKER_PIECE}\n` : "";
	return fillTemplate(PS_COMMAND_TEMPLATE, {
		"@@AP_HEADER_FILE@@": headerFile,
		"@@AP_PRELUDE@@": PS_PRELUDE_PIECE,
		"@@AP_MARKER@@": marker,
		"@@AP_GATE@@": PS_GATE_PIECE,
		"@@AP_AUTH_ARG@@": PS_AUTH_ARG,
		"@@AP_URL@@": `${opts.baseUrl}/api/v1/hooks?event=${opts.event}`,
		"@@AP_AGENT@@": opts.agent,
	});
}

/**
 * JSON.stringify with two-space indent, plus every character outside
 * space..~ written as a lowercase \uXXXX escape, exactly like Python's
 * json.dumps (ensure_ascii) — which is what the shell installers use to
 * write the same files. The hook commands carry a byte order mark (the
 * exclusion check strips one from the rules file), and the escaped form is
 * also the one an editor or a line-ending tool can't silently change.
 */
function stringifyHooksJson(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(
		/[\u007f-\uffff]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** Canonical CodexEvent order (must match src/shared/types.ts's CodexEvent union declaration order — see check-hook-event-parity.ts for the drift guard). */
export const CODEX_EVENT_ORDER: readonly string[] = [
	"SessionStart",
	"SessionEnd",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"Interrupt",
	"SubagentStart",
	"SubagentStop",
	"PermissionRequest",
	"PreCompact",
	"PostCompact",
];

/** D12: minimum accepted timeout; used uniformly for every event (see the plan's Verification section — "async:false + timeout:1 for all 12 events"). */
const CODEX_HOOK_TIMEOUT_SECONDS = 1;

/**
 * D12's exact Codex hooks.json shape: all 12 CodexEvent members, `command`
 * handlers, `async:false`, `timeout:1`, no `matcher` key anywhere (required
 * for UserPromptSubmit/Stop/Interrupt, and "match all" for the rest — see
 * Phase 0 fact 4). Keys are emitted in CODEX_EVENT_ORDER and serialized with
 * `JSON.stringify(x, null, 2) + "\n"` so bash/PowerShell transcriptions can
 * be diffed byte-for-byte against this function's output.
 */
export function buildCodexHooksFile(opts: { baseUrl: string; direct: boolean }): string {
	assertValidHookBaseUrl(opts.baseUrl);
	const hooks: Record<string, unknown> = {};
	for (const event of CODEX_EVENT_ORDER) {
		const command = buildBashHookCommand({
			baseUrl: opts.baseUrl,
			direct: opts.direct,
			agent: "codex_cli",
			event,
		});
		hooks[event] = [
			{
				hooks: [{ type: "command", command, async: false, timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
			},
		];
	}
	return `${stringifyHooksJson({ hooks })}\n`;
}

/**
 * What marks a Codex hook handler as AgentPulse's own: its `command` posts to
 * the AgentPulse hook endpoint. Every command the installers have generated
 * (sh and PowerShell, relay and direct) contains this path with the event
 * query, whatever the host or port, so a handler written by an older release or
 * for another URL is still recognised and replaced. Nothing else is matched: not
 * the word "agentpulse", not the agent name, not a bare `/api/v1/hooks`, and not
 * handlers without a `command` string. The shell and PowerShell merges use the
 * same text (scripts/codex-hooks-merge.test.ts holds them to it).
 */
export const AGENTPULSE_HOOK_MARKER = "/api/v1/hooks?event=";

export type CodexHooksMergeResult =
	| { status: "changed"; text: string }
	| { status: "unchanged" }
	| { status: "unusable"; reason: string };

function isAgentPulseHandler(handler: unknown): boolean {
	if (typeof handler !== "object" || handler === null) return false;
	const command = (handler as { command?: unknown }).command;
	return typeof command === "string" && command.includes(AGENTPULSE_HOOK_MARKER);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges AgentPulse's Codex hooks (`ours`, the output of buildCodexHooksFile)
 * into the text of an existing hooks.json (`null` when there is no file).
 *
 * Every handler that is not AgentPulse's stays where it is, as do unknown
 * top-level keys and unknown events. AgentPulse's handlers are removed from
 * wherever they are (including events AgentPulse no longer uses) and its current
 * entries go back into the slot the first old one held, or at the end of the
 * event's list; events that did not exist are appended in generator order. The
 * result is idempotent: merging it again is "unchanged", and so is merging a file
 * that already says the same thing in different formatting.
 *
 * A file that is not valid JSON, is not an object, or has a `hooks` value (or
 * one of AgentPulse's own events) of the wrong type is "unusable" and the caller
 * must leave it alone. The shell copies (ap_codex_merge_hooks_json) and the
 * PowerShell copy (Merge-ApCodexHooksFile) implement the same rules.
 */
export function mergeCodexHooksFile(existing: string | null, ours: string): CodexHooksMergeResult {
	const oursHooks = (JSON.parse(ours) as { hooks: Record<string, unknown[]> }).hooks;
	if (existing === null || existing.trim() === "") return { status: "changed", text: ours };

	let doc: unknown;
	try {
		doc = JSON.parse(existing);
	} catch {
		return { status: "unusable", reason: "is not valid JSON" };
	}
	if (!isPlainObject(doc)) return { status: "unusable", reason: "is not a JSON object" };
	if ("hooks" in doc && !isPlainObject(doc.hooks)) {
		return { status: "unusable", reason: 'has a "hooks" entry that is not an object' };
	}
	const before = stringifyHooksJson(doc);

	const hooks: Record<string, unknown> = isPlainObject(doc.hooks) ? { ...doc.hooks } : {};
	for (const event of Object.keys(oursHooks)) {
		if (event in hooks && !Array.isArray(hooks[event])) {
			return { status: "unusable", reason: `has a non-list "${event}" entry` };
		}
	}

	for (const event of Object.keys(hooks)) {
		const groups = hooks[event];
		if (!Array.isArray(groups)) continue;
		const kept: unknown[] = [];
		let slot = -1;
		for (const group of groups) {
			const handlers = isPlainObject(group) ? group.hooks : undefined;
			if (!Array.isArray(handlers) || !handlers.some(isAgentPulseHandler)) {
				kept.push(group);
				continue;
			}
			if (slot === -1) slot = kept.length;
			const rest = handlers.filter((h) => !isAgentPulseHandler(h));
			if (rest.length > 0) kept.push({ ...(group as Record<string, unknown>), hooks: rest });
		}
		const mine = oursHooks[event] ?? [];
		kept.splice(slot === -1 ? kept.length : slot, 0, ...mine);
		if (kept.length > 0 || slot === -1) hooks[event] = kept;
		else delete hooks[event];
	}
	for (const event of Object.keys(oursHooks)) {
		if (!(event in hooks)) hooks[event] = oursHooks[event];
	}

	const merged = stringifyHooksJson({ ...doc, hooks });
	return merged === before ? { status: "unchanged" } : { status: "changed", text: `${merged}\n` };
}

/**
 * The PowerShell installer's Codex hooks file: the same 12 events and the same
 * handler shape as buildCodexHooksFile, but each command is the PowerShell
 * command (buildPowerShellHookCommand), the form install-local.ps1 writes for
 * Codex on Windows. scripts/__golden__/codex-hooks.direct.powershell.json pins
 * it, and scripts/test-install-local.ps1 compares New-ApCodexHooksFile to that
 * file. Never executed.
 */
export function buildPowerShellCodexHooksFile(opts: { baseUrl: string; direct: boolean }): string {
	assertValidHookBaseUrl(opts.baseUrl);
	const hooks: Record<string, unknown> = {};
	for (const event of CODEX_EVENT_ORDER) {
		const command = buildPowerShellHookCommand({
			baseUrl: opts.baseUrl,
			direct: opts.direct,
			agent: "codex_cli",
			event,
		});
		hooks[event] = [
			{
				hooks: [{ type: "command", command, async: false, timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
			},
		];
	}
	return `${stringifyHooksJson({ hooks })}\n`;
}

/** Canonical CopilotEvent order (must match src/shared/types.ts's CopilotEvent union declaration order — see check-hook-event-parity.ts for the drift guard). Deliberately excludes preToolUse/permissionRequest (D7: Copilot's fail-closed paths). */
export const COPILOT_EVENT_ORDER: readonly string[] = [
	"sessionStart",
	"sessionEnd",
	"userPromptSubmitted",
	"postToolUse",
	"postToolUseFailure",
	"agentStop",
	"subagentStart",
	"subagentStop",
	"preCompact",
	"errorOccurred",
];

const COPILOT_HOOK_TIMEOUT_SECONDS = 5;

/**
 * D8/D13: Copilot's `~/.copilot/hooks/agentpulse.json` shape — a
 * `{"version":1,"hooks":{<key>:[{"type":"command", ...}]}}` map, all 10
 * CopilotEvent members, each carrying the D13 bash command under `bash`.
 * `includePowerShell` additionally carries the PowerShell equivalent under
 * `powershell` — Copilot's own docs describe both keys as valid per
 * platform; the bash-only installer sites (setup-hooks.sh, setup-relay.sh,
 * the /setup.sh template) never run on Windows, so they omit it, while
 * install-local.ps1 (the only Windows site) includes both so either shell
 * Copilot picks can run the hook.
 */
export function buildCopilotHooksFile(opts: {
	baseUrl: string;
	direct: boolean;
	includePowerShell?: boolean;
}): string {
	assertValidHookBaseUrl(opts.baseUrl);
	const hooks: Record<string, unknown> = {};
	for (const event of COPILOT_EVENT_ORDER) {
		const handler: Record<string, unknown> = {
			type: "command",
			bash: buildBashHookCommand({
				baseUrl: opts.baseUrl,
				direct: opts.direct,
				agent: "copilot_cli",
				event,
			}),
		};
		if (opts.includePowerShell) {
			handler.powershell = buildPowerShellHookCommand({
				baseUrl: opts.baseUrl,
				direct: opts.direct,
				agent: "copilot_cli",
				event,
			});
		}
		handler.timeoutSec = COPILOT_HOOK_TIMEOUT_SECONDS;
		hooks[event] = [handler];
	}
	return `${stringifyHooksJson({ version: 1, hooks })}\n`;
}

// The snippet needs these four characters as real bytes in its text (the
// shell has no escape syntax for them). They are built from char codes so
// the generator's own source never contains an invisible character, which
// editors and formatters silently rewrite.
const TAB = String.fromCharCode(0x09);
const LINE_FEED = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The characters nearly every path is made of, listed one by one (no ranges: a range is locale-dependent in some shells and must never be what decides "this path is plain ASCII"). A cheap first filter before the full printable-ASCII class. */
const COMMON_PATH_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-";

/** The 95 printable ASCII characters, `]` first and `-` last so they can sit inside one shell bracket expression; the snippet tests a path against it to find the paths whose spelling needs the external pwd on macOS. */
const PRINTABLE_ASCII_FOR_BRACKET = `]${Array.from({ length: 95 }, (_, i) =>
	String.fromCharCode(32 + i),
)
	.filter((c) => c !== "]" && c !== "-")
	.join("")}-`;

export interface BashExcludeSnippetOptions {
	/**
	 * Which case rule the snippet applies. Omitted (the production default)
	 * the snippet probes the real platform when it runs; "darwin" and
	 * "linux" fix the branch so both can be exercised on any host.
	 */
	platform?: "darwin" | "linux";
}

/**
 * The POSIX `sh` exclusion-check snippet. It is spliced inside the
 * detached subshell of the hook command, before the network call, so the
 * agent's turn never waits on it. Sets `$ap_excluded` to `"1"` or `"0"`
 * and manages the invalid-rules marker file as its only side effects;
 * never writes to stdout or stderr, matching checkNoStdoutShape's rules (no
 * echo/printf/tee/jq/bare-cat — every value is passed through a pipeline
 * via a heredoc instead of `printf '%s' "$x" |`, which textually contains
 * `printf`) and the existing no-bash-isms check (no `[[`, `$'...'`,
 * `function`/`source` keywords, array assignment, or `==`).
 *
 * Mirrors src/shared/exclude-rules.ts's decision exactly:
 *  - AGENTPULSE_SKIP is trimmed of leading/trailing space, tab, CR and LF
 *    — exactly that set, in every evaluator — before the case-insensitive
 *    allowlist check (1/true/yes/on); see isSkipValue.
 *  - only "not found" means "no rules". An unset or empty HOME, an
 *    unsearchable home, ancestor of the home or `.agentpulse`, a
 *    `.agentpulse` that is a link pointing nowhere or looping, or a rules
 *    path that can't be looked up for any other reason is invalid (fail
 *    closed): every directory down to `.agentpulse` is walked, and a link
 *    whose target is missing, or a directory without search permission, is
 *    a failed lookup, never "not found". A directory that is untrusted but
 *    holds no rules file is "no rules" (the file is never looked at),
 *    matching loadExcludeRules, except that a stale invalid marker is
 *    removed from a trusted directory once the rules file is gone.
 *  - more than 500 rules is invalid (every hook event checks every rule),
 *    and a rules file that can't be opened at read time (it vanished after
 *    its checks) is invalid: the loop sets a completion flag that only a
 *    completed read reaches.
 *  - the rules file is read only after both the file's own identity
 *    (symlink, regular, link count, owner, mode, size, readable) and its
 *    *directory*'s (a symlinked `.agentpulse` is allowed; what it
 *    resolves to must be searchable, owned by the user and not
 *    group/world-writable) pass — see loadExcludeRules. `ls -ldn` output
 *    is parsed strictly: an unexpected mode string or a non-numeric
 *    column refuses, and the call carries its own locale and block-size
 *    settings so the environment can't change the columns. `id -u` is
 *    compared against the owner, never `[ -O ]` (not POSIX for `sh`).
 *  - normalisation order: strip one leading BOM, strip a trailing CR,
 *    trim trailing space/tab, then skip blank/`#` lines — see
 *    parseRulesContent. The whole file is validated, in one pass of
 *    shell built-ins, before the marker is decided: a later invalid line
 *    can't let an earlier match clear a marker another sender set.
 *  - a line containing a `.`/`..` segment is invalid (fails the whole
 *    file closed) — see hasDotSegment. The shim's own cwd always comes
 *    from `pwd -P` and always exists; if it can't be read or no longer
 *    exists (a deleted directory; dash answers `pwd -P` from a cache, so
 *    the path is tested too) and rules are present, the event is
 *    excluded, as the TypeScript evaluator does for an unknown cwd.
 *  - a rule is resolved to the realpath of its deepest existing ancestor
 *    plus whatever remainder doesn't exist yet — see resolvePhysicalPath.
 *    A rule with a symlink component needs a resolution, and so does one
 *    with a byte outside printable ASCII on macOS (the on-disk spelling
 *    can differ in accents and normalisation form); each costs a
 *    builtin-only subshell (`cd` + `pwd -P`). On macOS the shell's own
 *    `pwd -P` can echo the spelling it was typed, so a path with a
 *    non-ASCII byte goes through the external pwd instead, whose answer
 *    is the on-disk spelling — one extra program for such a path only.
 *  - on macOS (detected by /System/Library/CoreServices, no program run,
 *    unless the generator was asked for a fixed platform) the cwd and
 *    every resolved rule are ASCII-lowercased before the comparison;
 *    Linux compares case-sensitively. See normalizeForCompare for why
 *    this is a policy and not a filesystem probe. Non-ASCII case folding
 *    is a documented limitation, identical in every evaluator: only the
 *    on-disk spelling of an EXISTING path is corrected.
 *  - a root rule ("/") matches every cwd, including "/" itself — see
 *    matchesRule.
 *  - the marker is written only when the directory passed its owner and
 *    mode checks and the marker path is not a symlink; a directory that
 *    is itself the reason for invalidity gets no marker. The event is
 *    dropped either way.
 *
 * Residual, accepted and not worth closing in `sh`: unlike the
 * TypeScript evaluator (one lstat, one open, one fstat, one read, all on
 * the same descriptor), this snippet checks the file's identity and then
 * reads it by path — there is no descriptor-bound read in POSIX `sh`, so
 * a file swapped in between isn't caught here. The window is the same
 * one shell scripts have always had; closing it would need a language
 * with file descriptors as first-class values, which `sh` isn't. Also
 * accepted: an embedded NUL byte in a rule line can't be reliably
 * detected in POSIX `sh` (a shell variable can't represent one — the
 * byte is silently dropped by `read`, and the one portable-looking
 * detection trick, piping a NUL through a command substitution to use as
 * a `grep` pattern, produces an **empty** pattern instead, which matches
 * every file and would wrongly invalidate a clean one) — this is the one
 * fixture-matrix case this snippet doesn't claim parity with TypeScript
 * on.
 *
 * Latency budget, pinned by scripts/exclude-shim-spawn-count.test.ts as
 * exact external-command lists: no rules file `[]`; AGENTPULSE_SKIP
 * allowlisted `[]`; rules present `id`, `ls`, `ls` (+ `rm` only when a
 * stale marker file exists) whatever the rule count. Everything else is
 * shell built-ins: `case`/parameter expansion for trimming and
 * lowercasing, `read` for the rules, `[ -e ]`/`[ -L ]`/`[ -d ]` for path
 * probing.
 *
 * Not done, on purpose: `id` and `ls` are invoked by bare name, trusting
 * whatever PATH resolves them to, rather than an absolute path. This is
 * deliberate, not an oversight: the threat model here is a hostile RULES
 * FILE or a hostile CWD, not a hostile PATH for the same user running
 * their own agent's hooks — if an attacker can already rewrite this
 * user's PATH, they can already run arbitrary code as that user through
 * countless other paths this snippet has no way to close. The one
 * absolute path is `/bin/pwd`, deliberate for a different reason: a bare
 * `pwd` is the shell built-in, which is exactly what must be bypassed.
 */
export function buildBashExcludeSnippet(options: BashExcludeSnippetOptions = {}): string {
	const platformLine =
		options.platform === "darwin"
			? "ap_is_darwin=1"
			: options.platform === "linux"
				? "ap_is_darwin=0"
				: "ap_is_darwin=0\nif [ -d /System/Library/CoreServices ]; then ap_is_darwin=1; fi";
	return `ap_dir="$HOME/${EXCLUDE_DIR_NAME}"
ap_rules="$ap_dir/${EXCLUDE_RULES_FILE_NAME}"
ap_marker="$ap_dir/${EXCLUDE_MARKER_FILE_NAME}"
ap_excluded=0
ap_valid=1
ap_dir_ok=1
ap_match=0
ap_nrules=0
ap_cr='${CARRIAGE_RETURN}'
ap_bom='${BYTE_ORDER_MARK}'
ap_trimset=" ${TAB}$ap_cr${LINE_FEED}"
ap_ascii='${PRINTABLE_ASCII_FOR_BRACKET.replace(/'/g, `'\\''`)}'
${platformLine}

ap_lower() {
  ap_lc_in="$1"
  ap_lc_out=""
  while :; do
    case "$ap_lc_in" in
      *[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*) : ;;
      *) break ;;
    esac
    ap_lc_pre=\${ap_lc_in%%[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*}
    ap_lc_in=\${ap_lc_in#"$ap_lc_pre"}
    ap_lc_c=\${ap_lc_in%"\${ap_lc_in#?}"}
    ap_lc_in=\${ap_lc_in#?}
    case "$ap_lc_c" in
      A) ap_lc_c=a ;; B) ap_lc_c=b ;; C) ap_lc_c=c ;; D) ap_lc_c=d ;; E) ap_lc_c=e ;;
      F) ap_lc_c=f ;; G) ap_lc_c=g ;; H) ap_lc_c=h ;; I) ap_lc_c=i ;; J) ap_lc_c=j ;;
      K) ap_lc_c=k ;; L) ap_lc_c=l ;; M) ap_lc_c=m ;; N) ap_lc_c=n ;; O) ap_lc_c=o ;;
      P) ap_lc_c=p ;; Q) ap_lc_c=q ;; R) ap_lc_c=r ;; S) ap_lc_c=s ;; T) ap_lc_c=t ;;
      U) ap_lc_c=u ;; V) ap_lc_c=v ;; W) ap_lc_c=w ;; X) ap_lc_c=x ;; Y) ap_lc_c=y ;;
      Z) ap_lc_c=z ;;
    esac
    ap_lc_out="$ap_lc_out$ap_lc_pre$ap_lc_c"
  done
  ap_lc_out="$ap_lc_out$ap_lc_in"
}

ap_stat() {
  ap_stat_mode=""
  ap_stat_line=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$1" 2>/dev/null) || return 1
  IFS=" " read -r ap_stat_mode ap_stat_nlink ap_stat_uid ap_stat_gid ap_stat_size ap_stat_tail <<AP_STAT_EOF
$ap_stat_line
AP_STAT_EOF
  ap_stat_m=$ap_stat_mode
  case "$ap_stat_m" in *[@+.]) ap_stat_m=\${ap_stat_m%?} ;; esac
  case "$ap_stat_m" in
    [-dlcbpsDw?][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]) : ;;
    *) return 1 ;;
  esac
  case "$ap_stat_nlink" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_uid" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_size" in ""|*[!0-9]*) return 1 ;; esac
  ap_stat_rest=\${ap_stat_m#?????}
  ap_stat_gw=\${ap_stat_rest%"\${ap_stat_rest#?}"}
  ap_stat_rest2=\${ap_stat_m#????????}
  ap_stat_ow=\${ap_stat_rest2%"\${ap_stat_rest2#?}"}
  return 0
}

ap_physical() {
  if [ "$ap_is_darwin" = "1" ]; then
    case "$1" in
      *[!"$ap_ascii"]*) /bin/pwd -P 2>/dev/null; return ;;
    esac
  fi
  pwd -P 2>/dev/null
}

ap_skip_raw=\${AGENTPULSE_SKIP:-}
while :; do
  case "$ap_skip_raw" in
    *["$ap_trimset"]) ap_skip_raw=\${ap_skip_raw%?} ;;
    *) break ;;
  esac
done
while :; do
  case "$ap_skip_raw" in
    ["$ap_trimset"]*) ap_skip_raw=\${ap_skip_raw#?} ;;
    *) break ;;
  esac
done
case "$ap_skip_raw" in
  [1]|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) ap_excluded=1 ;;
esac

ap_present=0
if [ "$ap_excluded" != "1" ]; then
  if [ -z "$HOME" ]; then
    ap_excluded=1
  elif [ -e "$ap_rules" ] || [ -L "$ap_rules" ]; then
    ap_present=1
  else
    case "$ap_dir" in /*) ap_wp="" ;; *) ap_wp="." ;; esac
    ap_wrest=\${ap_dir#/}
    while [ -n "$ap_wrest" ]; do
      case "$ap_wrest" in
        */*)
          ap_wseg=\${ap_wrest%%/*}
          ap_wrest=\${ap_wrest#*/}
          ;;
        *)
          ap_wseg="$ap_wrest"
          ap_wrest=""
          ;;
      esac
      if [ -z "$ap_wseg" ]; then continue; fi
      ap_wp="$ap_wp/$ap_wseg"
      if [ -L "$ap_wp" ] && [ ! -e "$ap_wp" ]; then ap_present=1; break; fi
      if [ -d "$ap_wp" ]; then
        if [ ! -x "$ap_wp" ]; then ap_present=1; break; fi
      else
        break
      fi
    done
  fi
fi

ap_check_dir() {
  ap_dir_ok=1
  if [ -L "$ap_dir" ]; then
    ap_dir_real=$(cd "$ap_dir" 2>/dev/null && pwd -P 2>/dev/null)
  else
    ap_dir_real="$ap_dir"
  fi
  if [ -z "$ap_dir_real" ] || [ ! -d "$ap_dir_real" ] || [ ! -x "$ap_dir_real" ]; then
    ap_dir_ok=0
  else
    ap_my_uid=$(id -u 2>/dev/null)
    case "$ap_my_uid" in ""|*[!0-9]*) ap_dir_ok=0 ;; esac
    if ap_stat "$ap_dir_real"; then
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_dir_ok=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_dir_ok=0; fi
    else
      ap_dir_ok=0
    fi
  fi
}

if [ "$ap_present" != "1" ] && [ "$ap_excluded" != "1" ]; then
  if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then
    ap_check_dir
    if [ "$ap_dir_ok" = "1" ]; then rm -f "$ap_dir_real/${EXCLUDE_MARKER_FILE_NAME}" 2>/dev/null; fi
  fi
fi

if [ "$ap_present" = "1" ]; then
  ap_check_dir
  ap_valid=$ap_dir_ok
  ap_marker="$ap_dir_real/${EXCLUDE_MARKER_FILE_NAME}"

  if [ "$ap_valid" = "1" ]; then
    if [ -L "$ap_rules" ]; then
      ap_valid=0
    elif [ ! -f "$ap_rules" ]; then
      ap_valid=0
    elif ap_stat "$ap_rules"; then
      if [ "$ap_stat_nlink" -gt 1 ]; then ap_valid=0; fi
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_valid=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ ! -r "$ap_rules" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ "$ap_stat_size" -gt 65536 ]; then ap_valid=0; fi
    else
      ap_valid=0
    fi
  fi

  if [ "$ap_valid" = "1" ]; then
    ap_cwd=$(pwd -P 2>/dev/null)
    if [ -n "$ap_cwd" ] && [ ! -d "$ap_cwd" ]; then ap_cwd=""; fi
    if [ "$ap_is_darwin" = "1" ]; then
      case "$ap_cwd" in
        *[!"$ap_ascii"]*) ap_cwd=$(/bin/pwd -P 2>/dev/null) ;;
      esac
      ap_lower "$ap_cwd"
      ap_cwd="$ap_lc_out"
    fi

    ap_line_no=0
    ap_read_ok=0
    {
    while IFS= read -r ap_line || [ -n "$ap_line" ]; do
      ap_line_no=$((ap_line_no + 1))
      case "$ap_line" in *"$ap_cr") ap_line=\${ap_line%"$ap_cr"} ;; esac
      if [ "$ap_line_no" = "1" ]; then
        case "$ap_line" in "$ap_bom"*) ap_line=\${ap_line#"$ap_bom"} ;; esac
      fi
      while :; do
        case "$ap_line" in
          *["$ap_trimset"]) ap_line=\${ap_line%?} ;;
          *) break ;;
        esac
      done
      case "$ap_line" in
        "") continue ;;
        "#"*) continue ;;
      esac
      ap_nrules=$((ap_nrules + 1))
      if [ "$ap_nrules" -gt ${EXCLUDE_MAX_RULES} ]; then ap_valid=0; break; fi
      case "$ap_line" in
        *'*'*|*'?'*|*'['*|*']'*) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        /*) : ;;
        "~") : ;;
        "~/"*) : ;;
        *) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        "~") ap_expanded="$HOME" ;;
        "~/"*) ap_expanded="$HOME/\${ap_line#\\~/}" ;;
        *) ap_expanded="$ap_line" ;;
      esac
      case "/$ap_expanded/" in
        *"/./"*|*"/../"*) ap_valid=0; break ;;
      esac
      if [ "$ap_match" = "1" ]; then continue; fi

      ap_seg_rest=\${ap_expanded#/}
      ap_prefix=""
      ap_needs_resolve=0
      ap_deepest=""
      ap_remainder=""
      while [ -n "$ap_seg_rest" ]; do
        case "$ap_seg_rest" in
          */*)
            ap_seg=\${ap_seg_rest%%/*}
            ap_seg_rest=\${ap_seg_rest#*/}
            ;;
          *)
            ap_seg="$ap_seg_rest"
            ap_seg_rest=""
            ;;
        esac
        if [ -z "$ap_seg" ]; then continue; fi
        ap_prefix="$ap_prefix/$ap_seg"
        if [ -L "$ap_prefix" ]; then ap_needs_resolve=1; fi
        if [ -e "$ap_prefix" ]; then
          ap_deepest="$ap_prefix"
          ap_remainder=""
        else
          ap_remainder="$ap_remainder/$ap_seg"
        fi
      done
      if [ -z "$ap_prefix" ]; then ap_prefix="/"; fi
      if [ "$ap_is_darwin" = "1" ]; then
        case "$ap_deepest" in
          *[!${COMMON_PATH_CHARS}]*)
            case "$ap_deepest" in
              *[!"$ap_ascii"]*) ap_needs_resolve=1 ;;
            esac ;;
        esac
      fi

      if [ "$ap_needs_resolve" = "1" ]; then
        ap_rt="\${ap_deepest:-/}"
        ap_rrem="$ap_remainder"
        while :; do
          ap_resolved=$(cd "$ap_rt" 2>/dev/null && ap_physical "$ap_rt")
          if [ -n "$ap_resolved" ]; then break; fi
          if [ "$ap_rt" = "/" ]; then ap_resolved="/"; break; fi
          ap_rrem="/\${ap_rt##*/}$ap_rrem"
          ap_rt=\${ap_rt%/*}
          if [ -z "$ap_rt" ]; then ap_rt="/"; fi
        done
        if [ "$ap_resolved" = "/" ]; then ap_resolved=""; fi
        ap_resolved="$ap_resolved$ap_rrem"
        if [ -z "$ap_resolved" ]; then ap_resolved="/"; fi
      else
        ap_resolved="$ap_prefix"
      fi

      if [ "$ap_is_darwin" = "1" ]; then
        ap_lower "$ap_resolved"
        ap_resolved="$ap_lc_out"
      fi

      if [ "$ap_resolved" = "/" ]; then
        ap_match=1
      elif [ "$ap_cwd" = "$ap_resolved" ]; then
        ap_match=1
      else
        ap_rem=\${ap_cwd#"$ap_resolved"/}
        if [ "$ap_rem" != "$ap_cwd" ]; then ap_match=1; fi
      fi
    done
    ap_read_ok=1
    } 2>/dev/null < "$ap_rules"
    if [ "$ap_read_ok" != "1" ]; then ap_valid=0; fi
    if [ "$ap_valid" = "1" ] && [ "$ap_nrules" -gt 0 ] && [ -z "$ap_cwd" ]; then ap_match=1; fi
  fi

  if [ "$ap_valid" = "1" ]; then
    if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then rm -f "$ap_marker" 2>/dev/null; fi
    if [ "$ap_match" = "1" ]; then ap_excluded=1; fi
  else
    if [ "$ap_dir_ok" = "1" ] && [ ! -L "$ap_marker" ]; then { :; } 2>/dev/null >"$ap_marker"; fi
    ap_excluded=1
  fi
fi
`;
}

/**
 * The three invisible characters the shell snippet needs as real bytes.
 * Installers carry the snippet as ASCII text with these placeholders
 * (bash replaces them with $'\t' / $'\r' / $'\xef\xbb\xbf', PowerShell with
 * [char] values), so no installer source holds a literal tab, CR or BOM
 * that an editor or a line-ending conversion could silently change.
 */
export const INSTALLER_SNIPPET_PLACEHOLDERS = {
	tab: "@@AP_TAB@@",
	cr: "@@AP_CR@@",
	bom: "@@AP_BOM@@",
} as const;

/**
 * A short content hash (cyrb53, 53 bits, hex): a version label that makes a
 * stale installed script detectable by comparing one line, not a security
 * primitive. Pure arithmetic so the web bundle can import this module.
 */
function contentHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * What the trust check covers, written into both installed checks so anyone
 * reading the file sees the limit: the hook command runs the script only when
 * the directory and the script themselves are owned by the user and not
 * writable by others. Ancestors of the directory are not examined.
 */
const EXCLUDE_SCRIPT_TRUST_NOTE = [
	"# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you",
	"# and not group- or world-writable. Only that directory and this file are checked, not the",
	"# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users",
	"# can write is not protected.",
	"",
].join("\n");

/** The comment that opens line 2 of an installed check; the rest of the line is the content hash. */
export const EXCLUDE_SCRIPT_HEADER_PREFIX = "# agentpulse-exclude-check ";

/**
 * The installed sh check, `~/.agentpulse/exclude-check.sh`. Its body is the
 * exclusion snippet above; it ends by turning the snippet's verdict into an
 * exit status: 0 = send, non-zero = don't. It decides from the working
 * directory, the environment and the rules file only (it takes no
 * arguments), prints nothing, and keeps every property of the snippet.
 * Line 2 carries a hash of the rest of the file, so a copy left by an older
 * AgentPulse can be recognised as stale.
 */
export function buildBashExcludeScript(options: BashExcludeSnippetOptions = {}): string {
	const body = `${EXCLUDE_SCRIPT_TRUST_NOTE}${buildBashExcludeSnippet(options)}if [ "$ap_excluded" = "1" ]; then exit 1; fi\nexit ${EXCLUDE_SCRIPT_SEND_STATUS}\n`;
	return `#!/bin/sh\n${EXCLUDE_SCRIPT_HEADER_PREFIX}${contentHash(body)}\n${body}`;
}

/** The hash in an installed script's header comment (line 2 of the sh one, line 1 of the PowerShell one), or null when the file doesn't look like one. */
export function excludeScriptHeaderHash(text: string): string | null {
	const match = /^(?:#!\/bin\/sh\n)?# agentpulse-exclude-check ([0-9a-f]{14})\n/.exec(text);
	return match ? (match[1] as string) : null;
}

/** buildBashExcludeScript() as ASCII-only installer text; replacing the placeholders restores it exactly. */
export function buildBashExcludeScriptForInstaller(): string {
	return buildBashExcludeScript()
		.split(TAB)
		.join(INSTALLER_SNIPPET_PLACEHOLDERS.tab)
		.split(CARRIAGE_RETURN)
		.join(INSTALLER_SNIPPET_PLACEHOLDERS.cr)
		.split(BYTE_ORDER_MARK)
		.join(INSTALLER_SNIPPET_PLACEHOLDERS.bom);
}

/** The two PowerShell functions the hook command and the installed check both need, kept as one text so the copies can't drift. */
const PS_REPARSE_FN = `function ApIsReparsePoint($apPath) {
  $apItem = Get-Item -LiteralPath $apPath -Force -ErrorAction SilentlyContinue
  if (-not $apItem) { return $false }
  if ($apItem.LinkType) { return $true }
  return [bool]($apItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}`;

const PS_SECURITY_FN = `function ApCheckSecurity($apPath) {
  try {
    $apAcl = Get-Acl -LiteralPath $apPath -ErrorAction Stop
  } catch {
    return $false
  }
  $apCurrentSid = $null
  try { $apCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
  if (-not $apCurrentSid) { return $false }
  $apOwnerSid = $null
  try { $apOwnerSid = $apAcl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  if (-not $apOwnerSid) {
    try { $apOwnerSid = ([System.Security.Principal.NTAccount]$apAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  }
  $apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $apOwnerSid -or -not ($apExempt -contains $apOwnerSid)) { return $false }
  $apWriteNames = @('WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','WriteDac','ChangePermissions','WriteOwner','TakeOwnership','Delete','DeleteSubdirectoriesAndFiles','Modify','FullControl','Write','GenericWrite','GenericAll')
  $apWriteRightsMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($apAce in $apAcl.Access) {
    if ($apAce.AccessControlType.ToString() -ne 'Allow') { continue }
    $apRightsStr = $apAce.FileSystemRights.ToString().Trim()
    $apHasWrite = $false
    if ($apRightsStr -match '^-?\\d+$') {
      if (([int64]$apRightsStr -band $apWriteRightsMask) -ne 0) { $apHasWrite = $true }
    } else {
      foreach ($apName in ($apRightsStr -split ',')) {
        if ($apWriteNames -contains $apName.Trim()) { $apHasWrite = $true; break }
      }
    }
    if (-not $apHasWrite) { continue }
    $apAceSid = $null
    try { $apAceSid = $apAce.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }
    return $false
  }
  return $true
}`;

/**
 * The PowerShell pieces of the hook command, exported so install-local.ps1 can
 * carry them as literal text and the parity test can hold the copies to these.
 * NEVER EXECUTED: no PowerShell host exists here; they are covered by
 * text-level assertions only, and the Windows CI job is their first run.
 *
 *  - prelude: the reparse-point test the marker and the gate use;
 *  - marker (Codex): created exclusively (CreateNew: it fails rather than
 *    follow or replace anything), never into or through a link;
 *  - gate: the skip variable, then "no rules file" (send), otherwise the
 *    installed `exclude-check.ps1` decides: it runs only if the directory and
 *    the file pass the evaluator's own ACL check and the file is a plain
 *    file, in a new process of the same PowerShell host (execution policy
 *    bypassed for that one file) started in the agent's directory; exit 0
 *    sends. Anything missing or untrusted sends nothing.
 */
export const PS_PRELUDE_PIECE = PS_REPARSE_FN.replace(/^/gm, "  ");

export const PS_CODEX_MARKER_PIECE =
	"$jobRaw = [IO.File]::ReadAllText($t); $sid = [regex]::Match($jobRaw, '\"session_id\"\\s*:\\s*\"([A-Za-z0-9-]{1,128})\"').Groups[1].Value; if ($sid) { $md = Join-Path $HOME '.agentpulse\\codex-native'; if (-not (ApIsReparsePoint $md)) { New-Item -ItemType Directory -Force $md -ErrorAction SilentlyContinue | Out-Null; $mf = Join-Path $md $sid; if (-not (ApIsReparsePoint $mf)) { try { [IO.File]::Open($mf, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite).Close() } catch {} } } }";

export const PS_GATE_PIECE = `  $apGo = $true
  $apSkip = $apJobSkip
  if ($null -eq $apSkip) { $apSkip = '' }
  if (@('1','true','yes','on') -contains $apSkip.Trim(' ', "\`t", "\`r", "\`n").ToLowerInvariant()) { $apGo = $false }
  elseif ([string]::IsNullOrEmpty($HOME)) { $apGo = $false }
  else {
    $apDir = Join-Path $HOME '${EXCLUDE_DIR_NAME}'
    $apHand = $false
    try { $null = Get-Item -LiteralPath (Join-Path $apDir '${EXCLUDE_RULES_FILE_NAME}') -Force -ErrorAction Stop; $apHand = $true }
    catch [System.Management.Automation.ItemNotFoundException] { }
    catch [System.Management.Automation.DriveNotFoundException] { }
    catch { $apHand = $true }
    if (-not $apHand) {
      try { $null = Get-Item -LiteralPath (Join-Path $apDir '${EXCLUDE_MARKER_FILE_NAME}') -Force -ErrorAction Stop; $apHand = $true }
      catch [System.Management.Automation.ItemNotFoundException] { }
      catch [System.Management.Automation.DriveNotFoundException] { }
      catch { $apHand = $true }
    }
    if (-not $apHand) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) { $apHand = $true }
    }
    if ($apHand) {
      $apGo = $false
${PS_SECURITY_FN.replace(/^/gm, "      ")}
      $apScript = Join-Path $apDir 'exclude-check.ps1'
      if ((Test-Path -LiteralPath $apScript -PathType Leaf) -and -not (ApIsReparsePoint $apScript) -and (ApCheckSecurity $apDir) -and (ApCheckSecurity $apScript)) {
        $apHost = (Get-Process -Id $PID).Path
        $apProc = Start-Process -FilePath $apHost -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $apScript + '"')) -WorkingDirectory $apJobCwd -WindowStyle Hidden -Wait -PassThru
        if ($apProc -and $apProc.ExitCode -eq ${EXCLUDE_SCRIPT_SEND_STATUS}) { $apGo = $true }
      }
    }
  }`;

/**
 * Hands the key file to curl when it exists and isn't empty (direct mode). Built
 * with an `if` statement that assigns, never an inline `$(if ...)` expression:
 * the expression form yields $null when the condition is false, and
 * `@(...) + $null` appends a null element that Start-Process -ArgumentList
 * rejects, which would send nothing in relay mode and in direct mode with an
 * empty key file. NEVER EXECUTED.
 */
export const PS_AUTH_ARG =
	"$headerArgs = @()\n    if ($f -and (Test-Path $f -ErrorAction SilentlyContinue) -and (Get-Item $f -ErrorAction SilentlyContinue).Length -gt 0) { $headerArgs = @('-H', \"@$f\") }";

/** The whole PowerShell command with its holes, filled the same way by install-local.ps1. */
export const PS_COMMAND_TEMPLATE = [
	"$ErrorActionPreference = 'SilentlyContinue'",
	"$d = Join-Path $env:TEMP 'agentpulse-hooks'",
	"New-Item -ItemType Directory -Force $d | Out-Null",
	"$t = Join-Path $d ([guid]::NewGuid().ToString())",
	"$raw = [Console]::In.ReadToEnd()",
	"[IO.File]::WriteAllText($t, $raw)",
	"@@AP_HEADER_FILE@@",
	"Start-Job -ScriptBlock {",
	"  param($t, $f, $url, $agent, $apJobCwd, $apJobSkip)",
	"  try {",
	"@@AP_PRELUDE@@",
	"@@AP_MARKER@@@@AP_GATE@@",
	"  if ($apGo) {",
	"    @@AP_AUTH_ARG@@",
	"    $curlArgs = @('-sS','--max-time','2','-o','NUL','-X','POST',$url,'-H','Content-Type: application/json','-H',\"X-Agent-Type: $agent\") + $headerArgs + @('--data-binary',\"@$t\")",
	"    Start-Process -FilePath curl.exe -WindowStyle Hidden -ArgumentList $curlArgs -Wait",
	"  }",
	"  } finally {",
	"    Remove-Item -Force $t -ErrorAction SilentlyContinue",
	"  }",
	"} -ArgumentList $t, $f, '@@AP_URL@@', '@@AP_AGENT@@', (Get-Location).Path, $env:AGENTPULSE_SKIP | Out-Null",
	"Get-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue",
	"exit 0",
	"",
].join("\n");

/**
 * The PowerShell equivalent of buildBashExcludeSnippet() — the same
 * decisions in the same order, kept line-for-line comparable: skip values
 * trimmed with the explicit space/tab/CR/LF set; an empty HOME, or any
 * lookup error other than "not found" on the rules file, fails closed;
 * the rules file is read as UTF-8 explicitly (a read error is invalid,
 * never an empty list) and split on LF only; the whole file is validated
 * in one pass before the marker is decided; the working directory and
 * every rule go through the same symlink/junction walker
 * (ApResolveLinks) so they resolve the way the TypeScript evaluator's
 * realpath does; a rule that resolves to something no drive path can match
 * is invalid rather than inert; and the marker is created without
 * truncation, only when the directory passed its checks and the marker is
 * not itself a link. Reparse-point and hardlink detection mirror
 * scripts/install-local.ps1's Test-ApReparsePoint/Test-ApMultipleHardLinks
 * (not imported — this snippet is a self-contained block of text, like the
 * bash one); the Windows security check mirrors exclude-rules.ts's
 * evaluateWindowsSecurity exactly (SID-based: current user, S-1-5-18
 * SYSTEM, S-1-5-32-544 Administrators are exempt; everything else that
 * grants a write-capable right is not, matched by SID, never by display
 * name).
 *
 * NEVER EXECUTED. There is no Windows machine and no PowerShell host in
 * this environment, so nothing in this snippet has run, including every
 * change in this revision (the UTF-8 read, the not-found distinction, the
 * link walker, the marker guard). It is covered by text-level assertions
 * and by `scripts/exclude-shim-parity-ps.test.ts`, whose first real
 * execution is the Windows CI job. Known gaps against the TypeScript
 * evaluator's realpath: 8.3 short names are not expanded, and a link whose
 * target can't be read is kept as typed.
 */
export function buildPowerShellExcludeSnippet(): string {
	return `$apDir = Join-Path $HOME '${EXCLUDE_DIR_NAME}'
$apRules = Join-Path $apDir '${EXCLUDE_RULES_FILE_NAME}'
$apMarker = Join-Path $apDir '${EXCLUDE_MARKER_FILE_NAME}'
$apExcluded = $false
$apValid = $true
$apDirOk = $true
$apMatch = $false
$apNRules = 0

${PS_REPARSE_FN}

function ApHasMultipleHardLinks($apPath) {
  if (-not (Test-Path -LiteralPath $apPath)) { return $false }
  try {
    $apOutput = & fsutil hardlink list $apPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $apOutput) { return $false }
    $apCount = @($apOutput | Where-Object { $_.Trim().Length -gt 0 }).Count
    return $apCount -gt 1
  } catch {
    return $false
  }
}

${PS_SECURITY_FN}

function ApResolveLinks($apPath, $apDepth) {
  if ($apDepth -gt 32) { return $null }
  $apRoot = [System.IO.Path]::GetPathRoot($apPath)
  if ([string]::IsNullOrEmpty($apRoot)) { return $apPath }
  $apCur = $apRoot
  foreach ($apSeg in ($apPath.Substring($apRoot.Length) -split '[\\\\/]' | Where-Object { $_.Length -gt 0 })) {
    $apNext = Join-Path $apCur $apSeg
    $apItem = Get-Item -LiteralPath $apNext -Force -ErrorAction SilentlyContinue
    if ($apItem -and $apItem.LinkType) {
      $apTarget = @($apItem.Target)[0]
      if (-not [System.IO.Path]::IsPathRooted($apTarget)) { $apTarget = Join-Path $apCur $apTarget }
      $apNext = ApResolveLinks ([System.IO.Path]::GetFullPath($apTarget)) ($apDepth + 1)
      if ($null -eq $apNext) { return $null }
    }
    $apCur = $apNext
  }
  return $apCur
}

function ApResolve($apTarget) {
  $apFull = $apTarget
  try { $apFull = [System.IO.Path]::GetFullPath($apTarget) } catch {}
  $apOut = ApResolveLinks $apFull 0
  if ($null -eq $apOut) { return $apFull }
  return $apOut
}

$apSkipTrimmed = $env:AGENTPULSE_SKIP
if ($null -eq $apSkipTrimmed) { $apSkipTrimmed = '' }
$apSkipTrimmed = $apSkipTrimmed.Trim(' ', "\`t", "\`r", "\`n").ToLowerInvariant()
if ([Array]::IndexOf(@('1','true','yes','on'), $apSkipTrimmed) -ge 0) { $apExcluded = $true }

$apPresent = $false
$apLookupError = $false
if (-not $apExcluded) {
  if ([string]::IsNullOrEmpty($HOME)) {
    $apExcluded = $true
  } else {
    try {
      $null = Get-Item -LiteralPath $apRules -Force -ErrorAction Stop
      $apPresent = $true
    } catch [System.Management.Automation.ItemNotFoundException] {
      $apPresent = $false
    } catch [System.Management.Automation.DriveNotFoundException] {
      $apPresent = $false
    } catch {
      $apPresent = $true
      $apLookupError = $true
    }
    if (-not $apPresent) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) {
        $apPresent = $true
        $apLookupError = $true
      }
    }
  }
}

if (-not $apPresent -and -not $apExcluded) {
  if (Test-Path -LiteralPath $apMarker) {
    $apDirReal = ApResolveLinks $apDir 0
    if (-not [string]::IsNullOrEmpty($apDirReal) -and (Test-Path -LiteralPath $apDirReal -PathType Container) -and (ApCheckSecurity $apDirReal)) {
      Remove-Item -LiteralPath (Join-Path $apDirReal '${EXCLUDE_MARKER_FILE_NAME}') -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($apPresent) {
  $apDirReal = ApResolveLinks $apDir 0
  if ($apLookupError -or [string]::IsNullOrEmpty($apDirReal)) {
    $apDirOk = $false
  } elseif (-not (Test-Path -LiteralPath $apDirReal -PathType Container -ErrorAction SilentlyContinue)) {
    $apDirOk = $false
  } elseif (-not (ApCheckSecurity $apDirReal)) {
    $apDirOk = $false
  }
  $apValid = $apDirOk
  if ($apDirOk) {
    $apRules = Join-Path $apDirReal '${EXCLUDE_RULES_FILE_NAME}'
    $apMarker = Join-Path $apDirReal '${EXCLUDE_MARKER_FILE_NAME}'
  }

  if ($apValid) {
    if (ApIsReparsePoint $apRules) {
      $apValid = $false
    } elseif (Test-Path -LiteralPath $apRules -PathType Container) {
      $apValid = $false
    } elseif (ApHasMultipleHardLinks $apRules) {
      $apValid = $false
    } elseif (-not (ApCheckSecurity $apRules)) {
      $apValid = $false
    } else {
      $apInfo = Get-Item -LiteralPath $apRules -Force -ErrorAction SilentlyContinue
      if ($null -eq $apInfo -or $apInfo.Length -gt 65536) { $apValid = $false }
    }
  }

  if ($apValid) {
    $apCwd = ApResolveLinks ((Get-Location).Path) 0
    $apText = $null
    try {
      $apText = [System.IO.File]::ReadAllText($apRules, (New-Object System.Text.UTF8Encoding($false)))
    } catch { $apValid = $false }
    if ($null -eq $apText) { $apValid = $false }
  }

  if ($apValid) {
    $apCwdCmp = ''
    if (-not [string]::IsNullOrEmpty($apCwd)) { $apCwdCmp = $apCwd.Replace('/', '\\').ToLowerInvariant() }
    foreach ($apRawLine in ($apText -split "\`n")) {
      $apLine = $apRawLine
      if ($apLine.EndsWith("\`r")) { $apLine = $apLine.Substring(0, $apLine.Length - 1) }
      $apLine = $apLine.TrimEnd(' ', "\`t")
      if ($apLine.Length -eq 0) { continue }
      if ($apLine.StartsWith('#')) { continue }
      $apNRules = $apNRules + 1
      if ($apNRules -gt ${EXCLUDE_MAX_RULES}) { $apValid = $false; break }
      if ($apLine -match '[*?\\[\\]]') { $apValid = $false; break }
      $apIsAbsolute = $apLine.StartsWith('/') -or $apLine -eq '~' -or $apLine.StartsWith('~/') -or ($apLine -match '^[A-Za-z]:[\\\\/]')
      if (-not $apIsAbsolute) { $apValid = $false; break }
      $apSegments = $apLine -split '[\\\\/]' | Where-Object { $_.Length -gt 0 }
      if (($apSegments -contains '.') -or ($apSegments -contains '..')) { $apValid = $false; break }
      if ($apMatch) { continue }
      if ($apLine -eq '~') {
        $apExpanded = $HOME
      } elseif ($apLine.StartsWith('~/')) {
        $apExpanded = Join-Path $HOME ($apLine.Substring(2))
      } else {
        $apExpanded = $apLine
      }
      $apResolved = ApResolve $apExpanded
      if ($apResolved -notmatch '^[A-Za-z]:[\\\\/]' -and -not $apResolved.StartsWith('\\\\')) { $apValid = $false; break }
      $apResolvedCmp = $apResolved.Replace('/', '\\').ToLowerInvariant()
      $apResolvedIsRoot = $apResolvedCmp -match '^[a-z]:\\\\$'
      $apResolvedWithSep = if ($apResolvedIsRoot) { $apResolvedCmp } else { "$apResolvedCmp\\" }
      if ([string]::Equals($apCwdCmp, $apResolvedCmp, 'Ordinal') -or $apCwdCmp.StartsWith($apResolvedWithSep, 'Ordinal')) {
        $apMatch = $true
      }
    }
    if ($apValid -and $apNRules -gt 0 -and [string]::IsNullOrEmpty($apCwd)) { $apMatch = $true }
  }

  if ($apValid) {
    Remove-Item -LiteralPath $apMarker -Force -ErrorAction SilentlyContinue
    if ($apMatch) { $apExcluded = $true }
  } else {
    if ($apDirOk -and -not (ApIsReparsePoint $apMarker)) {
      try {
        $apFs = [System.IO.File]::Open($apMarker, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $apFs.Close()
      } catch {}
    }
    $apExcluded = $true
  }
}
`;
}

/**
 * The installed PowerShell check, `~/.agentpulse/exclude-check.ps1`: the
 * snippet above, run in its own process in the agent's directory, ending in
 * an exit status (0 = send, 1 = don't), with a content-hash comment on line 1
 * for staleness. NEVER EXECUTED (see the snippet).
 */
export function buildPowerShellExcludeScript(): string {
	const body = `${EXCLUDE_SCRIPT_TRUST_NOTE}${buildPowerShellExcludeSnippet()}if ($apExcluded) { exit 1 }\nexit ${EXCLUDE_SCRIPT_SEND_STATUS}\n`;
	return `${EXCLUDE_SCRIPT_HEADER_PREFIX}${contentHash(body)}\n${body}`;
}
