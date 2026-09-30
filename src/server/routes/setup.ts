import { Hono } from "hono";
import { config } from "../config.js";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../installers.js";

const setup = new Hono();

// F198: 0.0.0.0 is the "any interface" bind address, not a routable host —
// treated as loopback so a PUBLIC_URL of http://0.0.0.0:<port> is rejected
// the same way http://localhost:<port> is (F172), instead of being handed
// out to a remote installer that can never reach it.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const PORT_RE = /^[0-9]{1,5}$/;
// Spliced into a double-quoted shell string, so nothing that expands there.
const SAFE_SERVER_URL_RE =
	/^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/;

/** Splits a Host header into hostname and port; the port is null unless numeric. */
function parseHost(host: string | undefined): { hostname: string; port: string | null } {
	if (!host) return { hostname: "", port: null };
	const bracketed = /^(\[[^\]]*\])(?::(.*))?$/.exec(host);
	const [hostname, rawPort] = bracketed
		? [bracketed[1], bracketed[2]]
		: host.indexOf(":") === host.lastIndexOf(":")
			? (host.split(":") as [string, string | undefined])
			: [host, undefined];
	const port =
		rawPort !== undefined && PORT_RE.test(rawPort) && Number(rawPort) <= 65535 ? rawPort : null;
	return { hostname: hostname.toLowerCase(), port };
}

function isLoopbackHostname(hostname: string) {
	return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * D19: base URL for the local installers (/setup.sh, /install-local.*), whose
 * hooks must hit this machine. Only a numeric Host port is used; the Host
 * hostname never is.
 */
export function resolveLocalHookBaseUrl(host: string | undefined): string {
	return `http://localhost:${parseHost(host).port ?? config.port}`;
}

type InstallerErrorCode = keyof typeof INSTALLER_ERROR_MESSAGES;

type PublicServerUrl =
	| { ok: true; url: string }
	| { ok: false; error: Exclude<InstallerErrorCode, "installer_unavailable"> };

/**
 * D19: the server URL a remote relay should talk to. It comes from PUBLIC_URL
 * only (its first entry when comma-separated), never from the Host hostname.
 * A request from this machine may use a localhost URL; anyone else needs a
 * PUBLIC_URL they can actually reach (F172).
 */
export function resolvePublicServerUrl(host: string | undefined): PublicServerUrl {
	const requester = parseHost(host);
	const fromThisMachine = isLoopbackHostname(requester.hostname);
	if (!config.publicUrlExplicit) {
		if (!fromThisMachine) return { ok: false, error: "public_url_unset" };
		// F174: the port the request came in on, the same rule as the local installers.
		return { ok: true, url: `http://localhost:${requester.port ?? config.port}` };
	}
	const url = (config.publicUrl.split(",")[0] ?? "").trim().replace(/\/+$/, "");
	if (!SAFE_SERVER_URL_RE.test(url)) return { ok: false, error: "public_url_invalid" };
	if (!fromThisMachine && isLoopbackHostname(new URL(url).hostname.toLowerCase())) {
		return { ok: false, error: "public_url_loopback" };
	}
	return { ok: true, url };
}

const SET_PUBLIC_URL =
	"Set PUBLIC_URL on the AgentPulse server so the relay installer knows its public address.";

const INSTALLER_ERROR_MESSAGES = {
	public_url_unset: SET_PUBLIC_URL,
	public_url_invalid: `PUBLIC_URL on the AgentPulse server isn't a plain http(s) URL, so the relay installer can't use it. ${SET_PUBLIC_URL}`,
	public_url_loopback: `PUBLIC_URL on the AgentPulse server is a localhost address, which other machines can't reach. ${SET_PUBLIC_URL}`,
	installer_unavailable:
		"The relay installer isn't available on this server right now. Check the server log.",
} as const;

export const INSTALLER_ERROR_CODES = Object.keys(INSTALLER_ERROR_MESSAGES) as InstallerErrorCode[];

/**
 * F166: a 503 body that's still valid shell, so `curl | bash` prints the
 * reason and fails instead of executing JSON. The message goes through a
 * quoted heredoc, so no character in it needs escaping.
 */
export function installerErrorBody(error: InstallerErrorCode): string {
	return [
		"#!/bin/sh",
		`# ${JSON.stringify({ error })}`,
		"cat >&2 <<'AGENTPULSE_ERROR'",
		`AgentPulse: ${INSTALLER_ERROR_MESSAGES[error]}`,
		"AGENTPULSE_ERROR",
		"exit 1",
		"",
	].join("\n");
}

// F192: every installer response embeds the requester's Host (port for the
// local scripts, F174; PUBLIC_URL eligibility for the relay one, F172), so a
// shared/CDN cache keying only on the URL would serve one requester's body to
// another. no-store rules out caching it at all; Vary: Host documents why for
// any cache that does inspect it.
const INSTALLER_RESPONSE_HEADERS = { "Cache-Control": "no-store", Vary: "Host" } as const;

function installerError(error: InstallerErrorCode) {
	return new Response(installerErrorBody(error), {
		status: 503,
		headers: { "Content-Type": "text/plain; charset=utf-8", ...INSTALLER_RESPONSE_HEADERS },
	});
}

function scriptResponse(script: string, filename: string) {
	return new Response(script, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": `inline; filename=${filename}`,
			...INSTALLER_RESPONSE_HEADERS,
		},
	});
}

