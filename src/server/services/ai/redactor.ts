import { stripInvisibleKeepNewlines } from "./untrusted-text.js";

export interface RedactionRule {
	name: string;
	pattern: RegExp;
	/** What to emit in place of the matched substring. */
	replacement: string | ((match: string) => string);
	/**
	 * Optional prefilter: a NECESSARY condition for the pattern to match anywhere in
	 * `text` (`lower()` is the lower-cased text). `false` skips the rule's pass; `true`
	 * proves nothing. Built-in rules only: a user rule has no gate and always runs.
	 */
	gate?: (text: string, lower: () => string) => boolean;
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

// Where a token may start. `\b` misses a token glued to a literal `\n`, `\r` or `\t`
// escape (the text of a JSON string), to an ANSI colour sequence and to a `%xx`
// escape, because each of those ends in a word character. STD is `\b` plus those three.
// DISTINCT is for long, unmistakable prefixes (`sk-ant-`, `ghp_`): it only refuses a
// preceding LETTER, so `API_KEY_sk-ant-...` and `1ghp_...` are caught while an
// identifier like `task-ant-...` is not.
const START_ESCAPES = String.raw`(?<=\\[nrt])|(?<=\x1b\[[0-9;]{0,12}m)|(?<=%[0-9A-Fa-f]{2})`;
const STD_START = String.raw`(?:(?<![A-Za-z0-9_])|${START_ESCAPES})`;
const DISTINCT_START = String.raw`(?:(?<![A-Za-z])|${START_ESCAPES})`;
/** A whole marker as any rule writes it: `[REDACTED]` or `[REDACTED:name]`. */
const MARKER = String.raw`\[REDACTED(?::[a-z_]+)?\]`;

// A JSON key that names a secret: any identifier prefix (`db_`, `client-`,
// `access`, `Session`), then the secret word, and nothing after it, so
// `max_tokens`, `token_count`, `password_hint` and `tokenType` are other keys.
const JSON_SECRET_KEY = String.raw`[a-z0-9_\-.]{0,40}(?:password|passwd|secret|api[_-]?key|token|private[_-]?key(?:[_-]?id)?|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|connection[_-]?string|authorization|credentials?|cookie)`;
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
	String.raw`(?=\\?")(?<=(?:^|[{,\[])\s*)(?:"(?:${JSON_SECRET_KEY})"\s*:\s*"(?!${MARKER}")(?!${JSON_NOT_A_SECRET}")(?:[^"\\\n]|\\.){6,}"|\\"(?:${JSON_SECRET_KEY})\\"\s*:\s*\\"(?!${MARKER}\\")(?!${JSON_NOT_A_SECRET}\\")(?:[^"\\\n]|\\(?!")){6,}\\")`,
	"gim",
);

/**
 * The object-literal forms a log line carries: a Python repr (`{'password': 'x'}`)
 * and `console.log` output (`{ password: 'x' }`): a quoted or bare key naming a
 * secret, a single-quoted value of 6 or more characters (the double-quoted form is
 * the JSON rule's, and in source code it is a call argument). Same key
 * and not-a-secret rules as the JSON rule, and no CamelCase or hyphenated-name
 * exception: a hyphenated value is masked under every key. The key must open
 * a member on the same line (right after `{`, `,` or `[`, with at most 40
 * blanks between): a key at the start of a line is the YAML rule's, or source
 * code's. `passwordField:` is another key. Every repeat is bounded.
 */
const OBJECT_LITERAL_SECRET_PATTERN = new RegExp(
	String.raw`(?=['"A-Za-z0-9_.-])(?<=[{,\[][ \t]{0,40})(?:'(?:${JSON_SECRET_KEY})'|"(?:${JSON_SECRET_KEY})"|(?:${JSON_SECRET_KEY}))[ \t]*:[ \t]*(?:'(?!${MARKER}')(?!${JSON_NOT_A_SECRET}')(?:[^'\\\n]|\\.){6,}')`,
	"gim",
);

/**
 * `{"name":"DB_PASSWORD","value":"..."}`, the pair `kubectl get pod -o json`
 * prints for an environment variable: the value is masked when the name is a
 * secret key, whatever the value looks like (4 or more characters).
 */
