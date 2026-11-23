/**
 * Staging the target release into `app.staging-<version>` (step 8) and the checks on the tree that is about
 * to be replaced (step 7's dirty-tree test).
 *
 * Everything fetched is pinned: the clone is made locally from `app` (so no network is needed for the base),
 * the remote is set to the canonical URL, and the target is fetched by commit and by exact tag. The tag's
 * commit must equal the manifest's, and the installed HEAD must be its ancestor (fast-forward only: nothing
 * local is merged or reset). Dependencies install with `--frozen-lockfile --ignore-scripts`, so a fetched
 * package's lifecycle scripts never run. Every git call ignores the person's git config, runs no hook and no
 * fsmonitor, never prompts, and allows only the protocol the remote uses.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { type RunFn, SAFE_GIT_FLAGS, baseEnv, gitEnv, gitProtocolArgs } from "./exec.js";

const GIT_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;

export interface StageDeps {
	run: RunFn;
	env: Record<string, string | undefined>;
	home: string;
}

function git(deps: StageDeps, cwd: string, remote: string, ...args: string[]) {
	return deps.run(["git", ...SAFE_GIT_FLAGS, ...gitProtocolArgs(remote), ...args], {
		cwd,
		env: gitEnv(deps.env, deps.home),
		timeoutMs: GIT_TIMEOUT_MS,
	});
}

// ---- the dirty-tree test ----

/** Untracked or ignored paths the updater tolerates (and does not carry over). Everything else refuses the update. */
export function isBenignUntracked(path: string): boolean {
	const clean = path.replace(/\/+$/, "");
	const segments = clean.split("/");
	const last = segments[segments.length - 1] ?? "";
	if (
		segments.some(
			(s) =>
				s === "node_modules" ||
				s === "dist" ||
				s === ".vite" ||
				s === "__pycache__" ||
				s === ".claude",
		)
	) {
		return true;
	}
	if (last === ".DS_Store" || last.endsWith(".pyc") || last.endsWith(".tsbuildinfo")) return true;
	// `.env*` is carried over, but only the ones at the root of the checkout.
	return segments.length === 1 && last.startsWith(".env");
}

export type TreeVerdict =
	| { ok: true }
	| {
			ok: false;
			code: Extract<UpdateOutcomeCode, "dirty_tree" | "untracked_files" | "install_failed">;
			count?: number;
			/** The offending paths, for a test to name; never printed or logged (the output says a count only). */
			paths?: string[];
	  };

/** `git status --porcelain --ignored` on the installed checkout. */
export async function checkTreeClean(
	deps: StageDeps,
	app: string,
	remote: string,
): Promise<TreeVerdict> {
	const result = await git(deps, app, remote, "status", "--porcelain", "--ignored", "-uall");
	if (result.code !== 0) return { ok: false, code: "install_failed" };
	const stray: string[] = [];
	for (const line of result.stdout.split("\n")) {
		if (line.length < 4) continue;
		const status = line.slice(0, 2);
		const path = line.slice(3);
		if (status === "!!" || status === "??") {
			if (!isBenignUntracked(path)) stray.push(path);
		} else {
			return { ok: false, code: "dirty_tree", paths: [path] };
		}
	}
	return stray.length > 0
		? { ok: false, code: "untracked_files", count: stray.length, paths: stray.slice(0, 10) }
		: { ok: true };
}

// ---- staging ----

export type StageFailure = Extract<
	UpdateOutcomeCode,
	"commit_mismatch" | "not_fast_forward" | "install_failed" | "build_failed"
>;

export type StageResult =
	| { ok: true; hasUpdaterSource: boolean }
	| { ok: false; code: StageFailure };

export interface StageInput {
	app: string;
	staging: string;
	remote: string;
	version: string;
	commit: string;
	bunBin: string;
	/** A person's explicit downgrade: the target may be an ancestor of the installed HEAD instead of a descendant. */
	allowBackward?: boolean;
}

