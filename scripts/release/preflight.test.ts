import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo } from "./fixture-repo.ts";
import { pinRelease } from "./pin.ts";
import { type PreflightOptions, imageTagsFor, runPreflight } from "./preflight.ts";

const cleanup: string[] = [];
afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const KEYS_WITH_ACTIVE = `export const RELEASE_KEYS = [\n\t{ keyId: "k-000000000001", publicKeyRaw: "AAAA", status: "active" },\n];\n`;
const KEYS_EMPTY = "export const RELEASE_KEYS: readonly ReleaseKey[] = [];\n";

const files = (version: string, over: Record<string, string> = {}) => ({
	"package.json": `{\n\t"name": "agentpulse",\n\t"version": "${version}",\n\t"private": true\n}\n`,
	"scripts/relay.ts": `export const RELAY_VERSION = "${version}";\n`,
	"scripts/statusline.sh": `AGENTPULSE_STATUSLINE_VERSION="${version}"\n`,
	"src/shared/release-keys.ts": KEYS_WITH_ACTIVE,
	...over,
});

const dataFile = (pins: { version: string; commit: string }[]) =>
	JSON.stringify({
		schema: 1,
		firstSignedVersion: "0.12.0",
		minSupported: "0.11.0",
		revokedKeyIds: [],
		releases: pins,
	});

function world() {
	const repo = createFixtureRepo();
	cleanup.push(repo.dir);
	repo.commit(files("0.11.0"), "base");
	const good = repo.commit(files("0.20.0"), "0.20.0");
	repo.tag("v0.20.0", good);
	const light = repo.commit(files("0.12.1"), "0.12.1");
	repo.tag("v0.12.1", light, "lightweight");
	const badRelay = repo.commit(
		files("0.12.2", { "scripts/relay.ts": 'export const RELAY_VERSION = "0.11.0";\n' }),
		"relay not bumped",
	);
	repo.tag("v0.12.2", badRelay);
	const badPkg = repo.commit(files("0.11.0"), "package not bumped");
	repo.tag("v0.12.3", badPkg);
	const noKey = repo.commit(
		files("0.12.4", { "src/shared/release-keys.ts": KEYS_EMPTY }),
		"no key",
	);
	repo.tag("v0.12.4", noKey);
	const pre = repo.commit(files("0.13.0-rc.1"), "rc");
	repo.tag("v0.13.0-rc.1", pre);
	const unpinned = repo.commit(files("0.12.5"), "unpinned");
	repo.tag("v0.12.5", unpinned);
	const backport = repo.commit(files("0.11.9"), "backport");
	repo.tag("v0.11.9", backport);
	const wrongPin = repo.commit(files("0.12.7"), "pinned to another commit");
	repo.tag("v0.12.7", wrongPin);
	repo.pushMain();
	repo.git("checkout", "-q", "-b", "side");
	const offMain = repo.commit(files("0.12.6"), "off main");
	repo.tag("v0.12.6", offMain);
	repo.git("checkout", "-q", "main");
	const pins = [good, light, badRelay, badPkg, noKey, pre, backport, offMain].map((commit, i) => ({
		version: ["0.20.0", "0.12.1", "0.12.2", "0.12.3", "0.12.4", "0.13.0-rc.1", "0.11.9", "0.12.6"][
			i
		] as string,
		commit,
	}));
	repo.commit(
		{ "releases/release-data.json": dataFile([...pins, { version: "0.12.7", commit: good }]) },
		"pins",
	);
	repo.pushMain();
	return { repo, good, pre, backport };
}

let shared: ReturnType<typeof world> | undefined;
const w = () => {
	shared ??= world();
	return shared;
};
const run = (tag: string, over: Partial<PreflightOptions> = {}) =>
	runPreflight({ repoDir: w().repo.dir, tag, shortShaLength: 7, ...over });

