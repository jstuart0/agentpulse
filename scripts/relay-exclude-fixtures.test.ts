/**
 * The shared fixture matrix (src/shared/__fixtures__/exclude-cases.json) is
 * the contract every evaluator meets: the TypeScript module, the shell and
 * PowerShell scripts, and the copy of the TypeScript evaluator embedded in
 * scripts/relay.ts. This runs the matrix against the RELAY's copy, imported
 * from the relay module itself, so the relay is held to the same cases.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as shared from "../src/shared/exclude-rules.ts";
import type { ExcludeFixtureCase } from "../src/shared/exclude-rules.ts";

// scripts/check-installers.ts: relay.ts is imported with a query, never plainly.
const relay = (await import("./relay.ts?module")) as typeof import("./relay.ts");

const fixtures: ExcludeFixtureCase[] = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "src/shared/__fixtures__/exclude-cases.json"), "utf-8"),
).cases;

function isApplicable(fixture: ExcludeFixtureCase, platform: NodeJS.Platform): boolean {
	if (fixture.platform === "any") return true;
	if (fixture.platform === "posix") return platform !== "win32";
	return fixture.platform === platform;
}

function rawContentFor(fixture: ExcludeFixtureCase): string | undefined {
	if (fixture.rulesFileLinesRaw !== undefined) return fixture.rulesFileLinesRaw;
	if (fixture.rulesFileLines !== undefined) return `${fixture.rulesFileLines.join("\n")}\n`;
	return undefined;
}

function rewriteUnderHome(
	cwd: string | null | undefined,
	fixtureHome: string | undefined,
	realHome: string,
): string | null {
	if (cwd === undefined || cwd === null) return null;
	if (fixtureHome && cwd.startsWith(fixtureHome)) return realHome + cwd.slice(fixtureHome.length);
	return cwd;
}

describe("the relay's embedded evaluator meets the shared fixture matrix", () => {
	test("the relay exports the evaluator it embeds", () => {
		for (const name of [
			"loadExcludeRules",
			"evaluateExclusion",
			"isSkipValue",
			"isSkipHeaderValue",
			"setInvalidMarker",
			"normalizeForCompare",
			"matchesRule",
		]) {
			expect(typeof (relay as Record<string, unknown>)[name], name).toBe("function");
		}
	});

	const matchable = fixtures.filter((f) => !f.dedicated && f.cwd !== undefined);
	test("the matching fixture set is non-trivially large", () => {
		expect(matchable.length).toBeGreaterThanOrEqual(20);
	});

	for (const fixture of matchable) {
		test.skipIf(!isApplicable(fixture, process.platform))(`${fixture.name}`, () => {
			const home = mkdtempSync(join(tmpdir(), "ap-relay-fixture-"));
			try {
				const content = rawContentFor(fixture);
				if (content !== undefined) {
					mkdirSync(join(home, ".agentpulse"), { recursive: true });
					writeFileSync(join(home, ".agentpulse", "exclude"), content);
				}
				const cwd = rewriteUnderHome(fixture.cwd, fixture.home, home);
				const viaRelay = relay.evaluateExclusion({
					cwd,
					skip: undefined,
					rules: relay.loadExcludeRules(home),
				});
				expect(viaRelay.excluded).toBe(fixture.expected.excluded);
				expect(viaRelay.reason).toBe(fixture.expected.reason ?? null);
				// and it is the same answer the shared module gives
				const viaShared = shared.evaluateExclusion({
					cwd,
					skip: undefined,
					rules: shared.loadExcludeRules(home),
				});
				expect(viaRelay).toEqual(viaShared);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}

	const skipFixtures = fixtures.filter((f) => f.expectedSkip !== undefined);
	test("at least 18 skip-value fixtures are present", () => {
		expect(skipFixtures.length).toBeGreaterThanOrEqual(18);
	});
	for (const fixture of skipFixtures) {
		test(`skip value: ${fixture.name}`, () => {
			expect(relay.isSkipValue(fixture.skip)).toBe(fixture.expectedSkip as boolean);
		});
	}

	test("the header form caps the length it will look at, the value form does not", () => {
		expect(relay.isSkipHeaderValue("1")).toBe(true);
		expect(relay.isSkipHeaderValue(" \tYes\r\n")).toBe(true);
		expect(relay.isSkipHeaderValue("$AGENTPULSE_SKIP")).toBe(false);
		expect(relay.isSkipHeaderValue("")).toBe(false);
		expect(relay.isSkipHeaderValue(null)).toBe(false);
		const padded = `${" ".repeat(relay.SKIP_HEADER_MAX_LENGTH)}1`;
		expect(relay.isSkipValue(padded)).toBe(true);
		expect(relay.isSkipHeaderValue(padded)).toBe(false);
	});
});
