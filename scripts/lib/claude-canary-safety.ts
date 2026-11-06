/**
 * The rules a live Claude canary keeps (AGEN-117, phase 0), as code, so a CI test with no Claude can hold them.
 * They mirror the Codex canary's (`codex-canary-safety.ts`), after the 2026-11-05 incident in which a mutation
 * run SIGTERMed the person's relay, supervisor and Claude sessions.
 *
 *  1. Claude runs only with a throwaway `HOME` and `CLAUDE_CONFIG_DIR` strictly inside a scratch directory:
 *     never unset, relative, the person's home, `~/.claude`, `~/.claude.json`, `~/.agentpulse` or `~/.codex`,
 *     a sibling that shares a prefix, or a path that reaches them through a link.
 *  2. Only `scripts/lib/claude-canary-spawn.ts` starts Claude. It builds the child's environment from an
 *     allowlist (nothing inherited by accident: no parent-session markers, no stray credentials) and allows only
 *     argvs that cap spend and start no terminal interface.
 *  3. Nothing is killed by name. A process is signalled by a pid this run started, or one whose own environment
 *     names this run's exact CLAUDE_CONFIG_DIR (`lib/own-pids.ts`).
 *  4. A credential is only ever in the child's environment: never argv, never a log (`redactKey`).
 *  5. `/tmp/cc-socks` (the peer sockets each Claude creates outside the scratch directory) is scrubbed for
 *     this run's own dead pids only.
 *
 * The scan is an advisory tripwire for accidents; what holds the line is the run-time checks.
 */
import { join } from "node:path";
import { stripComments } from "./codex-canary-safety.js";
import { assertThrowawayHome } from "./throwaway-home.js";

export const CLAUDE_SPAWN_ALLOWED_FILES = ["scripts/lib/claude-canary-spawn.ts"];
export const CLAUDE_RULES_FILE = "scripts/lib/claude-canary-safety.ts";

/** What a canary must never reach: the person's own state, and anything above it. */
export function realClaudePaths(realHome: string): string[] {
	return [
		realHome,
		join(realHome, ".claude"),
		join(realHome, ".claude.json"),
		join(realHome, ".agentpulse"),
		join(realHome, ".codex"),
	];
}

export function assertThrowawayClaudeHome(
	name: "HOME" | "CLAUDE_CONFIG_DIR",
	value: string | undefined,
	scratchRoot: string,
	realHome: string,
): string {
	return assertThrowawayHome({
		name,
		value,
		scratchRoot,
		forbidden: realClaudePaths(realHome),
		forbiddenLabel: "the real home or one of its Claude, AgentPulse or Codex paths",
	});
}

export interface ClaudeFinding {
	rule: "claude-spawn" | "kill-by-name";
	path: string;
	detail: string;
}

/** Files a Claude canary is made of: scanned for ways to signal a process by name or a command substitution. */
export const isClaudeCanaryFile = (path: string): boolean =>
	/^scripts\/(lib\/)?claude-[\w-]+\.(ts|mjs|js|sh)$/.test(path) && path !== CLAUDE_RULES_FILE;

export function scanClaudeText(path: string, raw: string): ClaudeFinding[] {
	if (path === CLAUDE_RULES_FILE || /\.test\.ts$/.test(path)) return [];
	const text = stripComments(raw);
	const findings: ClaudeFinding[] = [];
	if (!CLAUDE_SPAWN_ALLOWED_FILES.includes(path)) {
		const spawn =
			/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`][^"'`]*\bclaude["'`]|Bun\.spawn(?:Sync)?\(\s*\[\s*["'`][^"'`]*\bclaude["'`]|\bspawn\w*\([^)]*\[\s*["'`][^"'`]*\bclaude["'`]/;
		const m = spawn.exec(text);
		if (m) findings.push({ rule: "claude-spawn", path, detail: m[0] });
	}
	if (isClaudeCanaryFile(path)) {
		const byName =
			/\bpkill\b|\bkillall\b|xargs\s+kill|kill\s+(?:-\w+\s+)?\$\(|kill\s+(?:-\w+\s+)?`/;
		const m = byName.exec(text);
		if (m) findings.push({ rule: "kill-by-name", path, detail: m[0] });
	}
	return findings;
}

/** Replaces the key, and its last 20 characters (the tail a truncated log can still carry), with placeholders. */
export function redactKey(text: string, key: string | undefined): string {
	if (!key) return text;
	let out = text.split(key).join("<KEY>");
	if (key.length > 20) out = out.split(key.slice(-20)).join("<SFX>");
	return out;
}
