/**
 * Static checks on the release workflows. Nothing here runs a workflow: it reads release.yml and
 * pages.yml as data and holds the properties the release design depends on, so a later edit can't
 * quietly loosen one (an unpinned action, a signing secret reachable from a job that runs fetched code,
 * a tag name interpolated into a script).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");
const SIGNING_SECRET = "AGENTPULSE_RELEASE_SIGNING_KEY";

interface Step {
	id?: string;
	uses?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}
interface Job {
	uses?: string;
	environment?: string | { name: string };
	permissions?: Record<string, string>;
	needs?: string | string[];
	steps?: Step[];
	if?: string;
	outputs?: Record<string, string>;
}
interface Workflow {
	on: {
		push?: { tags?: string[]; branches?: string[]; paths?: string[] };
		schedule?: { cron: string }[];
		workflow_dispatch?: unknown;
	};
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
}

const text = (name: string) => readFileSync(join(WORKFLOWS, name), "utf-8");
const load = (name: string) => Bun.YAML.parse(text(name)) as Workflow;
const release = load("release.yml");
const pages = load("pages.yml");
const stepsOf = (job: Job | undefined) => job?.steps ?? [];

function* strings(value: unknown, path: string): Generator<[string, string]> {
	if (typeof value === "string") yield [path, value];
	else if (Array.isArray(value))
		for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
	else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
	}
}

/** GitHub's tag filter syntax, the subset these workflows use: `*` stays inside a path segment, `[..]` is a class. */
function githubGlobMatches(pattern: string, ref: string): boolean {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] as string;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else source += "[^/]*";
		} else if (c === "?") source += "[^/]";
		else if (c === "[") {
			const end = pattern.indexOf("]", i);
			source += pattern.slice(i, end + 1);
			i = end;
		} else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`).test(ref);
}

describe("every action is pinned to a commit", () => {
	for (const name of ["release.yml", "pages.yml"]) {
		const workflow = load(name);
		const raw = text(name).split("\n");
		test(`${name}: every uses: is owner/repo@<40 hex> with the tag in a comment`, () => {
			const all = Object.values(workflow.jobs)
				.flatMap((job) => [job.uses, ...stepsOf(job).map((s) => s.uses)])
				.filter((u): u is string => !!u);
			expect(all.length).toBeGreaterThan(0);
			for (const uses of all)
				expect(uses, uses).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
			for (const line of raw.filter((l) => /\buses:\s/.test(l))) {
				expect(line, line).toMatch(/@[0-9a-f]{40} # v\d+/);
			}
		});
	}

	test("the same action is pinned to the same commit everywhere it appears", () => {
		const pins = new Map<string, Set<string>>();
		for (const name of ["release.yml", "pages.yml"]) {
			for (const m of text(name).matchAll(/uses:\s*(\S+)@([0-9a-f]{40})/g)) {
				const action = m[1] as string;
				pins.set(action, (pins.get(action) ?? new Set()).add(m[2] as string));
			}
		}
		expect(pins.size).toBeGreaterThan(0);
		for (const [action, shas] of pins) expect(shas.size, action).toBe(1);
	});
});

describe("the signing secret", () => {
	test("appears in exactly one workflow file, in the sign job, which has no actions and a separate signing step", () => {
		const holders = readdirSync(WORKFLOWS).filter((f) => text(f).includes(SIGNING_SECRET));
		expect(holders).toEqual(["pages.yml"]);
		const sign = pages.jobs.sign as Job;
		for (const [name, job] of Object.entries(pages.jobs)) {
			const mentions = [...strings(job, name)].filter(([, v]) => v.includes(SIGNING_SECRET));
			expect(mentions.length > 0, name).toBe(name === "sign");
		}
		expect(stepsOf(sign).some((s) => s.uses)).toBe(false);
		expect(sign.uses).toBeUndefined();
		const withSecret = stepsOf(sign).filter((s) =>
			JSON.stringify(s.env ?? {}).includes(SIGNING_SECRET),
		);
		expect(withSecret).toHaveLength(1);
		expect(withSecret[0]?.id).toBe("sign");
		// The checks step runs first, with no secret in its environment.
		expect(JSON.stringify(stepsOf(sign)[0]?.env ?? {})).not.toContain("secrets.");
	});

	test("release.yml never mentions it, and `release-signing` is named only by the sign job", () => {
		expect(text("release.yml")).not.toContain(SIGNING_SECRET);
		const sign = pages.jobs.sign as Job;
		expect(typeof sign.environment === "string" ? sign.environment : sign.environment?.name).toBe(
			"release-signing",
		);
		for (const [name, job] of Object.entries(pages.jobs)) {
			if (name === "sign") continue;
			expect(JSON.stringify(job.environment ?? "")).not.toContain("release-signing");
		}
		for (const f of readdirSync(WORKFLOWS).filter((f) => f !== "pages.yml")) {
			expect(load(f).jobs && JSON.stringify(load(f).jobs)).not.toContain("release-signing");
		}
	});
});

describe("the sign job takes every input through env", () => {
	const sign = pages.jobs.sign as Job;
	const runs = stepsOf(sign).flatMap((s) => (s.run ? [s.run] : []));

	test("no ${{ expression inside any run:", () => {
		expect(runs.length).toBeGreaterThanOrEqual(2);
		for (const run of runs) expect(run).not.toContain("${{");
	});

	test("it refuses a non-main ref, compares the main tip to the commit and checks sourceCommit", () => {
		const all = runs.join("\n");
		expect(all).toContain("refs/heads/main");
		expect(all).toContain("git ls-remote");
		expect(all).toContain("sourceCommit");
		expect(all).toContain("gh workflow run pages.yml");
		expect(all).toContain("--ref main");
		expect(all).toMatch(/openssl pkeyutl -sign -rawin/);
	});

	test("it holds actions: write for the superseded re-dispatch, and nothing else", () => {
		expect(sign.permissions).toEqual({ actions: "write" });
	});

	test("it needs the manifest job and its steps never check anything out", () => {
		expect(sign.needs).toBe("manifest");
		expect(stepsOf(sign).some((s) => s.uses?.startsWith("actions/checkout"))).toBe(false);
	});
});

describe("the other pages jobs", () => {
	test("manifest and deploy hold no signing secret, and manifest reads contents only", () => {
		expect((pages.jobs.manifest as Job).permissions).toEqual({ contents: "read" });
		expect(JSON.stringify(pages.jobs.manifest)).not.toContain("secrets.");
		expect(JSON.stringify(pages.jobs.deploy)).not.toContain("secrets.");
	});

	test("deploy verifies the envelope with the repo's own trust root before the site is uploaded", () => {
		const steps = stepsOf(pages.jobs.deploy);
		const verify = steps.findIndex((s) =>
			s.run?.includes("scripts/release/write-site-manifest.ts"),
		);
		const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-pages-artifact"));
		expect(verify).toBeGreaterThan(-1);
		expect(upload).toBeGreaterThan(verify);
	});

	test("triggers: main pushes of the release inputs, the twice-weekly cron, and dispatch", () => {
		expect(pages.on.push?.branches).toEqual(["main"]);
		for (const path of [
			"site/**",
			"releases/**",
			"scripts/release/**",
			"src/shared/release-manifest.ts",
			"src/shared/release-keys.ts",
			".github/workflows/pages.yml",
		]) {
			expect(pages.on.push?.paths).toContain(path);
		}
		expect(pages.on.schedule).toEqual([{ cron: "17 4 * * 1,4" }]);
		expect("workflow_dispatch" in pages.on).toBe(true);
	});
});

describe("release.yml", () => {
	test("actions: write is held only by publish; every job names its own permissions", () => {
		expect(release.permissions).toEqual({});
		for (const [name, job] of Object.entries(release.jobs)) {
			expect(job.permissions, name).toBeDefined();
			expect(Object.keys(job.permissions ?? {}).includes("actions"), name).toBe(name === "publish");
		}
		expect(release.jobs.publish?.permissions?.contents).toBe("write");
		expect(release.jobs.images?.permissions).toMatchObject({
			packages: "write",
			"id-token": "write",
			attestations: "write",
		});
	});

	test("no cache action, and the images job needs the preflight", () => {
		expect(text("release.yml")).not.toMatch(/actions\/cache/);
		expect(release.jobs.images?.needs).toBe("preflight");
		expect(release.jobs.publish?.needs).toEqual(["preflight", "images"]);
	});

	test("the release is created non-draft against the verified tag, then the manifest workflow is started", () => {
		const run = stepsOf(release.jobs.publish)
			.map((s) => s.run ?? "")
			.join("\n");
		expect(run).toContain("gh release create");
		expect(run).toContain("--verify-tag");
		expect(run).not.toContain("--draft");
		expect(run.indexOf("gh release create")).toBeLessThan(run.indexOf("gh workflow run pages.yml"));
	});

	test("preflight runs lint, types, the architecture guards and the exclude and relay suites", () => {
		const runs = stepsOf(release.jobs.preflight)
			.map((s) => s.run ?? "")
			.join("\n");
		for (const needle of [
			"bun run check",
			"bun run typecheck",
			"bun run check:architecture",
			"scripts/exclude-shim-parity.test.ts",
			"scripts/relay-exclude",
		]) {
			expect(runs, needle).toContain(needle);
		}
	});

	test("images carry the commit as an OCI label and are attested", () => {
		const images = stepsOf(release.jobs.images);
		const labelled = images.filter((s) => s.uses?.startsWith("docker/build-push-action"));
		expect(labelled).toHaveLength(2);
		for (const step of labelled)
			expect(String(step.with?.labels)).toContain("org.opencontainers.image.revision=");
		expect(
			images.filter((s) => s.uses?.startsWith("actions/attest-build-provenance")),
		).toHaveLength(2);
	});
});

describe("github.ref_name reaches scripts only through env:", () => {
	for (const name of ["release.yml", "pages.yml"]) {
		test(name, () => {
			const workflow = load(name);
			const hits = [...strings(workflow.jobs, "jobs")].filter(([, v]) =>
				v.includes("github.ref_name"),
			);
			for (const [path] of hits) expect(path, path).toMatch(/\.env\.[A-Z_]+$/);
			for (const job of Object.values(workflow.jobs)) {
				for (const step of stepsOf(job)) expect(step.run ?? "").not.toContain("ref_name");
			}
		});
	}
	test("release.yml does use it, so this check has something to hold", () => {
		expect(text("release.yml")).toContain("github.ref_name");
	});
});

describe("the tag trigger", () => {
	const [pattern] = release.on.push?.tags ?? [];
	test("matches release tags and pre-release tags", () => {
		expect(pattern).toBeDefined();
		for (const tag of ["v0.12.0", "v1.2.3", "v10.20.30", "v0.13.0-rc.1"]) {
			expect(githubGlobMatches(pattern as string, tag), tag).toBe(true);
		}
	});

	test("does not match the MCP package tags or other names (named member: mcp-v*)", () => {
		for (const tag of [
			"mcp-v0.4.0",
			"mcp-v1.0.0",
			"vX.Y.Z",
			"release-v1.0.0",
			"v1",
			"v1.2",
			"latest",
		]) {
			expect(githubGlobMatches(pattern as string, tag), tag).toBe(false);
		}
		const mcp = Bun.YAML.parse(text("mcp-release.yml")) as Workflow;
		expect(mcp.on.push?.tags).toEqual(["mcp-v*"]);
		expect(githubGlobMatches("mcp-v*", "v0.12.0")).toBe(false);
	});
});
