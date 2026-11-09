import { describe, expect, test } from "bun:test";
import {
	AGENT_METADATA,
	AGENT_TYPES,
	LAUNCHABLE_AGENT_TYPES,
	isLaunchable,
	isObservedOnly,
} from "./constants.js";

describe("observed-only agent types", () => {
	test("isObservedOnly is true for Copilot CLI and OpenCode, false for the launchable agents", () => {
		expect(isObservedOnly("copilot_cli")).toBe(true);
		expect(isObservedOnly("opencode")).toBe(true);
		expect(isObservedOnly("claude_code")).toBe(false);
		expect(isObservedOnly("codex_cli")).toBe(false);
	});

	test("an unknown or inherited name is not observed-only (and does not throw)", () => {
		for (const name of ["", "totally_bogus", "constructor", "__proto__", "toString"]) {
			expect(isObservedOnly(name), name).toBe(false);
		}
	});

	test("every registered agent type is either launchable or observed-only, never both", () => {
		for (const t of AGENT_TYPES) {
			expect(isLaunchable(t) !== isObservedOnly(t), t).toBe(true);
		}
	});

	test("opencode is observed, carries a hint, and is not launchable (AGEN-141)", () => {
		expect(AGENT_TYPES).toContain("opencode");
		expect(LAUNCHABLE_AGENT_TYPES as readonly string[]).not.toContain("opencode");
		expect(isLaunchable("opencode")).toBe(false);
		expect(AGENT_METADATA.opencode.label).toBe("OpenCode");
		expect(AGENT_METADATA.opencode.observeOnlyHint).toContain("OpenCode");
		expect(AGENT_METADATA.opencode.hasNameSource).toBe(false);
	});

	test("badge colours are distinct across agents", () => {
		const badges = AGENT_TYPES.map((t) => AGENT_METADATA[t].badgeClass);
		const dots = AGENT_TYPES.map((t) => AGENT_METADATA[t].dotClass);
		expect(new Set(badges).size).toBe(AGENT_TYPES.length);
		expect(new Set(dots).size).toBe(AGENT_TYPES.length);
	});
});
