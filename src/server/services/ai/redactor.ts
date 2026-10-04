import { stripInvisibleKeepNewlines } from "./untrusted-text.js";

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

/** Case-insensitive spelling of a literal, for patterns that must stay case-sensitive elsewhere. */
function ci(word: string): string {
	return [...word]
		.map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c))
		.join("");
}

// A JSON key that names a secret: any identifier prefix (`db_`, `client-`,
// `access`, `Session`), then the secret word, and nothing after it, so
// `max_tokens`, `token_count`, `password_hint` and `tokenType` are other keys.
const JSON_SECRET_KEY = String.raw`[a-z0-9_\-.]{0,40}(?:password|passwd|secret|api[_-]?key|token|private[_-]?key(?:[_-]?id)?|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|connection[_-]?string|authorization|credentials?)`;
// A value that is not a secret: the name of a type (`"token": "string"`), a
// scheme word alone (`"Authorization": "Bearer "`), or a placeholder standing
// for one (`${API_KEY}`, `$API_KEY`, `<your-key>`, `{{ key }}`, optionally after a
// scheme word). Judged on the whole value, so `${x}realsecret` is still masked.
const JSON_NOT_A_SECRET = String.raw`(?:string|number|boolean|object|array|integer|null|undefined|true|false|unknown|(?:bearer|basic|digest) ?|(?:(?:bearer|basic|digest) )?(?:\\?\$\{[^}"\\]*\}|\\?\$[a-z_][a-z0-9_]*|<[^>"\\]*>|\{\{[^}"\\]*\}\}))`;

/**
 * A quoted exact key, `:`, a quoted value of 6 or more characters (an escaped
 * quote does not end it); or the same one level down, inside a JSON string
 * (`\"password\":\"...\"`). The key must open an object member: start of a line
 * or right after `{`, `,` or `[` (and whitespace), which keeps a ternary like
 * `ok ? "current-password" : "new-password"` out. The cheap lookahead comes
 * first so the look-behind only runs where a quote starts.
 */
const JSON_SECRET_VALUE_PATTERN = new RegExp(
	String.raw`(?=\\?")(?<=(?:^|[{,\[])\s*)(?:"(?:${JSON_SECRET_KEY})"\s*:\s*"(?!\[REDACTED)(?!${JSON_NOT_A_SECRET}")(?:[^"\\\n]|\\.){6,}"|\\"(?:${JSON_SECRET_KEY})\\"\s*:\s*\\"(?!\[REDACTED)(?!${JSON_NOT_A_SECRET}\\")(?:[^"\\\n]|\\(?!")){6,}\\")`,
	"gim",
);

const YAML_SECRET_WORDS = [
	"password",
	"passwd",
	"secret",
	"api[_-]?key",
	"token",
	"private[_-]?key",
	"secret[_-]?key",
	"signing[_-]?key",
	"encryption[_-]?key",
]
	.map((w) => w.split("[_-]?").map(ci).join("[_-]?"))
	.join("|");
const YAML_TYPE_WORDS = [
	"true",
	"false",
	"null",
	"undefined",
	"string",
	"number",
	"boolean",
	"unknown",
	"object",
	"Optional",
	"Union",
	"Callable",
	"datetime",
	"Decimal",
]
	.map(ci)
	.join("|");
const YAML_VALUE_END = String.raw`["']?[ \t]*(?:#[^\r\n]*)?$`;

/**
 * `key: value` with the key at the start of a line (after indentation and an
 * optional list dash; any prefix like `DB_` or `ssh-`), the value the rest of
 * the line: 8 or more characters, none of which is part of code or a type
 * (`< > ( ) $ { } [ ] | ; ,`). Not a secret: a type word, a CamelCase word
 * (`SecretStr`, `AccessToken`) or a lowercase hyphenated name (`my-secret-name`):
 * ACCEPTED, a passphrase of either shape is left alone. `$` already matches
 * before a CR, and the comment stops at it, so CRLF files keep their endings.
 * The excluded `[` also keeps an already-masked value out.
 */
const YAML_SECRET_VALUE_PATTERN = new RegExp(
	String.raw`^[ \t]*(?:-[ \t]+)?(?:[A-Za-z0-9]+[_-]){0,8}(?:${YAML_SECRET_WORDS})[ \t]*:[ \t]+["']?(?!(?:${YAML_TYPE_WORDS})\b)(?!(?:[A-Z][a-z]+){2,}${YAML_VALUE_END})(?![a-z]+(?:-[a-z]+)+${YAML_VALUE_END})[^\s<>()$\{\}[\]|;,"']{8,}${YAML_VALUE_END}`,
	"gm",
);