const NAME_VALUE_SECRET_PATTERN = new RegExp(
	String.raw`(?="name")(?<=(?:^|[{,\[])[ \t\r\n]{0,40})"name"\s*:\s*"(?:${JSON_SECRET_KEY})"\s*,\s*"value"\s*:\s*"(?!${MARKER}")(?!${JSON_NOT_A_SECRET}")(?:[^"\\\n]|\\.){4,}"`,
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
		String.raw`(?<=[\s>"']|\\[nrt])(?:Set-)?Cookie:${COOKIE_PAIR}[^\r\n"']*`,
	].join("|"),
	"gm",
);

/** The same pattern with its start rule swapped in front (flags kept). */
function withStart(re: RegExp, start: string): RegExp {
	return new RegExp(`${start}${re.source}`, re.flags);
}

/** A token pattern: a cheap lookahead on its first characters, then the start rule, then the body. */
function tokenPattern(start: string, lead: string, body: string, flags = "g"): RegExp {
	return new RegExp(`(?=${lead})${start}${body}`, flags);
}

// What a secret-named key can end in, lower-case, for the prefilter gates below. The key
// patterns allow any identifier prefix and nothing after the secret word, so the quoted
// key always ends in one of these.
const KEY_ENDS = String.raw`(?:password|passwd|secret|key|key[_-]?id|token|string|authorization|credentials?|cookie)`;
const JSON_KEY_GATE = new RegExp(String.raw`${KEY_ENDS}\\?"\s*:\s*\\?"`);
const OBJECT_KEY_GATE = new RegExp(String.raw`${KEY_ENDS}['"]?[ \t]*:[ \t]*'`);
const YAML_KEY_GATE = /(?:password|passwd|secret|key|token)[ \t]*:[ \t]+/;
const ENV_KEY_GATE =
	/(?:password|passwd|pass|secret_key|secret|signing_key|encryption_key|api_key|apikey|token|access_key|private_key|credentials)[ \t]*=/;
const CLI_FLAG_GATE =
	/--(?:(?:client|access|auth|api|refresh|bearer)-)?(?:password|token|secret|api-key)/;
const has =
	(...needles: string[]) =>
	(text: string): boolean =>
		needles.some((n) => text.includes(n));