describe("runPreflight", () => {
	test("a good annotated, pinned, on-main tag passes and gets every image tag", () => {
		const r = run("v0.20.0");
		expect(r).toEqual({
			ok: true,
			version: "0.20.0",
			commit: w().good,
			imageTags: ["0.20.0", `sha-${w().good.slice(0, 7)}`, "0.20", "0", "latest"],
		});
	});

	const refusals: [string, string, RegExp][] = [
		["a lightweight tag", "v0.12.1", /annotated/],
		["a relay constant that wasn't bumped", "v0.12.2", /RELAY_VERSION|relay/i],
		["a package.json that wasn't bumped", "v0.12.3", /package\.json/],
		["a tree with no active release key", "v0.12.4", /active/],
		["a version not pinned in release-data.json", "v0.12.5", /pin/],
		["a commit that isn't on origin/main", "v0.12.6", /origin\/main/],
		["a tag that doesn't exist", "v0.12.99", /exist|resolve/],
		["a pin that names another commit", "v0.12.7", /pin|commit/],
	];
	for (const [name, tag, why] of refusals) {
		test(`refuses ${name}`, () => {
			const r = run(tag);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(why);
		});
	}

	test("refuses tag names outside the grammar before touching git (v1.2.3;x and friends)", () => {
		for (const tag of [
			"v1.2.3;x",
			"v01.2.3",
			"v1.2",
			"1.2.3",
			"v1.2.3-",
			"v1.2.3 ",
			"v1.2.3\n",
			"v1.2.3-$(id)",
		]) {
			const r = run(tag);
			expect(r.ok, JSON.stringify(tag)).toBe(false);
			if (!r.ok) expect(r.reason, JSON.stringify(tag)).toMatch(/not a release tag/);
		}
	});

	test("a pre-release gets only its own version and the sha tag", () => {
		const r = run("v0.13.0-rc.1");
		expect(r.ok && r.imageTags).toEqual(["0.13.0-rc.1", `sha-${w().pre.slice(0, 7)}`]);
	});

	test("a backport below the highest stable tag never gets latest, X.Y or X", () => {
		const r = run("v0.11.9");
		expect(r.ok && r.imageTags).toEqual(["0.11.9", `sha-${w().backport.slice(0, 7)}`]);
	});

	test("refuses to repoint an existing X.Y.Z image built from a different commit; the same commit is allowed", () => {
		const other = run("v0.20.0", { existingImageRevision: () => "f".repeat(40) });
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.reason).toMatch(/already exists|different commit/);
		const same = run("v0.20.0", { existingImageRevision: () => w().good });
		expect(same.ok).toBe(true);
		const none = run("v0.20.0", { existingImageRevision: () => null });
		expect(none.ok).toBe(true);
	});
});

describe("imageTagsFor", () => {
	test("the highest stable gets X.Y, X and latest; others don't", () => {
		expect(imageTagsFor("1.4.2", "abcdef0", ["1.4.2", "1.4.1", "1.3.0"])).toEqual([
			"1.4.2",
			"sha-abcdef0",
			"1.4",
			"1",
			"latest",
		]);
		expect(imageTagsFor("1.4.1", "abcdef0", ["1.4.2", "1.4.1"])).toEqual(["1.4.1", "sha-abcdef0"]);
		expect(imageTagsFor("2.0.0-rc.1", "abcdef0", ["1.4.2"])).toEqual(["2.0.0-rc.1", "sha-abcdef0"]);
	});
});

describe("pinRelease (release:pin)", () => {
	test("writes a sorted pin for a commit that is on origin/main and says that version", () => {
		const { repo, good } = w();
		const path = join(repo.dir, "releases/release-data.json");
		pinRelease(repo.dir, "0.20.0", good);
		const data = JSON.parse(readFileSync(path, "utf-8"));
		expect(data.releases.filter((r: { version: string }) => r.version === "0.20.0")).toEqual([
			{ version: "0.20.0", commit: good },
		]);
	});

	test("refuses a commit whose package.json says another version, one not on origin/main, and a re-pin to a different commit", () => {
		const { repo, good } = w();
		const head = repo.git("rev-parse", "HEAD");
		expect(() => pinRelease(repo.dir, "0.12.9", good)).toThrow(/package\.json/);
		const sideCommit = repo.git("rev-parse", "v0.12.6");
		expect(() => pinRelease(repo.dir, "0.12.6", sideCommit)).toThrow(/origin\/main/);
		expect(() => pinRelease(repo.dir, "0.20.0", head)).toThrow(/package\.json|already pinned/);
		expect(() => pinRelease(repo.dir, "not-a-version", good)).toThrow(/version/);
		expect(() => pinRelease(repo.dir, "0.20.0", "abc")).toThrow(/40/);
	});
});
