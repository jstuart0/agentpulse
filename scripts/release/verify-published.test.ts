import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOW,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
} from "../../src/shared/__fixtures__/release-test-signer.ts";
import type { CappedFetchResult, fetchCapped } from "../../src/shared/capped-fetch.ts";

type Fetcher = typeof fetchCapped;
import { type AuditSnapshot, auditFindings, verifyPublished } from "./verify-published.ts";
import { type LiveOptions, envelopeFromEnv, writeSiteManifest } from "./write-site-manifest.ts";

const NO_LIVE: LiveOptions = { noLive: true, nothingPinned: false };

const dirs: string[] = [];
const site = () => {
	const dir = mkdtempSync(join(tmpdir(), "ap-site-"));
	dirs.push(dir);
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), "<html></html>");
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("writeSiteManifest (the deploy gate)", () => {
	test("verifies the envelope and writes it byte for byte", async () => {
		const dir = site();
		const envelope = envelopeFor(testPayload());
		const done = await writeSiteManifest({
			siteDir: dir,
			envelope,
			keys: TEST_KEY_LIST,
			now: NOW,
			live: NO_LIVE,
		});
		expect(done).toEqual({ seq: 100, latest: "0.12.0", keyStatus: "active" });
		expect(readFileSync(join(dir, "releases/manifest.json"), "utf-8")).toBe(envelope);
	});

	test("an envelope that doesn't verify writes nothing", async () => {
		const dir = site();
		const envelope = envelopeFor(testPayload(), "unknown");
		await expect(
			writeSiteManifest({ siteDir: dir, envelope, keys: TEST_KEY_LIST, now: NOW, live: NO_LIVE }),
		).rejects.toThrow(/unknown_key/);
		await expect(
			writeSiteManifest({ siteDir: dir, envelope, keys: [], now: NOW, live: NO_LIVE }),
		).rejects.toThrow(/does not verify/);
		expect(() => readFileSync(join(dir, "releases/manifest.json"))).toThrow();
	});

	test("an expired manifest is refused, not published", async () => {
		const dir = site();
		await expect(
			writeSiteManifest({
				siteDir: dir,
				envelope: envelopeFor(testPayload()),
				keys: TEST_KEY_LIST,
				now: Date.parse("2027-01-01T00:00:00Z"),
				live: NO_LIVE,
			}),
		).rejects.toThrow(/expired/);
	});

	test("a private key header anywhere under site/ stops the publish", async () => {
		const dir = site();
		writeFileSync(join(dir, "assets", "oops.txt"), "-----BEGIN PRIVATE KEY-----\nAAAA\n");
		await expect(
			writeSiteManifest({
				siteDir: dir,
				envelope: envelopeFor(testPayload()),
				keys: TEST_KEY_LIST,
				now: NOW,
				live: NO_LIVE,
			}),
		).rejects.toThrow(/private key/);
	});
});

describe("envelopeFromEnv", () => {
	test("a signed envelope input wins; payload with key id and sig assembles one; nothing is no manifest", async () => {
		const envelope = envelopeFor(testPayload());
		expect(envelopeFromEnv({ SIGNED_ENVELOPE: envelope })).toBe(envelope);
		const parsed = JSON.parse(envelope);
		expect(
			envelopeFromEnv({ PAYLOAD: parsed.payload, KEY_ID: parsed.keyId, SIG: parsed.sig }),
		).toBe(envelope);
		expect(envelopeFromEnv({})).toBeNull();
		expect(() => envelopeFromEnv({ PAYLOAD: parsed.payload })).toThrow(/KEY_ID/);
	});
});

describe("verifyPublished", () => {
	const serve =
		(body: string): Fetcher =>
		async () =>
			({ ok: true, status: 200, body }) as CappedFetchResult;

	test("a verifying live manifest reports latest and seq", async () => {
		const r = await verifyPublished({
			fetcher: serve(envelopeFor(testPayload())),
			keys: TEST_KEY_LIST,
			now: NOW,
		});
		expect(r).toEqual({ ok: true, latest: "0.12.0", seq: 100, stale: false });
	});

	test("a fetch failure and a bad signature are named", async () => {
		const down = (async () => ({ ok: false, code: "timeout" })) as unknown as Fetcher;
		expect(await verifyPublished({ fetcher: down, keys: TEST_KEY_LIST, now: NOW })).toEqual({
			ok: false,
			reason: "could not fetch the manifest (timeout)",
		});
		const r = await verifyPublished({
			fetcher: serve(envelopeFor(testPayload(), "unknown")),
			keys: TEST_KEY_LIST,
			now: NOW,
		});
		expect(r).toEqual({
			ok: false,
			reason: "the published manifest does not verify (unknown_key)",
		});
	});
});

