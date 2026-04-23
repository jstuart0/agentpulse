export interface FilterResult {
	allowed: boolean;
	/** Human-readable reason for the trip, shown in the UI + audit event. */
	reason?: string;
	/** Rule name that matched; stable identifier for telemetry. */
	rule?: string;
}

export interface DispatchRule {
	name: string;
	/** Matched case-insensitively against the outgoing nextPrompt. */
	pattern: RegExp;
}

// Baseline deny-list for outgoing watcher-generated prompts. Trips here
// convert a `continue` decision to a HITL request regardless of policy;
// the human has to explicitly approve anything caught here.
export const DEFAULT_RULES: DispatchRule[] = [
	{ name: "rm_rf_root", pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(?!\w)/i },
	{ name: "rm_rf_home", pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+[~$]/i },
	{ name: "rm_rf_star", pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\*/i },
	// Pipe-to-shell from network. Catches curl|sh, wget|sh, any-command|bash.
	{
		name: "pipe_to_shell",
		pattern: /\b(?:curl|wget|fetch)\s[^\n|]+\|\s*(?:sh|bash|zsh|python\d?)\b/i,
	},
	// Base64-decode piped to shell.
	{ name: "base64_to_shell", pattern: /\bbase64\s+-d[^\n|]*\|\s*(?:sh|bash|zsh)\b/i },
	// Disk destruction (mkfs has subcommands like mkfs.ext4, mkfs.xfs).
	{ name: "disk_destroy", pattern: /\b(?:dd|mkfs(?:\.[a-z0-9]+)?|shred)\s+/i },
	// Writing to system config paths.
	{ name: "write_etc", pattern: />\s*\/etc\//i },
	{ name: "write_root", pattern: />\s*\/(?:boot|lib|bin|sbin|usr)\//i },
	// Credential exfiltration.
	{ name: "dump_env", pattern: /\b(?:env|printenv|set)\s*(?:\|\s*(?:curl|wget|nc)|>\s*\/)/i },
	{ name: "read_ssh", pattern: /\b(?:cat|base64|tar|cp|mv)\s+[^\n]*\.ssh\b/i },
	{ name: "read_aws", pattern: /\b(?:cat|base64|tar|cp|mv)\s+[^\n]*\.aws\b/i },
	{ name: "history_delete", pattern: /\bhistory\s+-c\b/i },
	// Destructive git operations the watcher should never initiate unprompted.
	{
		name: "git_force_push_main",
		pattern: /\bgit\s+push\s+(?:[^\n]*\s)?-f[^\n]*\s(?:main|master)\b/i,
	},
	{ name: "git_reset_hard_remote", pattern: /\bgit\s+reset\s+--hard\s+origin\//i },
	// DB destruction.
	{ name: "drop_database", pattern: /\bDROP\s+(?:DATABASE|TABLE)\b/i },
	{ name: "truncate_table", pattern: /\bTRUNCATE\s+(?:TABLE\s+)?\w/i },
];

const MAX_LENGTH_CHARS = 4000;

/**
 * Check an outgoing continuation prompt against the deny-list and length cap.
 * Runs fast; meant to sit right before control-action dispatch.
 */
export function checkDispatch(nextPrompt: string, extraRules: DispatchRule[] = []): FilterResult {
	if (typeof nextPrompt !== "string") {
		return { allowed: false, reason: "Prompt is not a string", rule: "invalid_input" };
	}
	if (!nextPrompt.trim()) {
		return { allowed: false, reason: "Prompt is empty", rule: "empty_prompt" };
	}
	if (nextPrompt.length > MAX_LENGTH_CHARS) {
		return {
			allowed: false,
			reason: `Prompt exceeds ${MAX_LENGTH_CHARS} chars (${nextPrompt.length})`,
			rule: "length_cap",
		};
	}
	for (const rule of [...DEFAULT_RULES, ...extraRules]) {
		if (rule.pattern.test(nextPrompt)) {
			return {
				allowed: false,
				reason: `Matched safety rule: ${rule.name}`,
				rule: rule.name,
			};
		}
	}
	return { allowed: true };
}
