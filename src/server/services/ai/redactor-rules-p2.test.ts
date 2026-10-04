/**
 * AGEN-69 phase 2 review fixes (punch list P2-5 to P2-18): the redaction rules
 * after review. Every secret below is assembled at run time from an obviously
 * fake tail, so no literal here looks like a real key to a scanner.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import type { Session } from "../../../shared/types.js";
import benign from "./__fixtures__/redaction-benign.json";
import { oldRedact } from "./__fixtures__/redactor-old-rules.js";
import { buildWatcherContext } from "./context.js";
import { type RedactionRule, redact, stripAndRedact } from "./redactor.js";

const repeat = (s: string, n: number) => s.repeat(n);

/** A fake value built at run time: `prefix` + `tail` repeated to `length` characters. */
const fake = (prefix: string, tail: string, length: number): string =>
	prefix + tail.repeat(Math.ceil(length / tail.length)).slice(0, length);

/** `redact`, asserting every secret is gone. Returns the masked text. */
function masked(input: string, secrets: string[]): string {
	const { text } = redact(input);
	for (const secret of secrets) expect(text, `leaked ${secret}`).not.toContain(secret);
	return text;
}

function untouched(input: string, note = ""): void {
	const { text, hits } = redact(input);
	expect({ note, text, hits: hits.map((h) => h.rule) }).toEqual({
		note,
		text: input,
		hits: [],
	});
}

/** A seeded body of base64-looking characters, so a leaked window can be searched for. */
function keyBody(length: number, seed = 7): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let a = seed;
	let out = "";
	for (let i = 0; i < length; i++) {
		a = (Math.imul(a, 1103515245) + 12345) | 0;
		out += alphabet[(a >>> 16) % alphabet.length];
	}
	return out;
}
const wrapLines = (body: string, width = 64) =>
	body.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n");

function expectNoBodyLeft(text: string, body: string): void {
	const flat = body.replace(/\s/g, "");
	for (const i of [0, Math.floor(flat.length / 3), Math.floor(flat.length / 2), flat.length - 24]) {
		expect(text, `window at ${i} survived`).not.toContain(flat.slice(i, i + 16));
	}
	expect(text, "the tail of the key survived").not.toContain(flat.slice(-12));
}

// ── P2-5 private keys ────────────────────────────────────────────────────────

