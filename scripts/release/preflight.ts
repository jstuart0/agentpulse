#!/usr/bin/env bun
/**
 * The release gate, first job of release.yml. For a tag it decides whether the release may be built:
 *   - the name matches the strict release-tag grammar (the tag name is data, never interpolated);
 *   - the tag is annotated and resolves to a commit that is an ancestor of origin/main;
 *   - package.json and both client constants at that commit say the tag's version;
 *   - `releases/release-data.json` on origin/main pins this version to exactly this commit;
 *   - the tree has an active release key (a release nobody can sign for is not a release);
 *   - an existing `X.Y.Z` image was not built from a different commit (a published tag is never repointed).
 * It then computes the image tags. `X.Y`, `X` and `latest` go only to the highest stable tag, so a backport
 * never moves `latest`.
 *
 * CLI: TAG and GITHUB_SHA in the environment; writes `version`, `commit` and `tags` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { compareReleaseVersions, parseReleaseVersion } from "../../src/shared/version.ts";
import { VERSION_SITES } from "./version-parity.ts";

const TAG_GRAMMAR = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
const DEFAULT_SHORT_SHA = 12;
export const IMAGE_REPOSITORY = "ghcr.io/jstuart0/agentpulse";

export type PreflightResult =
	| { ok: true; version: string; commit: string; imageTags: string[] }
	| { ok: false; reason: string };

export interface PreflightOptions {
	repoDir: string;
	tag: string;
	mainRef?: string;
	/** The commit an already-published `X.Y.Z` image was built from (its OCI revision label), or null when it isn't published. */
	existingImageRevision?: (imageTag: string) => string | null;
	shortShaLength?: number;
}

const refuse = (reason: string): PreflightResult => ({ ok: false, reason });

function git(repoDir: string, args: string[]): string | null {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

function parsedStable(version: string) {
	const parsed = parseReleaseVersion(version);
	return parsed && parsed.pre.length === 0 ? parsed : null;
}

export function imageTagsFor(
	version: string,
	shortSha: string,
	stableVersions: readonly string[],
): string[] {
	const tags = [version, `sha-${shortSha}`];
	const mine = parsedStable(version);
	if (!mine) return tags;
	const highest = stableVersions.every((other) => {
		const parsed = parsedStable(other);
		return parsed === null || compareReleaseVersions(mine, parsed) >= 0;
	});
	if (highest) tags.push(`${mine.core[0]}.${mine.core[1]}`, `${mine.core[0]}`, "latest");
	return tags;
}

function versionProblems(repoDir: string, commit: string, version: string): string | null {
	for (const site of VERSION_SITES) {
		const text = git(repoDir, ["show", `${commit}:${site.file}`]);
		const found = text === null ? null : site.pattern.exec(text)?.[1];
		if (found !== version) {
			return `${site.file} at the tag says ${found ?? "nothing"}, not ${version}`;
		}
	}
	return null;
}

export function runPreflight(options: PreflightOptions): PreflightResult {
	const { repoDir, tag } = options;
	const mainRef = options.mainRef ?? "origin/main";
	if (!TAG_GRAMMAR.test(tag) || !parseReleaseVersion(tag.slice(1))) {
		return refuse("the tag name is not a release tag (vX.Y.Z or vX.Y.Z-pre)");
	}
	const version = tag.slice(1);
	const ref = `refs/tags/${tag}`;
	const commit = git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
	if (!commit) return refuse(`tag ${tag} does not exist or does not resolve to a commit`);
	if (git(repoDir, ["cat-file", "-t", ref])?.trim() !== "tag")
		return refuse(`tag ${tag} is not annotated`);
	if (git(repoDir, ["merge-base", "--is-ancestor", commit, mainRef]) === null) {
		return refuse(`the commit of ${tag} is not an ancestor of ${mainRef}`);
	}
	const mismatch = versionProblems(repoDir, commit, version);
	if (mismatch) return refuse(mismatch);

	const dataText = git(repoDir, ["show", `${mainRef}:releases/release-data.json`]);
	let pinned: unknown;
	try {
		const releases =
			(JSON.parse(dataText ?? "") as { releases?: { version?: unknown; commit?: unknown }[] })
				.releases ?? [];
		pinned = releases.find((r) => r.version === version)?.commit;
	} catch {
		return refuse(`releases/release-data.json on ${mainRef} is missing or not JSON`);
	}
	if (pinned !== commit) {
		return refuse(
			`releases/release-data.json on ${mainRef} does not pin ${version} to this commit (run release:pin)`,
		);
	}
	const keys = git(repoDir, ["show", `${commit}:src/shared/release-keys.ts`]);
	if (keys === null || !/status:\s*"active"/.test(keys)) {
		return refuse("src/shared/release-keys.ts has no active key at this commit");
	}
	const published = options.existingImageRevision?.(version) ?? null;
	if (published !== null && published !== commit) {
		return refuse(
			`image ${version} already exists, built from a different commit; a published tag is never repointed`,
		);
	}

	const stable = (git(repoDir, ["tag", "--list", "v*"]) ?? "")
		.split("\n")
		.filter((t) => TAG_GRAMMAR.test(t))
		.map((t) => t.slice(1));
	const short = commit.slice(0, options.shortShaLength ?? DEFAULT_SHORT_SHA);
	return {
		ok: true,
		version,
		commit,
		imageTags: imageTagsFor(version, short, [...stable, version]),
	};
}

/** The OCI revision label of a published image, null when the tag isn't published. Throws on any other failure. */
function registryRevision(imageTag: string): string | null {
	const ref = `${IMAGE_REPOSITORY}:${imageTag}`;
	const proc = Bun.spawnSync(
		["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Image}}"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (proc.exitCode !== 0) {
		const err = proc.stderr.toString();
		if (/not found|manifest unknown|no such manifest/i.test(err)) return null;
		throw new Error(`could not inspect ${ref}`);
	}
	const labels = (
		JSON.parse(proc.stdout.toString()) as { config?: { Labels?: Record<string, string> } }
	).config?.Labels;
	return labels?.["org.opencontainers.image.revision"] ?? "";
}

if (import.meta.main) {
	const tag = process.env.TAG ?? "";
	const result = runPreflight({
		repoDir: process.cwd(),
		tag,
		existingImageRevision: registryRevision,
	});
	if (!result.ok) {
		console.error(`preflight: ${result.reason}`);
		process.exit(1);
	}
	if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== result.commit) {
		console.error("preflight: the workflow ran at a commit other than the tag's");
		process.exit(1);
	}
	const out = process.env.GITHUB_OUTPUT;
	if (out) {
		appendFileSync(out, `version=${result.version}\ncommit=${result.commit}\n`);
		appendFileSync(
			out,
			`tags<<AP_TAGS_EOF\n${result.imageTags.map((t) => `${IMAGE_REPOSITORY}:${t}`).join("\n")}\nAP_TAGS_EOF\n`,
		);
		appendFileSync(
			out,
			`backup_tags<<AP_TAGS_EOF\n${result.imageTags.map((t) => `${IMAGE_REPOSITORY}-backup:${t}`).join("\n")}\nAP_TAGS_EOF\n`,
		);
	}
	console.log(`preflight ok: ${result.version} at ${result.commit}`);
}
