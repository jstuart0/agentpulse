import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRelease } from "./prepare.ts";
import { VERSION_SITES, readVersions } from "./version-parity.ts";

const REPO = join(import.meta.dir, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "ap-release-prepare-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function copyTree(name: string): string {
	const root = join(tmp, name);
	for (const site of VERSION_SITES) {
		mkdirSync(dirname(join(root, site.file)), { recursive: true });
		cpSync(join(REPO, site.file), join(root, site.file));
	}
	return root;
}

describe("release:prepare", () => {
	test("sets every version file and leaves the rest of each file alone", () => {
		const root = copyTree("ok");
		const before = readFileSync(join(root, "scripts/relay.ts"), "utf-8");
		const changed = prepareRelease(root, "9.8.7");
		expect(changed.sort()).toEqual([...VERSION_SITES.map((s) => s.file)].sort());
		expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(["9.8.7"]));
		const after = readFileSync(join(root, "scripts/relay.ts"), "utf-8");
		expect(after.split("\n").length).toBe(before.split("\n").length);
	});

	test("refuses a version outside the strict grammar and changes nothing", () => {
		const root = copyTree("bad");
		const before = readVersions(root);
		for (const bad of ["1.2", "v1.2.3", "1.2.3+build", "01.2.3", ""]) {
			expect(() => prepareRelease(root, bad)).toThrow(/not a release version/);
		}
		expect(readVersions(root)).toEqual(before);
	});

	test("running it twice changes nothing the second time", () => {
		const root = copyTree("twice");
		prepareRelease(root, "2.0.0");
		expect(prepareRelease(root, "2.0.0")).toEqual([]);
	});
});