describe("P2-5 pem_private_key", () => {
	const after = "text after the key";

	test("P2-5 an 8,000-character body is redacted whole and the text after END survives", () => {
		const body = keyBody(8000);
		const input = `before\n-----BEGIN PRIVATE KEY-----\n${wrapLines(body)}\n-----END PRIVATE KEY-----\n${after}`;
		const text = masked(input, ["BEGIN PRIVATE", "END PRIVATE"]);
		expectNoBodyLeft(text, body);
		expect(text).toBe(`before\n[REDACTED:pem_private_key]\n${after}`);
	});

	test("P2-5 an RSA-4096-sized body (3.3 KB, past the old 4,000 cap with headers) leaves nothing", () => {
		const body = keyBody(3300, 11);
		const input = `-----BEGIN RSA PRIVATE KEY-----\n${wrapLines(body)}\n-----END RSA PRIVATE KEY-----\n${after}`;
		const text = masked(input, []);
		expectNoBodyLeft(text, body);
		expect(text.endsWith(after)).toBe(true);
	});

	test("P2-5 a 5.4 KB and a 7 KB body (the sizes that leaked 1.4 KB and 3 KB) leave nothing", () => {
		for (const size of [5400, 7000]) {
			const body = keyBody(size, size);
			const text = masked(
				`-----BEGIN PRIVATE KEY-----\n${wrapLines(body)}\n-----END PRIVATE KEY-----\n${after}`,
				[],
			);
			expectNoBodyLeft(text, body);
			expect(text.endsWith(after)).toBe(true);
		}
	});

	test("P2-5 a legacy encrypted key with Proc-Type and DEK-Info header lines is redacted whole", () => {
		const body = keyBody(900, 3);
		const input = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"Proc-Type: 4,ENCRYPTED",
			"DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
			"",
			wrapLines(body),
			"-----END RSA PRIVATE KEY-----",
			after,
		].join("\n");
		const text = masked(input, ["Proc-Type", "DEK-Info", "AES-128-CBC", "0123456789ABCDEF"]);
		expectNoBodyLeft(text, body);
		expect(text).toBe(`[REDACTED:pem_private_key]\n${after}`);
	});

	test("P2-5 the .env quoted form with literal backslash-n escapes loses the key, not only its first line", () => {
		const body = keyBody(1700, 5);
		const escaped = `${wrapLines(body)?.replace(/\n/g, "\\n")}`;
		const input = `PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n${escaped}\\n-----END RSA PRIVATE KEY-----"\nNEXT_VAR=1`;
		const { text, hits } = redact(input);
		expectNoBodyLeft(text, body);
		expect(text).not.toContain("BEGIN RSA");
		expect(text).toContain("\nNEXT_VAR=1");
		expect(hits.map((h) => h.rule)).toContain("pem_private_key");
	});

	test("P2-5 the .env quoted form with real newlines runs the key rule before the env rule", () => {
		const body = keyBody(1700, 6);
		const input = `PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n${wrapLines(body)}\n-----END RSA PRIVATE KEY-----"\nNEXT_VAR=1`;
		const { text, hits } = redact(input);
		expectNoBodyLeft(text, body);
		expect(text).toContain("\nNEXT_VAR=1");
		expect(hits[0].rule).toBe("pem_private_key");
	});

	test("P2-5 carriage-return line endings and a PGP private key block are covered", () => {
		const body = keyBody(600, 9);
		const crlf = `-----BEGIN OPENSSH PRIVATE KEY-----\r\n${wrapLines(body)?.replace(/\n/g, "\r\n")}\r\n-----END OPENSSH PRIVATE KEY-----\r\n${after}`;
		expectNoBodyLeft(masked(crlf, []), body);
		const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${wrapLines(body)}\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----\n${after}`;
		const text = masked(pgp, ["PGP PRIVATE"]);
		expectNoBodyLeft(text, body);
		expect(text).toBe(`[REDACTED:pem_private_key]\n${after}`);
	});

	test("P2-5 a BEGIN with no END is still redacted, and a public key or certificate is untouched", () => {
		const body = keyBody(500, 2);
		expectNoBodyLeft(masked(`-----BEGIN PRIVATE KEY-----\n${wrapLines(body)}`, []), body);
		untouched(`-----BEGIN PUBLIC KEY-----\n${wrapLines(body)}\n-----END PUBLIC KEY-----`);
		untouched(`-----BEGIN CERTIFICATE-----\n${wrapLines(body)}\n-----END CERTIFICATE-----`);
	});
});

// ── P2-6, P2-14 env_assignment_secret ────────────────────────────────────────

describe("P2-6 and P2-14 env_assignment_secret", () => {
	test("P2-6 a quoted value with spaces is masked whole, in both quote styles", () => {
		expect(masked('PASSWORD="my pass phrase"', ["pass phrase"])).toBe("PASSWORD= [REDACTED]");
		expect(masked("DB_PASSWORD='two words here' next", ["words"])).toBe(
			"DB_PASSWORD= [REDACTED] next",
		);
		expect(masked('run: TOKEN="abc def ghi" --go', ["def"])).toBe("run: TOKEN= [REDACTED] --go");
	});

	test("P2-6 a quoted value without spaces keeps exactly the old output (the leftover quote included)", () => {
		for (const input of ['PASSWORD="abcdef12"', "SECRET='abcdef12'", "TOKEN=abcdef12"]) {
			expect(redact(input).text, input).toBe(oldRedact(input));
		}
		expect(redact('PASSWORD="abcdef12"').text).toBe('PASSWORD= [REDACTED]"');
	});

	test("P2-6 a quoted value that is too short, or empty, is left alone as before", () => {
		for (const input of ['PASSWORD=""', "TOKEN=''", 'PASSWORD="a b"', "SECRET=abc"]) {
			untouched(input);
		}
	});

	test("P2-6 an unterminated quote falls back to the old behaviour", () => {
		for (const input of ['PASSWORD="abcdefgh', "TOKEN='abcdefgh and more"]) {
			expect(redact(input).text, input).toBe(oldRedact(input));
			expect(redact(input).text).toContain("[REDACTED]");
		}
	});

	test("P2-6 a key past 8 prefix segments after an = differs from the old rule in the safe direction", () => {
		const key = `${repeat("AB_", 10)}PASSWORD`;
		const input = `X=${key}=hunter2hunter2`;
		// Old: the `=` before the key is the boundary, so the whole key name went with the secret.
		expect(oldRedact(input)).toBe("X= [REDACTED]");
		// New: the match starts inside the key; the secret is gone and the key name is kept.
		expect(redact(input).text).toBe(`X=${key}= [REDACTED]`);
		expect(redact(input).text).not.toContain("hunter2");
	});

	test("P2-14 a value may not start on a following line", () => {
		untouched("export TOKEN=\nnext_cmd --flag");
		untouched("PASSWORD=\n\nhunter2hunter2");
		untouched("TOKEN\n= hunter2hunter2");
	});

	test("P2-14 spaces and tabs around the = still count", () => {
		expect(masked("TOKEN = hunter2hunter2", ["hunter2"])).toBe("TOKEN = [REDACTED]");
		expect(masked("TOKEN\t=\thunter2hunter2", ["hunter2"])).toBe("TOKEN\t= [REDACTED]");
	});

	test("P2-14 ACCEPTED over-match: `const token = await getToken()` is masked, as the old rule did", () => {
		const input = "const token = await getToken();";
		expect(redact(input).text).toBe(oldRedact(input));
		expect(redact(input).text).not.toBe(input);
	});

	test("P2-9 SECRET_KEY, SIGNING_KEY, ENCRYPTION_KEY, PASSWD, PASS and CREDENTIALS are keywords", () => {
		for (const name of [
			"SECRET_KEY",
			"DJANGO_SECRET_KEY",
			"SIGNING_KEY",
			"ENCRYPTION_KEY",
			"PASSWD",
			"DB_PASS",
			"PASS",
			"AWS_CREDENTIALS",
			"CREDENTIALS",
		]) {
			expect(masked(`${name}=hunter2hunter2`, ["hunter2"]), name).toBe(`${name}= [REDACTED]`);
		}
	});

	test("P2-9 words that merely end in PASS, or continue after it, are not keys", () => {
		for (const input of [
			"compass=northeast",
			"bypass=enabled",
			"PASSENGER=abcd1234",
			"SECRET_KEY_BASE_NAME=abcd1234",
			"CREDENTIALS_FILE_NAME=abcd1234",
		]) {
			untouched(input);
		}
	});
});

// ── P2-7 authorization_header ────────────────────────────────────────────────

describe("P2-7 authorization_header", () => {
	const tok = fake("", "aB3dE5fG7hK", 40);

	test("P2-7 Bearer, Basic and Token schemes, with the characters real tokens carry", () => {
		const b64 = fake("", "aB/3+dE5fG7h=", 30);
		for (const scheme of ["Bearer", "Basic", "Token", "Negotiate"]) {
			expect(masked(`Authorization: ${scheme} ${b64}`, [b64]), scheme).toBe(
				"Authorization: [REDACTED]",
			);
		}
		const tilde = "aB3~dE5.fG7_hK-9~~";
		expect(masked(`Authorization: Bearer ${tilde}`, [tilde])).toBe("Authorization: [REDACTED]");
	});

	test("P2-7 Basic with / and + in the first 12 characters and padding is masked whole", () => {
		const value = "ab/c+d/e+fgh0123456789xyz==";
		expect(masked(`Authorization: Basic ${value}`, [value, "xyz=="])).toBe(
			"Authorization: [REDACTED]",
		);
	});

	test("P2-7 an AWS4-HMAC-SHA256 header is masked through the signature", () => {
		const key = fake("AKIA", "ABCD1234", 16);
		const sig = fake("", "0a1b2c3d", 64);
		const header = `Authorization: AWS4-HMAC-SHA256 Credential=${key}/20230101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${sig}`;
		const text = masked(header, [key, sig, "20230101"]);
		expect(text).toBe("Authorization: [REDACTED]");
	});

	test("P2-7 a Digest header is masked through its quoted parameters", () => {
		const header =
			'Authorization: Digest username="svc", realm="api", nonce="n0nce12345678", uri="/x", response="r3sponse0123456789abcdef"';
		const text = masked(header, ["n0nce12345678", "r3sponse0123456789abcdef", "svc"]);
		expect(text).toBe("Authorization: [REDACTED]");
	});

	test("P2-7 the JSON form is masked and the rest of the object survives", () => {
		const text = masked(`{"Authorization":"Bearer ${tok}","Accept":"text/plain"}`, [tok]);
		expect(text).toContain('"Accept":"text/plain"}');
		expect(text).toContain("Authorization: [REDACTED]");
		const single = masked(`{'authorization': 'Bearer ${tok}', 'x': 1}`, [tok]);
		expect(single).toContain("'x': 1}");
	});

	test("P2-7 the header name matches in any case", () => {
		for (const name of ["AUTHORIZATION", "authorization", "Authorization", "aUtHoRiZaTiOn"]) {
			expect(masked(`${name}: bearer ${tok}`, [tok]), name).toBe("Authorization: [REDACTED]");
		}
	});

	test("P2-7 in a one-line curl the value ends at the closing quote and the URL survives", () => {
		expect(
			masked(`curl -H "Authorization: Bearer ${tok}" https://example.com/x -d '{}'`, [tok]),
		).toBe(`curl -H "Authorization: [REDACTED]" https://example.com/x -d '{}'`);
		expect(masked(`curl -H 'Authorization: Token ${tok}' https://example.com`, [tok])).toBe(
			"curl -H 'Authorization: [REDACTED]' https://example.com",
		);
	});

	test("P2-7 a bare token after the header name still counts, a short word does not", () => {
		expect(masked(`authorization: ${tok}`, [tok])).toBe("Authorization: [REDACTED]");
		for (const input of [
			"Authorization: required",
			"authorization: header is checked first",
			"Authorization: Bearer",
			"Authorization: Bearer ${token}",
			"Authorization: `Bearer ${token}`",
			'{"Authorization": "Bearer " + token}',
			"Authorization: Bearer $TOKEN",
		]) {
			untouched(input);
		}
	});
});

