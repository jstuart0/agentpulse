/**
 * Phase 5 (D12/D13, F35/F36): pure helpers behind SetupPage's per-agent auth
 * step, the Codex numbered step list, and the "last Codex/Copilot event"
 * line (D22). Kept side-effect-free and DOM-free so they're unit-testable
 * without rendering the page — see setup-steps.test.ts.
 */

import { withHiddenKey } from "./hidden-key-prompt.js";

/** SetupPage's agent radiogroup already covers claude_code/codex_cli; this
 * table also serves copilot_cli ahead of Phase 6/7's onboarding UI, per D13's
 * "both agents share this shape." Not the same union as shared/constants.ts's
 * AgentType — that one gains "copilot_cli" only in Phase 6. */
export type SetupAgentType = "claude_code" | "codex_cli" | "copilot_cli";

export interface AuthStep {
	title: string;
	/** Body text shown above the command block(s). */
	description: string;
	/** POSIX sh command (macOS/Linux tab, or the only command for claude_code). */
	command: string;
	/** PowerShell equivalent — only present for codex_cli/copilot_cli (F56). */
	windowsCommand?: string;
	/** e.g. "requires curl 7.55+ (`curl --version`)". */
	note?: string;
}

/**
 * AGEN-49: every POSIX-sh auth step below reads the key at a hidden prompt
 * (see hidden-key-prompt.ts; portable to dash, unlike `read -s`) instead of
 * embedding it literally in the copy-paste command —
 * same principle as onboarding.ts's buildLocalCommand/buildRelayCommand. The
 * `key` parameter each AUTH_STEP entry still takes is unused on the POSIX
 * side as a result; codex_cli/copilot_cli's windowsCommand still embeds it
 * (PowerShell auth step, out of this fix's scope — tracked separately).
 */

/**
 * D13: per-agent auth step. `disableAuth: true` renders no step at all —
 * there's nothing to save when the server doesn't check keys.
 */
export const AUTH_STEP: Record<
	SetupAgentType,
	(key: string, disableAuth: boolean) => AuthStep | null
> = {
	claude_code: (_key, disableAuth) => {
		if (disableAuth) return null;
		// Same safe-write ordering as hook-auth-header below (parent symlink
		// check, mkdir, file symlink check, umask 077 temp file, then mv) —
		// but targeting ~/.agentpulse/env, plus an idempotent key-free source
		// line in the shell profile. Never the rc file directly: that's
		// world-readable by default, the exposure D37/F243 already fixed for
		// every other writer of this key.
		const writeEnv = `d=~/.agentpulse; f="$d/env"; if [ -L "$d" ]; then echo "refusing to write into a symlinked directory: $d" >&2; false; elif ! mkdir -p "$d" 2>/dev/null; then echo "can't create $d" >&2; false; elif [ -L "$f" ]; then echo "refusing to write through a symlink: $f" >&2; false; else t="$f.$$.tmp" && (umask 077 && printf 'export AGENTPULSE_API_KEY="%s"\\n' "$key" > "$t") && mv -f "$t" "$f"; fi && { p=~/.zshrc; [ "$(basename "$SHELL")" = bash ] && p=~/.bashrc; s='[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"'; grep -qF "$s" "$p" 2>/dev/null || printf '\\n# AgentPulse (key lives in ~/.agentpulse/env, not here)\\n%s\\n' "$s" >> "$p"; }`;
		const command = withHiddenKey("key", writeEnv, "nothing was saved.");
		return {
			title: "Save your key as an environment variable",
			description:
				"Run this in your terminal — it asks for the key (input hidden), writes it to ~/.agentpulse/env (mode 600, not world-readable), and adds a key-free source line to your shell profile (~/.zshrc or ~/.bashrc).",
			command,
		};
	},
	codex_cli: (key, disableAuth) => buildCommandHookAuthStep(key, disableAuth),
	copilot_cli: (key, disableAuth) => buildCommandHookAuthStep(key, disableAuth),
};

