#!/usr/bin/env bun
/**
 * Recomputes the image tags right before the images are built. Preflight computed them minutes earlier;
 * if a higher stable tag was pushed meanwhile, this release must not take `X.Y`, `X` or `latest` from it.
 * The tag list comes from the remote, not a local clone, so it is current.
 *
 * CLI: VERSION, COMMIT and REPO in the environment; writes `tags` and `backup_tags` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { IMAGE_REPOSITORY, imageTagsFor, stableVersionsFromRemoteTags } from "./preflight.ts";

const SHORT_SHA = 12;

export function recomputeTags(
	version: string,
	commit: string,
	lsRemoteTags: string,
): { tags: string[]; backupTags: string[] } {
	const names = imageTagsFor(version, commit.slice(0, SHORT_SHA), [
		...stableVersionsFromRemoteTags(lsRemoteTags),
		version,
	]);
	return {
		tags: names.map((t) => `${IMAGE_REPOSITORY}:${t}`),
		backupTags: names.map((t) => `${IMAGE_REPOSITORY}-backup:${t}`),
	};
}

if (import.meta.main) {
	const { VERSION, COMMIT, REPO, GITHUB_OUTPUT } = process.env;
	if (!VERSION || !COMMIT || !REPO) {
		console.error("image-tags: VERSION, COMMIT and REPO are required");
		process.exit(2);
	}
	const proc = Bun.spawnSync(["git", "ls-remote", "--tags", `https://github.com/${REPO}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		console.error("image-tags: could not read the remote tags");
		process.exit(1);
	}
	const { tags, backupTags } = recomputeTags(VERSION, COMMIT, proc.stdout.toString());
	if (GITHUB_OUTPUT) {
		appendFileSync(GITHUB_OUTPUT, `tags<<AP_TAGS_EOF\n${tags.join("\n")}\nAP_TAGS_EOF\n`);
		appendFileSync(
			GITHUB_OUTPUT,
			`backup_tags<<AP_TAGS_EOF\n${backupTags.join("\n")}\nAP_TAGS_EOF\n`,
		);
	}
	console.log(tags.join("\n"));
}
