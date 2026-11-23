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
import {
	clientDigests,
	extractExcludeHeredoc,
	heredocHazard,
} from "../../src/shared/relay-installer-parts.ts";
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

export interface ReleaseInfo {
	draft: boolean;
	/** The release's `published_at`, as an ISO time. */
	publishedAt?: string;
}

export class BuildError extends Error {}

/** `releases/release-data.json` pins nothing yet: before the first release there is no manifest to build. */
export class NoPinnedReleasesError extends BuildError {}

export interface BuildOptions {
	repoDir: string;
	/** Epoch ms: the payload's `issuedAt`. */
	now: number;
	/**
	 * The GitHub release for a tag: null only when there is none (a 404). Any other failure must throw, so a
	 * flaky API can never drop a pin quietly. Injected so tests never touch the network.
	 */
	releaseLookup: (tag: string) => ReleaseInfo | null;
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

/** Why a pin fails an inclusion rule, or null when it passes; `release` is what GitHub says, for publishedAt. */
function ineligibleReason(
	pin: Pin,
	options: BuildOptions,
	mainRef: string,
): { reason: string | null; release: ReleaseInfo | null } {
	const { repoDir } = options;
	const tag = `v${pin.version}`;
	const ref = `refs/tags/${tag}`;
	const refuse = (reason: string) => ({ reason, release: null });
	const kind = git(repoDir, ["cat-file", "-t", ref])?.trim();
	if (kind === undefined) return refuse(`tag ${tag} does not exist`);
	if (kind !== "tag") return refuse(`tag ${tag} is not annotated`);
	if (git(repoDir, ["rev-parse", `${ref}^{commit}`])?.trim() !== pin.commit) {
		return refuse(`tag ${tag} does not resolve to the pinned commit`);
	}
	if (git(repoDir, ["merge-base", "--is-ancestor", pin.commit, mainRef]) === null) {
		return refuse(`the pinned commit is not reachable from ${mainRef}`);
	}
	const pkg = git(repoDir, ["show", `${pin.commit}:package.json`]);
	let packaged: unknown = null;
	try {
		packaged = pkg === null ? null : (JSON.parse(pkg) as { version?: unknown }).version;
	} catch {
		// reported below
	}
	if (packaged !== pin.version)
		return refuse(`package.json at the pinned commit says ${String(packaged)}`);
	const release = options.releaseLookup(tag);
	if (release === null) return refuse(`no GitHub release exists for ${tag}`);
	if (release.draft) return refuse(`the GitHub release for ${tag} is a draft`);
	return { reason: null, release };
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

/** The release's published_at, else the tag's taggerdate, else the build time. Never the commit date. */
function publishedAtOf(pin: Pin, options: BuildOptions, release: ReleaseInfo | null): string {
	if (release?.publishedAt) return new Date(release.publishedAt).toISOString();
	const tagged = git(options.repoDir, [
		"for-each-ref",
		"--format=%(taggerdate:iso-strict)",
		`refs/tags/v${pin.version}`,
	])?.trim();
	const ms = tagged ? Date.parse(tagged) : Number.NaN;
	return new Date(Number.isFinite(ms) ? ms : options.now).toISOString();
}

async function describeRelease(
	pin: Pin,
	options: BuildOptions,
	release: ReleaseInfo | null,
): Promise<ManifestRelease> {
	const { repoDir } = options;
	const at = (path: string) =>
		mustGit(repoDir, ["show", `${pin.commit}:${path}`], `${path} missing at ${pin.version}`);
	const heredoc = extractExcludeHeredoc(at("scripts/setup-relay.sh"));
	if (!heredoc.ok) throw new BuildError(`${pin.version}: ${heredoc.reason}`);
	const relay = at("scripts/relay.ts");
	const statusline = at("scripts/statusline.sh");
	for (const [name, text] of [
		["scripts/relay.ts", relay],
		["scripts/statusline.sh", statusline],
	] as const) {
		const hazard = heredocHazard(text);
		if (hazard)
			throw new BuildError(`${pin.version}: ${name} has ${hazard}; the installer can't carry it`);
	}
	const clients = await clientDigests({
		relay,
		statusline,
		excludeCheck: materializeExcludeScript(heredoc.text),
	});
	return {
		version: pin.version,
		commit: pin.commit,
		publishedAt: publishedAtOf(pin, options, release),
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
	// Every pin from the first signed version on is judged. One that fails fails the build, so a flaky
	// check or a bad tag can never drop a release quietly; a pulled pin is kept either way, because
	// "this version is bad" must survive a missing tag or release.
	const judged = data.pins
		.filter((pin) => compareReleaseVersions(parsed(pin.version), first) >= 0)
		.map((pin) => ({ pin, ...ineligibleReason(pin, options, mainRef) }));
	for (const { pin, reason } of judged) {
		if (reason && !pin.pulled)
			throw new BuildError(`${pin.version} is pinned but fails an inclusion rule: ${reason}`);
	}
	const eligible = judged
		.sort((a, b) => compareReleaseVersions(parsed(b.pin.version), parsed(a.pin.version)))
		.map(({ pin, release }) => ({ pin, release }));
	if (eligible.length === 0)
		throw new BuildError("no pinned release is at or above firstSignedVersion");
	const latestEntry = eligible.find(
		({ pin }) => parsed(pin.version).pre.length === 0 && !pin.pulled,
	);
	const latestPin = latestEntry?.pin;
	if (!latestPin || !latestEntry)
		throw new BuildError("no non-pulled stable release to call latest");
	if (compareReleaseVersions(parsed(data.minSupported), parsed(latestPin.version)) > 0) {
		throw new BuildError("minSupported is above the latest release");
	}
	const kept = eligible.slice(0, MAX_RELEASES);
	if (!kept.includes(latestEntry))
		throw new BuildError("latest fell outside the newest 30 releases");

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
		releases: await Promise.all(
			kept.map(({ pin, release }) => describeRelease(pin, options, release)),
		),
	};
	const envelopeEstimate = Math.ceil((JSON.stringify(manifest).length * 4) / 3) + 256;
	if (envelopeEstimate > MAX_ENVELOPE_BYTES)
		throw new BuildError("the payload would not fit a 32 KiB envelope");
	return manifest;
}

/**
 * Turns `gh api repos/.../releases/tags/<tag>` output into a result. Only a 404 means "no release"; every
 * other failure (rate limit, 5xx, bad credentials, network) throws, so it can't pass for "not released".
 */
export function interpretGhResult(r: {
	exitCode: number;
	stdout: string;
	stderr: string;
}): ReleaseInfo | null {
	if (r.exitCode !== 0) {
		if (/HTTP 404/.test(r.stderr)) return null;
		throw new BuildError(`gh api failed: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`);
	}
	let parsed: { draft?: unknown; published_at?: unknown };
	try {
		parsed = JSON.parse(r.stdout);
	} catch {
		throw new BuildError("gh api returned something that is not JSON");
	}
	const published =
		typeof parsed.published_at === "string" ? Date.parse(parsed.published_at) : Number.NaN;
	return {
		draft: parsed.draft !== false,
		...(Number.isFinite(published) ? { publishedAt: new Date(published).toISOString() } : {}),
	};
}

function ghReleaseLookup(repo: string): BuildOptions["releaseLookup"] {
	return (tag) => {
		const proc = Bun.spawnSync(
			[
				"gh",
				"api",
				`repos/${repo}/releases/tags/${tag}`,
				"--jq",
				"{draft: .draft, published_at: .published_at}",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		return interpretGhResult({
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		});
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string) => args.includes(name);
	// A flag that is absent is undefined, never args[0] (indexOf -1 + 1): that made --repo-dir "--unsigned".
	const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
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