function buildCommandHookAuthStep(_key: string, disableAuth: boolean): AuthStep | null {
	if (disableAuth) return null;
	// F207: never write through a symlink at the destination — write to a
	// sibling temp file (umask 077 -> 0600 on create), then atomically
	// replace the destination via mv (rename(2) replaces the directory
	// entry itself; it doesn't follow a symlink there). Mirrors
	// scripts/setup-hooks.sh's hardened write.
	// F249 (codex r2 D38): the original version here only checked the
	// final component (hook-auth-header itself) for a symlink, not the
	// ~/.agentpulse parent directory — a symlinked parent would still let
	// `mkdir -p` silently succeed and the key land wherever the parent
	// symlink points. Checked first, before mkdir -p even runs (mkdir -p
	// on an already-existing symlinked path is a silent no-op success, so
	// the check has to come before it, not after).
	// AGEN-49: the key is read at a hidden prompt (see hidden-key-prompt.ts), never embedded literally in this command's text.
	const writeHeader = `d=~/.agentpulse; f="$d/hook-auth-header"; if [ -L "$d" ]; then echo "refusing to write into a symlinked directory: $d" >&2; false; elif ! mkdir -p "$d" 2>/dev/null; then echo "can't create $d" >&2; false; elif [ -L "$f" ]; then echo "refusing to write through a symlink: $f" >&2; false; else t="$f.$$.tmp" && (umask 077 && printf 'Authorization: Bearer %s\\n' "$key" > "$t") && mv -f "$t" "$f"; fi`;
	const command = withHiddenKey("key", writeHeader, "nothing was saved.");
	// F208: narrow the parent directory's ACL to the current user *before*
	// creating the file inside it, so the file inherits a private ACL from
	// the moment it exists — a Set-Content-then-icacls-the-file sequence
	// leaves a window where a newly (over)written file briefly holds the
	// directory's broader, inherited ACL. The file-level icacls stays too,
	// for idempotent hardening of a file that pre-dates this fix.
	// F249: Set-Content alone had no reparse-point check at all and wrote
	// in place rather than via a temp-file-then-move replace. Now checks
	// both the parent directory and the file for a reparse point (symlink
	// or junction — .LinkType alone misses a mount point, which carries
	// only the ReparsePoint attribute) and writes through a same-directory
	// temp file + Move-Item, mirroring install-local.ps1's
	// Test-ApReparsePoint/Write-ApFileNoFollow.
	// AGEN-49: the key is read via Read-Host -AsSecureString (input hidden,
	// never a command argument) and converted to plaintext in memory via
	// SecureStringToBSTR/PtrToStringBSTR, then ZeroFreeBSTR frees the
	// unmanaged copy — no install-local.ps1 precedent existed for this
	// (it takes -ApiKey as a plaintext parameter already), so this is new.
	// Also adds the hard-link check install-local.ps1's own
	// Test-ApMultipleHardLinks/New-ApHookAuthHeaderFile pair already has
	// but this displayed snippet didn't — same reparse-point, hard-link,
	// and user-only-ACL ordering as that function: parent reparse check,
	// mkdir, ACL-narrow the directory, then (for the file) hard-link
	// check, reparse check, write, ACL-narrow the file.
	const windowsCommand = `$secure = Read-Host -Prompt 'AgentPulse API key' -AsSecureString; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); function ApTestReparse($p) { $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if (-not $i) { return $false }; if ($i.LinkType) { return $true }; return [bool]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) }; function ApTestHardLink($p) { if (-not (Test-Path -LiteralPath $p)) { return $false }; try { $o = & fsutil hardlink list $p 2>$null; if ($LASTEXITCODE -ne 0 -or -not $o) { return $false }; return (@($o | Where-Object { $_.Trim().Length -gt 0 }).Count -gt 1) } catch { return $false } }; $d="$env:USERPROFILE\\.agentpulse"; if (ApTestReparse $d) { Write-Error "refusing to write through a reparse point: $d" } else { New-Item -ItemType Directory -Force $d | Out-Null; icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null; $f="$d\\hook-auth-header"; if (ApTestHardLink $f) { Write-Error "refusing to write through a multiply-linked file: $f" } elseif (ApTestReparse $f) { Write-Error "refusing to write through a reparse point: $f" } else { $t="$f.$([guid]::NewGuid().ToString('N')).tmp"; Set-Content -NoNewline -Path $t -Value "Authorization: Bearer $key\`n"; Move-Item -Force -Path $t -Destination $f; icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } }; $key = $null`;
	return {
		title: "Save your key for command hooks",
		description:
			"Run this in your terminal — it asks for the key (input hidden) and writes it to a file, not an environment variable, which keeps it out of process listings and shell history.",
		command,
		windowsCommand,
		note: "requires curl 7.55+ (`curl --version`). Automated alternative: install-local.ps1.",
	};
}

/**
 * D12: the 4 numbered Codex setup steps (SetupPage Codex card), as literal
 * copy — see the plan's Phase 5 "Where" (F36). Item 4 is the D22 "Last Codex
 * event / No Codex events yet" line; callers compute it with lastEventLine()
 * (it needs runtime data this pure function doesn't have) and pass it in.
 */
export function codexSetupSteps(lastEventLineText: string): string[] {
	return [
		"Back up your existing file first (`cp ~/.codex/hooks.json ~/.codex/hooks.json.bak`), then replace `~/.codex/hooks.json` with this file. The old AgentPulse `http` hook format no longer loads on Codex 0.145+.",
		"Save your key header (see the auth step below).",
		"Open Codex and run `/hooks`, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Approve them again after an update changes the hook command, or if you change the AgentPulse URL or port.",
		lastEventLineText,
	];
}

