/**
 * Phase 5 (D12/D13, F35/F36): pure helpers behind SetupPage's per-agent auth
 * step, the Codex numbered step list, and the "last Codex/Copilot event"
 * line (D22). Kept side-effect-free and DOM-free so they're unit-testable
 * without rendering the page — see setup-steps.test.ts.
 */

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

function singleQuote(value: string): string {
	// Keys are opaque tokens (ap_...) with no embedded quotes in practice;
	// still guard against breaking out of the single-quoted shell literal.
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * D13: per-agent auth step. `disableAuth: true` renders no step at all —
 * there's nothing to save when the server doesn't check keys.
 */
export const AUTH_STEP: Record<
	SetupAgentType,
	(key: string, disableAuth: boolean) => AuthStep | null
> = {
	claude_code: (key, disableAuth) => {
		if (disableAuth) return null;
		return {
			title: "Set Environment Variable",
			description: "Add this to your shell profile (~/.zshrc or ~/.bashrc):",
			command: `export AGENTPULSE_API_KEY="${key || "YOUR_API_KEY"}"`,
		};
	},
	codex_cli: (key, disableAuth) => buildCommandHookAuthStep(key, disableAuth),
	copilot_cli: (key, disableAuth) => buildCommandHookAuthStep(key, disableAuth),
};

function buildCommandHookAuthStep(key: string, disableAuth: boolean): AuthStep | null {
	if (disableAuth) return null;
	const value = key || "YOUR_API_KEY";
	return {
		title: "Save your key for command hooks",
		description:
			"Command hooks read the key from a file, not an environment variable — this keeps it out of process listings and shell history.",
		command: `mkdir -p ~/.agentpulse && (umask 077 && printf 'Authorization: Bearer %s\\n' ${singleQuote(value)} > ~/.agentpulse/hook-auth-header)`,
		windowsCommand: `\$d="\$env:USERPROFILE\\.agentpulse"; New-Item -ItemType Directory -Force \$d | Out-Null; \$f="\$d\\hook-auth-header"; Set-Content -NoNewline -Path \$f -Value "Authorization: Bearer ${value}\`n"; icacls \$f /inheritance:r /grant:r "\${env:USERNAME}:(R,W)" | Out-Null`,
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
		"Open Codex and run `/hooks`, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Re-trust if you change the AgentPulse URL or port.",
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
