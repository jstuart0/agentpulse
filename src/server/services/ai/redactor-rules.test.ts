/**
 * AGEN-69 phase 2b: the redaction rules added for the session summary, the
 * linear-time rewrite of `env_assignment_secret`, and the over-match guards
 * (TC-2.8, TC-2.9, TC-2.10). These rules also change what the watcher and Ask
 * send, so the benign corpus here is the regression net for those prompts.
 */
import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "../../../shared/types.js";
import benign from "./__fixtures__/redaction-benign.json";
import { buildWatcherContext } from "./context.js";
import { DEFAULT_RULES, redact } from "./redactor.js";

const repeat = (s: string, n: number) => s.repeat(n);

/** A fake secret value built at run time so no literal looks like a real key. */
const fake = (prefix: string, tail: string, length: number): string =>
	prefix + tail.repeat(Math.ceil(length / tail.length)).slice(0, length);

function expectHit(input: string, rule: string, secrets: string[]): string {
	const { text, hits } = redact(input);
	for (const secret of secrets) expect(text).not.toContain(secret);
	expect(hits.map((h) => h.rule)).toContain(rule);
	return text;
}

function expectUntouched(input: string): void {
	const { text, hits } = redact(input);
	expect({ text, hits: hits.length }).toEqual({ text: input, hits: 0 });
}

describe("TC-2.8 json_secret_value", () => {
	const keys = [
		"password",
		"passwd",
		"secret",
		"client_secret",
		"api_key",
		"apikey",
		"api_token",
		"access_token",
		"refresh_token",
		"auth_token",
		"token",
		"private_key",
	];
	for (const key of keys) {
		test(`TC-2.8 "${key}" with a quoted value of 6 or more is redacted and the key stays`, () => {
			const text = expectHit(`{"${key}":"hunter2hunter2"}`, "json_secret_value", ["hunter2"]);
			expect(text).toContain(`"${key}"`);
			expect(text).toContain("[REDACTED]");
		});
	}

	test("TC-2.8 the key is matched case-insensitively and with a space before the value", () => {
		expectHit('{"Password": "hunter2hunter2"}', "json_secret_value", ["hunter2"]);
	});

	test("TC-2.8 an escaped quote inside the value does not end the redaction early", () => {
		expectHit('{"password":"ab\\"cdefghij"}', "json_secret_value", ["cdefghij"]);
	});

	test("TC-2.8 a value of 5 characters is left alone, 6 is not", () => {
		expectUntouched('{"token":"abcde"}');
		expectHit('{"token":"abcdef"}', "json_secret_value", ["abcdef"]);
	});

	test("TC-2.8 a value another rule already masked is not masked a second time", () => {
		const { hits } = redact('{"api_key":"sk-ant-api03-abcdefghijklmnopqrstuvwxyz12"}');
		expect(hits.map((h) => h.rule)).toEqual(["anthropic_api_key"]);
	});

	test("TC-2.8 max_tokens, token_count and password_hint are not keys", () => {
		expectUntouched('{"max_tokens": 4000}');
		expectUntouched('{"token_count": 5}');
		expectUntouched('{"password_hint": "your first pet"}');
		expectUntouched('{"max_tokens": "4000000"}');
	});
});

