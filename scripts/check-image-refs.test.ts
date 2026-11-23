/**
 * No documentation or compose file may name the published image without a tag. A bare
 * `ghcr.io/jstuart0/agentpulse` means `:latest`, which a reader copies into a place where an update then
 * happens by accident. Allowed after the image name: `${AGENTPULSE_TAG...}`, an explicit version
 * (`0.12`, `0.12.0`, `0.12.0-rc.1`), a digest (`@sha256:`) and the documented `<sha>` / `<tag>` placeholders.
 * `:latest` is refused on purpose: the docs recommend `X.Y.Z` or `X.Y`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const IMAGE = /ghcr\.io\/jstuart0\/agentpulse(?:-backup)?/g;
const ALLOWED_AFTER = [
	/^:\$\{AGENTPULSE_TAG[:}-]/,
	/^:\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.]+)?(?![0-9A-Za-z.-])/,
	/^@sha256:/,
	/^:<(?:sha|tag)>/,
];

// A kustomize `images:` entry names the image without a tag on purpose; the tag is the `newTag` beside it.
const KUSTOMIZE_NAME_KEY = /^\s*-?\s*name:\s*$/;

function untaggedImageRefs(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(IMAGE)) {
		const lineStart = text.lastIndexOf("\n", match.index) + 1;
		if (KUSTOMIZE_NAME_KEY.test(text.slice(lineStart, match.index))) continue;
		const rest = text.slice(match.index + match[0].length);
		if (!ALLOWED_AFTER.some((ok) => ok.test(rest))) {
			found.push(`${match[0]}${rest.slice(0, 12).split("\n")[0]}`);
		}
	}
	return found;
}

function scannedFiles(): string[] {
	const patterns = ["README.md", "site/**/*.{html,md}", "deploy/**/*.md", "docker-compose*.yml"];
	const files = new Set<string>();
	for (const pattern of patterns) {
		for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })) {
			if (!file.includes("node_modules/")) files.add(file);
		}
	}
	return [...files].sort();
}

describe("check-image-refs: published image references carry a tag", () => {
	test("no scanned file has an untagged reference", () => {
		const offenders = scannedFiles().flatMap((file) =>
			untaggedImageRefs(readFileSync(join(ROOT, file), "utf8")).map((ref) => `${file}: ${ref}`),
		);
		expect(offenders).toEqual([]);
	});

	test("the scan covers the files that matter", () => {
		const files = scannedFiles();
		expect(files.length).toBeGreaterThanOrEqual(8);
		for (const named of [
			"README.md",
			"docker-compose.yml",
			"docker-compose.image.yml",
			"deploy/k8s/README.md",
			"deploy/README-kustomize.md",
			"site/guides/self-hosted-ai-coding-agent-dashboard/index.html",
			"site/guides/remote-claude-code-dashboard/index.html",
		]) {
			expect(files).toContain(named);
		}
		expect(files.every((f) => relative(ROOT, join(ROOT, f)) === f)).toBe(true);
	});

	test("an untagged reference is caught, in every shape the docs use", () => {
		expect(untaggedImageRefs("--name agentpulse ghcr.io/jstuart0/agentpulse")).toHaveLength(1);
		expect(
			untaggedImageRefs("--name agentpulse ghcr.io/jstuart0/agentpulse \\\n  --x"),
		).toHaveLength(1);
		expect(untaggedImageRefs("Use `ghcr.io/jstuart0/agentpulse` here")).toHaveLength(1);
		expect(untaggedImageRefs("ghcr.io/jstuart0/agentpulse-backup</code>")).toHaveLength(1);
		expect(untaggedImageRefs("ghcr.io/jstuart0/agentpulse:latest")).toHaveLength(1);
		expect(untaggedImageRefs("ghcr.io/jstuart0/agentpulse:0.12.x")).toHaveLength(1);
	});

	test("tagged references pass", () => {
		for (const ok of [
			"ghcr.io/jstuart0/agentpulse:0.12",
			"ghcr.io/jstuart0/agentpulse:0.12.3",
			"ghcr.io/jstuart0/agentpulse:0.12.0-rc.1",
			"ghcr.io/jstuart0/agentpulse-backup:0.12.3",
			"ghcr.io/jstuart0/agentpulse:${AGENTPULSE_TAG:?set AGENTPULSE_TAG, for example 0.12}",
			`ghcr.io/jstuart0/agentpulse@sha256:${"a".repeat(64)}`,
			"ghcr.io/jstuart0/agentpulse:<sha>",
			"<registry>/agentpulse:<SHA>",
			"  - name: ghcr.io/jstuart0/agentpulse\n    newTag: 0.12.3",
		]) {
			expect(untaggedImageRefs(ok)).toEqual([]);
		}
	});
});
