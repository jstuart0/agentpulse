import { describe, expect, test } from "bun:test";
import { bootTimeMs, processIdentity } from "./process-identity.js";

describe("processIdentity", () => {
	test("names a live process, and is stable for it", () => {
		const a = processIdentity(process.pid);
		expect(a).not.toBeNull();
		expect(processIdentity(process.pid)).toBe(a);
	});
	test("a process that has ended has none (a child this test started and ended)", async () => {
		const child = Bun.spawn(["sleep", "30"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(processIdentity(child.pid)).not.toBeNull();
		child.kill();
		await child.exited;
		expect(processIdentity(child.pid)).toBeNull();
	});
	test("a pid that isn't one is refused without running ps", () => {
		for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 40]) expect(processIdentity(pid)).toBeNull();
	});
	test("the boot time is a past time or unknown", () => {
		const boot = bootTimeMs();
		if (boot !== null) {
			expect(boot).toBeLessThan(Date.now());
			expect(boot).toBeGreaterThan(Date.UTC(2000, 0, 1));
		}
	});
});
