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
		pattern:
			/(^|[^A-Za-z0-9])((?:[A-Z][A-Z0-9]*_)*(?:PASSWORD|SECRET|API_KEY|APIKEY|TOKEN|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN))\s*=\s*["']?[^\s"'\n]{4,}/gi,
		replacement: (match) => {
			const eq = match.indexOf("=");
			return `${match.slice(0, eq + 1)} [REDACTED]`;
		},
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
