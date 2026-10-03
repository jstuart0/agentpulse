import { describe, expect, test } from "bun:test";
import { OWN_TURN_MAX_WAITING, OwnTurnBusyError, runInOwnTurn } from "./own-turn.js";

describe("runInOwnTurn", () => {
	test("jobs run one per turn of the event loop, in arrival order, with the loop served between them", async () => {
		const order: string[] = [];
		const jobs = ["one", "two", "three"].map((name) =>
			runInOwnTurn(async () => {
				order.push(name);
			}),
		);
		// Other work queued behind the jobs, as an I/O callback would be.
		setImmediate(() => order.push("other"));
		await Promise.all(jobs);
		expect(order).toEqual(["one", "other", "two", "three"]);
	});

	test("nothing runs on the calling turn", async () => {
		let ran = false;
		const job = runInOwnTurn(async () => {
			ran = true;
		});
		expect(ran).toBe(false);
		await job;
		expect(ran).toBe(true);
	});

	test("jobs never overlap, even when one waits on a timer", async () => {
		let active = 0;
		let maxActive = 0;
		const job = () =>
			runInOwnTurn(async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await Bun.sleep(5);
				active -= 1;
			});
		await Promise.all([job(), job(), job()]);
		expect(maxActive).toBe(1);
	});

	test("a job queued while another is mid-flight waits for it", async () => {
		let active = 0;
		let maxActive = 0;
		const job = (ms: number) =>
			runInOwnTurn(async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await Bun.sleep(ms);
				active -= 1;
			});
		const first = job(30);
		await Bun.sleep(10);
		expect(active).toBe(1);
		const second = job(5);
		await Promise.all([first, second]);
		expect(maxActive).toBe(1);
	});

	test("results come back to their own callers", async () => {
		const results = await Promise.all([1, 2, 3].map((n) => runInOwnTurn(async () => n * 10)));
		expect(results).toEqual([10, 20, 30]);
	});

	test("a job that fails (even synchronously) fails only its caller, and the queue keeps going", async () => {
		const failing = runInOwnTurn(async () => {
			throw new Error("async failure");
		});
		const failingSync = runInOwnTurn((() => {
			throw new Error("sync failure");
		}) as () => Promise<never>);
		const fine = runInOwnTurn(async () => "still runs");
		await expect(failing).rejects.toThrow("async failure");
		await expect(failingSync).rejects.toThrow("sync failure");
		expect(await fine).toBe("still runs");
	});
});

describe("queue depth ceiling", () => {
	test("a job beyond the ceiling is refused at once, and the queue recovers when the others finish", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		const running = runInOwnTurn(async () => {
			started = true;
			await gate;
		});
		while (!started) await new Promise((resolve) => setImmediate(resolve));

		try {
			const waiting = Array.from({ length: OWN_TURN_MAX_WAITING }, () =>
				runInOwnTurn(async () => "ran"),
			);
			// A refusal is immediate; an accepted job would sit behind the gate.
			const overflow = await Promise.race([
				runInOwnTurn(async () => "never").catch((err: unknown) => err),
				new Promise((resolve) => setTimeout(() => resolve("still queued"), 50)),
			]);
			expect(overflow).toBeInstanceOf(OwnTurnBusyError);

			release();
			await running;
			expect(await Promise.all(waiting)).toEqual(waiting.map(() => "ran"));
			expect(await runInOwnTurn(async () => "after")).toBe("after");
		} finally {
			release();
		}
	});
});
