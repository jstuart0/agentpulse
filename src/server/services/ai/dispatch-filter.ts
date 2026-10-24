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
	// The same removals with the flags split apart (`rm -r -f /`, `rm --recursive --force ~`).
	{
		name: "rm_split_flags",
		pattern: /\brm\s+(?:-[a-z-]+\s+){1,5}(?:\/(?!\w)|~|\$HOME\b|\*)/i,
	},
	// The same removals with the target quoted (`rm -rf "/"`, `rm -rf "$HOME"`, `rm -rf '~'`).
	{
		name: "rm_quoted_target",
		pattern: /\brm\s+(?:-[a-z-]+\s+){1,5}["'](?:\/|~|\$HOME|\$\{HOME\}|\*)["'](?=\s|$|[;&|])/i,
	},
	// Pipe-to-shell from network. Catches curl|sh, wget|sh, any-command|bash.
	{
		name: "pipe_to_shell",
		pattern: /\b(?:curl|wget|fetch)\s[^\n|]+\|\s*(?:sh|bash|zsh|python\d?)\b/i,
	},
	// Running a download without a pipe: `bash <(curl ...)`, `sh -c "$(curl ...)"`, `eval "$(wget ...)"`.
	{
		name: "shell_runs_download",
		pattern:
			/(?:<\(\s*(?:curl|wget|fetch)\b|\b(?:sh|bash|zsh|eval|source)\b[^\n]*(?:\$\(|`)\s*(?:curl|wget|fetch)\b)/i,
	},
	// The same with a privilege escalation in between (`curl x | sudo sh`).
	{ name: "pipe_to_sudo_shell", pattern: /\|\s*sudo\s+(?:-\S+\s+)*(?:sh|bash|zsh)\b/i },
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
	// A credential file read straight into a network tool.
	{
		name: "exfil_credentials_pipe",
		pattern:
			/\b(?:cat|base64|tar)\s+[^\n|]*(?:\.npmrc|\.netrc|\.pypirc|\.env\b|id_rsa|\.git-credentials)[^\n]*\|\s*(?:nc|ncat|curl|wget)\b/i,
	},
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

/** Only the start of a reply says whether it is chatter, so nothing past this is read. */
const CONVERSATIONAL_SCAN_CHARS = 200;

/** A bare acknowledgement ("Sure.", "Got it, thanks") is chatter only when it is this short. */
const ACKNOWLEDGEMENT_MAX_CHARS = 60;

const LEAD = String.raw`^[\s"'(*>-]*`;

/**
 * Openers that address a person: greetings, thanks, offers of help. Anchored at
 * the start, with alternations of fixed words only, so it runs in time linear
 * in the 200 characters it reads.
 */
const GREETING_OR_OFFER_RE = new RegExp(
	`${LEAD}(?:hi|hello|hey|howdy|thanks|thank you|thx|cheers|you'?re welcome|my pleasure|happy to (?:help|assist)|glad to help|ready when you are|i'?m ready|i am ready|i'?m here|let me know|is there anything|anything else|what would you like|how can i (?:help|assist)|can i help|do you need)\\b`,
	"i",
);

/** "Sure", "Got it": an acknowledgement, which is a prompt to nobody unless something follows. */
const ACKNOWLEDGEMENT_RE = new RegExp(
	`${LEAD}(?:sure|certainly|of course|absolutely|okay|ok|great|awesome|perfect|nice|sounds good|got it|understood|no problem)\\b`,
	"i",
);

/** "Anything else I can help with?" is chatter wherever it appears in the opening. */
const OFFER_ANYWHERE_RE =
	/\b(?:anything else|anything more|something else)(?: (?:i|we) can)?\b|\bhappy to (?:help|assist)\b|\bready when you are\b/i;

/**
 * Is this the model talking to the person ("Ready when you are! Anything else I
 * can assist with?") instead of telling the agent what to do? Such a reply as a
 * "next prompt" would be typed into the agent as noise. This is noise reduction,
 * not a safety control: a miss costs a useless suggestion, never an unsafe one.
 */
export function isConversationalReply(text: string): boolean {
	if (typeof text !== "string") return false;
	const head = text.slice(0, CONVERSATIONAL_SCAN_CHARS);
	if (GREETING_OR_OFFER_RE.test(head) || OFFER_ANYWHERE_RE.test(head)) return true;
	return text.trim().length <= ACKNOWLEDGEMENT_MAX_CHARS && ACKNOWLEDGEMENT_RE.test(head);
}
