import { describe, expect, test } from "bun:test";
import { LlmError } from "../ai/llm/types.js";
import { qaFailureReply } from "./ask-qa-handler.js";

describe("qaFailureReply (AGEN-79)", () => {
	test("our own deadline says the provider was slow and names the setting", () => {
		const err = new LlmError("transient_timeout", "timed out", undefined, undefined, true);
		expect(qaFailureReply(err)).toContain("took too long");
		expect(qaFailureReply(err)).toContain("AGENTPULSE_ASK_ANSWER_TIMEOUT_SECONDS");
	});

	test("an empty reply says no answer was produced, not that the provider errored", () => {
		const err = new LlmError("empty_output", "no answer text");
		expect(qaFailureReply(err)).toContain("didn't produce an answer");
	});

	test("a 5xx (a timeout subtype without our deadline) and anything else stay the generic error", () => {
		expect(qaFailureReply(new LlmError("transient_timeout", "502", 502))).toContain(
			"returned an error",
		);
		expect(qaFailureReply(new Error("boom"))).toContain("returned an error");
	});

	test("the reply never carries the error's own text", () => {
		const err = new LlmError("empty_output", "secret-detail-from-provider");
		expect(qaFailureReply(err)).not.toContain("secret-detail");
	});
});
