import { describe, expect, test } from "bun:test";
import {
	RED_UPDATE_STATES,
	UPDATE_OUTCOME_CODES,
	UPDATE_STATE_NAMES,
} from "../../shared/update-status.js";
import {
	MEMBER_RED_COPY,
	OUTCOME_COPY,
	UNKNOWN_OUTCOME_COPY,
	UNKNOWN_STATE_COPY,
	outcomeCopy,
	stateCopy,
} from "./update-outcome-copy.js";

const sorted = (values: readonly string[]) => [...values].sort();

describe("the copy tables equal the unions they explain", () => {
	test("one outcome entry per Outcome code, no more and no fewer", () => {
		expect(sorted(Object.keys(OUTCOME_COPY))).toEqual(sorted(UPDATE_OUTCOME_CODES));
	});

	test("one state entry per UpdateState name", async () => {
		const { STATE_COPY } = await import("./update-outcome-copy.js");
		expect(sorted(Object.keys(STATE_COPY))).toEqual(sorted(UPDATE_STATE_NAMES));
	});

	test("a member sentence for each red state, and only those", () => {
		expect(sorted(Object.keys(MEMBER_RED_COPY))).toEqual(sorted(RED_UPDATE_STATES));
		expect(MEMBER_RED_COPY).toEqual({
			security:
				"The server is running a version with a known security problem. An admin needs to update it.",
			current_pulled: "This version was withdrawn. An admin needs to update the server.",
			below_minimum: "This version is no longer supported. An admin needs to update the server.",
		});
	});
});

describe("every entry is a plain sentence and a next step", () => {
	test("outcomes: a sentence and a next step, each ending in a full stop, no markup", () => {
		for (const [code, copy] of Object.entries(OUTCOME_COPY)) {
			for (const text of [copy.sentence, copy.next]) {
				expect({ code, ok: /^[A-Z].*[.]$/.test(text), len: text.length < 200 }).toEqual({
					code,
					ok: true,
					len: true,
				});
				expect(text).not.toMatch(/[<>]|&[a-z]+;/);
			}
		}
	});

	test("states: a sentence for each, with the version only from a validated one", () => {
		for (const state of UPDATE_STATE_NAMES) {
			const { sentence } = stateCopy(state, "0.12.0");
			expect(sentence.length).toBeGreaterThan(10);
			expect(sentence).toMatch(/[.]$/);
		}
		expect(stateCopy("available", "0.12.0").next).toContain("0.12.0");
		expect(stateCopy("available", "0.12.0; rm -rf /").next ?? "").not.toContain("rm -rf");
		expect(stateCopy("available", null).next ?? "").not.toContain("null");
	});

	test("the quiet unverified copy is exactly the plan's words, and not alarming", () => {
		const copy = stateCopy("unverified", null);
		expect(copy.sentence).toBe("Can't verify updates. Update by hand.");
		expect(`${copy.sentence} ${copy.next ?? ""}`).not.toMatch(
			/problem|danger|unsafe|attack|fail|error/i,
		);
	});

	test("no copy names a personal path or a private host", () => {
		const everything = JSON.stringify([
			OUTCOME_COPY,
			MEMBER_RED_COPY,
			UNKNOWN_OUTCOME_COPY,
			UNKNOWN_STATE_COPY,
		]);
		expect(everything).not.toMatch(/\/Users\/|\/home\/|xmojo|192\.168/);
	});
});

describe("anything the table doesn't hold falls back, and never throws or echoes", () => {
	test("an unknown outcome code gets the fallback, not the code", () => {
		expect(outcomeCopy("something_new")).toEqual(UNKNOWN_OUTCOME_COPY);
		expect(JSON.stringify(outcomeCopy("<script>alert(1)</script>"))).not.toContain("script");
		expect(outcomeCopy("__proto__")).toEqual(UNKNOWN_OUTCOME_COPY);
		expect(outcomeCopy("constructor")).toEqual(UNKNOWN_OUTCOME_COPY);
	});

	test("an unknown state gets the unknown copy, not the state", () => {
		expect(stateCopy("stale_manifest", "0.12.0").sentence).toBe(UNKNOWN_STATE_COPY.sentence);
		expect(stateCopy("__proto__", null).sentence).toBe(UNKNOWN_STATE_COPY.sentence);
		expect(stateCopy("unknown", null).sentence).toBe(UNKNOWN_STATE_COPY.sentence);
	});

	test("a known code returns its own entry", () => {
		expect(outcomeCopy("dirty_tree")).toEqual(OUTCOME_COPY.dirty_tree);
	});
});

describe("copy fixes from the phase 3 review", () => {
	test("the stale-tab line is accurate after a rollback", async () => {
		const { UPDATE_NOTICE_COPY } = await import("./update-outcome-copy.js");
		expect(UPDATE_NOTICE_COPY.staleTab("0.12.0")).toBe(
			"AgentPulse is now running 0.12.0. Reload to use it.",
		);
	});

	test("the window, downgrade, disabled and up-to-date sentences", () => {
		expect(OUTCOME_COPY.outside_window.sentence).toBe("This is outside the allowed update window.");
		expect(OUTCOME_COPY.downgrade.next).toContain("--allow-downgrade");
		expect(stateCopy("disabled", null).next).toBe(
			"Remove AGENTPULSE_UPDATE_CHECK=off to turn them back on.",
		);
		expect(JSON.stringify(OUTCOME_COPY)).not.toContain("nothing to do");
	});

	test("the main-chunk copy module imports nothing of the panel or the host copy", async () => {
		const text = await Bun.file(new URL("./update-notice-copy.ts", import.meta.url)).text();
		const imports = text.split("\n").filter((line) => line.startsWith("import "));
		expect(imports.join("\n")).not.toContain("update-outcome-copy");
		expect(text).not.toMatch(/UPDATE_PANEL_COPY|UPDATE_HOST_COPY|OUTCOME_COPY/);
	});
});