const COOKIE_PAIR = String.raw`[ \t]*[\w.%~-]+=`;
const COOKIE_NAME_ANY_CASE = `(?:${ci("Set-")})?${ci("Cookie")}:`;
const COOKIE_HEADER_FLAG = `(?:-[Hh]|${ci("--header")})`;
const COOKIE_HEADER_PATTERN = new RegExp(
	[
		String.raw`${COOKIE_HEADER_FLAG}[ \t=]*(["'])${COOKIE_NAME_ANY_CASE}${COOKIE_PAIR}(?:(?!\1)[^\r\n])*`,
		String.raw`(?:^[ \t]*|${COOKIE_HEADER_FLAG}[ \t=]+)${COOKIE_NAME_ANY_CASE}${COOKIE_PAIR}[^\r\n]*`,
		String.raw`(?<=[\s>"'])(?:Set-)?Cookie:${COOKIE_PAIR}[^\r\n"']*`,
	].join("|"),
	"gm",
);

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
		name: "github_pat",
		// Fine-grained personal access tokens: `github_pat_` and 22 or more of
		// letters, digits and underscores (real ones carry 82).
		pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
		replacement: "[REDACTED:github_pat]",
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
		pattern: /\b(?:xox[baprs]|xapp)-[A-Za-z0-9-]{10,}\b/g,
		replacement: "[REDACTED:slack_token]",
	},
	{
		name: "slack_webhook",
		// The URL is the credential: anyone holding it can post to the channel.
		pattern: /\bhooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
		replacement: "[REDACTED:slack_webhook]",
	},
	{
		name: "jwt",
		// Three base64url segments separated by dots, header usually starts with `eyJ`.
		pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
		replacement: "[REDACTED:jwt]",
	},
	{
		name: "authorization_header",
		// `Authorization: <scheme> <credentials>` and the JSON form
		// `"Authorization":"Bearer ..."`, in any case. Bearer, Basic, Token and
		// similar schemes take a token of 8 or more characters (`+ / = ~` included:
		// base64 and tokens carry them). Digest and AWS4-HMAC-* take the whole
		// parameter list: `name="quoted"` pairs, or any characters up to a quote
		// or the end of the line, so a one-line curl keeps its URL. With no
		// scheme, a token of 12 or more characters.
		pattern:
			/\bauthorization["']?[ \t]*:[ \t]*["']?(?:(?:Digest|AWS4-[A-Z0-9-]+)[ \t]+(?:\\.|="[^"\r\n]*"|[^\r\n'"\\]){8,}|(?:Bearer|Basic|Token|Negotiate|NTLM|Hawk|OAuth|Bot)[ \t]+[A-Za-z0-9_\-.+/=~]{8,}|[A-Za-z0-9_\-.+/=~]{12,})/gi,
		replacement: "Authorization: [REDACTED]",
	},
	{
		name: "pem_private_key",
		// Runs before env_assignment_secret: `PRIVATE_KEY="-----BEGIN ...` would
		// otherwise lose its first line to that rule and leak the body. The body
		// is base64, whitespace, the literal two-character `\n` / `\r` escapes of a
		// quoted or JSON-embedded key, and the `Proc-Type:` / `DEK-Info:` header
		// lines of a legacy encrypted key: everything up to the END line, which
		// the lookahead stops at. The 16,000 bound (an RSA-8192 key is about
		// 6,500) only keeps the scan linear when an END is missing; a BEGIN with
		// no END is redacted as far as the bound.
		pattern:
			/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:(?!-----END)[A-Za-z0-9+/=\s\\:,.-]){0,16000}(?:-----END[^-]*-----)?/g,
		replacement: "[REDACTED:pem_private_key]",
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
		//
		// Only spaces and tabs may surround `=`: a value cannot start on the next
		// line (`export TOKEN=` then a command). A quoted value that contains
		// whitespace is taken whole (`PASSWORD="my pass phrase"`); a quoted value
		// without whitespace keeps the earlier behaviour, leftover quote and all.
		// PASS counts only when `=` follows it directly (`DB_PASS=x`), so a constant
		// like `MAX_BATCHES_PER_PASS = 1_000` is left alone.
		// ACCEPTED over-match: `const token = await getToken()` is masked.
		pattern:
			/(^|[^A-Za-z0-9])((?:[A-Z][A-Z0-9]*_){0,8}(?:PASSWORD|PASSWD|PASS(?==)|SECRET_KEY|SECRET|SIGNING_KEY|ENCRYPTION_KEY|API_KEY|APIKEY|TOKEN|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN|CREDENTIALS))[ \t]*=[ \t]*(?:"(?=[^"\n]*[ \t])[^"\n]{4,}"|'(?=[^'\n]*[ \t])[^'\n]{4,}'|["']?[^\s"'\n]{4,})/gi,
		replacement: (match) => {
			const eq = match.indexOf("=");
			return `${match.slice(0, eq + 1)} [REDACTED]`;
		},
	},
	// Rules below were added for the session summary (AGEN-69). Every pattern
	// is bounded so no input makes the scan super-linear, and every replacement
	// is itself unmatched by its own rule so redacting twice is stable.
	{
		name: "cookie_header",
		// The header, not the word. Three contexts: `Cookie:` / `Set-Cookie:` at the
		// start of a line (any case), after `-H` / `--header` (any case), or the
		// capitalised name after whitespace, `>` or a quote (a transcript line reads
		// `USER> Cookie: ...`; lower-case `cookie:` mid-line is code, not a header).
		// Inside a quoted -H argument, and in the third context, the value ends at
		// a closing quote, so the URL and later arguments of a one-line curl
		// survive; on a line of its own it runs to the end of the line, with no
		// cap. A cookie pair (`name=`) must follow, so prose is left alone.
		// ACCEPTED over-match: a bare `cookie: a=b` field at the start of a line.
		pattern: COOKIE_HEADER_PATTERN,
		replacement: (match) => {
			const lead = /^(?:-[Hh]|--header)[ \t=]*["']?|^[ \t]*/.exec(match)?.[0] ?? "";
			return `${lead}[REDACTED:cookie_header]`;
		},
	},
	{
		name: "api_key_header",
		pattern: /\bX-(?:Api-Key|Auth-Token):[ \t]*\S{8,}/gi,
		replacement: "[REDACTED:api_key_header]",
	},
	{
		name: "url_userinfo",
		// `scheme://user:password@host`. The username may be empty
		// (`redis://:secret@host`). The password runs to the last `@` before a
		// `/`, `?`, `#` or whitespace, so `p@ssw0rd` is masked whole and
		// `http://example.com:8080?email=a@b.com` (a query after a port) is not
		// userinfo. Or a token alone as the userinfo (`https://<token>@host`): 20
		// or more characters from the set a token uses. A placeholder password
		// (`<pw>`, `${PW}`, `$PW`) is not a secret. The user part never crosses a `/`, so
		// `http://localhost:3000/@scope/pkg` is not userinfo.
		pattern:
			/:\/\/(?:[^/\s:@]*:(?!(?:<[^>\s@]*>|\$\{[^}\s@]*\}|\$[A-Za-z_]\w*)@)[^/\s?#]*|[A-Za-z0-9_\-.~%]{20,})@/g,
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
		pattern: JSON_SECRET_VALUE_PATTERN,
		replacement: (match) => {
			const escaped = match.startsWith('\\"');
			const head = match.slice(0, match.indexOf(":") + 1);
			return `${head} ${escaped ? '\\"[REDACTED]\\"' : '"[REDACTED]"'}`;
		},
	},
	{
		name: "yaml_secret_value",
		pattern: YAML_SECRET_VALUE_PATTERN,
		replacement: (match) => `${match.slice(0, match.indexOf(":") + 1)} [REDACTED]`,
	},
	{
		name: "cli_secret_flag",
		// Four names, each with an optional client-/access-/auth-/api-/refresh-/
		// bearer- prefix, and only a -file / -path suffix: `--token-file path` is
		// masked (a path cannot be told from a secret here) while `--token-budget`,
		// `--secret-name`, `--api-key-env`, `--password-stdin`, `--tokens` and
		// `--passwordless` are not secrets at all. Nothing unbounded, so linear.
		// ACCEPTED over-match: prose after a flag (`no --api-key was provided`).
		pattern:
			/--(?:(?:client|access|auth|api|refresh|bearer)-)?(?:password|token|secret|api-key)(?:-file|-path)?(?:=|[ \t]+)(?!\[REDACTED)\S+/g,
		replacement: (match) => `${match.slice(0, match.search(/[=\s]/) + 1)}[REDACTED]`,
	},
	{
		name: "curl_user",
		// `-u`/`--user name:secret`, or short flags ending in u (`-sSu name:secret`),
		// in a curl command: the flag follows a space or a backslash-newline
		// continuation and `curl` is at most 500 characters before it. The cheap
		// tests come first and the look-behind for `curl` last, so the cost is
		// paid only at the few places a `-u` flag sits, not at every `curl`.
		pattern:
			/(?<=[ \t]|\\\n)(?=(?:-[A-Za-z]*u|--user)[ =]?["']?[^\s:"']+:)(?<=\bcurl\b(?:[^\n]|\\\n){0,500})(?:-[A-Za-z]*u|--user)[ =]?["']?[^\s:"']+:(?!\[REDACTED)[^\s"']+/g,
		replacement: (match) =>
			match.replace(/^((?:-[A-Za-z]*u|--user)[ =]?["']?[^\s:"']+:)[^\s"']+$/, "$1[REDACTED]"),
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

/**
 * The order a summary prompt must follow for any text it takes from a session:
 * strip, then redact, then fence. Redacting first lets a secret split by an
 * invisible character (a zero-width space, a variation selector, a tag
 * character) slip past every rule, and the model, which reads the characters
 * as nothing, sees the whole secret. This is the first two steps; the third is
 * `fenceUntrusted`. Line separators become real newlines here, before the
 * line-anchored rules run.
 */
export function stripAndRedact(input: string, extraRules: RedactionRule[] = []): RedactionResult {
	return redact(stripInvisibleKeepNewlines(input), extraRules);
}