describe("TC-2.8 yaml_secret_value", () => {
	test("TC-2.8 a line-start key with a value of 8 or more is redacted, the key stays", () => {
		const text = expectHit("password: hunter2hunter2", "yaml_secret_value", ["hunter2"]);
		expect(text).toBe("password: [REDACTED]");
	});

	test("TC-2.8 indentation, a list dash, quotes, a trailing comment and other keys are covered", () => {
		expectHit("db:\n  api_key: sk_abcdefgh12\n", "yaml_secret_value", ["abcdefgh12"]);
		expectHit("- token: abcdef123456", "yaml_secret_value", ["abcdef123456"]);
		expectHit('secret: "quotedvalue99"', "yaml_secret_value", ["quotedvalue99"]);
		expectHit("access_token: abcdefgh12 # rotate me", "yaml_secret_value", ["abcdefgh12"]);
		expectHit("client_secret: abcdefgh12", "yaml_secret_value", ["abcdefgh12"]);
	});

	test("TC-2.8 the neighbouring lines survive", () => {
		const { text } = redact("name: demo\npassword: hunter2hunter2\nport: 5432\n");
		expect(text).toBe("name: demo\npassword: [REDACTED]\nport: 5432\n");
	});

	test("TC-2.8 code and type annotations are not secrets", () => {
		for (const line of [
			"token: Promise<string>",
			"password: string;",
			"secret: true",
			"secretName: my-secret",
			"token: null",
			"token: abcdefg",
			"password: ${DB_PASSWORD}",
			"secret: getSecret(name)",
			"token: { value: abcdefghij }",
			"password: undefined",
		]) {
			expectUntouched(line);
		}
	});

	test("TC-2.8 BN-3: a bracketed, piped, semicolon or comma value is not masked", () => {
		for (const line of [
			"api_key: Optional[str]",
			"token: string | undefined",
			"password: abcdefgh,",
			"secret: abcdefgh;",
		]) {
			expectUntouched(line);
		}
	});

	test("TC-2.8 the key must start the line", () => {
		expectUntouched("see password: hunter2hunter2 in the docs");
		expectUntouched("see password: hunter2hunter2");
		expectUntouched("note password: hunter2hunter2");
	});
});

describe("TC-2.8 url_userinfo", () => {
	test("TC-2.8 user and password in a URL are redacted, the rest of the URL stays", () => {
		const text = expectHit("open https://user:pa55word@host/p now", "url_userinfo", ["pa55word"]);
		expect(text).toContain("https://");
		expect(text).toContain("@host/p now");
		expectHit("postgres://u:p4ssw0rd@h/db", "url_userinfo", ["p4ssw0rd"]);
	});

	test("TC-2.8 BN-2: an empty username is covered", () => {
		const text = expectHit("redis://:s3cretvalue@host:6379", "url_userinfo", ["s3cretvalue"]);
		expect(text).toContain("@host:6379");
		expectHit("amqp://:guestpw1@broker:5672/vhost", "url_userinfo", ["guestpw1"]);
	});

	test("TC-2.8 URLs without userinfo are untouched", () => {
		for (const s of [
			"http://localhost:3000/@scope/pkg",
			"git@github.com:org/repo",
			"ssh://git@host/x",
			"user@example.com",
			"https://example.com:443/path",
			"http://[::1]:3000/@x",
		]) {
			expectUntouched(s);
		}
	});
});

describe("TC-2.8 pem_private_key", () => {
	const body = repeat("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n", 20);

	test("TC-2.8 a complete multi-line key is redacted in full and text after it survives", () => {
		const input = `before\n-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\nafter text`;
		const text = expectHit(input, "pem_private_key", ["MIIEvQIBADANBg", "END PRIVATE KEY"]);
		expect(text).toBe("before\n[REDACTED:pem_private_key]\nafter text");
	});

	test("TC-2.8 RSA, EC and OpenSSH headers are covered", () => {
		for (const kind of [
			"RSA PRIVATE KEY",
			"EC PRIVATE KEY",
			"OPENSSH PRIVATE KEY",
			"ENCRYPTED PRIVATE KEY",
		]) {
			expectHit(`-----BEGIN ${kind}-----\n${body}-----END ${kind}-----`, "pem_private_key", [
				"MIIEvQIBADANBg",
			]);
		}
	});

	test("TC-2.8 a BEGIN with no END is redacted too", () => {
		expectHit(`-----BEGIN RSA PRIVATE KEY-----\n${body}`, "pem_private_key", ["MIIEvQIBADANBg"]);
	});

	test("TC-2.8 a public key and a certificate are untouched", () => {
		expectUntouched(`-----BEGIN PUBLIC KEY-----\n${body}-----END PUBLIC KEY-----`);
		expectUntouched(`-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----`);
	});
});

