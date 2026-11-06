import { describe, expect, test } from "bun:test";
import { outLines } from "./__fixtures__/claude-frames.js";
import { summarizeStreamLine } from "./claude-shared.js";

describe("summarizeStreamLine", () => {
	test("a control line emits no activity, whatever text it carries", () => {
		for (const frame of outLines("tools-m04").filter((m) =>
			String(m.type).startsWith("control_"),
		)) {
			expect(summarizeStreamLine(JSON.stringify(frame))).toBeNull();
		}
		for (const type of ["control_request", "control_response", "control_cancel_request"]) {
			expect(
				summarizeStreamLine(
					JSON.stringify({
						type,
						request: { input: { command: "echo SECRET" }, description: "echo SECRET" },
					}),
				),
			).toBeNull();
		}
	});

	test("an ordinary assistant line still does", () => {
		expect(
			summarizeStreamLine(
				JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
			)?.assistantDelta,
		).toBe("hi");
	});
});
