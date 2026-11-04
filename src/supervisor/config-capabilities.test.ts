/**
 * AGEN-91 (Pattern 3): a supervisor feature has to be in both feature lists, the default one and the one
 * built from what the host really has. `codex_follow_up_prompts` says "this process can start a turn on a
 * managed Codex thread"; the server withholds Codex prompts from a host that lacks it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_FOLLOW_UP_PROMPTS } from "../shared/constants.js";
import { buildDefaultConfig, withExecutableCapabilities } from "./config.js";
import { installFakeCodex } from "./providers/__fixtures__/fake-codex.js";

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "ap-config-capabilities-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("codex_follow_up_prompts", () => {
	test("is the literal the server reads", () => {
		expect(CODEX_FOLLOW_UP_PROMPTS).toBe("codex_follow_up_prompts");
	});

	test("is in the default list, which has grown by it", () => {
		const features = buildDefaultConfig().capabilities.features;
		expect(features).toContain("codex_follow_up_prompts");
		// Ten entries before this feature: an emptied list can't satisfy this.
		expect(features.length).toBeGreaterThanOrEqual(11);
	});

	test("is in the detected list only when Codex resolved", async () => {
		const withCodex = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: installFakeCodex(scratch),
		});
		const without = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: join(scratch, "no-such-codex"),
		});
		expect(withCodex.capabilities.features).toContain("codex_follow_up_prompts");
		expect(withCodex.capabilities.features).toContain("managed_codex");
		expect(without.capabilities.features).not.toContain("codex_follow_up_prompts");
		expect(without.capabilities.features).not.toContain("managed_codex");
		// Exactly the two Codex entries differ.
		expect(withCodex.capabilities.features.length - without.capabilities.features.length).toBe(2);
		expect(without.capabilities.features.length).toBeGreaterThanOrEqual(5);
	});
});