describe("TC-2.8 token prefixes", () => {
	const cases: Array<[string, string, string]> = [
		["stripe_live_key", "sk_live_", fake("", "aB3dE5fG7h", 26)],
		["huggingface_token", "hf_", fake("", "aB3dE5fG7h", 34)],
		["gitlab_token", "glpat-", fake("", "aB3dE-5fG_7h", 22)],
		["npm_token", "npm_", fake("", "aB3dE5fG7h", 36)],
	];
	for (const [rule, prefix, tail] of cases) {
		test(`TC-2.8 ${prefix}... is redacted (${rule})`, () => {
			const token = prefix + tail;
			const text = expectHit(`export KEY_IN_USE ${token} done`, rule, [tail]);
			expect(text).toContain("[REDACTED:");
		});
	}

	test("TC-2.8 too-short values and look-alikes are untouched", () => {
		for (const s of [
			"npm_config_registry",
			"hf_hub_download",
			"sk_live_short",
			"hf_abc",
			"glpat-short",
			`npm_${fake("", "aB3dE5fG7h", 20)}`,
			"my_npm_package",
		]) {
			expectUntouched(s);
		}
	});

	test("TC-2.8 an npm token of exactly 36 is redacted and 36 inside a longer run is not split", () => {
		const exact = `npm_${fake("", "aB3dE5fG7h", 36)}`;
		expectHit(exact, "npm_token", [exact]);
	});
});

describe("TC-2.8 cookie_header", () => {
	test("TC-2.8 Cookie and Set-Cookie lines are redacted to the end of the line only", () => {
		const t1 = expectHit("GET /\nCookie: sid=abc123def; theme=dark\nHost: x", "cookie_header", [
			"abc123def",
		]);
		expect(t1.startsWith("GET /\n")).toBe(true);
		expect(t1.endsWith("\nHost: x")).toBe(true);
		expectHit("Set-Cookie: id=zz9plural; HttpOnly; Secure", "cookie_header", ["zz9plural"]);
		expectHit("curl -H 'cookie: a=b1c2d3e4'", "cookie_header", ["b1c2d3e4"]);
	});

	test("TC-2.8 the word cookie in prose is untouched", () => {
		expectUntouched("Please accept the cookie policy to continue.");
		expectUntouched("the cookie: chocolate chip");
		expectUntouched("Cookies are small files");
	});

	test("TC-2.8 a header line of any length is redacted whole, with no cap", () => {
		const long = `Cookie: a=${"b".repeat(60000)}\nHost: x`;
		expect(redact(long).text).toBe("[REDACTED:cookie_header]\nHost: x");
	});
});

describe("TC-2.8 cli_secret_flag", () => {
	test("TC-2.8 the space form is redacted, the flag stays", () => {
		expect(expectHit("run --token abc123xyz now", "cli_secret_flag", ["abc123xyz"])).toBe(
			"run --token [REDACTED] now",
		);
		expectHit("run --password hunter2 now", "cli_secret_flag", ["hunter2"]);
		expectHit("--secret x1y2z3", "cli_secret_flag", ["x1y2z3"]);
		expectHit("--api-key sk1234", "cli_secret_flag", ["sk1234"]);
	});

	test("TC-2.8 the = form is redacted, by this rule for --api-key and by env_assignment_secret otherwise", () => {
		expectHit("--api-key=sk1234", "cli_secret_flag", ["sk1234"]);
		expect(expectHit("run --password=hunter2 now", "env_assignment_secret", ["hunter2"])).toBe(
			"run --password= [REDACTED] now",
		);
		expect(redact("--secret=x1y2z3").text).not.toContain("x1y2z3");
	});

	test("TC-2.8 --tokens 5 and --passwordless are untouched", () => {
		expectUntouched("node build.js --tokens 5");
		expectUntouched("node build.js --passwordless");
	});

	test("TC-2.8 --token-file path is hit, pinned as an accepted over-match", () => {
		expect(expectHit("tool --token-file /etc/path/x", "cli_secret_flag", ["/etc/path/x"])).toBe(
			"tool --token-file [REDACTED]",
		);
	});
});

