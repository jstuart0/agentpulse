#!/usr/bin/env bun
/**
 * Builds the unsigned release-manifest payload from git objects only (never the work tree, so a dirty
 * checkout changes nothing). A version is included only when all of these hold:
 *   - `releases/release-data.json` lists it with a `commit` (the reviewed pin, release step 2);
 *   - tag `vX.Y.Z` exists, is annotated, and resolves to exactly that commit;
 *   - that commit is reachable from `origin/main`;
 *   - `package.json` at that commit has that version;
 *   - GitHub shows a non-draft release for the tag.
 * The release check is a consistency check, not proof that release.yml passed; the pin is what binds a
 * version to a commit.
 *
 * CLI (the `manifest` job in pages.yml):
 *   bun scripts/release/build-manifest.ts --unsigned --repo owner/name --out payload.json [--github-output]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { materializeExcludeScript } from "../../src/shared/hook-command.ts";
import { clientDigests, extractExcludeHeredoc } from "../../src/shared/relay-installer-parts.ts";
import {
	MAX_ENVELOPE_BYTES,
	type Manifest,
	type ManifestRelease,
} from "../../src/shared/release-manifest.ts";
import { compareReleaseVersions, parseReleaseVersion } from "../../src/shared/version.ts";
import { checkPayloadForSigning, computeSeq } from "./sign-guard.ts";

const MAX_RELEASES = 30;
const VALIDITY_MS = 10 * 86_400_000;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,31}$/;

export class BuildError extends Error {}

/** `releases/release-data.json` pins nothing yet: before the first release there is no manifest to build. */
export class NoPinnedReleasesError extends BuildError {}

export interface BuildOptions {
	repoDir: string;
	/** Epoch ms: the payload's `issuedAt`. */
	now: number;
	/** The GitHub release for a tag, or null when there is none. Injected so tests never touch the network. */
	releaseLookup: (tag: string) => { draft: boolean } | null;
	/** The commit to build for; default HEAD. */
	rev?: string;
	/** The protected branch the pinned commits must be on; default origin/main. */
	mainRef?: string;
}

interface Pin {
	version: string;
	commit: string;
	severity: "normal" | "security";
	pulled: boolean;
	reason?: string;
}

interface ReleaseData {
	firstSignedVersion: string;
	minSupported: string;
	revokedKeyIds: string[];
	pins: Pin[];
}

function git(repoDir: string, args: string[]): string | null {
	const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

function mustGit(repoDir: string, args: string[], what: string): string {
	const out = git(repoDir, args);
	if (out === null) throw new BuildError(`${what} (git ${args[0]} failed)`);
	return out;
}

function parseReleaseData(text: string): ReleaseData {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new BuildError("releases/release-data.json is not JSON");
	}
	const d = raw as Record<string, unknown>;
	const fail = (why: string): never => {
		throw new BuildError(`releases/release-data.json: ${why}`);
	};
	if (typeof d !== "object" || d === null || d.schema !== 1) fail("schema is not 1");
	for (const key of ["firstSignedVersion", "minSupported"] as const) {
		if (typeof d[key] !== "string" || !parseReleaseVersion(d[key] as string))
			fail(`${key} is not a version`);
	}
	if (
		!Array.isArray(d.revokedKeyIds) ||
		!d.revokedKeyIds.every((k) => typeof k === "string" && KEY_ID.test(k))
	) {
		fail("revokedKeyIds is not a list of key ids");
	}
	if (!Array.isArray(d.releases)) fail("releases is not a list");
	const pins = (d.releases as Record<string, unknown>[]).map((r): Pin => {
		if (typeof r.version !== "string" || !parseReleaseVersion(r.version))
			fail("a release has no valid version");
		if (typeof r.commit !== "string" || !HEX40.test(r.commit))
			fail(`${r.version} has no 40-hex commit`);
		const severity = r.severity ?? "normal";
		if (severity !== "normal" && severity !== "security") fail(`${r.version} has a bad severity`);
		const pulled = r.pulled ?? false;
		if (typeof pulled !== "boolean") fail(`${r.version} has a bad pulled flag`);
		if (pulled && !(typeof r.reason === "string" && REASON_CODE.test(r.reason))) {
			fail(`${r.version} is pulled without a reason code`);
		}
		return {
			version: r.version as string,
			commit: r.commit as string,
			severity: severity as "normal" | "security",
			pulled: pulled as boolean,
			...(typeof r.reason === "string" ? { reason: r.reason } : {}),
		};
	});
	return {
		firstSignedVersion: d.firstSignedVersion as string,
		minSupported: d.minSupported as string,
		revokedKeyIds: d.revokedKeyIds as string[],
		pins,
	};
}