// Default deny-list. Kept short on purpose; users add patterns via settings.
// Each rule must be `g`-flagged so `replace` walks the entire input.
//
// Order matters: more specific rules (with unique prefixes like sk-ant-,
// sk-or-) run before the generic openai_api_key rule so tags land right.
export const DEFAULT_RULES: RedactionRule[] = [
	{
		name: "anthropic_api_key",
		pattern: tokenPattern(DISTINCT_START, "sk-ant-", String.raw`sk-ant-[A-Za-z0-9_\-]{20,}\b`),
		replacement: "[REDACTED:anthropic_api_key]",
		gate: has("sk-ant-"),
	},
	{
		name: "openrouter_api_key",
		pattern: tokenPattern(
			STD_START,
			"sk-or-",
			String.raw`sk-or-[a-z0-9]{1,4}-[A-Za-z0-9_\-]{24,}\b`,
		),
		replacement: "[REDACTED:openrouter_api_key]",
		gate: has("sk-or-"),
	},
	{
		name: "openai_api_key",
		// Standard sk-..., project keys sk-proj-..., and restricted keys sk-svcacct-...
		// Negative lookbehind is not portable; we rely on rule order so the
		// anthropic / openrouter rules strip their prefixes first.
		pattern: tokenPattern(
			STD_START,
			"sk-",
			String.raw`sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{24,}\b`,
		),
		replacement: "[REDACTED:openai_api_key]",
		gate: has("sk-"),
	},
	{
		name: "google_api_key",
		// Google/Gemini API keys start with AIza followed by ~35 alphanum/_/-.
		// Accepting 30+ for safety — real-world variants exist.
		pattern: tokenPattern(STD_START, "AIza", String.raw`AIza[A-Za-z0-9_\-]{30,}\b`),
		replacement: "[REDACTED:google_api_key]",
		gate: has("AIza"),
	},
	{
		name: "github_token",
		pattern: tokenPattern(
			DISTINCT_START,
			"gh[pousr]_",
			String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b`,
		),
		replacement: "[REDACTED:github_token]",
		gate: (text) => /gh[pousr]_/.test(text),
	},
	{
		name: "github_pat",
		// Fine-grained personal access tokens: `github_pat_` and 22 or more of
		// letters, digits and underscores (real ones carry 82).
		pattern: tokenPattern(DISTINCT_START, "github_pat_", String.raw`github_pat_[A-Za-z0-9_]{22,}`),
		replacement: "[REDACTED:github_pat]",
		gate: has("github_pat_"),
	},
	{
		name: "agentpulse_api_key",
		pattern: tokenPattern(STD_START, "ap_", String.raw`ap_[a-f0-9]{32}\b`),
		replacement: "[REDACTED:agentpulse_api_key]",
		gate: has("ap_"),
	},
	{
		name: "agentpulse_supervisor_token",
		pattern: tokenPattern(STD_START, "aps_", String.raw`aps_[a-f0-9]{32}\b`),
		replacement: "[REDACTED:agentpulse_supervisor_token]",
		gate: has("aps_"),
	},
	{
		name: "telegram_bot_token",
		pattern: tokenPattern(STD_START, String.raw`\d`, String.raw`\d{8,12}:[A-Za-z0-9_\-]{35}\b`),
		replacement: "[REDACTED:telegram_bot_token]",
		gate: (text) => /\d{8}:/.test(text),
	},
	{
		name: "aws_access_key",
		pattern: tokenPattern(STD_START, "AKIA|ASIA", String.raw`(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
		replacement: "[REDACTED:aws_access_key]",
		gate: has("AKIA", "ASIA"),
	},
	{
		name: "slack_token",
		pattern: tokenPattern(
			DISTINCT_START,
			"xox|xapp",
			String.raw`(?:xox[baprs]|xapp)-[A-Za-z0-9-]{10,}\b`,
		),
		replacement: "[REDACTED:slack_token]",
		gate: has("xox", "xapp-"),
	},
	{
		name: "slack_webhook",
		// The URL is the credential: anyone holding it can post to the channel.
		pattern: tokenPattern(
			STD_START,
			"hooks",
			String.raw`hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+`,
		),
		replacement: "[REDACTED:slack_webhook]",
		gate: has("hooks.slack.com"),
	},
	{
		name: "jwt",
		// Three base64url segments separated by dots, header usually starts with `eyJ`.
		pattern: tokenPattern(
			STD_START,
			"eyJ",
			String.raw`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b`,
		),
		replacement: "[REDACTED:jwt]",
		gate: has("eyJ"),
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
		pattern: withStart(
			/(?=authorization)authorization["']?[ \t]*:[ \t]*["']?(?:(?:Digest|AWS4-[A-Z0-9-]+)[ \t]+(?:\\.|="[^"\r\n]*"|[^\r\n'"\\]){8,}|(?:Bearer|Basic|Token|Negotiate|NTLM|Hawk|OAuth|Bot)[ \t]+[A-Za-z0-9_\-.+/=~]{8,}|[A-Za-z0-9_\-.+/=~]{12,})/gi,
			STD_START,
		),
		replacement: "Authorization: [REDACTED]",
		gate: (_text, lower) => lower().includes("authorization"),
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
		gate: has("-----BEGIN"),
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
		gate: (_text, lower) => ENV_KEY_GATE.test(lower()),
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
		gate: (_text, lower) => lower().includes("cookie:"),
	},
	{
		name: "api_key_header",
		pattern: tokenPattern(STD_START, "x-", String.raw`X-(?:Api-Key|Auth-Token):[ \t]*\S{8,}`, "gi"),
		replacement: "[REDACTED:api_key_header]",
		gate: (_text, lower) => lower().includes("x-api-key:") || lower().includes("x-auth-token:"),
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
		gate: (text) => text.includes("://") && text.includes("@"),
	},
	{
		name: "stripe_live_key",
		pattern: tokenPattern(DISTINCT_START, "sk_live_", String.raw`sk_live_[A-Za-z0-9]{24,}`),
		replacement: "[REDACTED:stripe_live_key]",
		gate: has("sk_live_"),
	},
	{
		name: "huggingface_token",
		pattern: tokenPattern(STD_START, "hf_", String.raw`hf_[A-Za-z0-9]{30,}`),
		replacement: "[REDACTED:huggingface_token]",
		gate: has("hf_"),
	},
	{
		name: "gitlab_token",
		pattern: tokenPattern(DISTINCT_START, "glpat-", String.raw`glpat-[A-Za-z0-9_-]{20,}`),
		replacement: "[REDACTED:gitlab_token]",
		gate: has("glpat-"),
	},
	{
		name: "npm_token",
		pattern: tokenPattern(STD_START, "npm_", String.raw`npm_[A-Za-z0-9]{36}\b`),
		replacement: "[REDACTED:npm_token]",
		gate: has("npm_"),
	},
	{
		name: "json_secret_value",
		pattern: JSON_SECRET_VALUE_PATTERN,
		replacement: (match) => {
			const escaped = match.startsWith('\\"');
			const head = match.slice(0, match.indexOf(":") + 1);
			return `${head} ${escaped ? '\\"[REDACTED]\\"' : '"[REDACTED]"'}`;
		},
		gate: (_text, lower) => JSON_KEY_GATE.test(lower()),
	},
	{
		name: "object_literal_secret",
		pattern: OBJECT_LITERAL_SECRET_PATTERN,
		replacement: (match) => {
			const quote = /:[ \t]*(['"])/.exec(match)?.[1] ?? '"';
			return `${match.slice(0, match.indexOf(":") + 1)} ${quote}[REDACTED]${quote}`;
		},
		gate: (_text, lower) => OBJECT_KEY_GATE.test(lower()),
	},
	{
		name: "name_value_secret",
		pattern: NAME_VALUE_SECRET_PATTERN,
		replacement: (match) => `${/^[\s\S]*?"value"\s*:/.exec(match)?.[0] ?? ""} "[REDACTED]"`,
		gate: (_text, lower) => lower().includes('"name"'),
	},
	{
		name: "yaml_secret_value",
		pattern: YAML_SECRET_VALUE_PATTERN,
		replacement: (match) => `${match.slice(0, match.indexOf(":") + 1)} [REDACTED]`,
		gate: (_text, lower) => YAML_KEY_GATE.test(lower()),
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
			/--(?:(?:client|access|auth|api|refresh|bearer)-)?(?:password|token|secret|api-key)(?:-file|-path)?(?:=|[ \t]+)(?!\[REDACTED(?::[a-z_]+)?\](?:\s|$))\S+/g,
		replacement: (match) => `${match.slice(0, match.search(/[=\s]/) + 1)}[REDACTED]`,
		gate: (text) => CLI_FLAG_GATE.test(text),
	},
	{
		name: "curl_user",
		// `-u`/`--user name:secret`, or short flags ending in u (`-sSu name:secret`),
		// in a curl command: the flag follows a space or a backslash-newline
		// continuation and `curl` is at most 500 characters before it. The cheap
		// tests come first and the look-behind for `curl` last, so the cost is
		// paid only at the few places a `-u` flag sits, not at every `curl`.
		pattern:
			/(?<=[ \t]|\\\n)(?=(?:-[A-Za-z]{0,8}u|--user)[ =]?["']?[^\s:"']{1,256}:)(?<=\bcurl\b(?:[^\n]|\\\n){0,500})(?:-[A-Za-z]{0,8}u|--user)[ =]?["']?[^\s:"']{1,256}:(?!\[REDACTED(?::[a-z_]+)?\](?:[\s"']|$))[^\s"']+/g,
		replacement: (match) =>
			match.replace(
				/^((?:-[A-Za-z]{0,8}u|--user)[ =]?["']?[^\s:"']{1,256}:)[^\s"']+$/,
				"$1[REDACTED]",
			),
		gate: has("curl"),
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
	const allRules = extraRules.length > 0 ? [...DEFAULT_RULES, ...extraRules] : DEFAULT_RULES;

	let text = input;
	// The lower-cased text is needed only by the gates, and only again after a rule changed `text`.
	let lowered: string | null = null;
	const lower = (): string => {
		lowered ??= text.toLowerCase();
		return lowered;
	};
	for (const rule of allRules) {
		// A gate is a necessary condition judged on the text as it stands now, so an
		// earlier rule's replacement can never hide an anchor from a later rule.
		if (rule.gate && !rule.gate(text, lower)) continue;
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
		if (hits.length > 0 && hits[hits.length - 1]?.rule === rule.name) lowered = null;
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

const KEY_NAME_PATTERN = new RegExp(`^(?:${JSON_SECRET_KEY})$`, "i");
const PLACEHOLDER_PATTERN = new RegExp(`^(?:${JSON_NOT_A_SECRET})$`, "i");

/** True when `name` is a key the JSON rule would treat as naming a secret (`api_key`, `Authorization`). */
export function isSecretKeyName(name: string): boolean {
	return name.length <= 80 && KEY_NAME_PATTERN.test(name);
}

/** True when `value` is a type name or a placeholder, not a secret (`string`, `${API_KEY}`, `Bearer `). */
export function isPlaceholderValue(value: string): boolean {
	return value.length <= 200 && PLACEHOLDER_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------
// The sliced engine (AGEN-146). `redact()` runs every rule over the whole text in one
// synchronous call, which at hundreds of KiB holds the event loop for tens of ms. A
// job runs the same rules in the same order, but a pass works through fixed windows
// of the current text so a caller can stop between windows.
// ---------------------------------------------------------------------------------

/** Characters of each rule pass a window accepts matches from. */
export const REDACTION_CHUNK = 16 * 1024;
/** Look-behind kept in front of a window: the longest bounded one is `curl_user`'s 500. */
export const REDACTION_BEFORE = 600;
/**
 * Look-ahead kept behind a window. A match is only accepted when it ends at least this far
 * short of the window's end, and a window ends at a line break when one lies this close, so
 * a quoted value of up to this many characters is always seen whole.
 */
export const REDACTION_AFTER = 4096;
/** The most a window may grow for one match; a match still touching the edge then is cut. */
export const REDACTION_MAX_EXTENSION = 64 * 1024;
/** What replaces a run no rule could finish within `REDACTION_MAX_EXTENSION`. */
export const RUN_TOO_LONG_MARKER = "[REDACTED:run_too_long]";

/**
 * Markers that stand for text nobody scanned or could show (a run too long, an event the
 * ingest step could not afford to scan, a cut leaf, a failed rule). A reader that decides
 * something from text must treat the text next to one as unknown, not as clean.
 */
export const FAIL_CLOSED_MARKER_PATTERN =
	/\[REDACTED:(?:redaction_backlog|redaction_error|over_limit|run_too_long|too_deep|too_large)\]/;

// Neither a newline nor a word character: stands in for the text before a window so
// `^` (with the `m` flag) and `\b` don't read the window's edge as a line or word start.
const WINDOW_SENTINEL = "\u0001";
const LINE_REST = /[^\n]*/g;

export interface RedactionJobOptions {
	chunk?: number;
	before?: number;
	after?: number;
	maxExtension?: number;
}

export interface RedactionJobStep {
	done: boolean;
	/** Characters scanned by this call (the window's own characters, plus rescans after growing). */
	units: number;
}

export interface RedactionJobResult {
	text: string;
	hits: number;
	/** Runs replaced by `RUN_TOO_LONG_MARKER`. */
	runsCut: number;
}

export interface RedactionJob {
	/** Work for at most `maxMs` or `maxUnits` characters (at least one window or gate), then return. */
	step(maxMs: number, maxUnits?: number): RedactionJobStep;
	readonly done: boolean;
	result(): RedactionJobResult;
}

/**
 * Same rules, same order and same output as `redact(text)` (no extra rules), in slices.
 * Equality holds for every input where no match looks more than `before` characters
 * behind its start, or more than `after` past its end without touching the edge (the
 * window then grows). The one documented gap is an unbounded `\s*` look-behind that
 * reaches back further than `before`.
 */
export function createRedactionJob(input: string, options: RedactionJobOptions = {}): RedactionJob {
	const chunk = Math.max(1, options.chunk ?? REDACTION_CHUNK);
	const before = options.before ?? REDACTION_BEFORE;
	const after = options.after ?? REDACTION_AFTER;
	const maxExtension = options.maxExtension ?? REDACTION_MAX_EXTENSION;

	let src = input;
	let lowered: string | null = null;
	const lower = (): string => {
		lowered ??= src.toLowerCase();
		return lowered;
	};
	let ruleIndex = 0;
	let inPass = false;
	let pos = 0;
	let emitted = 0;
	let out: string[] = [];
	let passHit = false;
	let hitCount = 0;
	let runsCut = 0;

	const startPass = (): number => {
		// A rule whose gate fails costs the gate alone.
		const rule = DEFAULT_RULES[ruleIndex];
		if (!rule) return 0;
		if (rule.gate && !rule.gate(src, lower)) {
			ruleIndex++;
			return Math.ceil(src.length / 128) + 1;
		}
		inPass = true;
		pos = 0;
		emitted = 0;
		out = [];
		passHit = false;
		return Math.ceil(src.length / 128) + 1;
	};

	const endPass = (): void => {
		if (passHit) {
			out.push(src.slice(emitted));
			src = out.join("");
			lowered = null;
		}
		out = [];
		inPass = false;
		ruleIndex++;
	};

	// The window being scanned. It outlives a `step()` call because a match that comes too
	// near the window's end makes the window grow, and each regrowth is a separate slice.
	interface Window {
		limit: number;
		winStart: number;
		offset: number;
		prefix: string;
		winEnd: number;
		win: string;
		cap: number;
		resumeAt: number;
		reached: number;
	}
	let w: Window | null = null;

	/**
	 * Advances the current pass by one window, or by one regrowth of it. Returns the
	 * characters scanned. A match is accepted only when it ends at least `after`
	 * characters short of the window's end (or the window ends with the text), so every
	 * decision saw `after` characters of what follows it.
	 */
	const runWindow = (rule: RedactionRule): number => {
		const n = src.length;
		let scanned = 0;
		if (!w) {
			let limit = Math.min(n, pos + chunk);
			if (limit < n) {
				// End the window just after a line break when one is near: every rule but the
				// PEM block stops at a line end, so no decision then depends on what follows.
				const brk = src.indexOf("\n", limit);
				if (brk !== -1 && brk - limit < after) limit = brk + 1;
			}
			const winStart = Math.max(0, pos - before);
			const prefix = winStart > 0 ? WINDOW_SENTINEL : "";
			const winEnd = Math.min(n, limit + after);
			w = {
				limit,
				winStart,
				offset: winStart - prefix.length,
				prefix,
				winEnd,
				win: prefix + src.slice(winStart, winEnd),
				cap: limit + after + maxExtension,
				resumeAt: pos,
				reached: limit,
			};
			scanned = limit - pos;
		}
		const cur = w;
		const re = rule.pattern;
		re.lastIndex = cur.resumeAt - cur.offset;
		for (;;) {
			const m = re.exec(cur.win);
			if (!m) break;
			const start = m.index + cur.offset;
			if (start >= cur.limit) break;
			let end = start + m[0].length;
			if (cur.winEnd < n && end > cur.winEnd - after) {
				if (cur.winEnd < cur.cap) {
					cur.winEnd = Math.min(n, cur.cap, cur.winEnd + Math.max(after, cur.winEnd - cur.limit));
					cur.win = cur.prefix + src.slice(cur.winStart, cur.winEnd);
					cur.resumeAt = start;
					return scanned + cur.win.length;
				}
				// Still too near the edge at the cap: mask the rest of the line.
				LINE_REST.lastIndex = end;
				const rest = LINE_REST.exec(src);
				end = rest ? end + rest[0].length : n;
				out.push(src.slice(emitted, start), RUN_TOO_LONG_MARKER);
				emitted = end;
				passHit = true;
				hitCount++;
				runsCut++;
				cur.reached = Math.max(cur.reached, end);
				break;
			}
			const replacement =
				typeof rule.replacement === "function" ? rule.replacement(m[0]) : rule.replacement;
			out.push(src.slice(emitted, start), replacement);
			emitted = end;
			passHit = true;
			hitCount++;
			cur.reached = Math.max(cur.reached, end);
			re.lastIndex = end === start ? end - cur.offset + 1 : end - cur.offset;
		}
		pos = Math.max(cur.limit, cur.reached);
		w = null;
		return scanned;
	};

	return {
		get done() {
			return ruleIndex >= DEFAULT_RULES.length;
		},
		step(maxMs: number, maxUnits = Number.POSITIVE_INFINITY): RedactionJobStep {
			const started = performance.now();
			let units = 0;
			do {
				if (ruleIndex >= DEFAULT_RULES.length) break;
				if (!inPass) {
					units += startPass();
					continue;
				}
				// A window costs up to `chunk`; one that would carry this slice past its budget waits for the next.
				if (units > 0 && !w && units + chunk > maxUnits) break;
				const rule = DEFAULT_RULES[ruleIndex] as RedactionRule;
				units += runWindow(rule);
				if (!w && pos >= src.length) endPass();
			} while (units < maxUnits && performance.now() - started < maxMs);
			return { done: ruleIndex >= DEFAULT_RULES.length, units };
		},
		result(): RedactionJobResult {
			if (ruleIndex < DEFAULT_RULES.length) {
				throw new Error("redaction job is not finished");
			}
			return { text: src, hits: hitCount, runsCut };
		},
	};
}