describe("TC-2.8 curl_user", () => {
	test("TC-2.8 -u and --user with name:secret are redacted, the name stays", () => {
		const t = expectHit("curl -u admin:pw123abc https://example.com/x", "curl_user", ["pw123abc"]);
		expect(t).toContain("-u admin:[REDACTED]");
		expect(t).toContain("https://example.com/x");
		expectHit("curl --user n:s3cr3t https://example.com", "curl_user", ["s3cr3t"]);
		expectHit("curl -s -L -u name:secr3t -o out https://example.com", "curl_user", ["secr3t"]);
		expectHit("curl -u 'name:quoted1' https://example.com", "curl_user", ["quoted1"]);
	});

	test("TC-2.8 a secret that itself contains a colon is covered", () => {
		expectHit("curl -u name:part1:part2 https://example.com", "curl_user", ["part1", "part2"]);
	});

	test("TC-2.8 -u with no colon, a non-curl command and curl without -u are untouched", () => {
		expectUntouched("curl -u name https://example.com");
		expectUntouched("ls -u a:b");
		expectUntouched("curl -I https://example.com/path");
	});
});

describe("TC-2.8 api_key_header", () => {
	test("TC-2.8 X-Api-Key and X-Auth-Token with 8 or more characters are redacted", () => {
		expectHit("X-Api-Key: abcdefgh12", "api_key_header", ["abcdefgh12"]);
		expectHit("x-auth-token: 12345678", "api_key_header", ["12345678"]);
		expectHit("curl -H 'X-Api-Key: k3y-v4lue-x' https://example.com", "api_key_header", [
			"k3y-v4lue-x",
		]);
	});

	test("TC-2.8 the bare header name, a short value and a value on the next line are untouched", () => {
		expectUntouched("X-Api-Key");
		expectUntouched("X-Api-Key:");
		expectUntouched("X-Api-Key: short");
		expectUntouched("X-Api-Key:\nabcdefghij");
	});
});

// ── TC-2.9 ────────────────────────────────────────────────────────────────────

