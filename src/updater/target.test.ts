import { describe, expect, test } from "bun:test";
import { NOW, testPayload, testRelease } from "../shared/__fixtures__/release-test-signer.js";
import type { Manifest } from "../shared/release-manifest.js";
import { type TargetInput, chooseTarget } from "./target.js";

const OLD = "2026-11-01T00:00:00.000Z";
function manifest(over: Partial<Manifest> = {}): Manifest {
	return testPayload({
		latest: "0.13.0",
		releases: [
			testRelease("0.13.0", { publishedAt: OLD }),
			testRelease("0.12.1", { publishedAt: OLD }),
			testRelease("0.12.0", { publishedAt: OLD }),
			testRelease("0.11.0", { publishedAt: OLD }),
		],
		...over,
	});
}
const input = (over: Partial<TargetInput> = {}): TargetInput => ({
	manifest: manifest(),
	installed: "0.12.0",
	mode: "manual",
	refused: {},
	now: NOW,
	...over,
});
const code = (over: Partial<TargetInput> = {}) => {
	const r = chooseTarget(input(over));
	return r.ok ? `ok:${r.release.version}` : r.code;
};

describe("chooseTarget", () => {
	test("takes latest; equal is up to date; a version ahead of latest is up to date, not a downgrade", () => {
		expect(code()).toBe("ok:0.13.0");
		expect(code({ installed: "0.13.0" })).toBe("up_to_date");
		expect(code({ installed: "0.14.0" })).toBe("up_to_date");
	});
	test("--to: unknown, pulled, refused, older", () => {
		expect(code({ to: "0.12.1" })).toBe("ok:0.12.1");
		expect(code({ to: "9.9.9" })).toBe("unverified");
		expect(code({ to: "not-a-version" })).toBe("unverified");
		expect(code({ refused: { "0.12.1": "rolled_back" }, to: "0.12.1" })).toBe("refused_before");
		expect(code({ to: "0.11.0" })).toBe("downgrade");
		expect(code({ to: "0.11.0", allowDowngrade: true })).toBe("ok:0.11.0");
		// the flag never helps an automatic run
		expect(code({ to: "0.11.0", allowDowngrade: true, mode: "auto" })).toBe("downgrade");
	});
	test("a pulled release is never offered", () => {
		const m = manifest({
			latest: "0.13.0",
			releases: [
				testRelease("0.13.0", { publishedAt: OLD }),
				testRelease("0.12.0", { publishedAt: OLD, pulled: true }),
				testRelease("0.11.0", { publishedAt: OLD }),
			],
		});
		expect(code({ manifest: m, installed: "0.11.0", to: "0.12.0" })).toBe("pulled");
	});
	test("automatic: waits 24 hours unless security", () => {
		const fresh = manifest({
			releases: [
				testRelease("0.13.0", { publishedAt: new Date(NOW - 3_600_000).toISOString() }),
				testRelease("0.12.0", { publishedAt: OLD }),
			],
		});
		expect(code({ manifest: fresh, mode: "auto" })).toBe("canary_wait");
		const security = manifest({
			releases: [
				testRelease("0.13.0", {
					publishedAt: new Date(NOW - 3_600_000).toISOString(),
					severity: "security",
				}),
				testRelease("0.12.0", { publishedAt: OLD }),
			],
		});
		expect(code({ manifest: security, mode: "auto" })).toBe("ok:0.13.0");
		// manual runs aren't held back
		expect(code({ manifest: fresh })).toBe("ok:0.13.0");
	});
	test("supervisor-only: the highest stable non-pulled release at or below the server", () => {
		const m = manifest({
			releases: [
				testRelease("0.13.0", { publishedAt: OLD }),
				testRelease("0.12.1", { publishedAt: OLD, pulled: true }),
				testRelease("0.12.0", { publishedAt: OLD }),
				testRelease("0.11.0", { publishedAt: OLD }),
			],
		});
		expect(
			code({ manifest: m, installed: "0.11.0", serverVersion: { value: "0.13.0-rc.1" } }),
		).toBe("ok:0.12.0");
		expect(code({ manifest: m, installed: "0.11.0", serverVersion: { value: "0.13.0" } })).toBe(
			"ok:0.13.0",
		);
		expect(code({ manifest: m, installed: "0.12.0", serverVersion: { value: "0.12.5" } })).toBe(
			"up_to_date",
		);
		expect(code({ manifest: m, installed: "0.11.0", serverVersion: { value: null } })).toBe(
			"server_version_unknown",
		);
		// never ahead of the server, even when asked
		expect(
			code({ manifest: m, installed: "0.11.0", serverVersion: { value: "0.12.0" }, to: "0.13.0" }),
		).toBe("server_version_unknown");
	});
});
