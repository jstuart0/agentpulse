import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo } from "./fixture-repo.ts";
import { recomputeTags } from "./image-tags.ts";
import { pinRelease } from "./pin.ts";
import {
	type PreflightOptions,
	imageTagsFor,
	parseReleaseKeysSource,
	revisionFromIndex,
	runPreflight,
	stableVersionsFromRemoteTags,
} from "./preflight.ts";

const cleanup: string[] = [];
afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const KEYS_WITH_ACTIVE = `export const RELEASE_KEYS = [\n\t{ keyId: "k-000000000001", publicKeyRaw: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "active" },\n];\n`;
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
		const unlabelled = run("v0.20.0", { existingImageRevision: () => "" });
		expect(unlabelled.ok).toBe(false);
		if (!unlabelled.ok) expect(unlabelled.reason).toMatch(/no revision label/);
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

const KEY = (id: string, status: string) =>
	`{ keyId: "${id}", publicKeyRaw: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "${status}" }`;

describe("parseReleaseKeysSource: the exported list is parsed, not pattern-matched", () => {
	const src = (body: string) => `export const RELEASE_KEYS: readonly ReleaseKey[] = [${body}];\n`;

	test("reads active and standby entries, tolerating comments and trailing commas", () => {
		const keys = parseReleaseKeysSource(
			src(
				`\n\t// the first key\n\t${KEY("k-aaaaaaaaaaaa", "active")},\n\t${KEY("k-bbbbbbbbbbbb", "standby")},\n`,
			),
		);
		expect(keys?.map((k) => [k.keyId, k.status])).toEqual([
			["k-aaaaaaaaaaaa", "active"],
			["k-bbbbbbbbbbbb", "standby"],
		]);
	});

	test("reads the repository's own release-keys.ts as Biome formats it (multi-line entries, trailing commas)", () => {
		const keys = parseReleaseKeysSource(
			readFileSync(join(import.meta.dir, "../../src/shared/release-keys.ts"), "utf8"),
		);
		expect(keys?.some((k) => k.status === "active")).toBe(true);
	});

	test("an empty list parses to an empty list", () => {
		expect(parseReleaseKeysSource(src(""))).toEqual([]);
	});

	const bad: [string, string][] = [
		["an active key that is commented out", src(`// ${KEY("k-aaaaaaaaaaaa", "active")},`)],
		["a block-commented active key", src(`/* ${KEY("k-aaaaaaaaaaaa", "active")} */`)],
		["a bad status", src(KEY("k-aaaaaaaaaaaa", "root"))],
		["a key id with a slash", src(KEY("k/aaaaaaaaaaa", "active"))],
		[
			"a public key of the wrong length",
			src(`{ keyId: "k-aaaaaaaaaaaa", publicKeyRaw: "AAAA", status: "active" }`),
		],
		[
			"a duplicate key id",
			src(`${KEY("k-aaaaaaaaaaaa", "active")}, ${KEY("k-aaaaaaaaaaaa", "standby")}`),
		],
		[
			"an extra field",
			src(
				`{ keyId: "k-aaaaaaaaaaaa", publicKeyRaw: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "active", x: 1 }`,
			),
		],
		["no RELEASE_KEYS at all", "export const OTHER = [];\n"],
	];
	for (const [name, text] of bad) {
		test(`refuses ${name}`, () => {
			const keys = parseReleaseKeysSource(text);
			expect(keys === null || !keys.some((k) => k.status === "active")).toBe(true);
		});
	}

	test("a tree whose only 'active' is in a comment fails the preflight (the old regex passed it)", () => {
		const repo = createFixtureRepo();
		cleanup.push(repo.dir);
		repo.commit(
			files("0.30.0", {
				"src/shared/release-keys.ts": src(`// ${KEY("k-aaaaaaaaaaaa", "active")},`),
			}),
		);
		const sha = repo.git("rev-parse", "HEAD");
		repo.tag("v0.30.0", sha);
		repo.commit({ "releases/release-data.json": dataFile([{ version: "0.30.0", commit: sha }]) });
		repo.pushMain();
		const r = runPreflight({ repoDir: repo.dir, tag: "v0.30.0" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/active/);
	});
});

describe("revisionFromIndex: the linux/amd64 image's own label, from an attested index", () => {
	const index = JSON.parse(
		readFileSync(join(import.meta.dir, "__fixtures__/attested-index.json"), "utf-8"),
	);
	const config = JSON.parse(
		readFileSync(join(import.meta.dir, "__fixtures__/image-config-amd64.json"), "utf-8"),
	);
	const AMD64 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

	test("picks the linux/amd64 manifest, not the attestation, and reads its revision label", () => {
		const asked: string[] = [];
		const r = revisionFromIndex(index, (digest) => {
			asked.push(digest);
			return digest === AMD64 ? config : null;
		});
		expect(r).toEqual({ state: "ok", revision: "0123456789abcdef0123456789abcdef01234567" });
		expect(asked).toEqual([AMD64]);
	});

	test("a missing label is its own state, not a mismatch", () => {
		const bare = { ...config, config: { Labels: { other: "x" } } };
		expect(revisionFromIndex(index, () => bare)).toEqual({ state: "no_label" });
		expect(revisionFromIndex(index, () => ({ config: {} }))).toEqual({ state: "no_label" });
	});

	test("an index with no linux/amd64 image, or an unreadable config, is refused as unreadable", () => {
		const attestationOnly = { ...index, manifests: [index.manifests[1]] };
		expect(revisionFromIndex(attestationOnly, () => config)).toEqual({ state: "unreadable" });
		expect(revisionFromIndex(index, () => null)).toEqual({ state: "unreadable" });
	});

	test("a plain single-image manifest (no index) reads its config directly", () => {
		const single = {
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			config: { digest: AMD64 },
		};
		expect(revisionFromIndex(single, () => config)).toEqual({
			state: "ok",
			revision: "0123456789abcdef0123456789abcdef01234567",
		});
	});
});

describe("stableVersionsFromRemoteTags", () => {
	test("reads `git ls-remote --tags` output, peeled lines and junk included", () => {
		const text = [
			"aaa\trefs/tags/v0.12.0",
			"bbb\trefs/tags/v0.12.0^{}",
			"ccc\trefs/tags/v0.13.0-rc.1",
			"ddd\trefs/tags/mcp-v0.4.0",
			"eee\trefs/tags/v1.0.0",
			"fff\trefs/tags/v1.0.0;x",
		].join("\n");
		expect(stableVersionsFromRemoteTags(text).sort()).toEqual(["0.12.0", "0.13.0-rc.1", "1.0.0"]);
	});
});

describe("recomputeTags (images job, right before the build)", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	const remote = (...tags: string[]) => tags.map((t) => `deadbeef\trefs/tags/${t}`).join("\n");

	test("the highest stable tag still gets the floating tags", () => {
		const { tags, backupTags } = recomputeTags("1.4.0", sha, remote("v1.3.0", "v1.4.0"));
		expect(tags.map((t) => t.split(":")[1])).toEqual([
			"1.4.0",
			"sha-0123456789ab",
			"1.4",
			"1",
			"latest",
		]);
		expect(backupTags[0]).toBe("ghcr.io/jstuart0/agentpulse-backup:1.4.0");
	});

	test("a higher stable tag pushed after preflight takes the floating tags away", () => {
		const { tags } = recomputeTags("1.4.0", sha, remote("v1.3.0", "v1.4.0", "v1.5.0"));
		expect(tags.map((t) => t.split(":")[1])).toEqual(["1.4.0", "sha-0123456789ab"]);
	});
});