/** The `env_assignment_secret` rule as it stood before phase 2b: the oracle. */
const OLD_ENV_PATTERN =
	/(^|[^A-Za-z0-9])((?:[A-Z][A-Z0-9]*_)*(?:PASSWORD|SECRET|API_KEY|APIKEY|TOKEN|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN))\s*=\s*["']?[^\s"'\n]{4,}/gi;
const oldEnvReplacement = (match: string) => `${match.slice(0, match.indexOf("=") + 1)} [REDACTED]`;

function applyRule(
	pattern: RegExp,
	replacement: string | ((m: string) => string),
	input: string,
): { text: string; count: number } {
	let count = 0;
	pattern.lastIndex = 0;
	const text = input.replace(pattern, (m: string) => {
		count++;
		return typeof replacement === "function" ? replacement(m) : replacement;
	});
	return { text, count };
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("TC-2.9 no regression", () => {
	test("TC-2.9 at least 30 benign watcher-style strings are byte-identical", () => {
		expect(benign.strings.length).toBeGreaterThanOrEqual(30);
		for (const s of benign.strings) {
			const { text, hits } = redact(s);
			expect({ s, text, hits: hits.map((h) => h.rule) }).toEqual({ s, text: s, hits: [] });
		}
	});

	test("TC-2.9 the rewritten env_assignment_secret equals the old rule on 3,000 seeded strings", () => {
		const rule = DEFAULT_RULES.find((r) => r.name === "env_assignment_secret");
		if (!rule) throw new Error("env_assignment_secret rule is missing");
		const keywords = [
			"PASSWORD",
			"SECRET",
			"API_KEY",
			"APIKEY",
			"TOKEN",
			"ACCESS_KEY",
			"PRIVATE_KEY",
			"AUTH_TOKEN",
		];
		const separators = ["=", " = ", "=\t", "  =  ", ":", " : ", "==", "=\n", "= ", " ="];
		const quotes = ["", "", '"', "'"];
		const boundaries = ["", " ", "\n", "-", ".", "x", "export ", "(", "_", "$", "\t"];
		const glue = [" ", "\n", ";", " && ", ", "];
		const valueChars = "abcxyz019-_./\"' \n=";
		const rand = mulberry32(20261003);
		const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
		const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
		const caseOf = (s: string) => {
			const mode = int(0, 3);
			return mode === 0
				? s.toLowerCase()
				: mode === 1
					? s
					: mode === 2
						? s[0] + s.slice(1).toLowerCase()
						: [...s].map((c) => (rand() < 0.5 ? c.toLowerCase() : c)).join("");
		};
		const segment = () => {
			const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
			let s = letters[int(0, 25)];
			const extra = int(0, 4);
			for (let i = 0; i < extra; i++) s += rand() < 0.2 ? String(int(0, 9)) : letters[int(0, 25)];
			return s;
		};
		let crossedBound = 0;
		let withMatch = 0;
		let withDifferentOutput = 0;
		const total = 3000;
		for (let n = 0; n < total; n++) {
			const pieces: string[] = [];
			const assignments = int(1, 3);
			for (let a = 0; a < assignments; a++) {
				const segments = rand() < 0.4 ? int(9, 20) : int(0, 8);
				if (segments > 8) crossedBound++;
				const prefix = Array.from({ length: segments }, () => `${segment()}_`).join("");
				let value = "";
				for (let i = int(0, 10); i > 0; i--) value += valueChars[int(0, valueChars.length - 1)];
				pieces.push(
					pick(boundaries) +
						caseOf(prefix + pick(keywords)) +
						pick(separators) +
						pick(quotes) +
						value,
				);
			}
			const input = pieces.join(pick(glue));
			const oracle = applyRule(OLD_ENV_PATTERN, oldEnvReplacement, input);
			const actual = applyRule(rule.pattern, rule.replacement, input);
			if (oracle.count > 0) withMatch++;
			if (oracle.text !== input) withDifferentOutput++;
			expect({ input, text: actual.text, count: actual.count }).toEqual({
				input,
				text: oracle.text,
				count: oracle.count,
			});
		}
		console.log(
			`[redactor-fuzz] ${total} strings, ${crossedBound} assignments past 8 prefix segments, ${withMatch} strings with a match, ${withDifferentOutput} changed by the rule; new rule equals old on all`,
		);
		expect(total).toBeGreaterThanOrEqual(2000);
		expect(crossedBound).toBeGreaterThan(500);
		expect(withMatch).toBeGreaterThan(1000);
		expect(withDifferentOutput).toBeGreaterThan(1000);
	});

	test("TC-2.9 a key of 12 prefix segments is still redacted (the {0,8} bound is a performance bound, not a behaviour: the match starts inside the key)", () => {
		const key = `${repeat("AB_", 12)}PASSWORD`;
		const { text } = redact(`${key}=hunter2hunter2`);
		expect(text).toBe(`${key}= [REDACTED]`);
	});

	test("TC-2.9 the watcher context passes benign text through unchanged and masks only the intended hit", () => {
		const session = {
			id: "s-1",
			sessionId: "sess-1",
			displayName: "brave-falcon",
			agentType: "claude_code",
			status: "active",
			cwd: "/Users/test/project",
			transcriptPath: null,
			model: "claude-sonnet-4-6",
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			endedAt: null,
			semanticStatus: null,
			currentTask: "implement feature",
			planSummary: ["step one"],
			totalToolUses: 0,
			isWorking: false,
			isPinned: false,
			nameSource: "generated",
			nativeName: null,
			gitBranch: "main",
			claudeMdContent: null,
			claudeMdPath: null,
			claudeMdUpdatedAt: null,
			notes: null,
			metadata: {},
			projectId: null,
			isArchived: false,
			lastAgentTurnCompletedAt: null,
			lastUserAcknowledgedAt: null,
		} as Session;
		const contents = [...benign.watcherEvents, benign.watcherEventWithIntentionalHit];
		const events = contents.map(
			(content, i) =>
				({
					id: i + 1,
					sessionId: "sess-1",
					eventType: "UserPromptSubmit",
					category: "prompt",
					source: "observed_hook",
					content,
					isNoise: false,
					providerEventType: null,
					toolName: null,
					toolInput: null,
					toolResponse: null,
					rawPayload: {},
					createdAt: new Date().toISOString(),
				}) as SessionEvent,
		);
		const ctx = buildWatcherContext({ session, events, triggerType: "idle" });
		for (const content of benign.watcherEvents) expect(ctx.transcriptPrompt).toContain(content);
		expect(ctx.transcriptPrompt).toContain("max_tokens: 100");
		expect(ctx.transcriptPrompt).toContain("token count");
		expect(ctx.transcriptPrompt).toContain("http://localhost:3000/@scope/pkg");
		expect(ctx.transcriptPrompt).not.toContain("abc123def456");
		expect(ctx.transcriptPrompt).toContain("[REDACTED:cookie_header]");
		expect(ctx.redactionHits).toBe(1);
	});
});

// ── TC-2.10 ───────────────────────────────────────────────────────────────────

/** Adversarial inputs for the linear-time test, each built to about `size` characters. */
const ADVERSARIAL: Record<string, (size: number) => string> = {
	"unterminated -----BEGIN (repeated)": (n) => repeat("-----BEGIN ", Math.ceil(n / 11)),
	"unterminated -----BEGIN then one long run": (n) => `-----BEGIN ${repeat("A ", n / 2)}`,
	"unterminated -----BEGIN PRIVATE KEY----- then body": (n) =>
		`-----BEGIN PRIVATE KEY-----\n${repeat("MIIEvQIB\n", n / 9)}`,
	"repeated ://": (n) => repeat("://", Math.ceil(n / 3)),
	"repeated ://a: with no slash after": (n) => `://${repeat("a:", n / 2)}`,
	'repeated "password":"': (n) => repeat('"password":"', Math.ceil(n / 12)),
	'"password":" then one long run': (n) => `"password":"${repeat("a", n)}`,
	"a long Cookie: value": (n) => `Cookie: ${repeat("a=b; ", n / 5)}`,
	"a long Cookie: value without =": (n) => `Cookie: ${repeat("a", n)}`,
	"repeated Cookie:": (n) => repeat("Cookie:", Math.ceil(n / 7)),
	"A_A_A_...": (n) => repeat("A_", n / 2),
	"A_A_A_... PASSWORD=x": (n) => `${repeat("A_", n / 2)}PASSWORD=xxxxxxxx`,
	"repeated --token": (n) => repeat("--token", Math.ceil(n / 7)),
	"repeated curl ": (n) => repeat("curl ", n / 5),
	"PASSWORD then spaces": (n) => `PASSWORD${repeat(" ", n)}`,
	"password: then spaces": (n) => `password:${repeat(" ", n)}a`,
	"X-Api-Key: then spaces": (n) => `X-Api-Key:${repeat(" ", n)}`,
	"key: then one long value": (n) => `token: ${repeat("a", n)}`,
	"repeated yaml keys": (n) => repeat("token: abcdefghij\n", Math.ceil(n / 18)),
	// P2-16
	'"password":" then \\a with no closing quote': (n) => `"password":"${repeat("\\a", n / 2)}`,
	'repeated "password":"\\a': (n) => repeat('"password":"\\a', Math.ceil(n / 14)),
	"curl then backslash-newline, repeated": (n) => `curl ${repeat("\\\n", n / 2)}`,
	"repeated curl with backslash-newline": (n) => repeat("curl \\\n", n / 8),
	// P2-5
	"repeated -----BEGIN PRIVATE KEY-----": (n) =>
		repeat("-----BEGIN PRIVATE KEY-----", Math.ceil(n / 27)),
	"-----BEGIN RSA PRIVATE KEY----- with Proc-Type headers, no END": (n) =>
		`-----BEGIN RSA PRIVATE KEY-----\n${repeat("Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B\n", n / 50)}`,
	// P2-6, P2-9
	'repeated PASSWORD="': (n) => repeat('PASSWORD="', Math.ceil(n / 10)),
	'repeated PASSWORD=" with a space': (n) => repeat('PASSWORD=" ', Math.ceil(n / 11)),
	"PASSWORD=' then one long unterminated run": (n) => `PASSWORD='${repeat("a ", n / 2)}`,
	// P2-7
	"repeated Authorization:": (n) => repeat("Authorization: ", Math.ceil(n / 15)),
	"Authorization: Digest then a long run": (n) => `Authorization: Digest ${repeat('a="', n / 3)}`,
	"Authorization: then spaces": (n) => `Authorization:${repeat(" ", n)}`,
	// P2-8
	'a long key before "token"': (n) => `"${repeat("a", n)}token":"abcdefgh"`,
	'repeated "accessToken":"': (n) => repeat('"accessToken":"', Math.ceil(n / 15)),
	'repeated \\"password\\":\\"': (n) => repeat('\\"password\\":\\"', Math.ceil(n / 16)),
	// P2-10, P2-12, P2-13
	"repeated --client-secret": (n) => repeat("--client-secret ", Math.ceil(n / 16)),
	"repeated ://u:": (n) => repeat("://u:", Math.ceil(n / 5)),
	"://u: then one long run without @": (n) => `://u:${repeat("a", n)}`,
	"://u: then a long run of @": (n) => `://u:${repeat("@", n)}`,
	"curl then a long run of -sS": (n) => `curl ${repeat("-sS ", n / 4)}`,
	"yaml keys with 8 prefix segments, repeated": (n) =>
		repeat("A_B_C_D_E_F_G_H_token: abcdefghij\n", Math.ceil(n / 35)),
	"a long CRLF yaml file": (n) =>
		repeat("name: demo\r\npassword: hunter2hunter2\r\n", Math.ceil(n / 40)),
};

function bestOf(runs: number, input: string): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		redact(input);
		best = Math.min(best, performance.now() - start);
	}
	return best;
}

const HARD_CAP_MS_100KB = 1000;
const NOISE_FLOOR_MS = 15;
// Linear time is 4x for 4x the input, quadratic is 16x. A bound of 8x plus the
// noise floor fails any quadratic rule and a mildly quadratic one the old
// 200 KB / 3.5x form let through whenever the 100 KB run took under 30 ms.
const LINEARITY_FACTOR = 8;

describe("TC-2.10 linear time on adversarial input", () => {
	for (const [name, build] of Object.entries(ADVERSARIAL)) {
		test(`TC-2.10 ${name}: 100 KB finishes, 400 KB is under ${LINEARITY_FACTOR}x`, () => {
			const small = build(100_000);
			const start = performance.now();
			redact(small);
			const first = performance.now() - start;
			expect(first).toBeLessThan(HARD_CAP_MS_100KB);
			const t100 = bestOf(5, small);
			const t400 = bestOf(5, build(400_000));
			console.log(
				`[redactor-perf] ${name}: best of 5 -> 100KB ${t100.toFixed(1)} ms, 400KB ${t400.toFixed(1)} ms`,
			);
			expect(t400).toBeLessThan(LINEARITY_FACTOR * t100 + NOISE_FLOOR_MS);
		}, 120_000);
	}
});
