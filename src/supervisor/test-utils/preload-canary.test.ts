/**
 * D10: proof that the supervisor test preload ran and is doing its job. The mutation harness runs this file
 * first, with `FOREIGN_CANARY_PID` naming a process it started that is not a child of this one, and
 * aborts if it fails. The refusals are asserted with `process.kill` replaced by a recorder, so a preload
 * that did not run cannot make this test signal anything; the one real signal is the positive control, to
 * a child this test started.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
	__setDescendantKillerForTests,
	__setGroupKillerForTests,
	groupReach,
} from "../process-stop.js";
import { allowGroupSignalsTo } from "./signal-guard.js";

/** The killers the preload installed (read by swapping them out and straight back). */
function installed() {
	const noop = () => {};
	const descendant = __setDescendantKillerForTests(noop);
	__setDescendantKillerForTests(descendant);
	const group = __setGroupKillerForTests(noop);
	__setGroupKillerForTests(group);
	return { descendant, group };
}

const foreignPid = Number(process.env.FOREIGN_CANARY_PID ?? Number.NaN);
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
});

describe("the supervisor test preload", () => {
	test("the descendant killer refuses every pid and signals nothing", () => {
		const { descendant } = installed();
		const spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		try {
			for (const pid of [2, 4242, process.ppid, process.pid]) {
				expect(() => descendant(pid, "SIGTERM")).toThrow(/refus|not in this test/);
			}
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	test("the group killer refuses a group that is not led by one of this test's own children", () => {
		const { group } = installed();
		const spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		try {
			// A pid no test has ever handed to groupReach (other tests register invented ones like 4242).
			const neverRegistered = 2_000_000_000;
			const strangers = [0, 1, -1, process.pid, process.ppid, neverRegistered];
			if (Number.isInteger(foreignPid)) strangers.push(foreignPid);
			for (const pid of strangers) expect(() => group(pid, "SIGKILL")).toThrow();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	test("the harness's foreign process is among those refused (set by the mutation harness)", () => {
		if (!Number.isInteger(foreignPid)) return;
		expect(() => installed().group(foreignPid, "SIGKILL")).toThrow();
		expect(() => process.kill(foreignPid, 0)).not.toThrow();
	});

	test("a group whose leader is gone is signalled only if groupReach was handed it while it was a live child of ours", async () => {
		const { group } = installed();
		const spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		try {
			// Never handed to groupReach: a dead pid is a stranger's.
			const stranger = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
			const strangerPid = stranger.pid as number;
			await new Promise((resolve) => stranger.once("exit", resolve));
			expect(() => group(strangerPid, "SIGKILL")).toThrow();

			// Handed over while alive, then it exits: its group is ours.
			const ours = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				detached: true,
				stdio: "ignore",
			});
			children.push(ours);
			const pid = ours.pid as number;
			groupReach({ pid, hasExited: () => false, kill: () => {} });
			ours.kill("SIGKILL");
			await new Promise((resolve) => ours.once("exit", resolve));
			group(pid, "SIGKILL");
			expect(spy.mock.calls).toEqual([[-pid, "SIGKILL"]]);
		} finally {
			spy.mockRestore();
		}
	});

	test("an invented pid handed to groupReach never authorises a group signal", () => {
		const { group } = installed();
		const spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		try {
			for (const invented of [4242, 31337, 2_000_000_000]) {
				groupReach({ pid: invented, hasExited: () => true, kill: () => {} });
				expect(() => group(invented, "SIGKILL")).toThrow();
			}
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	test("allowGroupSignalsTo refuses a pid that isn't a live direct child", () => {
		expect(() => allowGroupSignalsTo(4242)).toThrow(/not a live direct child/);
		expect(() => allowGroupSignalsTo(process.ppid)).toThrow(/not a live direct child/);
		expect(() => allowGroupSignalsTo(1)).toThrow(/not a live direct child/);
	});

	test("a registered pid that is alive but not our child's group is still refused (a grandchild leading its own group)", async () => {
		const { group } = installed();
		const middle = spawn(
			process.execPath,
			[
				"-e",
				`const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); g.unref(); console.log(g.pid); setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		children.push(middle);
		const grandchild = await new Promise<number>((resolve) =>
			middle.stdout?.once("data", (chunk) => resolve(Number(String(chunk).trim()))),
		);
		const spy = spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		try {
			groupReach({ pid: grandchild, hasExited: () => true, kill: () => {} });
			expect(() => group(grandchild, "SIGKILL")).toThrow();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			try {
				process.kill(grandchild, "SIGKILL");
			} catch {}
		}
	});

	test("positive control: the group killer does signal the group of a detached child this test started", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		children.push(child);
		const pid = child.pid as number;
		await Bun.sleep(100);
		installed().group(pid, "SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		expect(child.signalCode).toBe("SIGKILL");
	});
});