export interface LastEventLineInput {
	at: string | null;
	cwd?: string | null;
	/** D22, SPIKE fact 6: codex exec never writes the index — the
	 * hooks_not_firing signal is TUI-only. */
	execIndexed?: boolean;
}

const TUI_SCOPE_NOTE = "detected from interactive Codex sessions only";

/** Relative-time formatting shared with the rest of the dashboard's "Xm ago" style. */
function relativeFrom(at: string): string {
	const ms = Date.now() - Date.parse(at);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function basename(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * D22/F36/r3(F56): "Last Codex event: 3 min ago · in <basename(cwd)>", or,
 * with no events yet, the "run /hooks" nudge — plus the TUI-scope wording
 * when the D22 signal can't be evidence-based for headless-only usage.
 */
export function lastEventLine(input: LastEventLineInput): string {
	if (input.at) {
		const suffix = input.cwd ? ` · in ${basename(input.cwd)}` : "";
		return `Last Codex event: ${relativeFrom(input.at)}${suffix}`;
	}
	const base =
		"No Codex events yet — after installing, open Codex and run `/hooks` to trust the AgentPulse hooks.";
	return input.execIndexed === false ? `${base} (${TUI_SCOPE_NOTE})` : base;
}

/**
 * The Setup page's "Exclude directories" card, FirstRunWelcome's link to it,
 * and the two sentences around the Claude config and the relay. What each
 * sender row says is what the code does: the hook command (Codex, Copilot), the
 * relay (Claude through it) and the supervisor (launched sessions, the Codex
 * observer) apply the rules; Claude Code posting straight to the server applies
 * only the skip variable. Nothing about the PowerShell versions has been run on
 * Windows, so the card says so.
 */

export interface ExcludeSenderRow {
	sender: string;
	applies: string;
	/** Rendered as the amber note: this sender is NOT covered by path rules. */
	caution?: boolean;
}

export interface ExcludeCommand {
	label: string;
	command: string;
}

export const EXCLUDE_RULES_PATH = "~/.agentpulse/exclude";

export const EXCLUDE_CARD_ANCHOR = "exclude-directories";

export const EXCLUDE_CARD: {
	title: string;
	intro: string;
	commands: ExcludeCommand[];
	senders: ExcludeSenderRow[];
	windowsNote: string;
	newEventsNote: string;
	teamNote: string;
} = {
	title: "Exclude directories",
	intro: `Stop sessions in chosen directories from being reported. Rules live in ${EXCLUDE_RULES_PATH} on each machine.`,
	commands: [
		{ label: "Exclude a directory", command: "agentpulse exclude add ~/scratch" },
		{ label: "Check what is excluded here", command: "agentpulse exclude check" },
	],
	senders: [
		{
			sender: "Codex CLI, Copilot CLI",
			applies:
				"The hook command checks the rules before anything is sent. If the rules file can't be read or trusted, nothing is sent. AGENTPULSE_SKIP=1 skips one run.",
		},
		{
			sender: "Claude Code through the relay",
			applies:
				"The relay on that machine checks the rules before anything is stored or passed on, and sends nothing while the rules file is invalid. AGENTPULSE_SKIP=1 skips one run.",
		},
		{
			sender: "Sessions AgentPulse launches, and the Codex observer",
			applies:
				"The supervisor on that machine applies the rules. A launch into an excluded directory is refused. The supervisor doesn't see AGENTPULSE_SKIP; the directory rules are what cover these.",
		},
		{
			sender: "Claude Code straight to the server",
			applies:
				"Path rules are not applied on this machine, and a broken rules file doesn't stop it. Use the relay, or set AGENTPULSE_SKIP=1. With the skip variable the request still reaches the server, which discards it.",
			caution: true,
		},
	],
	windowsNote:
		"Windows (PowerShell): not yet tested on Windows. Don't rely on exclude rules there.",
	newEventsNote:
		"Rules apply to new events. Sessions already reported stay on the dashboard until you delete them.",
	teamNote:
		"Rules stay on each machine and aren't visible to admins or other members. The one thing a supervisor reports is that its exclude file or its saved exclude state has an error. Run agentpulse exclude check on that machine.",
};

export const CLAUDE_SKIP_LINE =
	"X-AgentPulse-Skip lets you turn reporting off for one run: AGENTPULSE_SKIP=1 claude. Events from that run are discarded, not stored.";

export const RELAY_PARAGRAPH =
	"On another machine, install a small relay. It keeps your key out of agent config, queues events when the server is unreachable, and applies your exclude rules before anything is sent. It runs as a login service, points Claude Code and Codex CLI at it, and installs the statusline. Re-run it anytime to update.";

export const FIRST_RUN_EXCLUDE_LINK = {
	lead: "Working somewhere you don't want reported?",
	linkText: "Exclude a directory.",
	to: `/setup#${EXCLUDE_CARD_ANCHOR}`,
};
