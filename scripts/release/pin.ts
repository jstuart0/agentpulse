#!/usr/bin/env bun
/**
 * `bun run release:pin <version> <commit>`: records which main commit IS release X in
 * `releases/release-data.json`, which CODEOWNERS covers. Which commit a version means is therefore a
 * reviewed decision, not whoever pushes a tag. It refuses unless the commit is on origin/main and its
 * package.json says that version. It changes the file only; reviewing, merging and tagging stay with
 * the person doing the release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareReleaseVersions, parseReleaseVersion } from "../../src/shared/version.ts";

const HEX40 = /^[0-9a-f]{40}$/;

interface Pin {
	version: string;
	commit: string;
	[key: string]: unknown;
}

function git(repoDir: string, args: string[]): string | null {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

export function pinRelease(
	repoDir: string,
	version: string,
	commit: string,
	mainRef = "origin/main",
): void {
	const parsed = parseReleaseVersion(version);
	if (!parsed) throw new Error(`"${version}" is not a release version`);
	if (!HEX40.test(commit))
		throw new Error("the commit must be a full 40-character lowercase hex sha");
	if (git(repoDir, ["merge-base", "--is-ancestor", commit, mainRef]) === null) {
		throw new Error(`${commit} is not on ${mainRef}`);
	}
	const pkg = git(repoDir, ["show", `${commit}:package.json`]);
	const packaged = pkg === null ? null : (JSON.parse(pkg) as { version?: unknown }).version;
	if (packaged !== version) {
		throw new Error(`package.json at ${commit} says ${String(packaged)}, not ${version}`);
	}
	const path = join(repoDir, "releases/release-data.json");
	const data = JSON.parse(readFileSync(path, "utf-8")) as { releases: Pin[] };
	const existing = data.releases.find((r) => r.version === version);
	if (existing && existing.commit !== commit) {
		throw new Error(
			`${version} is already pinned to ${existing.commit}; changing a pin is a new reviewed decision, edit the file by hand`,
		);
	}
	if (!existing) data.releases.push({ version, commit });
	data.releases.sort((a, b) => {
		const [pa, pb] = [parseReleaseVersion(a.version), parseReleaseVersion(b.version)];
		return pa && pb ? compareReleaseVersions(pb, pa) : 0;
	});
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
}

if (import.meta.main) {
	const [version, commit] = process.argv.slice(2);
	if (!version || !commit) {
		console.error("usage: bun run release:pin <version> <commit sha>");
		process.exit(2);
	}
	try {
		pinRelease(process.cwd(), version, commit);
		console.log(
			`pinned ${version} to ${commit} in releases/release-data.json; open a PR for it (CODEOWNERS reviews releases/**).`,
		);
	} catch (err) {
		console.error(`release:pin: ${err instanceof Error ? err.message : "failed"}`);
		process.exit(1);
	}
}
