/** AGEN-69 phase 8b: the web bundle budget check, and its self-test with a shrunk threshold. */
import { describe, expect, test } from "bun:test";
import { BUDGETS, checkBudget } from "./check-web-bundle-budget.js";

describe("checkBudget", () => {
	const budgets = [
		{ chunk: "A", maxGzip: 1000 },
		{ chunk: "B", maxGzip: 500 },
	];

	test("passes at or under every limit", () => {
		const findings = checkBudget({ A: 1000, B: 10 }, budgets);
		expect(findings.map((f) => f.ok)).toEqual([true, true]);
	});

	test("fails a chunk over its limit, and a chunk that is missing", () => {
		expect(checkBudget({ A: 1001, B: 10 }, budgets)[0]).toMatchObject({ chunk: "A", ok: false });
		expect(checkBudget({ A: 10 }, budgets)[1]).toMatchObject({ chunk: "B", gzip: null, ok: false });
	});

	test("self-test: a shrunk threshold fails what passed before", () => {
		const sizes = { A: 900, B: 400 };
		expect(checkBudget(sizes, budgets).every((f) => f.ok)).toBe(true);
		expect(checkBudget(sizes, budgets, 0.5).some((f) => !f.ok)).toBe(true);
	});

	test("the real budgets name the page, the lazy panel, the dashboard and the entry chunk", () => {
		expect(BUDGETS.map((b) => b.chunk)).toEqual([
			"SessionDetailPage",
			"SessionSummaryTab",
			"DashboardPage",
			"index",
		]);
		for (const b of BUDGETS) expect(b.maxGzip).toBeGreaterThan(0);
	});
});