// GET /setup.sh - Serve a self-contained install script
// Usage: curl -sSL https://your-server.com/setup.sh | bash
// Or:    curl -sSL https://your-server.com/setup.sh | bash -s -- --key ap_xxx
// F234: --key is briefly visible in `ps` during that one-time install;
// AGENTPULSE_KEY=ap_xxx curl ... | bash keeps it out of the process list.
setup.get("/setup.sh", (c) => {
	const defaultLocalUrl = resolveLocalHookBaseUrl(c.req.header("Host"));

	const script = `#!/usr/bin/env bash
set -euo pipefail

# ───────────────────────────────────────────────────
#  AgentPulse - One-Command Hook Setup
#  Configures Claude Code + Codex CLI to report to AgentPulse
# ───────────────────────────────────────────────────
#
# F234: --key is briefly visible in \`ps\` during this one-time install.
# Prefer: AGENTPULSE_KEY=ap_xxx curl -sSL .../setup.sh | bash

# Hooks MUST point to localhost -- Claude Code and Codex block
# HTTP hooks to remote/private IPs as a security measure.
HOOK_URL="${defaultLocalUrl}"
# F234: seed from \$AGENTPULSE_KEY (if exported) so it never has to be
# passed as an argv flag at all; --key below still overrides it.
API_KEY="\${AGENTPULSE_KEY:-}"
# D39 (F246): explicit escape hatch — see ap_check_auth_before_write below.
NO_AUTH_CHECK="0"

while [[ \$# -gt 0 ]]; do
  case \$1 in
    --key) API_KEY="\$2"; shift 2 ;;
    --url) HOOK_URL="\$2"; shift 2 ;;
    --no-auth-check) NO_AUTH_CHECK="1"; shift ;;
    *) shift ;;
  esac
done

# >>> agentpulse-hook-cmd
# D13: shared hook-command generators. Byte-identical to buildBashHookCommand/
# buildCodexHooksFile in src/shared/hook-command.ts (verified by
# scripts/hook-command-parity.test.ts) — this exact block also appears
# verbatim in scripts/setup-hooks.sh and scripts/setup-relay.sh. Do not
# hand-edit one copy without the others.

# F245 (High, codex r2 D38): same grammar as assertValidHookBaseUrl() in
# src/shared/hook-command.ts — bare http(s)://host[:port] or
# http(s)://[ipv6][:port], nothing else. The base URL is later embedded
# inside single-quoted curl text in the generated hook command (ap_hook_cmd
# below); a --url containing a quote, space, \$(...), or backtick would
# persist as shell code in hooks.json/agentpulse.json and execute on the
# next hook fire. Call before any hook JSON generation at every site.
ap_validate_hook_base_url() {
	local url="\$1"
	if [[ "\$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?\$ ]]; then
		return 0
	fi
	if [[ "\$url" =~ ^https?://\\[[0-9A-Fa-f:]+\\](:[0-9]{1,5})?\$ ]]; then
		return 0
	fi
	echo "invalid AgentPulse base URL for a hook command: \$url" >&2
	return 1
}

# F246 (High, codex r2 D38; tightened by D39): mirrors bin/cli.ts — with no
# key, against a server that requires auth, refuse before writing any
# command hooks. Without this, an auth-enabled server silently 401s every
# hook fire forever: the detached shim discards curl's output on its
# synchronous path by design (D13), so the failure is invisible.
#
# D39: fails CLOSED, not open. A key always skips the probe. With no key,
# only an explicit disableAuth:true in the response lets the install
# proceed — an unreachable server, a non-JSON response, or JSON missing
# the field all refuse now, same as a real disableAuth:false. \$3=1
# (--no-auth-check) is the explicit escape hatch.
ap_check_auth_before_write() {
	local base="\$1" key="\$2" skip="\${3:-}" body
	if [[ -n "\$key" ]]; then
		return 0
	fi
	if [[ "\$skip" == "1" ]]; then
		return 0
	fi
	if body="\$(curl -sS -m 10 "\${base}/api/v1/auth/me" 2>/dev/null)" && printf '%s' "\$body" | python3 -c '
import json, sys
try:
    me = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if me.get("disableAuth") is True else 1)
'; then
		return 0
	fi
	echo "This server requires an API key; pass --key (or AGENTPULSE_KEY), or bypass this check if this server runs with auth disabled." >&2
	return 1
}

# F252 (Medium/High, xander D39 re-verify): the inline secret writers
# (hook-auth-header for Codex/Copilot, ~/.agentpulse/env) checked only the
# final path component for a symlink and called mkdir -p BEFORE checking
# — a symlinked ~/.agentpulse parent directory would let mkdir -p silently
# succeed and the secret land wherever the parent symlink points,
# unrefused. Ports F249's ordering: refuse if the parent is a symlink,
# THEN mkdir, THEN refuse if the file itself is a symlink, THEN the
# umask-077 temp write + mv. \$2 is the exact file content, including any
# trailing newline the caller wants — printf '%s' writes it verbatim, no
# extra formatting here.
#
# AGEN-21 (xander, High): the old \`tmp="\${path}.\$\$.tmp"\` is predictable —
# an attacker doesn't need to win any race, just pre-plant a symlink at
# every plausible PID's tmp name before the script ever runs; the old
# \`> "\$tmp"\` then follows straight through it. mktemp's XXXXXX suffix is
# unguessable and O_CREAT|O_EXCL under the hood (atomic — refuses if
# anything, symlink or not, already exists at that exact random path), so
# nothing can be pre-planted at it. The \`[ -L "\$tmp" ]\` check afterward and
# \`set -C\`'s noclobber are belt-and-suspenders, not the primary defense: an
# environment with no mktemp falls back to a PID+\$RANDOM name plus its own
# noclobber create-or-fail (uniqueness, not the atomicity mktemp gives).
ap_write_private_no_follow() {
	local path="\$1" content="\$2" dir tmp
	dir="\$(dirname -- "\$path")"
	if [ -L "\$dir" ]; then
		echo "refusing to write into a symlinked directory: \$dir" >&2
		return 1
	fi
	mkdir -p "\$dir"
	if [ -L "\$path" ]; then
		echo "refusing to write through a symlink: \$path" >&2
		return 1
	fi
	if command -v mktemp >/dev/null 2>&1; then
		tmp="\$(mktemp "\${dir}/.\$(basename -- "\$path").XXXXXX")" || {
			echo "refusing: could not create a private temp file in \$dir" >&2
			return 1
		}
	else
		tmp="\${dir}/.\$(basename -- "\$path").\$\$.\${RANDOM}\${RANDOM}.tmp"
		if ! ( umask 077 && set -C && : > "\$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a private temp file: \$tmp" >&2
			return 1
		fi
	fi
	if [ -L "\$tmp" ]; then
		echo "refusing to write through a symlink: \$tmp" >&2
		return 1
	fi
	if ! ( set -C && printf '%s' "\$content" >| "\$tmp" ); then
		echo "refusing: could not write private temp file: \$tmp" >&2
		rm -f -- "\$tmp" 2>/dev/null || true
		return 1
	fi
	mv -f -- "\$tmp" "\$path"
}

ap_hook_cmd() {
	# \$1=base \$2=direct(0/1) \$3=agent \$4=event
	local base="\$1" direct="\$2" agent="\$3" event="\$4"
	local marker="" call_with_header call_without_header body
	if [ "\$agent" = "codex_cli" ]; then
		marker='sid=\$(grep -o '\\''"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"'\\'' "\$t" | head -n1); sid=\${sid%\\"}; sid=\${sid##*\\"}; case "\$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ \${#sid} -le 128 ]; then mkdir -p "\$HOME/.agentpulse/codex-native" 2>/dev/null; : > "\$HOME/.agentpulse/codex-native/\$sid" 2>/dev/null; fi ;; esac; '
	fi
	call_with_header="curl -sS --max-time 2 -o /dev/null -X POST '\${base}/api/v1/hooks?event=\${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: \${agent}'"' -H "@\$f" --data-binary "@\$t"'
	call_without_header="curl -sS --max-time 2 -o /dev/null -X POST '\${base}/api/v1/hooks?event=\${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: \${agent}'"' --data-binary "@\$t"'
	if [ "\$direct" = "1" ]; then
		body="\$marker"'f="\$HOME/.agentpulse/hook-auth-header"; if [ -s "\$f" ]; then '"\$call_with_header"'; else '"\$call_without_header"'; fi; rm -f "\$t"'
	else
		body="\$marker""\$call_without_header"'; rm -f "\$t"'
	fi
	printf '%s' 't=\$(mktemp "\${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "\$t"; ( '"\$body"' ) </dev/null >/dev/null 2>&1 & exit 0'
}

ap_codex_hooks_json() {
	# \$1=base \$2=direct(0/1)
	local base="\$1" direct="\$2"
	local CODEX_EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop" "Interrupt" "SubagentStart" "SubagentStop" "PermissionRequest" "PreCompact" "PostCompact")
	local event
	{
		for event in "\${CODEX_EVENTS[@]}"; do
			printf '%s\\0%s\\0' "\$event" "\$(ap_hook_cmd "\$base" "\$direct" "codex_cli" "\$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"hooks": [{"type": "command", "command": cmd, "async": False, "timeout": 1}]}]
sys.stdout.write(json.dumps({"hooks": hooks}, indent=2) + "\\n")
'
}

ap_copilot_hooks_json() {
	# \$1=base \$2=direct(0/1)
	local base="\$1" direct="\$2"
	local COPILOT_EVENTS=("sessionStart" "sessionEnd" "userPromptSubmitted" "postToolUse" "postToolUseFailure" "agentStop" "subagentStart" "subagentStop" "preCompact" "errorOccurred")
	local event
	{
		for event in "\${COPILOT_EVENTS[@]}"; do
			printf '%s\\0%s\\0' "\$event" "\$(ap_hook_cmd "\$base" "\$direct" "copilot_cli" "\$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"type": "command", "bash": cmd, "timeoutSec": 5}]
sys.stdout.write(json.dumps({"version": 1, "hooks": hooks}, indent=2) + "\\n")
'
}

# F232 (xander, Medium): writes stdin to \$1 via a same-directory temp file +
# atomic rename, refusing a symlink at \$1 or at \$1's parent directory —
# never a plain \`>\` redirect or \`cp\`, both of which follow a symlink at the
# destination. Used for both a Codex hooks.json write and its timestamped
# backup (same primitive, different path).
#
# AGEN-21 (xander, High): same predictable-tmp-name fix as
# ap_write_private_no_follow above — mktemp's XXXXXX is unguessable and
# atomic (O_CREAT|O_EXCL), closing the pre-planted-symlink attack the old
# \`tmp="\${path}.\$\$.tmp"\` was open to. See that function's comment for the
# full rationale; not repeated here.
ap_write_no_follow() {
	local path="\$1" dir tmp
	if [ -L "\$path" ]; then
		echo "refusing to write through a symlink: \$path" >&2
		return 1
	fi
	dir="\$(dirname -- "\$path")"
	if [ -L "\$dir" ]; then
		echo "refusing to write into a symlinked directory: \$dir" >&2
		return 1
	fi
	if command -v mktemp >/dev/null 2>&1; then
		tmp="\$(mktemp "\${dir}/.\$(basename -- "\$path").XXXXXX")" || {
			echo "refusing: could not create a temp file in \$dir" >&2
			return 1
		}
	else
		tmp="\${dir}/.\$(basename -- "\$path").\$\$.\${RANDOM}\${RANDOM}.tmp"
		if ! ( umask 022 && set -C && : > "\$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a temp file: \$tmp" >&2
			return 1
		fi
	fi
	if [ -L "\$tmp" ]; then
		echo "refusing to write through a symlink: \$tmp" >&2
		return 1
	fi
	if ! ( set -C && cat >| "\$tmp" ); then
		echo "refusing: could not write temp file: \$tmp" >&2
		rm -f -- "\$tmp" 2>/dev/null || true
		return 1
	fi
	chmod 0644 "\$tmp"
	mv -f -- "\$tmp" "\$path"
}

# D13/F57: -H "@\$f" needs curl >= 7.55 (silently sends no auth below that).
# Only direct-mode sh installers call this — relay mode sends no auth header.
ap_require_curl_755() {
	local ver major minor rest
	ver="\$(curl --version 2>/dev/null | head -n1 | sed -nE 's/^curl ([0-9]+\\.[0-9]+\\.[0-9]+).*/\\1/p')"
	if [ -z "\$ver" ]; then
		echo "AgentPulse direct hooks need curl >= 7.55 (curl not found). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
	major="\${ver%%.*}"
	rest="\${ver#*.}"
	minor="\${rest%%.*}"
	if [ "\$major" -lt 7 ] || { [ "\$major" -eq 7 ] && [ "\$minor" -lt 55 ]; }; then
		echo "AgentPulse direct hooks need curl >= 7.55 (found \${ver}). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
}
# <<< agentpulse-hook-cmd

# F245: reject a malformed --url before any hook JSON generation.
ap_validate_hook_base_url "\$HOOK_URL" || exit 1

# F246: before any file writes, refuse if this server needs a key we don't have.
ap_check_auth_before_write "\$HOOK_URL" "\$API_KEY" "\$NO_AUTH_CHECK" || exit 1

echo ""
echo "  AgentPulse Setup"
echo "  ────────────────"
echo "  Hooks will point to: \$HOOK_URL"
echo ""

# ── Claude Code ──

CLAUDE_DIR="\$HOME/.claude"
CLAUDE_SETTINGS="\$CLAUDE_DIR/settings.json"

# F<new> (H2, F249 ordering): refuse a symlinked destination or its parent
# directory BEFORE mkdir -p even runs -- mkdir -p on an already-existing
# symlinked path is a silent no-op success, so the check has to come first,
# not after. settings.json holds other user settings we must preserve, so
# this can't just delegate to ap_write_no_follow (which overwrites wholesale).
if [[ -L "\$CLAUDE_DIR" ]]; then
  echo "  ✗ refusing to write into a symlinked directory: \$CLAUDE_DIR" >&2
  exit 1
fi
mkdir -p "\$CLAUDE_DIR"
if [[ -L "\$CLAUDE_SETTINGS" ]]; then
  echo "  ✗ refusing to write through a symlink: \$CLAUDE_SETTINGS" >&2
  exit 1
fi

EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

# AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
# \$AGENTPULSE_API_KEY from ITS OWN process environment, not the shell that
# launched Claude Code -- a GUI, IDE, or stale-terminal launch never sources
# ~/.agentpulse/env, so the env-var form 401s silently there. This route has
# no project-scope option (it always targets \$HOME), so a supplied key gets
# the literal, more-reliable form -- acceptable because settings.json is
# tightened to 0600 below (never world-readable). No key at all (an
# auth-disabled server) keeps the env-var/allowedEnvVars form, same as before.
HOOKS_JSON="{"
for i in "\${!EVENTS[@]}"; do
  EVENT="\${EVENTS[\$i]}"
  [[ \$i -gt 0 ]] && HOOKS_JSON+=","
  if [[ -n "\$API_KEY" ]]; then
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"headers\\":{\\"Authorization\\":\\"Bearer \$API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  else
    HOOKS_JSON+="\\"\$EVENT\\":[{\\"matcher\\":\\"\\",\\"hooks\\":[{\\"type\\":\\"http\\",\\"url\\":\\"\${HOOK_URL}/api/v1/hooks\\",\\"async\\":true,\\"allowedEnvVars\\":[\\"AGENTPULSE_API_KEY\\"],\\"headers\\":{\\"Authorization\\":\\"Bearer \\\$AGENTPULSE_API_KEY\\",\\"X-Agent-Type\\":\\"claude_code\\"}}]}]"
  fi
done
HOOKS_JSON+="}"

# F<new> (High, xander re-verify): a plain "\$CLAUDE_SETTINGS.tmp" redirect
# target is predictable -- a pre-planted symlink there would let either
# merge branch's write (carrying the literal key) follow it, and the
# following \`mv\` would turn settings.json ITSELF into that symlink; the
# trailing chmod 600 further down would then narrow the attacker's file,
# not ours. mktemp's unpredictable sibling name closes that. The
# immediate -L check is defense in depth against the (already
# vanishingly small) race between mktemp's own atomic create and this
# check. The python3 branch produces the merged JSON on stdout into that
# same hardened temp -- it never opens \$CLAUDE_SETTINGS for writing
# itself (Python's open(path, "w") has no O_NOFOLLOW equivalent here).
if [[ -f "\$CLAUDE_SETTINGS" ]] && command -v jq &>/dev/null; then
  AP_CLAUDE_TMP="\$(umask 077 && mktemp "\${CLAUDE_SETTINGS}.XXXXXX")" || {
    echo "  ✗ can't create a temp file for \$CLAUDE_SETTINGS" >&2
    exit 1
  }
  if [[ -L "\$AP_CLAUDE_TMP" ]]; then
    echo "  ✗ refusing to write through a symlinked temp file: \$AP_CLAUDE_TMP" >&2
    exit 1
  fi
  jq --argjson hooks "\$HOOKS_JSON" '.hooks = (.hooks // {}) * \$hooks' "\$CLAUDE_SETTINGS" > "\$AP_CLAUDE_TMP"
  mv -f "\$AP_CLAUDE_TMP" "\$CLAUDE_SETTINGS"
elif [[ -f "\$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
  AP_CLAUDE_TMP="\$(umask 077 && mktemp "\${CLAUDE_SETTINGS}.XXXXXX")" || {
    echo "  ✗ can't create a temp file for \$CLAUDE_SETTINGS" >&2
    exit 1
  }
  if [[ -L "\$AP_CLAUDE_TMP" ]]; then
    echo "  ✗ refusing to write through a symlinked temp file: \$AP_CLAUDE_TMP" >&2
    exit 1
  fi
  python3 -c "
import json, sys
with open('\$CLAUDE_SETTINGS') as f: s = json.load(f)
h = json.loads('''\$HOOKS_JSON''')
s.setdefault('hooks', {}).update(h)
json.dump(s, sys.stdout, indent=2)
" > "\$AP_CLAUDE_TMP"
  mv -f "\$AP_CLAUDE_TMP" "\$CLAUDE_SETTINGS"
else
  echo '{"hooks":'\$HOOKS_JSON'}' > "\$CLAUDE_SETTINGS"
fi
# H2: a supplied key means the literal form above, so settings.json is
# tightened to owner-only -- never world-readable. No key: env-var form
# only, so the file's mode is left exactly as it was before this write.
if [[ -n "\$API_KEY" && -f "\$CLAUDE_SETTINGS" ]]; then
  chmod 600 "\$CLAUDE_SETTINGS"
fi
echo "  ✓ Claude Code hooks configured"

# ── Codex CLI ──

# D13/F57: below curl 7.55, -H "@\$f" silently sends no auth header at all.
ap_require_curl_755

# D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
# \$CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
CODEX_DIR="\${CODEX_HOME:-\$HOME/.codex}"
mkdir -p "\$CODEX_DIR"

if [[ -n "\$API_KEY" ]]; then
  # F207/F252: never write through a symlink at the destination or its
  # parent directory — see ap_write_private_no_follow above.
  AP_AUTH_HEADER_FILE="\$HOME/.agentpulse/hook-auth-header"
  printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\\n' "\$API_KEY"
  ap_write_private_no_follow "\$AP_AUTH_HEADER_FILE" "\$AP_AUTH_HEADER_CONTENT" || exit 1
fi

NEW_CODEX_HOOKS_JSON="\$(ap_codex_hooks_json "\$HOOK_URL" "1")"
if [[ -f "\$CODEX_DIR/hooks.json" ]] && [[ "\$(cat "\$CODEX_DIR/hooks.json")" == "\$NEW_CODEX_HOOKS_JSON" ]]; then
  echo "  ✓ Codex hooks unchanged — no re-trust needed"
else
  if [[ -f "\$CODEX_DIR/hooks.json" ]]; then
    CODEX_BACKUP_FILE="\$CODEX_DIR/hooks.json.agentpulse-bak.\$(date -u +%Y%m%dT%H%M%SZ)"
    cat "\$CODEX_DIR/hooks.json" | ap_write_no_follow "\$CODEX_BACKUP_FILE" || exit 1
    echo "  ✓ Backed up existing Codex hooks to \$CODEX_BACKUP_FILE"
  fi
  printf '%s\\n' "\$NEW_CODEX_HOOKS_JSON" | ap_write_no_follow "\$CODEX_DIR/hooks.json" || exit 1
  echo "  ✓ Codex CLI hooks configured"
  echo "    Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
  echo "    Re-trust after changing the AgentPulse URL or port."
fi
# D12: codex_hooks is a deprecated (but still-working) legacy alias for
# [features].hooks — left alone if present, never newly written.

# ── Copilot CLI (F247, codex r2 D38) ──
# D8: only write into a real Copilot install — never create config for a
# tool that isn't there. hook-auth-header is reused from the Codex section
# above (same file, same key) — nothing new to write for it here.

if command -v copilot >/dev/null 2>&1 || [[ -d "\$HOME/.copilot" ]]; then
  COPILOT_DIR="\$HOME/.copilot/hooks"
  COPILOT_HOOKS_FILE="\$COPILOT_DIR/agentpulse.json"
  mkdir -p "\$COPILOT_DIR"

  NEW_COPILOT_HOOKS_JSON="\$(ap_copilot_hooks_json "\$HOOK_URL" "1")"
  if [[ -f "\$COPILOT_HOOKS_FILE" ]] && [[ "\$(cat "\$COPILOT_HOOKS_FILE")" == "\$NEW_COPILOT_HOOKS_JSON" ]]; then
    echo "  ✓ Copilot hooks unchanged"
  else
    if [[ -f "\$COPILOT_HOOKS_FILE" ]]; then
      COPILOT_BACKUP_FILE="\${COPILOT_HOOKS_FILE}.agentpulse-bak.\$(date -u +%Y%m%dT%H%M%SZ)"
      cat "\$COPILOT_HOOKS_FILE" | ap_write_no_follow "\$COPILOT_BACKUP_FILE" || exit 1
      echo "  ✓ Backed up existing Copilot hooks to \$COPILOT_BACKUP_FILE"
    fi
    printf '%s\\n' "\$NEW_COPILOT_HOOKS_JSON" | ap_write_no_follow "\$COPILOT_HOOKS_FILE" || exit 1
    echo "  ✓ Copilot CLI hooks configured in \$COPILOT_HOOKS_FILE"
  fi
fi

# ── Env vars (D37/F243) ──
#
# Claude Code is always configured by this script, so this always applies
# (unlike scripts/setup-hooks.sh, which is --agent-scoped and skips this
# entirely for codex_cli/copilot_cli). Formerly appended the key in
# plaintext to the rc file, which is world-readable by default on many
# systems — now written to a 0600 ~/.agentpulse/env instead, with only a
# key-free, idempotent source line in the rc file.

if [[ -n "\$API_KEY" ]]; then
  PROFILE="\$HOME/.zshrc"
  [[ "\$(basename "\$SHELL")" == "bash" ]] && PROFILE="\$HOME/.bashrc"

  if grep -q "^export AGENTPULSE_API_KEY=" "\$PROFILE" 2>/dev/null; then
    echo "  ! \$PROFILE already has a plaintext AGENTPULSE_API_KEY export from an" >&2
    echo "    earlier install. Leaving it, but it's world-readable by default on" >&2
    echo "    many systems — remove it by hand:" >&2
    echo "      sed -i.bak '/^export AGENTPULSE_API_KEY=/d' \\"\$PROFILE\\"" >&2
  fi

  AP_ENV_FILE="\$HOME/.agentpulse/env"
  printf -v AP_ENV_CONTENT 'export AGENTPULSE_API_KEY="%s"\\nexport AGENTPULSE_URL="%s"\\n' \\
      "\$API_KEY" "\$HOOK_URL"
  ap_write_private_no_follow "\$AP_ENV_FILE" "\$AP_ENV_CONTENT" || exit 1
  echo "  ✓ Wrote AGENTPULSE_API_KEY/AGENTPULSE_URL to \$AP_ENV_FILE (0600)"

  AP_SOURCE_LINE='[ -f "\$HOME/.agentpulse/env" ] && . "\$HOME/.agentpulse/env"'
  if ! grep -qF "\$AP_SOURCE_LINE" "\$PROFILE" 2>/dev/null; then
    echo "" >> "\$PROFILE"
    echo "# AgentPulse (key lives in ~/.agentpulse/env, not here)" >> "\$PROFILE"
    echo "\$AP_SOURCE_LINE" >> "\$PROFILE"
    echo "  ✓ Added a source line for ~/.agentpulse/env to \$PROFILE"
  fi
fi

# ── Verify ──

if curl -sf "\$HOOK_URL/api/v1/health" >/dev/null 2>&1; then
  echo "  ✓ Server reachable"
else
  echo "  ! Server not reachable at \$HOOK_URL"
fi

echo ""
echo "  Done! Open a new terminal and start a Claude Code or Codex session."
echo ""
`;

	return scriptResponse(script, "setup.sh");
});