// ── P2-8 json_secret_value ───────────────────────────────────────────────────

describe("P2-8 json_secret_value", () => {
	const secret = "hunter2hunter2";

	test("P2-8 separated, camelCase and cloud-style key names are masked and the key stays", () => {
		const keys = [
			"accessToken",
			"refreshToken",
			"idToken",
			"clientSecret",
			"authToken",
			"privateKey",
			"private_key_id",
			"privateKeyId",
			"secretAccessKey",
			"SecretAccessKey",
			"SessionToken",
			"connectionString",
			"apiKey",
			"api-key",
			"client-secret",
			"db_password",
			"DB_PASSWORD",
			"signingKey",
			"encryptionKey",
		];
		for (const key of keys) {
			const text = masked(`{"${key}":"${secret}"}`, [secret]);
			expect(text, key).toContain(`"${key}"`);
			expect(text, key).toContain("[REDACTED]");
		}
	});

	test("P2-8 the key authorization is masked whatever rule gets there first", () => {
		masked(`{"authorization": "Basic ${secret}"}`, [secret]);
		masked(`{"Authorization":"${secret}"}`, [secret]);
	});

	test("P2-8 max_tokens, token_count, password_hint and the type word string are not secrets", () => {
		for (const input of [
			'{"max_tokens": "4000000"}',
			'{"token_count": "1234567"}',
			'{"password_hint": "your first pet"}',
			'{"token": "string"}',
			'{"token": "number"}',
			'{"password": "boolean"}',
			'{"tokenType": "Bearer"}',
			'{"secretName": "my-secret-name"}',
			'{"keyboard": "qwertyuiop"}',
			'{"is_secret": "false"}',
		]) {
			untouched(input);
		}
	});

	test("P2-8 one level of escaped JSON is matched and the surrounding structure survives", () => {
		const input = `{"arguments":"{\\"password\\":\\"${secret}\\",\\"user\\":\\"bob\\"}"}`;
		const text = masked(input, [secret]);
		expect(text).toBe('{"arguments":"{\\"password\\": \\"[REDACTED]\\",\\"user\\":\\"bob\\"}"}');
		const camel = masked(`{"a":"{\\"accessToken\\":\\"${secret}\\"}"}`, [secret]);
		expect(camel).toContain('\\"accessToken\\"');
	});

	test("P2-8 an escaped value of the type word string, or masked already, is left alone", () => {
		untouched('{"a":"{\\"token\\":\\"string\\"}"}');
	});

	test("P2-8 the exact output for a plain value", () => {
		expect(redact(`{"password":"${secret}"}`).text).toBe('{"password": "[REDACTED]"}');
		expect(redact(`{"accessToken" : "${secret}", "n": 1}`).text).toBe(
			'{"accessToken" : "[REDACTED]", "n": 1}',
		);
	});
});

