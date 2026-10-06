/**
 * Canary for the process-wide module registry (AGEN-69 P2-26). A test file that
 * replaces llm/registry.js with mock.module must put the real one back; if it
 * does not, every file that runs after it gets the fake. This file's name sorts
 * after ask-service-agent-refused.test.ts, the file that does the replacing, so
 * a directory run reaches it second.
 */
import { expect, test } from "bun:test";
import { startLlmStubServer } from "../../test-utils/llm-stub-server.js";

test("P2-26 getAdapter from the registry builds the real adapter, which reaches the stub server", async () => {
	const { getAdapter } = await import("../ai/llm/registry.js");
	const stub = startLlmStubServer();
	try {
		stub.script("anthropic", {
			text: "canary",
			stop: "end_turn",
			usage: { input: 3, output: 2 },
		});
		const adapter = getAdapter({
			kind: "anthropic",
			apiKey: "k",
			baseUrl: stub.baseUrl("anthropic"),
		});
		const res = await adapter.complete({
			systemPrompt: "s",
			transcriptPrompt: "t",
			model: "m",
		});
		expect(res.text).toBe("canary");
		expect(res.stopReason).toBe("end");
		expect(stub.requests("anthropic")).toHaveLength(1);
		stub.verify();
	} finally {
		await stub.stop();
	}
});
