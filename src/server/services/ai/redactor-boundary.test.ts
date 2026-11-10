import { describe, expect, test } from "bun:test";
import benign from "./__fixtures__/redaction-benign.json";
import { fuzzCorpus, inShapes, redactionSamples } from "./__fixtures__/redaction-samples.js";
import { isPlaceholderValue, isSecretKeyName, redact } from "./redactor.js";

const anthropic = `sk-ant-${"api03-"}${"A".repeat(40)}`;
const github = `ghp_${"d".repeat(36)}`;

describe("AGEN-146 token boundary: a token glued to an escape or a word", () => {
	test("a literal backslash-n before the token", () => {
		const out = redact(`line one\\n${anthropic}\\nline three`).text;
		expect(out).not.toContain("api03-");
		expect(out).toContain("[REDACTED:anthropic_api_key]");
	});

	test("an ANSI colour sequence before the token", () => {
		const out = redact(`\u001b[32m${github}\u001b[0m`).text;
		expect(out).not.toContain("dddddddd");
		expect(out).toContain("[REDACTED:github_token]");
	});

	test("a percent escape before the token", () => {
		const out = redact(`url=%0A${github}`).text;
		expect(out).not.toContain("dddddddd");
	});

	test("a long distinctive prefix after an underscore or a digit", () => {
		expect(redact(`API_KEY_${anthropic}`).text).not.toContain("api03-");
		expect(redact(`1${github}`).text).not.toContain("dddddddd");
	});

	test("every token family is still caught after a literal escape", () => {
		for (const sample of redactionSamples()) {
			const text = `ran it\\n${sample.text}`;
			// Whole-line rules (yaml, cookie, curl) need their own context; the token and
			// header families must not care what precedes them.
			if (
				!["anthropic", "github_token", "aws", "jwt", "stripe", "gitlab", "npm", "slack"].includes(
					sample.family,
				)
			)
				continue;
			expect(redact(text).text, sample.family).not.toContain(sample.secret);
		}
	});

	test("an identifier that only ends in the prefix's letters is not a key", () => {
		const kebab = `task-ant-${"a".repeat(30)}`;
		expect(redact(kebab).text).toBe(kebab);
		const desk = `desk-or-v1-${"a".repeat(30)}`;
		expect(redact(desk).text).toBe(desk);
	});

	test("the benign corpus is unchanged", () => {
		for (const text of benign.strings) expect(redact(text).text).toBe(text);
	});

	test("a cookie header after a literal escape is masked", () => {
		const out = redact("ran it\\nCookie: sid=abc123def; theme=dark\\n").text;
		expect(out).not.toContain("abc123def");
	});
});

describe("AGEN-146 marker forgery: a marker only protects a value that is only a marker", () => {
	test("a marker followed by more value is masked in every rule that skips markers", () => {
		const cases: Array<[string, string]> = [
			['{"password":"[REDACTED]hunter2"}', "hunter2"],
			['{\\"password\\":\\"[REDACTED]hunter2\\"}', "hunter2"],
			["{ password: '[REDACTED]hunter2x' }", "hunter2x"],
			['{"name":"DB_PASSWORD","value":"[REDACTED]hunter2"}', "hunter2"],
			["run --token [REDACTED]x", "[REDACTED]x"],
			["curl -u bob:[REDACTED]hunter2 https://example.test", "hunter2"],
		];
		for (const [text, leaked] of cases) {
			expect(redact(text).text, text).not.toContain(leaked);
		}
	});

	test("a whole marker is left alone, so a second pass changes nothing", () => {
		const cases = [
			'{"password":"[REDACTED]"}',
			'{"token":"[REDACTED:jwt]"}',
			"{ password: '[REDACTED]' }",
			"run --token [REDACTED] now",
			"curl -u bob:[REDACTED] https://example.test",
		];
		for (const text of cases) expect(redact(text).text, text).toBe(text);
	});

	test("redact is idempotent over the fuzz corpus and every family in nine shapes", () => {
		const texts = [
			...fuzzCorpus(3000, 3),
			...redactionSamples().flatMap((s) => inShapes(s.text)),
			...benign.strings,
		];
		expect(texts.length).toBeGreaterThan(3000);
		for (const text of texts) {
			const once = redact(text).text;
			expect(redact(once).text).toBe(once);
		}
	});
});

describe("secret-key and placeholder predicates", () => {
	test("isSecretKeyName follows the JSON rule's key grammar", () => {
		for (const name of ["password", "api_key", "Authorization", "access_token", "db-secret"]) {
			expect(isSecretKeyName(name), name).toBe(true);
		}
		for (const name of ["max_tokens", "token_count", "password_hint", "name", "tool_use_id"]) {
			expect(isSecretKeyName(name), name).toBe(false);
		}
	});

	test("isPlaceholderValue accepts type names and placeholders, not values", () => {
		for (const v of ["string", "${API_KEY}", "<your-key>", "Bearer ", "{{ key }}"]) {
			expect(isPlaceholderValue(v), v).toBe(true);
		}
		for (const v of ["hunter2hunter2", "${x}realsecret", ""]) {
			expect(isPlaceholderValue(v), v).toBe(false);
		}
	});
});
