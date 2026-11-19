/**
 * The MCP package can't import src/shared, so it vendors the update-status wire type. This holds the
 * copy to the shared one: every field of `UpdateStatus` and every member of the closed unions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReleaseVersion } from "../../packages/agentpulse-mcp/src/client.js";
import {
	extractConstTuple,
	extractInterfaceFields,
	extractUnion,
} from "../../scripts/lib/parity-utils.js";
import { RED_UPDATE_STATES, UPDATE_CHECK_RESULTS, UPDATE_STATE_NAMES } from "./update-status.js";
import { parseReleaseVersion } from "./version.js";

const root = new URL("../..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SHARED = read("src/shared/update-status.ts");
const MANIFEST = read("src/shared/release-manifest.ts");
const MCP = read("packages/agentpulse-mcp/src/types.ts");
const sorted = (values: readonly string[]) => [...values].sort();

describe("the vendored update status", () => {
	test("UpdateStatus has the same fields", () => {
		const shared = extractInterfaceFields(SHARED, "UpdateStatus");
		expect(shared.length).toBeGreaterThan(8);
		expect(sorted(extractInterfaceFields(MCP, "UpdateStatus"))).toEqual(sorted(shared));
	});

	test("LocalApplyStatus has the same fields", () => {
		expect(sorted(extractInterfaceFields(MCP, "UpdateLocalApplyStatus"))).toEqual(
			sorted(extractInterfaceFields(SHARED, "LocalApplyStatus")),
		);
	});

	test("the state names are the shared ones, which are the manifest module's union", () => {
		const vendored = extractUnion(MCP, "UpdateStateName", { allowUnderscore: true });
		expect(sorted(vendored)).toEqual(sorted(UPDATE_STATE_NAMES));
		expect(sorted(extractUnion(MANIFEST, "UpdateStateName", { allowUnderscore: true }))).toEqual(
			sorted(UPDATE_STATE_NAMES),
		);
	});

	test("the check results are the shared ones plus nothing else", () => {
		const verifyCodes = extractUnion(MANIFEST, "VerifyFailureCode", { allowUnderscore: true });
		const vendored = extractUnion(MCP, "UpdateCheckResult", { allowUnderscore: true });
		expect(sorted(vendored)).toEqual(
			sorted(["ok", "unreachable", "not_published", ...verifyCodes]),
		);
	});

	test("the red-state list is a subset of the state names, and the vendored tuple equals it", () => {
		for (const state of RED_UPDATE_STATES) expect(UPDATE_STATE_NAMES).toContain(state);
		expect(sorted(extractConstTuple(MCP, "RED_UPDATE_STATES"))).toEqual(sorted(RED_UPDATE_STATES));
	});

	test("the install kinds and tracks match", () => {
		const installRecord = read("src/shared/install-record.ts");
		expect(sorted(extractUnion(MCP, "UpdateInstallKind", { allowUnderscore: true }))).toEqual(
			sorted(extractUnion(installRecord, "InstallKind", { allowUnderscore: true })),
		);
	});

	test("the vendored check results equal the shared allowlist", () => {
		expect(sorted(extractUnion(MCP, "UpdateCheckResult", { allowUnderscore: true }))).toEqual(
			sorted(UPDATE_CHECK_RESULTS),
		);
	});

	test("the vendored release-version grammar answers like the shared one", () => {
		const values = [
			"0.12.0",
			"1.2.3",
			"10.20.30",
			"0.0.0",
			"1.2.3-rc.1",
			"1.2.3-0",
			"1.2.3-01",
			"1.2.3-a.01",
			"01.2.3",
			"1.02.3",
			"1.2.03",
			"1.2",
			"1.2.3.4",
			"v1.2.3",
			"",
			" 1.2.3",
			"1.2.3 ",
			"1.2.3\n",
			"12345.0.0",
			"1.2.3-",
			"1.2.3-a..b",
			"1.2.3+build",
			`1.2.3-${"a".repeat(43)}`,
			`1.2.3-${"a".repeat(42)}`,
			"1.2.3-alpha.1.2",
			"1.2.3-ÿ",
		];
		for (const value of values) {
			expect({ value, mcp: isReleaseVersion(value) }).toEqual({
				value,
				mcp: parseReleaseVersion(value) !== null,
			});
		}
	});
});
