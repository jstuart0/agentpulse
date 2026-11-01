import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { disposeRuntimesAndExit } from "./fatal-exit.js";

describe("disposeRuntimesAndExit", () => {
	const spies: Array<{ mockRestore(): void }> = [];
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	test("exits the process with status 1 once the runtimes have been disposed", async () => {
		const exit = spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit called");
		}) as never);
		spies.push(exit);
		await expect(disposeRuntimesAndExit()).rejects.toThrow("exit called");
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	test("both runtime families are disposed before the exit", async () => {
		const order: string[] = [];
		const headless = await import("../providers/claude-headless.js");
		const codex = await import("../providers/codex-managed.js");
		spies.push(
			spyOn(codex, "disposeAllManagedCodexRuntimes").mockImplementation(() => {
				order.push("codex");
			}),
			spyOn(headless, "disposeAllHeadlessRuntimes").mockImplementation(async () => {
				await new Promise((r) => setTimeout(r, 5));
				order.push("headless");
			}),
			spyOn(process, "exit").mockImplementation((() => {
				order.push("exit");
				throw new Error("exit called");
			}) as never),
		);
		await expect(disposeRuntimesAndExit()).rejects.toThrow("exit called");
		expect(order).toEqual(["codex", "headless", "exit"]);
	});
});
