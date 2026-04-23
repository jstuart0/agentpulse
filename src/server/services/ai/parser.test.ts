import { describe, expect, test } from "bun:test";
import { parseDecision } from "./parser.js";

describe("parser: happy path", () => {
	test("parses continue", () => {
		const res = parseDecision('{"decision":"continue","nextPrompt":"run the tests"}');
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		expect(res.decision.decision).toBe("continue");
		if (res.decision.decision === "continue") {
			expect(res.decision.nextPrompt).toBe("run the tests");
		}
	});

	test("parses ask", () => {
		const res = parseDecision(
			'{"decision":"ask","proposal":"re-run failing test","why":"saw a flaky"}',
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		if (res.decision.decision === "ask") {
			expect(res.decision.proposal).toBe("re-run failing test");
			expect(res.decision.why).toBe("saw a flaky");
		}
	});

	test("parses report with highlights", () => {
		const res = parseDecision(
			'{"decision":"report","summary":"tests passed","status":"success","highlights":["a","b"]}',
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		if (res.decision.decision === "report") {
			expect(res.decision.status).toBe("success");
			expect(res.decision.highlights).toEqual(["a", "b"]);
		}
	});

	test("parses stop", () => {
		const res = parseDecision('{"decision":"stop","why":"nothing more"}');
		expect(res.ok).toBe(true);
	});

	test("parses wait", () => {
		const res = parseDecision('{"decision":"wait"}');
		expect(res.ok).toBe(true);
	});

	test("tolerates markdown fences", () => {
		const res = parseDecision('```json\n{"decision":"wait"}\n```');
		expect(res.ok).toBe(true);
	});

	test("tolerates plain triple-backtick fences", () => {
		const res = parseDecision('```\n{"decision":"wait"}\n```');
		expect(res.ok).toBe(true);
	});
});

describe("parser: failures", () => {
	test("rejects empty input", () => {
		const res = parseDecision("");
		expect(res.ok).toBe(false);
	});

	test("tolerates prose wrapping (extracts the first JSON object)", () => {
		// Local reasoning models routinely add commentary around their JSON.
		// We accept them because the real safety gate is HITL + dispatch-filter,
		// not the parser.
		const res = parseDecision('Sure! Here is the plan: {"decision":"wait"} done.');
		expect(res.ok).toBe(true);
	});

	test("still rejects when no JSON object is present", () => {
		const res = parseDecision("Sure, I will do that!");
		expect(res.ok).toBe(false);
	});

	test("rejects unknown decision", () => {
		const res = parseDecision('{"decision":"attack"}');
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected fail");
		expect(res.schemaViolation).toBe(true);
	});

	test("rejects continue without nextPrompt", () => {
		const res = parseDecision('{"decision":"continue"}');
		expect(res.ok).toBe(false);
	});

	test("rejects continue with too-long nextPrompt", () => {
		const big = "x".repeat(5000);
		const res = parseDecision(JSON.stringify({ decision: "continue", nextPrompt: big }));
		expect(res.ok).toBe(false);
	});

	test("rejects ask without proposal", () => {
		const res = parseDecision('{"decision":"ask"}');
		expect(res.ok).toBe(false);
	});

	test("rejects report with invalid status", () => {
		const res = parseDecision('{"decision":"report","summary":"s","status":"weird"}');
		expect(res.ok).toBe(false);
	});

	test("rejects array input", () => {
		const res = parseDecision('[{"decision":"wait"}]');
		expect(res.ok).toBe(false);
	});

	test("distinguishes JSON syntax errors from schema violations", () => {
		const syntax = parseDecision("{not json}");
		expect(syntax.ok).toBe(false);
		if (syntax.ok) throw new Error("expected fail");
		expect(syntax.schemaViolation).toBe(false);

		const schema = parseDecision('{"decision":"continue"}');
		expect(schema.ok).toBe(false);
		if (schema.ok) throw new Error("expected fail");
		expect(schema.schemaViolation).toBe(true);
	});
});