// ── P2-9 additional token shapes ─────────────────────────────────────────────

describe("P2-9 more secret shapes", () => {
	test("P2-9 github_pat_ fine-grained tokens: 21 are not masked, 22 are", () => {
		expect(redact(`github_pat_${fake("", "aB3dE5fG7h_", 21)}`).hits).toEqual([]);
		const t22 = `github_pat_${fake("", "aB3dE5fG7h_", 22)}`;
		expect(masked(`token ${t22} end`, [t22])).toBe("token [REDACTED:github_pat] end");
		const long = `github_pat_${fake("", "aB3dE5fG7h_", 82)}`;
		expect(masked(long, [long.slice(14)])).toBe("[REDACTED:github_pat]");
	});

	test("P2-9 Slack xapp tokens and incoming-webhook URLs", () => {
		const xapp = `xapp-1-A0${fake("", "123456789", 9)}-${fake("", "9876543210", 13)}-${fake("", "abcdef0123", 20)}`;
		expect(masked(`use ${xapp} here`, [xapp.slice(10)])).toBe("use [REDACTED:slack_token] here");
		const hook = `https://hooks.slack.com/services/T${fake("", "0123ABCD", 9)}/B${fake("", "4567EFGH", 9)}/${fake("", "aB3dE5fG7h", 24)}`;
		const text = masked(`post to ${hook} now`, [hook.slice(-24), "/services/T"]);
		expect(text).toContain("[REDACTED:slack_webhook]");
		expect(text.endsWith(" now")).toBe(true);
		untouched("https://hooks.slack.com/docs/messaging");
	});

	test("P2-9 YAML with uppercase and prefixed keys, as in a compose environment map", () => {
		const yaml = [
			"services:",
			"  db:",
			"    environment:",
			"      DB_PASSWORD: hunter2hunter2",
			"      POSTGRES_PASSWORD: hunter2hunter2",
			"      LOG_LEVEL: info",
			"      - SECRET_KEY: abcdefghij12",
			"      app_secret: abcdefghij12",
		].join("\n");
		const text = masked(yaml, ["hunter2", "abcdefghij12"]);
		expect(text).toContain("LOG_LEVEL: info");
		expect(text).toContain("DB_PASSWORD: [REDACTED]");
		expect(text).toContain("- SECRET_KEY: [REDACTED]");
	});

	test("P2-9 ssh-privatekey (a Kubernetes ssh-auth secret key) is masked", () => {
		const blob = fake("", "dGhpcyBpcyBub3QgYSBrZXk", 80);
		expect(masked(`data:\n  ssh-privatekey: ${blob}\n`, [blob])).toBe(
			"data:\n  ssh-privatekey: [REDACTED]\n",
		);
	});

	test("P2-9 a token as the whole userinfo is masked: 19 characters are a name, 20 are a token", () => {
		const t20 = fake("", "aB3dE5fG7hK", 20);
		const t19 = fake("", "aB3dE5fG7hK", 19);
		expect(masked(`git clone https://${t20}@host.example/org/repo.git`, [t20])).toBe(
			"git clone https://[REDACTED]@host.example/org/repo.git",
		);
		untouched(`git clone https://${t19}@host.example/org/repo.git`);
		untouched("git clone https://git@host.example/org/repo.git");
	});
});

// ── P2-10 cli_secret_flag ────────────────────────────────────────────────────

