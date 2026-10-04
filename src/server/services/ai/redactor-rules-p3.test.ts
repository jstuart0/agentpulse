/**
 * AGEN-69 phase 3 review fixes (P3-37): the curl_user rule's run-time bound,
 * the watcher's strip-before-redact, and three JSON-shaped secret forms. Every
 * secret is a made-up value built here.
 */
import { describe, expect, test } from "bun:test";
import type { Session } from "../../../shared/types.js";
import { buildWatcherContext } from "./context.js";
import { redact } from "./redactor.js";

const PW = "hunter2xyz";

function masked(input: string, secrets: string[] = [PW]): string {
	const { text } = redact(input);
	for (const secret of secrets) expect(text, `leaked ${secret} in ${input}`).not.toContain(secret);
	return text;
}
function untouched(input: string): void {
	expect(redact(input).text, input).toBe(input);
}

describe("P3-37.1 curl_user is linear in a run of flag letters", () => {
	test("a 16,000-character run of u after ' -' is redacted in well under the old 1.3 s", () => {
		const input = `curl -${"u".repeat(16_000)}`;
		const best = Math.min(
			...Array.from({ length: 3 }, () => {
				const start = performance.now();
				redact(input);
				return performance.now() - start;
			}),
		);
		console.log(`[p3-37.1] curl - + u x 16000: best of 3 ${best.toFixed(1)} ms`);
		expect(best).toBeLessThan(150);
	});

	test("positive controls still match: continuation, combined flags, long distance, --user", () => {
		expect(masked("curl -sSu user:pw123abc https://example.com", ["pw123abc"])).toContain(
			"-sSu user:[REDACTED]",
		);
		expect(masked("curl -u admin:pw123abc https://example.com", ["pw123abc"])).toContain(
			"-u admin:[REDACTED]",
		);
		expect(masked("curl --user n:pw123abc https://example.com", ["pw123abc"])).toContain(
			"--user n:[REDACTED]",
		);
		untouched("curl https://example.com --something-u x:y");
	});

	test("the bounds hold: a flag cluster longer than 8 letters, or a name longer than 256, is the documented non-match", () => {
		untouched(`curl -${"s".repeat(9)}u user:x https://example.com`);
		expect(redact(`curl -u ${"n".repeat(300)}:pw123abc`).text).toContain("pw123abc");
	});
});

