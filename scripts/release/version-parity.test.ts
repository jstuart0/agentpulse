import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION_SITES, readVersions } from "./version-parity.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("version parity", () => {
	test("the population is the explicit three files, including the relay", () => {
		expect(VERSION_SITES.map((s) => s.file).sort()).toEqual([
			"package.json",
			"scripts/relay.ts",
			"scripts/statusline.sh",
		]);
	});

	test("each file carries its constant, and all three are equal", () => {
		const versions = readVersions(ROOT);
		for (const [file, version] of Object.entries(versions)) {
			expect(version, `${file} has no version constant`).not.toBeNull();
		}
		expect(new Set(Object.values(versions)).size).toBe(1);
	});

	test("the named member scripts/relay.ts exports RELAY_VERSION equal to package.json", async () => {
		const relay = (await import("../relay.ts?module")) as { RELAY_VERSION?: string };
		const pkg = (await import("../../package.json", { with: { type: "json" } })).default;
		expect(relay.RELAY_VERSION).toBe(pkg.version);
	});

	test("each pattern matches its own rendering", () => {
		for (const site of VERSION_SITES) {
			expect(site.pattern.exec(site.render("1.2.3"))?.[1]).toBe("1.2.3");
		}
	});
});