describe("auditFindings", () => {
	const good: AuditSnapshot = {
		environment: { reviewers: 0, customBranchPolicies: true, branchPolicies: ["main"] },
		pagesEnvironment: { reviewers: 0, customBranchPolicies: true, branchPolicies: ["main"] },
		rulesets: [
			{
				target: "tag",
				refs: ["refs/tags/v*"],
				rules: ["creation", "update", "deletion"],
				bypassActors: 0,
			},
			{ target: "branch", refs: ["~DEFAULT_BRANCH"], rules: ["pull_request"], bypassActors: 0 },
		],
		mainProtection: { requireCodeOwnerReviews: true, enforceAdmins: true },
	};
	const tagRuleset = (over: Partial<AuditSnapshot["rulesets"][number]>) => [
		{ ...(good.rulesets[0] as AuditSnapshot["rulesets"][number]), ...over },
		good.rulesets[1] as AuditSnapshot["rulesets"][number],
	];

	test("a fully protected repository has no findings", () => {
		expect(auditFindings(good)).toEqual([]);
	});

	const cases: [string, AuditSnapshot, RegExp][] = [
		["no environment", { ...good, environment: null }, /release-signing does not exist/],
		[
			"an environment open to every branch",
			{ ...good, environment: { reviewers: 0, customBranchPolicies: false, branchPolicies: [] } },
			/release-signing must admit only the main branch/,
		],
		[
			"an environment that admits two branches",
			{
				...good,
				environment: { reviewers: 0, customBranchPolicies: true, branchPolicies: ["main", "dev"] },
			},
			/release-signing must admit only the main branch/,
		],
		[
			"a required reviewer",
			{
				...good,
				environment: { reviewers: 1, customBranchPolicies: true, branchPolicies: ["main"] },
			},
			/required reviewer/,
		],
		[
			"no github-pages environment",
			{ ...good, pagesEnvironment: null },
			/github-pages does not exist/,
		],
		[
			"a github-pages environment open to every branch",
			{
				...good,
				pagesEnvironment: { reviewers: 0, customBranchPolicies: false, branchPolicies: [] },
			},
			/github-pages must admit only the main branch/,
		],
		[
			"a github-pages environment that admits another branch",
			{
				...good,
				pagesEnvironment: {
					reviewers: 0,
					customBranchPolicies: true,
					branchPolicies: ["main", "gh-pages"],
				},
			},
			/github-pages must admit only the main branch/,
		],
		["no tag ruleset", { ...good, rulesets: [] }, /no tag ruleset/],
		[
			"a tag ruleset that allows update",
			{ ...good, rulesets: tagRuleset({ rules: ["creation", "deletion"] }) },
			/forbid update/,
		],
		[
			"a tag ruleset that allows delete",
			{ ...good, rulesets: tagRuleset({ rules: ["creation", "update"] }) },
			/forbid deletion/,
		],
		[
			"a tag ruleset that doesn't restrict creation",
			{ ...good, rulesets: tagRuleset({ rules: ["update", "deletion"] }) },
			/restrict creation/,
		],
		[
			"bypass actors on the tag ruleset",
			{ ...good, rulesets: tagRuleset({ bypassActors: 1 }) },
			/tag ruleset has bypass actors/,
		],
		[
			"bypass actors on a ruleset covering main",
			{
				...good,
				rulesets: [
					good.rulesets[0] as AuditSnapshot["rulesets"][number],
					{ target: "branch", refs: ["refs/heads/main"], rules: ["pull_request"], bypassActors: 2 },
				],
			},
			/main.*bypass/,
		],
		[
			"a branch ruleset instead of a tag one",
			{
				...good,
				rulesets: [
					{
						target: "branch",
						refs: ["refs/tags/v*"],
						rules: ["update", "deletion"],
						bypassActors: 0,
					},
				],
			},
			/no tag ruleset/,
		],
		[
			"no CODEOWNERS review",
			{ ...good, mainProtection: { requireCodeOwnerReviews: false, enforceAdmins: true } },
			/CODEOWNERS/,
		],
		["no branch protection", { ...good, mainProtection: null }, /CODEOWNERS/],
		[
			"admins who can bypass main's protection",
			{ ...good, mainProtection: { requireCodeOwnerReviews: true, enforceAdmins: false } },
			/administrators/,
		],
	];
	for (const [name, snapshot, why] of cases) {
		test(`finds ${name}`, () => {
			expect(auditFindings(snapshot).join("\n")).toMatch(why);
		});
	}
});

test("the script's feed URL is the one the clients fetch (src/shared/release-feed.ts)", async () => {
	const { MANIFEST_URL: fromScript } = await import("./verify-published.ts");
	const { MANIFEST_URL: fromShared } = await import("../../src/shared/release-feed.ts");
	expect(fromScript).toBe(fromShared);
	expect(readFileSync(join(import.meta.dir, "verify-published.ts"), "utf-8")).not.toMatch(
		/"https:\/\/[^"]*manifest\.json"/,
	);
});
