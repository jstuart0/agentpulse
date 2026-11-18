#!/usr/bin/env bun
/**
 * `bun run release:prepare <version>`: sets the release version in every file that carries it
 * (`VERSION_SITES`), after checking it against the strict release grammar. It changes files only;
 * committing, tagging and publishing stay with the person doing the release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseVersion } from "../../src/shared/version.ts";
import { VERSION_SITES, readVersions } from "./version-parity.ts";

export function prepareRelease(root: string, version: string): string[] {
	if (!parseReleaseVersion(version)) {
		throw new Error(`"${version}" is not a release version (expected x.y.z or x.y.z-pre.1)`);
	}
	const changed: string[] = [];
	for (const site of VERSION_SITES) {
		const path = join(root, site.file);
		const text = readFileSync(path, "utf-8");
		if (!site.pattern.test(text)) throw new Error(`${site.file} has no version line to update`);
		const next = text.replace(site.pattern, site.render(version));
		if (next !== text) {
			writeFileSync(path, next);
			changed.push(site.file);
		}
	}
	const after = new Set(Object.values(readVersions(root)));
	if (after.size !== 1 || !after.has(version)) {
		throw new Error("the version files still disagree after the update");
	}
	return changed;
}

if (import.meta.main) {
	const version = process.argv[2];
	if (!version) {
		console.error("usage: bun run release:prepare <version>");
		process.exit(2);
	}
	try {
		const changed = prepareRelease(join(import.meta.dir, "..", ".."), version);
		console.log(
			changed.length ? `Set ${version} in: ${changed.join(", ")}` : `Already ${version}.`,
		);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
