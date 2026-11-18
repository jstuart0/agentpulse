import { describe, expect, test } from "bun:test";
import * as legacy from "../supervisor/providers/version-range.js";
import {
	type ReleaseVersion,
	compareReleaseVersions,
	compareVersions,
	parseReleaseVersion,
	parseVersion,
	parseVersionPrefix,
	versionInRange,
} from "./version.js";

function rv(text: string): ReleaseVersion {
	const parsed = parseReleaseVersion(text);
	if (!parsed) throw new Error(`expected ${JSON.stringify(text)} to parse`);
	return parsed;
}
const cmp = (a: string, b: string) => Math.sign(compareReleaseVersions(rv(a), rv(b)));

describe("parseReleaseVersion (strict)", () => {
	test("accepts plain and pre-release versions", () => {
		expect(rv("0.11.0").core).toEqual([0, 11, 0]);
		expect(rv("1.2.3-rc.1")).toEqual({ core: [1, 2, 3], pre: ["rc", "1"] });
		expect(rv("1.2.3").pre).toEqual([]);
	});

	test("refuses leading zeros, empty identifiers, build metadata, trailing newline", () => {
		for (const bad of [
			"01.2.3",
			"1.02.3",
			"1.2.03",
			"1.2.3-01",
			"1.2.3-",
			"1.2.3-a..b",
			"1.2.3-a.",
			"1.2.3+build",
			"1.2.3-rc.1+build",
			"1.2.3\n",
			" 1.2.3",
			"1.2",
			"v1.2.3",
			"1.2.3garbage",
			"",
		]) {
			expect(parseReleaseVersion(bad)).toBeNull();
		}
	});

	test("length limit: 48 characters accepted, 49 refused", () => {
		const base = "1.2.3-";
		expect(parseReleaseVersion(base + "a".repeat(48 - base.length))).not.toBeNull();
		expect(parseReleaseVersion(base + "a".repeat(49 - base.length))).toBeNull();
	});

	test("numeric parts: 4 digits accepted, 5 refused", () => {
		expect(parseReleaseVersion("9999.9999.9999")).not.toBeNull();
		for (const bad of ["10000.0.0", "0.10000.0", "0.0.10000"]) {
			expect(parseReleaseVersion(bad)).toBeNull();
		}
	});

	test("a non-string is refused", () => {
		expect(parseReleaseVersion(undefined as unknown as string)).toBeNull();
		expect(parseReleaseVersion(1 as unknown as string)).toBeNull();
	});
});

describe("compareReleaseVersions (semver 2.0 precedence)", () => {
	test("numeric, not lexical: 0.9.0 < 0.10.0 < 0.11.0", () => {
		expect(cmp("0.9.0", "0.10.0")).toBe(-1);
		expect(cmp("0.10.0", "0.11.0")).toBe(-1);
		expect(cmp("0.11.0", "0.9.0")).toBe(1);
		expect(cmp("1.2.3", "1.2.3")).toBe(0);
	});

	test("pre-release chain: alpha < alpha.1 < alpha.beta < beta.2 < beta.11 < rc.1 < release", () => {
		const chain = [
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-alpha.beta",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
		];
		for (let i = 0; i < chain.length - 1; i++) {
			expect(cmp(chain[i] as string, chain[i + 1] as string)).toBe(-1);
			expect(cmp(chain[i + 1] as string, chain[i] as string)).toBe(1);
		}
	});

	test("numeric identifiers sort below alphanumeric ones", () => {
		expect(cmp("1.0.0-1", "1.0.0-a")).toBe(-1);
	});

	test("a pre-release of a higher core still beats a lower release", () => {
		expect(cmp("0.12.0-rc.1", "0.11.0")).toBe(1);
	});
});

describe("parseVersionPrefix keeps the binary-version behaviour", () => {
	test("accepts a leading x.y.z and ignores the rest", () => {
		expect(parseVersionPrefix("1.2.3garbage")).toEqual([1, 2, 3]);
		expect(parseVersionPrefix("0.163.0 (build 5)")).toEqual([0, 163, 0]);
		expect(parseVersionPrefix("garbage")).toBeNull();
		expect(parseVersionPrefix(null)).toBeNull();
	});

	test("the strict parser refuses what the prefix parser accepts", () => {
		expect(parseReleaseVersion("1.2.3garbage")).toBeNull();
	});

	test("the old names still work and version-range re-exports the same functions", () => {
		expect(parseVersion("2.1.318")).toEqual([2, 1, 318]);
		expect(compareVersions([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
		expect(versionInRange([2, 1, 320], [2, 1, 318], [2, 2, 0])).toBe(true);
		expect(versionInRange([2, 2, 0], [2, 1, 318], [2, 2, 0])).toBe(false);
		expect(legacy.parseVersion).toBe(parseVersion);
		expect(legacy.compareVersions).toBe(compareVersions);
		expect(legacy.versionInRange).toBe(versionInRange);
	});
});