// GET /install-local.sh - Serve the local Bun+SQLite installer
// Usage: curl -sSL http://localhost:3000/install-local.sh | bash
setup.get("/install-local.sh", (c) => {
	const url = resolveLocalHookBaseUrl(c.req.header("Host"));
	return scriptResponse(
		INSTALLER_SOURCES.installLocalSh.replace('PUBLIC_URL=""', () => `PUBLIC_URL="${url}"`),
		"install-local.sh",
	);
});

// GET /install-local.ps1 - Serve the local Bun+SQLite installer for Windows
// Usage: irm http://localhost:3000/install-local.ps1 | iex
setup.get("/install-local.ps1", (c) => {
	const url = resolveLocalHookBaseUrl(c.req.header("Host"));
	return scriptResponse(
		INSTALLER_SOURCES.installLocalPs1.replace(
			'[string]$PublicUrl = ""',
			() => `[string]$PublicUrl = "${url}"`,
		),
		"install-local.ps1",
	);
});

// GET /setup-relay.sh - One-command relay setup for machines whose agents
// report to a remote AgentPulse server.
// Usage: curl -sSL https://your-server.com/setup-relay.sh | bash
setup.get("/setup-relay.sh", (c) => {
	const server = resolvePublicServerUrl(c.req.header("Host"));
	if (!server.ok) return installerError(server.error);
	const built = buildRelayInstaller(INSTALLER_SOURCES, server.url);
	if (!built.ok) {
		console.error(`[setup] relay installer unavailable: ${built.reason}`);
		return installerError("installer_unavailable");
	}
	return scriptResponse(built.script, "setup-relay.sh");
});

export { setup };