/** Clones, fetches, verifies and checks out the target in `staging`. The tree is not built yet. */
export async function fetchTarget(deps: StageDeps, input: StageInput): Promise<StageResult> {
	rmSync(input.staging, { recursive: true, force: true });
	mkdirSync(input.staging, { recursive: true, mode: 0o700 });
	chmodSync(input.staging, 0o700);
	const tag = `v${input.version}`;
	const steps: string[][] = [
		// The file protocol is allowed for this one clone from the installed checkout, and for nothing else.
		[
			"-c",
			"protocol.file.allow=always",
			"clone",
			"--quiet",
			"--no-hardlinks",
			input.app,
			input.staging,
		],
	];
	const clone = await deps.run(["git", ...SAFE_GIT_FLAGS, ...steps[0]], {
		cwd: input.app,
		env: gitEnv(deps.env, deps.home),
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (clone.code !== 0) return { ok: false, code: "install_failed" };
	const staging = input.staging;
	const remote = input.remote;
	if ((await git(deps, staging, remote, "remote", "set-url", "origin", remote)).code !== 0) {
		return { ok: false, code: "install_failed" };
	}
	const fetched = await git(
		deps,
		staging,
		remote,
		"fetch",
		"--quiet",
		"--no-tags",
		"origin",
		input.commit,
		`+refs/tags/${tag}:refs/tags/${tag}`,
	);
	if (fetched.code !== 0) return { ok: false, code: "install_failed" };
	const tagCommit = await git(deps, staging, remote, "rev-parse", `${tag}^{commit}`);
	if (tagCommit.code !== 0 || tagCommit.stdout.trim() !== input.commit) {
		return { ok: false, code: "commit_mismatch" };
	}
	const head = await git(deps, staging, remote, "rev-parse", "HEAD");
	if (head.code !== 0) return { ok: false, code: "install_failed" };
	const ancestor = await git(
		deps,
		staging,
		remote,
		"merge-base",
		"--is-ancestor",
		head.stdout.trim(),
		input.commit,
	);
	if (ancestor.code !== 0) {
		// Moving backwards along the checkout's own history is a downgrade, and only a person's flag allows it.
		const backward =
			input.allowBackward === true &&
			(
				await git(
					deps,
					staging,
					remote,
					"merge-base",
					"--is-ancestor",
					input.commit,
					head.stdout.trim(),
				)
			).code === 0;
		if (!backward) return { ok: false, code: "not_fast_forward" };
	}
	if (
		(await git(deps, staging, remote, "checkout", "--quiet", "--detach", input.commit)).code !== 0
	) {
		return { ok: false, code: "install_failed" };
	}
	return { ok: true, hasUpdaterSource: existsSync(join(staging, "src", "updater", "cli.ts")) };
}

function hasPlainLockfile(staging: string): boolean {
	try {
		return lstatSync(join(staging, "bun.lock")).isFile();
	} catch {
		return false;
	}
}

/**
 * `bun install --frozen-lockfile --ignore-scripts`, then `bun run build`, in the staged tree. Bun's frozen
 * install succeeds with no lockfile at all (it just resolves), so the lockfile has to be there, a plain file,
 * before it runs: a release that shipped without one would otherwise install unconstrained.
 */
export async function buildStaged(
	deps: StageDeps,
	input: { staging: string; bunBin: string },
): Promise<{ ok: true } | { ok: false; code: "install_failed" | "build_failed" }> {
	if (!hasPlainLockfile(input.staging)) return { ok: false, code: "install_failed" };
	const env = { ...baseEnv(deps.env, deps.home) };
	const install = await deps.run(
		[input.bunBin, "install", "--frozen-lockfile", "--ignore-scripts"],
		{ cwd: input.staging, env, timeoutMs: INSTALL_TIMEOUT_MS },
	);
	if (install.code !== 0) return { ok: false, code: "install_failed" };
	const build = await deps.run([input.bunBin, "run", "build"], {
		cwd: input.staging,
		env: { ...env, NODE_ENV: "production" },
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	return build.code === 0 ? { ok: true } : { ok: false, code: "build_failed" };
}

/** Bundles the staged tree's updater into a single file, outside the tree. */
export async function bundleUpdater(
	deps: StageDeps,
	input: { staging: string; bunBin: string; outDir: string },
): Promise<boolean> {
	rmSync(input.outDir, { recursive: true, force: true });
	mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
	const out = join(input.outDir, "updater.js");
	const result = await deps.run(
		[input.bunBin, "build", "--target=bun", "src/updater/cli.ts", "--outfile", out],
		{ cwd: input.staging, env: baseEnv(deps.env, deps.home), timeoutMs: BUILD_TIMEOUT_MS },
	);
	return result.code === 0 && existsSync(out);
}
