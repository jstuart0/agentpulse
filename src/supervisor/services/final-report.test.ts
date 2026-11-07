/**
 * AGEN-117 T12: a launch's or prompt's last status is kept in memory and retried until the server answers,
 * because the final report was one attempt and a lost one left the session's turn guard shut. The wait is
 * injected: nothing here sleeps.
 */
import { describe, expect, test } from "bun:test";
import { createFinalReporter } from "./final-report.js";
import { SupervisorNetworkError, SupervisorRequestError } from "./report-resilience.js";

function harness() {
	const waits: Array<{ ms: number; release: () => void }> = [];
	const logged: string[] = [];
	const wait = (ms: number) =>
		new Promise<void>((resolve) => {
			waits.push({ ms, release: resolve });
		});
	const finalReport = createFinalReporter({ wait, log: (line) => logged.push(line) });
	/** Lets the retry loop run until it is waiting again (or has finished). */
	const settle = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	return { finalReport, waits, logged, settle };
}

describe("a final report that gets through", () => {
	test("is sent once and nothing is scheduled", async () => {
		const h = harness();
		let sent = 0;
		await h.finalReport("launch:1", async () => {
			sent++;
		});
		expect(sent).toBe(1);
		expect(h.waits).toEqual([]);
	});
});

describe("a final report that doesn't", () => {
	test.each([
		["no answer", () => new SupervisorNetworkError()],
		["a 500", () => new SupervisorRequestError(500, "Internal Server Error")],
		["a 429", () => new SupervisorRequestError(429, "Too Many Requests")],
		[
			"a 503 busy with a Retry-After",
			() => new SupervisorRequestError(503, "Service Unavailable", "busy", 2000),
		],
	])(
		"is retried after %s until the server answers, with the first call returning at once",
		async (_n, fail) => {
			const h = harness();
			let calls = 0;
			const done = h.finalReport("action:1", async () => {
				calls++;
				if (calls < 3) throw fail();
			});
			await done;
			expect(calls).toBe(1);
			expect(h.waits).toHaveLength(1);
			h.waits[0]?.release();
			await h.settle();
			expect(calls).toBe(2);
			expect(h.waits).toHaveLength(2);
			h.waits[1]?.release();
			await h.settle();
			expect(calls).toBe(3);
			expect(h.waits).toHaveLength(2);
		},
	);

	test("the wait grows and stops growing", async () => {
		const h = harness();
		const done = h.finalReport("action:grow", async () => {
			throw new SupervisorNetworkError();
		});
		await done;
		for (let i = 0; i < 9; i++) {
			h.waits[i]?.release();
			await h.settle();
		}
		const waited = h.waits.map((w) => w.ms);
		expect(waited[1] as number).toBeGreaterThan(waited[0] as number);
		expect(Math.max(...waited)).toBeLessThanOrEqual(60_000);
		expect(waited.at(-1)).toBe(Math.max(...waited));
	});

	test("an answer that is not a retry ends it: a 404 is the server's word, and so is a credential refusal", async () => {
		for (const error of [
			new SupervisorRequestError(404, "Not Found"),
			new SupervisorRequestError(401, "Unauthorized", "Invalid supervisor credential"),
		]) {
			const h = harness();
			let calls = 0;
			await h.finalReport("action:answered", async () => {
				calls++;
				throw error;
			});
			expect(calls).toBe(1);
			expect(h.waits).toEqual([]);
		}
	});

	test("a newer final report for the same key replaces a pending retry; the old one stops", async () => {
		const h = harness();
		const calls: string[] = [];
		await h.finalReport("launch:1", async () => {
			calls.push("completed");
			throw new SupervisorNetworkError();
		});
		await h.finalReport("launch:1", async () => {
			calls.push("cancelled");
		});
		h.waits[0]?.release();
		await h.settle();
		expect(calls).toEqual(["completed", "cancelled"]);
	});

	test("different keys retry independently", async () => {
		const h = harness();
		let a = 0;
		let b = 0;
		await h.finalReport("a", async () => {
			a++;
			throw new SupervisorNetworkError();
		});
		await h.finalReport("b", async () => {
			b++;
		});
		h.waits[0]?.release();
		await h.settle();
		expect([a, b]).toEqual([2, 1]);
	});

	test("the log line names the key and the class, never the error text", async () => {
		const h = harness();
		await h.finalReport("launch:xyz", async () => {
			throw new SupervisorRequestError(500, "Internal Server Error", "boom /Users/x/secret");
		});
		const line = h.logged.join("\n");
		expect(line).toContain("launch:xyz");
		expect(line).not.toContain("/Users/x/secret");
	});
});
