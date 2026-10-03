import { describe, expect, test } from "bun:test";
import { createInFlight } from "./in-flight.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createInFlight", () => {
	test("callers with the same key share one computation", async () => {
		const run = createInFlight<number>();
		const gate = deferred<number>();
		let computations = 0;
		const compute = () => {
			computations += 1;
			return gate.promise;
		};
		const calls = [run("k", compute), run("k", compute), run("k", compute)];
		gate.resolve(7);
		expect(await Promise.all(calls)).toEqual([7, 7, 7]);
		expect(computations).toBe(1);
	});

	test("different keys never share", async () => {
		const run = createInFlight<string>();
		const [a, b] = await Promise.all([run("a", async () => "A"), run("b", async () => "B")]);
		expect([a, b]).toEqual(["A", "B"]);
	});

	test("the entry is gone once the computation settles", async () => {
		const run = createInFlight<number>();
		let computations = 0;
		const compute = async () => ++computations;
		expect(await run("k", compute)).toBe(1);
		expect(await run("k", compute)).toBe(2);
	});

	test("a failure reaches every joined caller and does not poison the next call", async () => {
		const run = createInFlight<number>();
		const gate = deferred<number>();
		const joined = [run("k", () => gate.promise), run("k", () => gate.promise)];
		gate.reject(new Error("boom"));
		const settled = await Promise.allSettled(joined);
		expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
		expect(await run("k", async () => 5)).toBe(5);
	});

	test("a computation that throws before returning a promise is still cleaned up", async () => {
		const run = createInFlight<number>();
		await expect(
			run("k", () => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		expect(await run("k", async () => 9)).toBe(9);
	});
});