describe("P3-37.3 the watcher strips invisible characters before it redacts", () => {
	const KEY = `sk-ant-${"aB3dE5fG7h".repeat(4)}`;
	const split = `${KEY.slice(0, 20)}​${KEY.slice(20)}`;
	function session(claudeMdContent: string): Session {
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
	test("a key split by a zero-width space in CLAUDE.md does not reach the system prompt", () => {
		const ctx = buildWatcherContext({
			session: session(`notes\n${split}\nkeep`),
			events: [],
			triggerType: "manual",
			extraRedactionRules: [],
		});
		expect(ctx.systemPrompt).not.toContain("aB3dE5fG7haB3d");
		expect(ctx.systemPrompt).not.toContain("sk-ant-");
		expect(ctx.systemPrompt).toContain("keep");
	});
	test("a key split by a zero-width space in a transcript event does not reach the user prompt", () => {
		const ctx = buildWatcherContext({
			session: session("x"),
			events: [
				{
					id: 1,
					sessionId: "sess-1",
					eventType: "UserPromptSubmit",
					toolName: null,
					toolInput: null,
					toolResponse: null,
					content: `use ${split} now`,
					category: "prompt",
					createdAt: new Date().toISOString(),
				} as never,
			],
			triggerType: "manual",
			extraRedactionRules: [],
		});
		const everything = `${ctx.systemPrompt}\n${JSON.stringify(ctx)}`;
		expect(everything).not.toContain("aB3dE5fG7haB3d");
		expect(everything).not.toContain("sk-ant-");
	});
});

describe("P3-37.4a object-literal secrets with single quotes or no key quotes", () => {
	test("Python repr and console.log forms are masked mid-line", () => {
		expect(masked(`cfg = {'password': '${PW}'} done`)).toContain("done");
		masked(`{ password: '${PW}' }`);
		masked(`got { user: 'a', password: '${PW}', port: 5432 } ok`);
		masked(`{'db_password': '${PW}', 'x': 1}`);
		masked(`{ password: "${PW}" }`);
		masked(`{ apiKey: '${PW}' }`);
		masked(`{\n  token: '${PW}',\n}`);
		masked(`[{'secret': '${PW}'}]`);
	});
	test("a hyphenated value is masked under private_key, api_key, signing_key and secret_key", () => {
		const value = "my-secret-key-value";
		for (const key of ["private_key", "api_key", "signing_key", "secret_key", "password"]) {
			masked(`{ ${key}: '${value}' }`, [value]);
			masked(`{'${key}': '${value}'}`, [value]);
		}
	});
	test("other keys, types, placeholders and short values are untouched", () => {
		for (const input of [
			"{'max_tokens': 'abcdefgh1234'}",
			"{ token_count: 'abcdefgh1234' }",
			"{ tokenType: 'Bearer' }",
			"{'password_hint': 'my first pet'}",
			"{ password: 'string' }",
			"{'password': '<your-password>'}",
			"{ password: 'abc' }",
			"{ name: 'passwordless-login-enabled' }",
			"{ passwordField: 'abcdefgh1234' }",
		]) {
			untouched(input);
		}
	});
	test("a long run of spaces or object openers is linear", () => {
		const best = (input: string) =>
			Math.min(
				...Array.from({ length: 3 }, () => {
					const s = performance.now();
					redact(input);
					return performance.now() - s;
				}),
			);
		const small = best(`{${" ".repeat(100_000)}password`);
		const large = best(`{${" ".repeat(400_000)}password`);
		expect(large).toBeLessThan(8 * small + 15);
		const s2 = best("{password:".repeat(10_000));
		const l2 = best("{password:".repeat(40_000));
		expect(l2).toBeLessThan(8 * s2 + 15);
	});
});

describe("P3-37.4b cookie and set-cookie as JSON keys", () => {
	test("masked", () => {
		masked(`{"cookie":"session=${PW}"}`);
		masked(`{"Set-Cookie": "id=${PW}; Path=/"}`);
		masked(`{"a":1,"set_cookie":"${PW}"}`);
		masked(`{ cookie: '${PW}' }`);
	});
	test("untouched", () => {
		for (const input of [
			'{"cookies_enabled":"abcdefgh1234"}',
			'{"cookie_policy":"accepted-all-cookies"}',
			'{"cookie":"string"}',
			'{"cookie":"a"}',
			'{"cookiejar":"abcdefgh1234"}',
		]) {
			untouched(input);
		}
	});
});

describe("P3-37.4c name/value pairs as kubectl prints them", () => {
	test("the value is masked when the name is secret-ish", () => {
		const out = masked(
			`[{"name":"DB_PASSWORD","value":"${PW}"},{"name":"LOG_LEVEL","value":"debuggingnow"}]`,
		);
		expect(out).toContain("debuggingnow");
		expect(out).toContain('"DB_PASSWORD"');
		masked(`{ "name": "API_TOKEN", "value": "${PW}" }`);
		masked(`{"name":"client-secret","value":"${PW}"}`);
		masked(`{"name":"PRIVATE_KEY","value":"my-hyphenated-key"}`, ["my-hyphenated-key"]);
		masked(`[{"name": "AWS_SECRET_ACCESS_KEY",\n "value": "${PW}"}]`);
	});
	test("other names, valueFrom and already-masked values are untouched", () => {
		for (const input of [
			'[{"name":"MAX_TOKENS","value":"1234567890"}]',
			'{"name":"PASSWORD_HINT","value":"my first pet"}',
			'{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"db","key":"pw"}}}',
			'{"name":"TOKEN_TYPE","value":"Bearer"}',
			'{"name":"DB_PASSWORD","value":"[REDACTED]"}',
			'{"name":"DB_PASSWORD","value":"string"}',
		]) {
			untouched(input);
		}
	});
});
