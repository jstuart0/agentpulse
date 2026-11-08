/**
 * AGEN-119..123 Track 0: what preparing a fork's options wrote is undone once, from every way the fork ends
 * (a stop, a dispose, the process exiting, a fatal ending, a refused start). Nothing is signalled that the
 * test did not start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	AWAIT,
	FAST_TIMINGS,
	type Harness,
	INIT,
	NO_LOGIN_ACCOUNT,
	createHarness,
	until,
} from "../test-utils/claude-stream-harness.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";

const harnesses: Harness[] = [];
const harness = (config?: FakeConfig) => {
	const h = createHarness(config);
	harnesses.push(h);
	return h;
};
afterEach(async () => {
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("cleanup", () => {
	test("a stop", async () => {
		let n = 0;
		const rt = await harness().start({ cleanup: () => void n++ });
		await rt.stop(FAST_TIMINGS);
		await until(() => n === 1, "cleanup");
		await Bun.sleep(100);
		expect(n).toBe(1);
	});

	test("a dispose", async () => {
		let n = 0;
		const rt = await harness().start({ cleanup: () => void n++ });
		await rt.dispose(FAST_TIMINGS);
		await until(() => n === 1, "cleanup");
	});

	test("the process exiting on its own", async () => {
		let n = 0;
		const h = harness({ turns: [[INIT, { exit: 0 }]] });
		const rt = await h.start({ cleanup: () => void n++ });
		rt.beginSettle();
		rt.settled();
		await (await rt.sendPrompt("go", "a1")).done;
		await until(() => n === 1, "cleanup");
	});

	test("a fatal ending", async () => {
		let n = 0;
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "command_lifecycle",
							command_uuid: "someone-else",
							state: "started",
							session_id: "$SESSION",
						},
					},
					AWAIT,
				],
			],
		});
		const rt = await h.start({ cleanup: () => void n++ });
		rt.beginSettle();
		rt.settled();
		await (await rt.sendPrompt("go", "a1")).done;
		await until(() => n === 1, "cleanup");
		await Bun.sleep(150);
		expect(n).toBe(1);
	});

	test("a refused start (the login does not agree), and a cleanup that throws is logged and swallowed", async () => {
		let n = 0;
		const h = harness({ account: NO_LOGIN_ACCOUNT });
		await expect(
			h.start({
				mode: "restricted",
				cleanup: () => {
					n++;
					throw new Error("cleanup-boom");
				},
			}),
		).rejects.toMatchObject({ kind: "claude_not_logged_in" });
		await until(() => n === 1, "cleanup");
		expect(n).toBe(1);
	});
});
