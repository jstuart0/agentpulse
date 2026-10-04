/**
 * The default redaction rules exactly as they stood at ff1449f, before the
 * session summary work (AGEN-69) touched the redactor. A frozen oracle: tests
 * compare today's output with what this set produced, so every difference is a
 * deliberate, named change. Never edit the patterns below; add to the redactor.
 */
import type { RedactionRule } from "../redactor.js";

export const OLD_RULES: readonly RedactionRule[] = [
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

/** The old `redact()`: the old rules applied in order, no extras. */
export function oldRedact(input: string): string {
	let text = input;
	for (const rule of OLD_RULES) {
		rule.pattern.lastIndex = 0;
		text = text.replace(rule.pattern, (match) =>
			typeof rule.replacement === "function" ? rule.replacement(match) : rule.replacement,
		);
	}
	return text;
}
