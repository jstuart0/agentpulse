import { describe, expect, test } from "bun:test";
import { parseUserRules, redact } from "./redactor.js";

describe("redactor: default rules", () => {
	test("redacts Anthropic API keys", () => {
		const input = "call anthropic with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz12";
		const { text, hits } = redact(input);
		expect(text).toContain("[REDACTED:anthropic_api_key]");
		expect(text).not.toContain("sk-ant-");
		expect(hits).toHaveLength(1);
		expect(hits[0].rule).toBe("anthropic_api_key");
	});

	test("redacts OpenAI keys (classic, proj, svcacct)", () => {
		const inputs = [
			"sk-abcdefghijklmnopqrstuvwxyz12345678",
			"sk-proj-abcdefghijklmnopqrstuvwxyz12345678",
			"sk-svcacct-abcdefghijklmnopqrstuvwxyz12345678",
		];
		for (const key of inputs) {
			const { text } = redact(`call with key ${key} please`);
			expect(text).not.toContain(key);
			expect(text).toContain("[REDACTED:openai_api_key]");
		}
	});

	test("redacts OpenRouter keys", () => {
		const input = "use OpenRouter with sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789";
		const { text } = redact(input);
		expect(text).toContain("[REDACTED:openrouter_api_key]");
		expect(text).not.toContain("sk-or-v1-");
	});

	test("redacts Google API keys", () => {
		const input = "gemini key AIzaSyD_abcdefghijklmnopqrstuvwxyz0123456";
		const { text } = redact(input);
		expect(text).toContain("[REDACTED:google_api_key]");
	});

	test("redacts GitHub tokens", () => {
		const input = "gh auth token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AB";
		const { text } = redact(input);
		expect(text).toContain("[REDACTED:github_token]");
		expect(text).not.toContain("ghp_");
	});

	test("redacts AgentPulse API keys", () => {
		const input = "auth with ap_1a9b4a5275aae89613541da7a76ae6d5 here";
		const { text } = redact(input);
		expect(text).not.toContain("ap_1a9b4a5275aae89613541da7a76ae6d5");
		expect(text).toContain("[REDACTED:agentpulse_api_key]");
	});

	test("redacts JWTs", () => {
		const input =
			"Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const { text } = redact(input);
		// Either JWT rule or auth-header rule matches — both count as success.
		expect(text).toContain("[REDACTED");
		expect(text).not.toContain("eyJhbGci");
	});

	test("redacts Authorization headers", () => {
		const input = "Request had Authorization: Bearer abcdefghijklmnop";
		const { text } = redact(input);
		expect(text).toContain("Authorization: [REDACTED]");
		expect(text).not.toContain("abcdefghijklmnop");
	});

	test("redacts env-style secret assignments", () => {
		const input = "DB_PASSWORD=hunter2hunter2\nunrelated=fine\nAPI_KEY=sekretabc";
		const { text } = redact(input);
		expect(text).not.toContain("hunter2hunter2");
		expect(text).not.toContain("sekretabc");
		expect(text).toContain("unrelated=fine");
		expect(text).toContain("[REDACTED]");
	});

	test("redacts AWS access keys", () => {
		const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
		const { text } = redact(input);
		expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
	});

	test("redacts Slack tokens", () => {
		const input = "slack bot xoxb-1234-5678-abcdefghij";
		const { text } = redact(input);
		expect(text).toContain("[REDACTED:slack_token]");
	});

	test("redacts Telegram bot tokens", () => {
		const input = "bot token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
		const { text } = redact(input);
		expect(text).toContain("[REDACTED:telegram_bot_token]");
	});

	test("returns hit details", () => {
		const input = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AB sk-ant-api03-abcdefghijklmnopqrstuvwxyz12";
		const { hits } = redact(input);
		const ruleNames = hits.map((h) => h.rule).sort();
		expect(ruleNames).toEqual(["anthropic_api_key", "github_token"]);
		for (const hit of hits) {
			expect(hit.originalLength).toBeGreaterThan(0);
			expect(hit.replacement).toContain("REDACTED");
		}
	});

	test("leaves innocuous text alone", () => {
		const input = "Nothing to see here. Just normal prose with no secrets.";
		const { text, hits } = redact(input);
		expect(text).toBe(input);
		expect(hits).toHaveLength(0);
	});

	test("handles empty input", () => {
		expect(redact("").text).toBe("");
		expect(redact("").hits).toEqual([]);
	});

	test("handles multiple occurrences of the same key", () => {
		const key = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890AB";
		const input = `first ${key} and again ${key}`;
		const { text, hits } = redact(input);
		expect(hits.filter((h) => h.rule === "github_token")).toHaveLength(2);
		expect(text.split("[REDACTED:github_token]")).toHaveLength(3);
	});
});

describe("redactor: user rules", () => {
	test("applies user-provided patterns after built-ins", () => {
		const userRules = parseUserRules(["internal_id|INT-[0-9]{6}|[REDACTED:internal]"]);
		const { text, hits } = redact("ticket INT-123456 ready", userRules);
		expect(text).toContain("[REDACTED:internal]");
		expect(hits.some((h) => h.rule === "internal_id")).toBe(true);
	});

	test("falls back to auto replacement when user rule omits one", () => {
		const userRules = parseUserRules(["cust_id|C[0-9]{4}"]);
		const { text } = redact("customer C4242 logged in", userRules);
		expect(text).toContain("[REDACTED:cust_id]");
	});

	test("silently skips malformed user rules", () => {
		const userRules = parseUserRules([
			"bad_rule|(unclosed|repl",
			"good_rule|foo|[REDACTED]",
			"not a rule at all",
		]);
		expect(userRules).toHaveLength(1);
		expect(userRules[0].name).toBe("good_rule");
	});

	test("handles non-array settings gracefully", () => {
		expect(parseUserRules(null)).toEqual([]);
		expect(parseUserRules("a string")).toEqual([]);
		expect(parseUserRules({ some: "object" })).toEqual([]);
	});
});