describe("P2-10 cli_secret_flag", () => {
	test("P2-10 the four flag names and their client-, access-, auth-, api-, refresh-, bearer- forms are masked", () => {
		const flags = [
			"--password",
			"--token",
			"--secret",
			"--api-key",
			"--client-secret",
			"--access-token",
			"--auth-token",
			"--api-token",
			"--refresh-token",
			"--bearer-token",
			"--client-password",
		];
		for (const flag of flags) {
			expect(masked(`tool ${flag} hunter2x run`, ["hunter2x"]), flag).toBe(
				`tool ${flag} [REDACTED] run`,
			);
			expect(masked(`tool ${flag}=hunter2x run`, ["hunter2x"]), `${flag}=`).toContain("[REDACTED]");
		}
	});

	test("P2-10 the -file and -path suffixes are masked: the --token-file case stays covered", () => {
		expect(masked("tool --token-file /etc/path/x go", ["/etc/path/x"])).toBe(
			"tool --token-file [REDACTED] go",
		);
		expect(masked("tool --secret-path /run/secrets/x go", ["/run/secrets/x"])).toBe(
			"tool --secret-path [REDACTED] go",
		);
	});

	test("P2-10 flags that only start like a secret flag are untouched", () => {
		for (const input of [
			"node build.js --token-budget 8000",
			"aws secretsmanager get-secret-value --secret-id x",
			"tool --secret-name foo",
			"tool --api-key-env MY_VAR",
			"docker login --password-stdin < pass.txt",
			"docker login --password-stdin registry.example.com",
			"node build.js --tokens 5",
			"node build.js --passwordless",
			"tool --token",
			"tool --password",
			"tool --tokenizer gpt",
			"tool --secretive yes",
		]) {
			untouched(input);
		}
	});
});

// ── P2-11 cookie_header ──────────────────────────────────────────────────────

describe("P2-11 cookie_header", () => {
	test("P2-11 a Cookie line of any length is masked to the end of the line, indentation kept", () => {
		const long = `  Cookie: sid=${repeat("a1b2", 5000)}`;
		expect(redact(`${long}\nHost: x`).text).toBe("  [REDACTED:cookie_header]\nHost: x");
		expect(redact("Set-Cookie: id=zz9plural; HttpOnly; Secure\nnext").text).toBe(
			"[REDACTED:cookie_header]\nnext",
		);
		expect(redact("GET /\r\nCookie: sid=abc123def; theme=dark\r\nHost: x").text).toBe(
			"GET /\r\n[REDACTED:cookie_header]\r\nHost: x",
		);
	});

	test("P2-11 inside a quoted -H argument the value ends at the closing quote", () => {
		expect(redact("curl -H 'Cookie: sid=abc123def; a=b' https://example.com/x -o out").text).toBe(
			"curl -H '[REDACTED:cookie_header]' https://example.com/x -o out",
		);
		expect(redact('curl -H "cookie: sid=abc123def" https://example.com/x').text).toBe(
			'curl -H "[REDACTED:cookie_header]" https://example.com/x',
		);
		expect(redact("curl --header 'Set-Cookie: a=b1c2d3e4' https://example.com").text).toBe(
			"curl --header '[REDACTED:cookie_header]' https://example.com",
		);
		expect(redact('curl --header="Cookie: a=b1c2d3e4" https://example.com').text).toBe(
			'curl --header="[REDACTED:cookie_header]" https://example.com',
		);
	});

	test("P2-11 the identifier cookie in code is not a header", () => {
		for (const input of [
			"const cookie: str=None",
			'def f(cookie: str="", x=1):',
			"session_cookie: a=b1c2d3",
			"if (cookie: a=b) {}",
			"x = {cookie: a=b1c2d3}",
		]) {
			untouched(input);
		}
	});

	test("P2-11 prose and a header with no pair are untouched", () => {
		untouched("Please accept the cookie policy to continue.");
		untouched("the cookie: chocolate chip");
		untouched("Cookie: none");
		untouched("Cookies are small files");
	});

	test("P2-11 ACCEPTED over-match: a bare `cookie: a=b` field at the start of a line is masked", () => {
		expect(redact("    cookie: str=None").text).toBe("    [REDACTED:cookie_header]");
	});
});

// ── P2-12 over- and under-matches ────────────────────────────────────────────

describe("P2-12 names and types are not secrets", () => {
	test("P2-12 a type name or a resource name after the key is not masked", () => {
		for (const input of [
			"password: SecretStr",
			"token: AccessToken",
			"secret: my-secret-name",
			"    api_key: ApiKeyHeader  # the header",
			"secret: some-resource-name-here",
		]) {
			untouched(input);
		}
	});

	test("P2-12 ACCEPTED: an all-lowercase hyphenated passphrase and a CamelCase word look like names and are left alone", () => {
		untouched("password: correct-horse-battery-staple");
		untouched("password: HunterTwoThree");
	});

	test("P2-12 a value with a digit, a symbol or an upper-case-only run is still masked", () => {
		for (const input of [
			"password: my-secret-name-2",
			"password: HunterTwo3",
			"token: ABCDEFGHIJKL",
			"secret: correct-Horse-battery",
		]) {
			expect(
				redact(input).hits.map((h) => h.rule),
				input,
			).toContain("yaml_secret_value");
		}
	});

	test("P2-12 CRLF line endings do not hide a YAML value", () => {
		expect(redact("password: hunter2hunter2\r\nname: x\r\n").text).toBe(
			"password: [REDACTED]\r\nname: x\r\n",
		);
		expect(redact("a: 1\r\n  token: abcdef123456 # c\r\nb: 2").text).toBe(
			"a: 1\r\n  token: [REDACTED]\r\nb: 2",
		);
	});

	test("P2-12 userinfo cannot follow a port, a path or a query", () => {
		for (const input of [
			"http://example.com:8080?email=a@b.com",
			"http://example.com:8080/x?email=a@b.com",
			"http://example.com:8080#frag@b.com",
			"https://example.com:443/path@fragment",
			"http://localhost:3000/@scope/pkg",
		]) {
			untouched(input);
		}
	});

	test("P2-12 a password containing @ is masked up to the last @ before the host", () => {
		expect(redact("postgres://user:p@ssw0rd@host/db").text).toBe("postgres://[REDACTED]@host/db");
		expect(redact("postgres://user:p@ss:w0rd@host:5432/db?x=1").text).toBe(
			"postgres://[REDACTED]@host:5432/db?x=1",
		);
		expect(redact("redis://:s3cret@host:6379").text).toBe("redis://[REDACTED]@host:6379");
		expect(redact("open https://user:pa55word@host/p now").text).toBe(
			"open https://[REDACTED]@host/p now",
		);
	});
});

