/**
 * The sentence a person reads when an automatic send was refused and the
 * suggestion waits for them instead. A new refusal reason must never fall
 * through to the default branch that prints the raw code.
 */
import { describe, expect, test } from "bun:test";
import "./__test_db.js";

const { autoRefusalWhy } = await import("./continue-decision.js");

const CONFIG = { continuationsUsed: 1, maxContinuations: 3 } as never;
const refused = (reason: string) => ({ code: "prompt_not_deliverable", reason });

describe("autoRefusalWhy", () => {
	test("host_gone says the host was removed and never shows the raw code", () => {
		const why = autoRefusalWhy(refused("host_gone"), CONFIG);
		expect(why).toBe(
			"This session's host was removed from AgentPulse, so it can't receive prompts.",
		);
		expect(why).not.toContain("host_gone");
	});

	test("the reasons it already named keep their sentence", () => {
		expect(autoRefusalWhy(refused("supervisor_offline"), CONFIG)).toBe(
			"This session can't receive prompts (supervisor_offline).",
		);
		expect(autoRefusalWhy(refused("control_busy"), CONFIG)).toBe(
			"This session can't receive prompts (control_busy).",
		);
	});

	test("a pause or a cap is still its own sentence, and a stale proposal says nothing", () => {
		expect(autoRefusalWhy({ code: "auto_send_blocked", reason: "paused" }, CONFIG)).toBe(
			"Auto-send is paused.",
		);
		expect(autoRefusalWhy({ code: "stale_proposal" }, CONFIG)).toBeNull();
	});
});
