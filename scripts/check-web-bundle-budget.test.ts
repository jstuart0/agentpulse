/** AGEN-69 phase 8b: the web bundle budget check, and its self-test with a shrunk threshold. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGETS, HEADROOM, checkBudget } from "./check-web-bundle-budget.js";

describe("checkBudget", () => {
	const budgets = [
		{ chunk: "A", maxGzip: 1000, measured: 900 },
		{ chunk: "B", maxGzip: 500, measured: 450 },
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
			"CodexApprovalCard",
			"SessionTakeoverCard",
			"DashboardPage",
			"index",
		]);
		for (const b of BUDGETS) expect(b.maxGzip).toBeGreaterThan(0);
	});
});

describe("CodexApprovalCard (AGEN-87)", () => {
	const row = BUDGETS.find((b) => b.chunk === "CodexApprovalCard");
	const base = { index: 118_197, SessionDetailPage: 20_026 };

	test("the card is a lazy chunk with a row of its own", () => {
		expect(row).toBeDefined();
		expect(row?.maxGzip).toBeGreaterThan(0);
	});

	test("the entry chunk grew at most 200 B over its AGEN-87 base (the two take-over api methods and one error sentence, AGEN-115); the session page's limit is the one AGEN-117 P4 re-based (27,900: P3's composer and fork routing had taken it to 27,721 without moving it)", () => {
		const index = BUDGETS.find((b) => b.chunk === "index");
		const page = BUDGETS.find((b) => b.chunk === "SessionDetailPage");
		expect(index?.measured as number).toBeLessThanOrEqual(base.index + 200);
		expect(index?.maxGzip as number).toBeLessThanOrEqual(118_600);
		expect(page?.maxGzip as number).toBeLessThanOrEqual(27_900);
	});

	test("the take-over card is a lazy chunk with a row of its own (AGEN-115), and the page's limit rose once for it", () => {
		const takeover = BUDGETS.find((b) => b.chunk === "SessionTakeoverCard");
		expect(takeover?.maxGzip).toBe(5_400);
	});

	test("the card's own limit rose twice: to 12,000 for the AGEN-87 phase 6 review, and to 13,600 for AGEN-117 P4 (the Claude request kinds, copy, peer notice and focus rule), and no further", () => {
		expect(row?.maxGzip).toBe(13_600);
		expect(row?.measured as number).toBeLessThanOrEqual(13_475);
	});
});

describe("T-6 main(), run as a script against a fixture build", () => {
	const SCRATCH = mkdtempSync(join(tmpdir(), "agentpulse-budget-"));
	afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
	function fixture(extra: Record<string, string> = {}): string {
		const dir = mkdtempSync(join(SCRATCH, "budget-fixture-"));
		for (const b of BUDGETS)
			writeFileSync(
				join(dir, `${b.chunk}-abc123XY.js`),
				`export const x = ${JSON.stringify(b.chunk)};`,
			);
		for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
		return dir;
	}
	async function run(...args: string[]) {
		const p = Bun.spawn(["bun", "scripts/check-web-bundle-budget.ts", ...args], {
			cwd: join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: await p.exited,
			out: await new Response(p.stdout).text(),
			err: await new Response(p.stderr).text(),
		};
	}

	test("a small build passes (exit 0)", async () => {
		const r = await run("--dir", fixture());
		expect(r.code).toBe(0);
		expect(r.out).toContain("ok   SessionDetailPage");
	});

	test("--scale shrinks every limit: a small build still fails at a tiny scale (exit 1)", async () => {
		expect((await run("--dir", fixture(), "--scale", "0.0001")).code).toBe(1);
	});

	test("a chunk over its limit fails (exit 1)", async () => {
		const big = Array.from({ length: 60000 }, (_, i) => `${i}-${Math.random()}`).join(",");
		const dir = fixture({
			"SessionSummaryTab-zzzzzz99.js": `export default [${JSON.stringify(big)}]`,
		});
		const r = await run("--dir", dir);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL");
	});

	test("a chunk carrying zod fails (exit 1)", async () => {
		const r = await run("--dir", fixture({ "other-qqqqqq11.js": "throw new ZodError()" }));
		expect(r.code).toBe(1);
		expect(r.out).toContain("zod");
	});

	test("a missing directory is exit 2, and a missing chunk is exit 1", async () => {
		expect((await run("--dir", "/nonexistent-dir-for-budget")).code).toBe(2);
		const dir = mkdtempSync(join(SCRATCH, "budget-empty-"));
		writeFileSync(join(dir, "unrelated-abcdef.js"), "1");
		expect((await run("--dir", dir)).code).toBe(1);
	});

	test("every limit is at most the measured size plus the stated headroom", () => {
		expect(HEADROOM).toBe(0.1);
		for (const b of BUDGETS) {
			expect(b.maxGzip, b.chunk).toBeGreaterThanOrEqual(b.measured);
			expect(b.maxGzip, b.chunk).toBeLessThanOrEqual(Math.ceil(b.measured * (1 + HEADROOM)));
		}
	});
});