// ── P2-13 curl_user ──────────────────────────────────────────────────────────

describe("P2-13 curl_user", () => {
	test("P2-13 a backslash-newline continuation form is masked, with or without indentation", () => {
		expect(redact("curl -s \\\n  -u admin:pw123abc \\\n  https://example.com/x").text).toBe(
			"curl -s \\\n  -u admin:[REDACTED] \\\n  https://example.com/x",
		);
		expect(redact("curl https://example.com \\\n-u admin:pw123abc").text).toBe(
			"curl https://example.com \\\n-u admin:[REDACTED]",
		);
	});

	test("P2-13 a -u 200 characters after curl is still found", () => {
		const input = `curl ${"-H 'X-A: b' ".repeat(16)}-u admin:pw123abc https://example.com`;
		expect(input.indexOf("-u admin")).toBeGreaterThan(190);
		expect(masked(input, ["pw123abc"])).toContain("-u admin:[REDACTED]");
	});

	test("P2-13 --something-u x:y and a -u on another line are untouched", () => {
		untouched("curl https://example.com --something-u x:y");
		untouched("curl https://example.com\nls -u a:b");
	});

	test("P2-13 combined short flags ending in u are masked", () => {
		expect(redact("curl -sSu user:pw123abc https://example.com").text).toBe(
			"curl -sSu user:[REDACTED] https://example.com",
		);
		expect(redact("curl -fsSLu user:pw123abc https://example.com").text).toBe(
			"curl -fsSLu user:[REDACTED] https://example.com",
		);
	});
});

// ── P2-15 corpus and self-scan ───────────────────────────────────────────────

interface CorpusLine {
	id: string;
	text: string;
}
interface DeliberateDifference extends CorpusLine {
	expected: string;
	why: string;
}
const corpus = (benign as unknown as { corpus: CorpusLine[] }).corpus;
const deliberate = (benign as unknown as { deliberateDifferences: DeliberateDifference[] })
	.deliberateDifferences;

