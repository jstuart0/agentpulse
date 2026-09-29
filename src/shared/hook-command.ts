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
 * Cross-campaign requirement (event-dedup D12 / mozart D19): the Codex
 * command-hook shim additionally writes an empty native-coverage marker file
 * at `$HOME/.agentpulse/codex-native/<session_id>` *inside the detached
 * subshell, before the curl* — off the synchronous path, exactly like the
 * POST — so a sibling campaign's supervisor-side reader can tell a native
 * Codex hook actually fired. Only ever written when the session_id extracted
 * from the drained payload matches `^[A-Za-z0-9-]{1,128}$`; never deleted.
 */

const BASE_URL_HOST_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const BASE_URL_IPV6_RE = /^https?:\/\/\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$/;

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
 * The sh snippet that extracts `session_id` from the already-drained payload
 * file ($t) and, only when it matches the safe charset/length, writes the
 * native-coverage marker. Pure shell built-ins plus one `grep -o` — no `cat`,
 * `echo`, `printf`, `tee`, or `jq`, and no stdout of its own (every operation
 * either writes to a file or is silenced with 2>/dev/null).
 *
 * Extraction is deliberately narrow: `grep -o` only matches a value already
 * restricted to `[A-Za-z0-9-]`, so a malformed or malicious session_id (e.g.
 * containing `/` or `..`) simply fails to match and `$sid` stays empty — the
 * `case` below is defense-in-depth for the length bound grep can't express.
 */
const CODEX_MARKER_SH_SNIPPET =
	'sid=$(grep -o \'"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"\' "$t" | head -n1); sid=${sid%\\"}; sid=${sid##*\\"}; case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ ${#sid} -le 128 ]; then mkdir -p "$HOME/.agentpulse/codex-native" 2>/dev/null; : > "$HOME/.agentpulse/codex-native/$sid" 2>/dev/null; fi ;; esac; ';

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
 * stdin into the temp file; everything else — including the Codex
 * native-coverage marker and the network call — runs in a backgrounded
 * subshell with stdin/stdout/stderr all redirected, so the parent can
 * `exit 0` immediately and Codex's turn is never blocked on it.
 */
export function buildBashHookCommand(opts: HookCommandOptions): string {
	assertValidHookBaseUrl(opts.baseUrl);
	const marker = opts.agent === "codex_cli" ? CODEX_MARKER_SH_SNIPPET : "";
	// item 13 (r6): a read-only TMPDIR must produce zero stdout/stderr too —
	// mktemp's own diagnostic runs synchronously (before the subshell's own
	// redirection takes effect), so it needs its own 2>/dev/null.
	const mktempPrefix =
		't=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ';

	let body: string;
	if (opts.direct) {
		const withHeader = curlInvocation(opts.baseUrl, opts.event, opts.agent, ' -H "@$f"');
		const withoutHeader = curlInvocation(opts.baseUrl, opts.event, opts.agent, "");
		body = `${marker}f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then ${withHeader}; else ${withoutHeader}; fi; rm -f "$t"`;
	} else {
		const call = curlInvocation(opts.baseUrl, opts.event, opts.agent, "");
		body = `${marker}${call}; rm -f "$t"`;
	}

	return `${mktempPrefix}( ${body} ) </dev/null >/dev/null 2>&1 & exit 0`;
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
	const url = `${opts.baseUrl}/api/v1/hooks?event=${opts.event}`;
	// D13: only direct-mode reads the key file; relay mode never sends auth.
	const headerFileLine = opts.direct
		? `$f = Join-Path $HOME '.agentpulse\\hook-auth-header'\n`
		: "$f = $null\n";
	const authArg =
		"(if ($f -and (Test-Path $f -ErrorAction SilentlyContinue) -and (Get-Item $f -ErrorAction SilentlyContinue).Length -gt 0) { @('-H',\"@$f\") } else { @() })";
	const markerLine =
		opts.agent === "codex_cli"
			? "$sid = [regex]::Match($raw, '\"session_id\"\\s*:\\s*\"([A-Za-z0-9-]{1,128})\"').Groups[1].Value; if ($sid) { $md = Join-Path $HOME '.agentpulse\\codex-native'; New-Item -ItemType Directory -Force $md -ErrorAction SilentlyContinue | Out-Null; New-Item -ItemType File -Force (Join-Path $md $sid) -ErrorAction SilentlyContinue | Out-Null }\n"
			: "";
	return `$ErrorActionPreference = 'SilentlyContinue'\n$d = Join-Path $env:TEMP 'agentpulse-hooks'\nNew-Item -ItemType Directory -Force $d | Out-Null\n$t = Join-Path $d ([guid]::NewGuid().ToString())\n$raw = [Console]::In.ReadToEnd()\n[IO.File]::WriteAllText($t, $raw)\n${headerFileLine}${markerLine}Start-Job -ScriptBlock {\n  param($t, $f, $url, $agent)\n  $headerArgs = ${authArg}\n  $curlArgs = @('-sS','--max-time','2','-o','NUL','-X','POST',$url,'-H','Content-Type: application/json','-H',"X-Agent-Type: $agent") + $headerArgs + @('--data-binary',"@$t")\n  Start-Process -FilePath curl.exe -WindowStyle Hidden -ArgumentList $curlArgs -Wait\n  Remove-Item -Force $t -ErrorAction SilentlyContinue\n} -ArgumentList $t, $f, '${url}', '${opts.agent}' | Out-Null\nGet-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue\nexit 0\n`;
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
	return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