/** True when the pin passes every inclusion rule except the client files. */
function isEligible(pin: Pin, options: BuildOptions, mainRef: string): boolean {
	const { repoDir } = options;
	const tag = `v${pin.version}`;
	const ref = `refs/tags/${tag}`;
	if (git(repoDir, ["cat-file", "-t", ref])?.trim() !== "tag") return false; // missing, or lightweight
	if (git(repoDir, ["rev-parse", `${ref}^{commit}`])?.trim() !== pin.commit) return false;
	if (git(repoDir, ["merge-base", "--is-ancestor", pin.commit, mainRef]) === null) return false;
	const pkg = git(repoDir, ["show", `${pin.commit}:package.json`]);
	if (pkg === null) return false;
	try {
		if ((JSON.parse(pkg) as { version?: unknown }).version !== pin.version) return false;
	} catch {
		return false;
	}
	const release = options.releaseLookup(tag);
	return release !== null && !release.draft;
}

function lastMigration(repoDir: string, commit: string, dialect: "sqlite" | "postgres"): string {
	const text = mustGit(
		repoDir,
		["show", `${commit}:drizzle/${dialect}/meta/_journal.json`],
		`${dialect} journal missing at ${commit}`,
	);
	const entries = (JSON.parse(text) as { entries?: { tag?: unknown }[] }).entries ?? [];
	const tag = entries.at(-1)?.tag;
	if (typeof tag !== "string")
		throw new BuildError(`${dialect} journal at ${commit} has no entries`);
	return tag;
}

async function describeRelease(pin: Pin, repoDir: string): Promise<ManifestRelease> {
	const at = (path: string) =>
		mustGit(repoDir, ["show", `${pin.commit}:${path}`], `${path} missing at ${pin.version}`);
	const heredoc = extractExcludeHeredoc(at("scripts/setup-relay.sh"));
	if (!heredoc.ok) throw new BuildError(`${pin.version}: ${heredoc.reason}`);
	const clients = await clientDigests({
		relay: at("scripts/relay.ts"),
		statusline: at("scripts/statusline.sh"),
		excludeCheck: materializeExcludeScript(heredoc.text),
	});
	const commitTime = mustGit(
		repoDir,
		["show", "-s", "--format=%cI", pin.commit],
		`no commit ${pin.commit}`,
	).trim();
	return {
		version: pin.version,
		commit: pin.commit,
		publishedAt: new Date(commitTime).toISOString(),
		severity: pin.severity,
		pulled: pin.pulled,
		...(pin.pulled && pin.reason ? { pulledReason: pin.reason } : {}),
		migrations: {
			sqlite: lastMigration(repoDir, pin.commit, "sqlite"),
			postgres: lastMigration(repoDir, pin.commit, "postgres"),
		},
		clients,
	};
}

