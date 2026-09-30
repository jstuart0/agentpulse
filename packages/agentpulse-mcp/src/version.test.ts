/**
 * Phase 6 (D7 "Where"): this campaign changes agentpulse-mcp's public
 * surface (OBSERVED_AGENT_TYPE_ENUM/AgentType gain "copilot_cli") — the
 * package version must be bumped above whatever origin/main ships, so a
 * consumer installing the published package after this merges gets a
 * version bump signal, not a silent same-version content change.
 *
 * ORIGIN_MAIN_VERSION_AT_PLANNING is pinned to the value confirmed at
 * 2d4bb8a (the commit cited in the plan's "Where": "0.1.0 on main at
 * 2d4bb8a -> 0.2.0 unless aimr-214 merges first with its own bump, in
 * which case the next minor"). This test only proves the *direction*
 * (strictly greater than that pin) — it deliberately does not hardcode
 * "0.2.0" as the exact target, since the real value depends on merge
 * order with the sibling campaign.
 */
import { describe, expect, test } from "bun:test";
import { VERSION } from "./version.js";

const ORIGIN_MAIN_VERSION_AT_PLANNING = "0.1.0";

function parseSemver(v: string): [number, number, number] {
	const parts = v.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
		throw new Error(`not a plain semver string: ${v}`);
	}
	return [parts[0], parts[1], parts[2]];
}

function isGreater(a: [number, number, number], b: [number, number, number]): boolean {
	if (a[0] !== b[0]) return a[0] > b[0];
	if (a[1] !== b[1]) return a[1] > b[1];
	return a[2] > b[2];
}

describe("Phase 6: agentpulse-mcp package version is bumped above origin/main (D7)", () => {
	test(`VERSION (${VERSION}) is strictly greater than the origin/main baseline (${ORIGIN_MAIN_VERSION_AT_PLANNING})`, () => {
		expect(isGreater(parseSemver(VERSION), parseSemver(ORIGIN_MAIN_VERSION_AT_PLANNING))).toBe(
			true,
		);
	});
});
