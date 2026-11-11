/**
 * Fake secrets for the redaction tests, one per built-in rule family. Every value is
 * built at run time from short pieces, so no realistic key appears in the source.
 * `secret` is the part that must be gone from the output.
 */
export interface RedactionSample {
	family: string;
	/** The text as an agent would show it. */
	text: string;
	/** A substring of `text` that must not survive redaction. */
	secret: string;
}

const pem = (kind: string, lines = 4): string => {
	const body = Array.from({ length: lines }, (_, i) =>
		`${"QUJD".repeat(15)}${String(i).padStart(2, "0")}`.slice(0, 64),
	).join("\n");
	return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
};

export function redactionSamples(): RedactionSample[] {
	const s = (family: string, text: string, secret: string): RedactionSample => ({
		family,
		text,
		secret,
	});
	const anth = `sk-ant-${"api03-"}${"A".repeat(40)}`;
	const orv = `sk-or-${"v1-"}${"a".repeat(30)}`;
	const oai = `sk-${"proj-"}${"B".repeat(30)}`;
	const goog = `AIza${"C".repeat(35)}`;
	const ghp = `ghp_${"d".repeat(36)}`;
	const pat = `github_pat_${"E".repeat(30)}`;
	const ap = `ap_${"a1".repeat(16)}`;
	const aps = `aps_${"b2".repeat(16)}`;
	const tg = `123456789:${"F".repeat(35)}`;
	const aws = `AKIA${"ABCDEFGH12345678"}`;
	const slack = `xoxb-${"1234567890-abcdef"}`;
	const hook = `hooks.slack.com/services/T0AAAA/B0BBBB/${"c".repeat(12)}`;
	const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;
	const stripe = `sk_live_${"g".repeat(26)}`;
	const hf = `hf_${"h".repeat(34)}`;
	const gl = `glpat-${"i".repeat(24)}`;
	const npm = `npm_${"j".repeat(36)}`;
	return [
		s("anthropic", anth, anth),
		s("openrouter", orv, orv),
		s("openai", oai, oai),
		s("google", goog, goog),
		s("github_token", ghp, ghp),
		s("github_pat", pat, pat),
		s("ap", ap, ap),
		s("aps", aps, aps),
		s("telegram", tg, tg),
		s("aws", aws, aws),
		s("slack", slack, slack),
		s("slack_webhook", hook, "c".repeat(12)),
		s("jwt", jwt, jwt),
		s("authorization", `Authorization: Bearer ${"x".repeat(20)}`, "x".repeat(20)),
		s("pem", pem("RSA PRIVATE KEY"), "QUJDQUJD"),
		s("env", "DB_PASSWORD=hunter2hunter2", "hunter2hunter2"),
		s("cookie", "Cookie: sid=abc123def; theme=dark", "abc123def"),
		s("api_key_header", `X-Api-Key: ${"k".repeat(20)}`, "k".repeat(20)),
		s("url_userinfo", "https://user:hunter2pw@example.test/path", "hunter2pw"),
		s("stripe", stripe, stripe),
		s("huggingface", hf, hf),
		s("gitlab", gl, gl),
		s("npm", npm, npm),
		s("aws_session", "ASIA0123456789ABCDEF", "ASIA0123456789ABCDEF"),
		s("json", '{"password":"hunter2hunter2"}', "hunter2hunter2"),
		s("json_credentials", '{"credentials":"hunter2hunter2"}', "hunter2hunter2"),
		s("json_key_id", '{"private_key_id":"hunter2hunter2"}', "hunter2hunter2"),
		s("json_connection_string", '{"connection_string":"hunter2hunter2"}', "hunter2hunter2"),
		s("json_escaped", '{\\"api_key\\":\\"hunter2hunter2\\"}', "hunter2hunter2"),
		s("object_credentials", "{ credentials: 'hunter2hunter2' }", "hunter2hunter2"),
		s("yaml_secret", "client_secret: abcdefghijkl", "abcdefghijkl"),
		s("env_secret_key", "SECRET_KEY=hunter2hunter2", "hunter2hunter2"),
		s("env_apikey", "export APIKEY=hunter2hunter2", "hunter2hunter2"),
		s("x_auth_token", `X-Auth-Token: ${"m".repeat(20)}`, "m".repeat(20)),
		s("set_cookie", "Set-Cookie: sid=abc123def; Path=/", "abc123def"),
		s("cli_api_key", "run --api-key abcdefghij now", "abcdefghij"),
		s("object_literal", "{ password: 'hunter2hunter2' }", "hunter2hunter2"),
		s("name_value", '{"name":"DB_PASSWORD","value":"abcdefgh"}', "abcdefgh"),
		s("yaml", "api_key: abcdefghijkl", "abcdefghijkl"),
		s("cli_flag", "run --token abcdefghij now", "abcdefghij"),
		s("curl_user", "curl -u bob:hunter2pw https://example.test", "hunter2pw"),
	];
}

/** Nine ways a secret reaches stored text. */
export function inShapes(sample: string): string[] {
	return [
		sample,
		`before ${sample} after`,
		`line one\n${sample}\nline three`,
		`line one\r\n${sample}\r\nline three`,
		JSON.stringify({ output: `ran it\n${sample}\n` }),
		`"${sample}"`,
		`KEY=${sample}`,
		`${"lorem ipsum dolor ".repeat(60)}${sample}`,
		`${sample}${" tail".repeat(80)}`,
	];
}

/** Deterministic pseudo-random numbers (no Math.random: failures must reproduce). */
export function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

const SOUP = [
	"password",
	":",
	"=",
	'"',
	"'",
	"{",
	"}",
	"\n",
	" ",
	"token",
	"key",
	"secret_key",
	"credentials",
	"private_key_id",
	"connection_string",
	"Cookie:",
	"curl",
	"-u",
	"--",
	"--token",
	"://",
	"@",
	"sk-",
	"sk-ant-",
	"ghp_",
	"AKIA",
	"a",
	"b",
	"123456",
	"\t",
	"eyJ",
	".",
	"-----BEGIN PRIVATE KEY-----",
	"-----END PRIVATE KEY-----",
	"Authorization",
	"Bearer",
	"X-Api-Key:",
	"api_key",
	"hunter2hunter2",
	"_",
	"name",
	'"name"',
	"value",
	'"value":',
	"[",
	"]",
	",",
	"[REDACTED]",
	"[REDACTED:jwt]",
	"\\n",
	'\\"',
	"%0A",
	"\u001b[31m",
	"NAME",
	"PASSWORD",
	"xoxb-",
	"glpat-",
	"npm_",
	"hf_",
	"AIza",
	"ap_",
];

/** Token-soup strings that touch every rule's anchors. */
export function fuzzCorpus(count: number, seed = 1): string[] {
	const rnd = seededRandom(seed);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		let s = "";
		const n = 5 + Math.floor(rnd() * 60);
		for (let j = 0; j < n; j++) s += SOUP[Math.floor(rnd() * SOUP.length)];
		out.push(s);
	}
	return out;
}