export async function buildManifest(options: BuildOptions): Promise<Manifest> {
	const { repoDir } = options;
	const mainRef = options.mainRef ?? "origin/main";
	const sourceCommit = mustGit(
		repoDir,
		["rev-parse", `${options.rev ?? "HEAD"}^{commit}`],
		"cannot resolve the commit to build",
	).trim();
	mustGit(repoDir, ["rev-parse", "--verify", `${mainRef}^{commit}`], `${mainRef} does not exist`);
	const data = parseReleaseData(
		mustGit(
			repoDir,
			["show", `${sourceCommit}:releases/release-data.json`],
			"releases/release-data.json is missing",
		),
	);
	const first = parseReleaseVersion(data.firstSignedVersion) as NonNullable<
		ReturnType<typeof parseReleaseVersion>
	>;
	const parsed = (version: string) =>
		parseReleaseVersion(version) as NonNullable<ReturnType<typeof parseReleaseVersion>>;

	if (data.pins.length === 0)
		throw new NoPinnedReleasesError(
			"no release is pinned yet, so no release passes the inclusion rules",
		);
	const eligible = data.pins
		.filter((pin) => compareReleaseVersions(parsed(pin.version), first) >= 0)
		.filter((pin) => isEligible(pin, options, mainRef))
		.sort((a, b) => compareReleaseVersions(parsed(b.version), parsed(a.version)));
	if (eligible.length === 0) throw new BuildError("no release passes the inclusion rules");

	const latestPin = eligible.find((pin) => parsed(pin.version).pre.length === 0 && !pin.pulled);
	if (!latestPin) throw new BuildError("no non-pulled stable release to call latest");
	if (compareReleaseVersions(parsed(data.minSupported), parsed(latestPin.version)) > 0) {
		throw new BuildError("minSupported is above the latest release");
	}
	const kept = eligible.slice(0, MAX_RELEASES);
	if (!kept.includes(latestPin)) throw new BuildError("latest fell outside the newest 30 releases");

	const issuedAt = new Date(options.now);
	const manifest: Manifest = {
		schema: 1,
		seq: computeSeq(repoDir, sourceCommit),
		sourceCommit,
		issuedAt: issuedAt.toISOString(),
		expiresAt: new Date(issuedAt.getTime() + VALIDITY_MS).toISOString(),
		latest: latestPin.version,
		minSupported: data.minSupported,
		revokedKeyIds: data.revokedKeyIds,
		releases: await Promise.all(kept.map((pin) => describeRelease(pin, repoDir))),
	};
	const envelopeEstimate = Math.ceil((JSON.stringify(manifest).length * 4) / 3) + 256;
	if (envelopeEstimate > MAX_ENVELOPE_BYTES)
		throw new BuildError("the payload would not fit a 32 KiB envelope");
	return manifest;
}

/** The GitHub release for `tag` via `gh api`, or null when there is none. Needs GH_TOKEN. */
function ghReleaseLookup(repo: string): BuildOptions["releaseLookup"] {
	return (tag) => {
		const proc = Bun.spawnSync(
			["gh", "api", `repos/${repo}/releases/tags/${tag}`, "--jq", "{draft: .draft}"],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (proc.exitCode !== 0) return null;
		const parsed = JSON.parse(proc.stdout.toString()) as { draft?: unknown };
		return { draft: parsed.draft !== false };
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string) => args.includes(name);
	const value = (name: string) => args[args.indexOf(name) + 1];
	if (!flag("--unsigned") || !value("--repo") || !value("--out")) {
		console.error(
			"usage: bun scripts/release/build-manifest.ts --unsigned --repo owner/name --out payload.json [--repo-dir dir] [--github-output] [--allow-none]",
		);
		process.exit(2);
	}
	try {
		const now = Date.now();
		const manifest = await buildManifest({
			repoDir: value("--repo-dir") ?? process.cwd(),
			now,
			releaseLookup: ghReleaseLookup(value("--repo") as string),
		});
		const verdict = checkPayloadForSigning(manifest, {
			githubSha: process.env.GITHUB_SHA ?? manifest.sourceCommit,
			now,
		});
		if (!verdict.ok) throw new BuildError(`sign guard: ${verdict.reason}`);
		const json = JSON.stringify(manifest);
		writeFileSync(value("--out") as string, json);
		if (flag("--github-output") && process.env.GITHUB_OUTPUT) {
			appendFileSync(
				process.env.GITHUB_OUTPUT,
				`payload=${Buffer.from(json).toString("base64url")}\n`,
			);
		}
		console.log(
			`manifest: seq ${manifest.seq}, latest ${manifest.latest}, ${manifest.releases.length} releases`,
		);
	} catch (err) {
		// Before the first release nothing is pinned: the site deploys without a manifest. Once anything is
		// pinned, "no manifest" is a failure and the deploy is skipped, so a manifest is never dropped.
		if (err instanceof NoPinnedReleasesError && flag("--allow-none")) {
			if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "payload=\n");
			console.log("manifest: no release is pinned yet; the site deploys without one");
			process.exit(0);
		}
		console.error(`build-manifest: ${err instanceof Error ? err.message : "failed"}`);
		process.exit(1);
	}
}