describe("P2-15 the benign corpus equals the old rule set", () => {
	test("P2-15 at least 20 realistic lines, each redacted exactly as the old rules redacted it", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(20);
		for (const { id, text } of corpus) {
			expect({ id, text: redact(text).text }).toEqual({ id, text: oldRedact(text) });
		}
	});

	test("P2-15 the strings the old rules already mask are in the corpus and agree", () => {
		const alreadyMasked = corpus.filter((c) => oldRedact(c.text) !== c.text);
		expect(alreadyMasked.length).toBeGreaterThanOrEqual(2);
	});

	test("P2-15 every deliberate difference is named, explained and pinned", () => {
		expect(deliberate.length).toBeGreaterThanOrEqual(3);
		for (const { id, text, expected, why } of deliberate) {
			expect(why.length, id).toBeGreaterThan(10);
			expect({ id, text: redact(text).text }).toEqual({ id, text: expected });
			expect(oldRedact(text), `${id} must differ from the old rules`).not.toBe(expected);
		}
	});

	test("P2-15 the fixture ids are unique", () => {
		const ids = [...corpus, ...deliberate].map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

const ROOT = new URL("../../../../", import.meta.url).pathname;

/**
 * Places the new rules mask on purpose, each a line of a non-test file: `file`
 * plus a substring of the original line. Every entry is an accepted over-match
 * or the intended widening, named in `why`.
 */
const SELF_SCAN_ALLOWLIST: Array<{ file: string; includes: string; why: string }> = [
	{
		file: "src/web/lib/auth-session.ts",
		includes: "WRONG_CURRENT_PASSWORD",
		why: "a quoted value with spaces after PASSWORD= is masked whole (P2-6); the old rule masked its first word",
	},
	{
		file: "README.md",
		includes: "--api-key ap_your_key_here",
		why: "ACCEPTED: the word after a secret flag is read as its value, placeholder or not",
	},
	{
		file: "README.md",
		includes: "DATABASE_URL=postgres://user:password@host",
		why: "a documentation password: the word `password` cannot be told from one",
	},
	{
		file: "README.md",
		includes: '`DATABASE_URL` | `""` (SQLite)',
		why: "a documentation password in an example URL",
	},
	{
		file: "scripts/install-local.sh",
		includes: "--api-key",
		why: "ACCEPTED: usage text and prose after a secret flag are read as its value",
	},
	{
		file: "scripts/setup-relay.sh",
		includes: 'API_KEY="${KEY_ARG',
		why: "a quoted value with spaces after API_KEY= is masked whole (P2-6)",
	},
	{
		file: "scripts/ai-live-test.ts",
		includes: '"apiKey":"',
		why: "a JSON example in a comment, with an example key",
	},
];
/** Test files whose literals are fake credentials on purpose (auth, URL and header handling). */
const SELF_SCAN_FAKE_CREDENTIAL_FIXTURES = new Set([
	"src/supervisor/services/prelaunch-actions.test.ts",
	"src/server/app.integration.test.ts",
	"src/server/services/workspace/clone.test.ts",
	"src/server/routes/ingest-latency.test.ts",
	"src/server/routes/ingest-p7.test.ts",
	"src/server/db/dialect.test.ts",
	"src/server/auth/route-scope-policy.test.ts",
	"src/server/auth/origin-check.test.ts",
	"src/web/lib/setup-steps.test.ts",
	"scripts/install-local-private-write.test.ts",
	"scripts/write-private-no-follow.test.ts",
]);
/** Files that are about redaction itself: their text is the rules' own test input. */
const SELF_SCAN_FILES_ABOUT_REDACTION = new Set([
	"src/server/services/ai/redactor.ts",
	"src/server/services/ai/redactor-rules.test.ts",
	"src/server/services/ai/redactor-rules-p2.test.ts",
	"src/server/services/ai/redactor-rules-p3.test.ts",
	"src/server/services/ai/redactor.test.ts",
	"src/server/services/ai/untrusted-text.test.ts",
	"src/server/services/ai/__fixtures__/redaction-benign.json",
	"src/server/services/ai/__fixtures__/redactor-old-rules.ts",
	"src/server/services/ai/session-summary/evidence-loader.test.ts",
	"src/server/services/ai/session-summary/ledger.test.ts",
	"src/server/services/ai/session-summary/command-class.test.ts",
	"CHANGELOG.md",
]);

describe("P2-15 repo self-scan", () => {
	test("P2-15 redact() over this repo's source and docs changes nothing the old rules left, outside an allowlist", async () => {
		const patterns = [
			"src/**/*.ts",
			"src/**/*.tsx",
			"docs/**/*.md",
			"*.md",
			"scripts/**/*.ts",
			"scripts/**/*.sh",
			"deploy/**/*.md",
			"packages/**/*.ts",
		];
		const unexplained: string[] = [];
		let files = 0;
		for (const pattern of patterns) {
			for await (const file of new Glob(pattern).scan({ cwd: ROOT })) {
				if (
					SELF_SCAN_FILES_ABOUT_REDACTION.has(file) ||
					SELF_SCAN_FAKE_CREDENTIAL_FIXTURES.has(file)
				) {
					continue;
				}
				const text = await Bun.file(`${ROOT}${file}`).text();
				files++;
				const was = oldRedact(text);
				const now = redact(text).text;
				if (was === now) continue;
				const before = was.split("\n");
				const after = now.split("\n");
				const original = text.split("\n");
				if (before.length !== after.length) {
					unexplained.push(`${file}: line count changed`);
					continue;
				}
				for (let i = 0; i < after.length; i++) {
					if (before[i] === after[i]) continue;
					const line = original[i] ?? "";
					const allowed = SELF_SCAN_ALLOWLIST.some(
						(a) => a.file === file && line.includes(a.includes),
					);
					if (!allowed) unexplained.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
				}
			}
		}
		expect(files).toBeGreaterThan(500);
		expect(unexplained).toEqual([]);
	}, 120_000);
});

// ── P2-17 boundaries and exact outputs ───────────────────────────────────────

describe("P2-17 token prefix lengths, one below and at the minimum", () => {
	const cases: Array<[string, string, number, string]> = [
		["huggingface_token", "hf_", 30, "aB3dE5fG7h"],
		["gitlab_token", "glpat-", 20, "aB3dE-5fG_7h"],
		["stripe_live_key", "sk_live_", 24, "aB3dE5fG7h"],
		["npm_token", "npm_", 36, "aB3dE5fG7h"],
		["github_pat", "github_pat_", 22, "aB3dE5fG7h_"],
	];
	for (const [rule, prefix, min, tail] of cases) {
		test(`P2-17 ${prefix}: ${min - 1} characters are not masked, ${min} are (${rule})`, () => {
			untouched(prefix + fake("", tail, min - 1));
			const ok = prefix + fake("", tail, min);
			const { text, hits } = redact(ok);
			expect(text).toBe(`[REDACTED:${rule}]`);
			expect(hits.map((h) => h.rule)).toEqual([rule]);
		});
	}

	test("P2-17 an npm token followed by more word characters is not a token (the word boundary)", () => {
		untouched(`npm_${fake("", "aB3dE5fG7h", 37)}`);
	});

	test("P2-17 a YAML value of exactly 8 characters is masked and 7 is not", () => {
		expect(redact("password: abcdefgh").text).toBe("password: [REDACTED]");
		untouched("password: abcdefg");
	});

	test("P2-17 bare type words that fill the minimum length are not secrets, case-insensitively", () => {
		for (const word of ["Optional", "Callable", "datetime", "OPTIONAL", "CALLABLE"]) {
			untouched(`api_key: ${word}`);
		}
		expect(redact("api_key: datetimes2").hits.map((h) => h.rule)).toContain("yaml_secret_value");
	});

	test("P2-17 the exact masked output for URL, JSON and cookie cases", () => {
		expect(redact("open https://user:pa55word@host/p now").text).toBe(
			"open https://[REDACTED]@host/p now",
		);
		expect(redact('{"password":"hunter2hunter2","user":"bob"}').text).toBe(
			'{"password": "[REDACTED]","user":"bob"}',
		);
		expect(redact("GET /\nCookie: sid=abc123def; theme=dark\nHost: x").text).toBe(
			"GET /\n[REDACTED:cookie_header]\nHost: x",
		);
	});
});

// ── P2-18 strip, then redact ─────────────────────────────────────────────────

describe("P2-18 strip before redact", () => {
	const key = `sk-ant-${fake("", "aB3dE5fG7h", 40)}`;
	const splitBy = (ch: string) => `${key.slice(0, 20)}${ch}${key.slice(20)}`;

	test("P2-18 control: plain redact() does not see a key split by an invisible character", () => {
		expect(redact(splitBy("​")).text).toContain("sk-ant-");
		expect(redact(splitBy("\u{E0100}")).text).toContain("sk-ant-");
	});

	test("P2-18 stripAndRedact masks a key split by U+200B, a variation selector or a tag character", () => {
		for (const ch of ["​", "\u{E0100}", "\u{E01EF}", "︁", "\u{E0041}", "⁠", "­"]) {
			const { text, hits } = stripAndRedact(splitBy(ch));
			expect(text, JSON.stringify(ch)).toBe("[REDACTED:anthropic_api_key]");
			expect(hits.map((h) => h.rule)).toEqual(["anthropic_api_key"]);
		}
	});

	test("P2-18 a split env keyword and a split private key header are masked too", () => {
		expect(stripAndRedact("PASS​WORD=hunter2hunter2").text).toBe("PASSWORD= [REDACTED]");
		const body = keyBody(300, 4);
		const pem = `-----BEGIN​ PRIVATE KEY-----\n${wrapLines(body)}\n-----END PRIVATE KEY-----`;
		expect(stripAndRedact(pem).text).toBe("[REDACTED:pem_private_key]");
	});

	test("P2-18 line separators become real lines before redaction, so a line-anchored rule sees them", () => {
		const { text } = stripAndRedact("note password: hunter2hunter2");
		expect(text).toBe("note\npassword: [REDACTED]");
	});

	test("P2-18 the extra rules run after the defaults, on the stripped text", () => {
		const { text } = stripAndRedact("id INT​-123456 here", [
			{ name: "internal", pattern: /INT-\d{6}/g, replacement: "[REDACTED:internal]" },
		]);
		expect(text).toBe("id [REDACTED:internal] here");
	});

	test("P2-18 empty input is returned as is", () => {
		expect(stripAndRedact("")).toEqual({ text: "", hits: [] });
	});
});

// ── P2-27 the watcher's CLAUDE.md excerpt ────────────────────────────────────

describe("P2-27 the CLAUDE.md excerpt in the watcher's prompt is redacted", () => {
	function watcherSession(claudeMdContent: string): Session {
		return {
			id: "s-1",
			sessionId: "sess-1",
			displayName: "brave-falcon",
			agentType: "claude_code",
			status: "active",
			cwd: "/work/project",
			transcriptPath: null,
			model: null,
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			endedAt: null,
			semanticStatus: null,
			currentTask: null,
			planSummary: null,
			totalToolUses: 0,
			isWorking: false,
			isPinned: false,
			nameSource: "generated",
			nativeName: null,
			gitBranch: null,
			claudeMdContent,
			claudeMdPath: null,
			claudeMdUpdatedAt: null,
			notes: null,
			metadata: {},
			projectId: null,
			isArchived: false,
			lastAgentTurnCompletedAt: null,
			lastUserAcknowledgedAt: null,
		} as Session;
	}
	const key = `sk-ant-${fake("", "aB3dE5fG7h", 40)}`;
	const build = (content: string, extra: RedactionRule[] = []) =>
		buildWatcherContext({
			session: watcherSession(content),
			events: [],
			triggerType: "manual",
			extraRedactionRules: extra,
		});

	test("P2-27 a key, an env secret and a database URL in CLAUDE.md never reach the system prompt", () => {
		const ctx = build(
			`# Notes\nuse ${key}\nDB_PASSWORD=hunter2hunter2\nDATABASE_URL=postgres://u:pa55word@host/db\nkeep this line`,
		);
		expect(ctx.systemPrompt).not.toContain(key);
		expect(ctx.systemPrompt).not.toContain("hunter2");
		expect(ctx.systemPrompt).not.toContain("pa55word");
		expect(ctx.systemPrompt).toContain("keep this line");
		expect(ctx.systemPrompt).toContain("# Repository instructions (excerpt)");
	});

	test("P2-27 a key that straddles the 2,000-character cut is masked before the cut, so no piece of it remains", () => {
		const ctx = build(`${"a".repeat(1990)} ${key} tail`);
		expect(ctx.systemPrompt).not.toContain("sk-ant-");
		expect(ctx.systemPrompt).not.toContain("aB3dE5");
	});

	test("P2-27 user-defined rules apply to the excerpt as well", () => {
		const ctx = build("ticket INT-123456 is open", [
			{ name: "internal", pattern: /INT-\d{6}/g, replacement: "[REDACTED:internal]" },
		]);
		expect(ctx.systemPrompt).toContain("ticket [REDACTED:internal] is open");
	});

	test("P2-27 an excerpt with nothing secret in it is unchanged up to the cut", () => {
		const text = `${"plain line\n".repeat(300)}`;
		const ctx = build(text);
		expect(ctx.systemPrompt).toContain(text.slice(0, 1990));
	});
});
