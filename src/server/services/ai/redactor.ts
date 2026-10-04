export interface RedactionRule {
	name: string;
	pattern: RegExp;
	/** What to emit in place of the matched substring. */
	replacement: string | ((match: string) => string);
}

export interface RedactionHit {
	rule: string;
	position: number;
	originalLength: number;
	replacement: string;
}

export interface RedactionResult {
	text: string;
	hits: RedactionHit[];
}

// Default deny-list. Kept short on purpose; users add patterns via settings.
// Each rule must be `g`-flagged so `replace` walks the entire input.
//
// Order matters: more specific rules (with unique prefixes like sk-ant-,
// sk-or-) run before the generic openai_api_key rule so tags land right.
export const DEFAULT_RULES: RedactionRule[] = [
	{
		name: "anthropic_api_key",
		pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
		replacement: "[REDACTED:anthropic_api_key]",
	},
	{
		name: "openrouter_api_key",
		pattern: /\bsk-or-[a-z0-9]{1,4}-[A-Za-z0-9_\-]{24,}\b/g,
		replacement: "[REDACTED:openrouter_api_key]",
	},
	{
		name: "openai_api_key",
		// Standard sk-..., project keys sk-proj-..., and restricted keys sk-svcacct-...
		// Negative lookbehind is not portable; we rely on rule order so the
		// anthropic / openrouter rules strip their prefixes first.
		pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{24,}\b/g,
		replacement: "[REDACTED:openai_api_key]",
	},
	{
		name: "google_api_key",
		// Google/Gemini API keys start with AIza followed by ~35 alphanum/_/-.
		// Accepting 30+ for safety — real-world variants exist.
		pattern: /\bAIza[A-Za-z0-9_\-]{30,}\b/g,
		replacement: "[REDACTED:google_api_key]",
	},
	{
		name: "github_token",
		pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
		replacement: "[REDACTED:github_token]",
	},
	{
		name: "agentpulse_api_key",
		pattern: /\bap_[a-f0-9]{32}\b/g,
		replacement: "[REDACTED:agentpulse_api_key]",
	},
	{
		name: "agentpulse_supervisor_token",
		pattern: /\baps_[a-f0-9]{32}\b/g,
		replacement: "[REDACTED:agentpulse_supervisor_token]",
	},
	{
		name: "telegram_bot_token",
		pattern: /\b\d{8,12}:[A-Za-z0-9_\-]{35}\b/g,
		replacement: "[REDACTED:telegram_bot_token]",
	},
	{
		name: "aws_access_key",
		pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
		replacement: "[REDACTED:aws_access_key]",
	},
	{
		name: "slack_token",
		pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
		replacement: "[REDACTED:slack_token]",
	},
	{
		name: "jwt",
		// Three base64url segments separated by dots, header usually starts with `eyJ`.
		pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
		replacement: "[REDACTED:jwt]",
	},
	{
		name: "authorization_header",
		// Matches `Authorization: Bearer <token>` and `authorization: <token>`.
		pattern: /\b[Aa]uthorization:\s*(?:Bearer\s+|Basic\s+)?[A-Za-z0-9_\-\.]{12,}/g,
		replacement: "Authorization: [REDACTED]",
	},
	{
		name: "env_assignment_secret",
		// KEY=value style. Prefix allows underscores/prefixes like DB_PASSWORD,
		// APP_SECRET, etc. The opening boundary uses a character class instead
		// of \b so `DB_PASSWORD` still matches (underscore is a word char).
		//
		// The prefix repeat is bounded at 8 segments. Unbounded, a long run of
		// `A_A_A_...` made every start position rescan the whole run: 7.3 s on
		// 100 KB. A longer key still redacts to the same text: `_` is itself a
		// boundary character, so the match simply starts inside the key.
		pattern:
			/(^|[^A-Za-z0-9])((?:[A-Z][A-Z0-9]*_){0,8}(?:PASSWORD|SECRET|API_KEY|APIKEY|TOKEN|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN))\s*=\s*["']?[^\s"'\n]{4,}/gi,
		replacement: (match) => {
			const eq = match.indexOf("=");
			return `${match.slice(0, eq + 1)} [REDACTED]`;
		},
	},
	// Rules below were added for the session summary (AGEN-69). Every pattern
	// is bounded so no input makes the scan super-linear, and every replacement
	// is itself unmatched by its own rule so redacting twice is stable.
	{
		name: "pem_private_key",
		// A BEGIN with no END is caught too: the body is capped at 4,000
		// characters and the END is optional.
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,4000}(?:-----END[^-]*-----)?/g,
		replacement: "[REDACTED:pem_private_key]",
	},
	{
		name: "cookie_header",
		// A cookie pair (`name=`) must follow, so the word "cookie" followed by
		// a colon in prose is left alone. The rest of the line is taken, to a cap.
		pattern: /(?<![A-Za-z0-9_-])(?:Set-)?Cookie:[ \t]*[\w.%~-]+=[^\r\n]{0,4096}/gi,
		replacement: "[REDACTED:cookie_header]",
	},
	{
		name: "api_key_header",
		pattern: /\bX-(?:Api-Key|Auth-Token):[ \t]*\S{8,}/gi,
		replacement: "[REDACTED:api_key_header]",
	},
	{
		name: "url_userinfo",
		// `scheme://user:password@host`. The username may be empty
		// (`redis://:secret@host`). Neither group crosses a `/`, so
		// `http://localhost:3000/@scope/pkg` is not userinfo.
		pattern: /:\/\/[^/\s:@]*:[^/\s@]+@/g,
		replacement: "://[REDACTED]@",
	},
	{
		name: "stripe_live_key",
		pattern: /\bsk_live_[A-Za-z0-9]{24,}/g,
		replacement: "[REDACTED:stripe_live_key]",
	},
	{
		name: "huggingface_token",
		pattern: /\bhf_[A-Za-z0-9]{30,}/g,
		replacement: "[REDACTED:huggingface_token]",
	},
	{
		name: "gitlab_token",
		pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g,
		replacement: "[REDACTED:gitlab_token]",
	},
	{
		name: "npm_token",
		pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
		replacement: "[REDACTED:npm_token]",
	},
	{
		name: "json_secret_value",
		// A quoted exact key, `:`, a quoted value of 6 or more characters (an
		// escaped quote does not end it). `"max_tokens"` and `"password_hint"`
		// are different keys. An already-masked value is skipped.
		pattern:
			/"(?:password|passwd|secret|client_secret|api_key|apikey|api_token|access_token|refresh_token|auth_token|token|private_key)"\s*:\s*"(?!\[REDACTED)(?:[^"\\\n]|\\.){6,}"/gi,
		replacement: (match) => `${match.slice(0, match.indexOf(":") + 1)} "[REDACTED]"`,
	},
	{
		name: "yaml_secret_value",
		// The key starts the line (after indentation and an optional list
		// dash) and the value is the rest of the line: 8 or more characters, none
		// of which is part of code or a type (`< > ( ) $ { } [ ] | ; ,`), not a
		// type word. The excluded `[` also keeps an already-masked value out.
		pattern:
			/^[ \t]*(?:-[ \t]+)?(?:password|passwd|secret|client_secret|api_key|apikey|api_token|access_token|refresh_token|auth_token|token|private_key)[ \t]*:[ \t]+["']?(?!(?:true|false|null|undefined|string|number|boolean|unknown|object|Optional|Union|Callable|datetime|Decimal)\b)[^\s<>()${}[\]|;,"']{8,}["']?[ \t]*(?:#[^\n]*)?$/gim,
		replacement: (match) => `${match.slice(0, match.indexOf(":") + 1)} [REDACTED]`,
	},
	{
		name: "cli_secret_flag",
		// `--token-file path` is hit too: accepted, since telling a path from a
		// secret is not possible here. `--tokens` and `--passwordless` are not.
		pattern:
			/--(?:password|token|secret|api-key)(?![A-Za-z0-9_])[^\s=]{0,64}(?:=|[ \t]+)(?!\[REDACTED)\S+/g,
		replacement: (match) => `${match.slice(0, match.search(/[=\s]/) + 1)}[REDACTED]`,
	},
	{
		name: "curl_user",
		// `-u`/`--user name:secret` inside a curl command, the command at most
		// 500 characters before the flag.
		pattern:
			/\bcurl\b(?:[^\n]|\\\n){0,500}?[ \t](?:-u|--user)[ =]?["']?[^\s:"']+:(?!\[REDACTED)[^\s"']+/g,
		replacement: (match) =>
			match.replace(/([ \t](?:-u|--user)[ =]?["']?[^\s:"']+:)[^\s"']+$/, "$1[REDACTED]"),
	},
];

/**
 * Redact secrets from text using the built-in rules plus any caller-provided
 * extras. Returns the redacted text alongside detailed hit information so
 * UIs can show "we redacted N things" or drop them inline.
 *
 * The function is pure and order-sensitive: earlier rules run first, and
 * overlapping matches go to whichever rule matched first.
 */
export function redact(input: string, extraRules: RedactionRule[] = []): RedactionResult {
	const hits: RedactionHit[] = [];
	if (!input) return { text: input ?? "", hits };
	const allRules = [...DEFAULT_RULES, ...extraRules];

	let text = input;
	for (const rule of allRules) {
		// Reset lastIndex on every iteration so global regexes don't skip matches.
		rule.pattern.lastIndex = 0;
		text = text.replace(rule.pattern, (match, ...args) => {
			// `args` penultimate value is the offset in the *current* `text`.
			// We record the offset into the post-redaction text; that's enough
			// for UIs that want to highlight a replacement region.
			const offset =
				typeof args[args.length - 2] === "number" ? (args[args.length - 2] as number) : 0;
			const replacement =
				typeof rule.replacement === "function" ? rule.replacement(match) : rule.replacement;
			hits.push({
				rule: rule.name,
				position: offset,
				originalLength: match.length,
				replacement,
			});
			return replacement;
		});
	}
	return { text, hits };
}

/**
 * Dry-run helper that the UI can call to preview redaction before the user
 * enables the watcher. Identical output shape to `redact`, but names a
 * distinct call site for observability.
 */
export function redactDryRun(input: string, extraRules: RedactionRule[] = []): RedactionResult {
	return redact(input, extraRules);
}

/**
 * Parse user-configured rule strings from the settings table.
 *
 * Each row looks like `name|regex|replacement`. A missing replacement falls
 * back to `[REDACTED:<name>]`. Invalid regexes are skipped with a warning
 * so one bad entry doesn't nuke the whole list.
 */
export function parseUserRules(rows: unknown): RedactionRule[] {
	if (!Array.isArray(rows)) return [];
	const rules: RedactionRule[] = [];
	for (const row of rows) {
		if (typeof row !== "string" || !row.includes("|")) continue;
		const [name, patternStr, replacement] = row.split("|", 3);
		if (!name || !patternStr) continue;
		try {
			const pattern = new RegExp(patternStr, "g");
			rules.push({
				name,
				pattern,
				replacement: replacement || `[REDACTED:${name}]`,
			});
		} catch (err) {
			console.warn(`[redactor] skipping invalid user rule "${name}":`, err);
		}
	}
	return rules;
}
