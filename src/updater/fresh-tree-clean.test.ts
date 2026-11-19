import { Database } from "bun:sqlite";
/**
 * A fresh install, then the dirty check. On an archive of HEAD made into a git repo (the worktree's
 * node_modules linked in, so no network), this runs `bun run build` and a smoke boot, then the same
 * step-7 check the updater runs before an update, which must say the tree is clean. If the build or a boot
 * leaves a file that isn't in the benign list, the failure names it: add it to `.gitignore` (and to
 * `isBenignUntracked` if the updater should tolerate it), or stop the build writing it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCapped } from "../shared/capped-fetch.js";
import { defaultRun } from "./exec.js";
import { smokeBoot } from "./smoke.js";
import { checkTreeClean } from "./stage.js";

const REPO = join(import.meta.dir, "..", "..");
let scratch: string;
let tree: string;

const GIT_ENV = {
	PATH: process.env.PATH ?? "",
	HOME: tmpdir(),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (...args: string[]) => {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd: tree,
		env: GIT_ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "ap-fresh-"));
	tree = join(scratch, "app");
	mkdirSync(tree);
	const archive = Bun.spawnSync(["git", "-C", REPO, "archive", "HEAD"], { stdout: "pipe" });
	writeFileSync(join(scratch, "tree.tar"), archive.stdout);
	Bun.spawnSync(["tar", "-xf", join(scratch, "tree.tar"), "-C", tree]);
	git("init", "-q", "--initial-branch=main");
	// -f: the archive holds what the real repository tracks, including files its .gitignore also names.
	git("add", "-Af");
	git("commit", "-q", "-m", "fresh");
	symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a fresh tree stays clean through a build and a boot", () => {
	test("checkTreeClean says clean afterwards, and names any file that isn't", async () => {
		const env = { PATH: process.env.PATH, HOME: tmpdir() };
		const deps = { run: defaultRun, env, home: tmpdir() };
		expect(await checkTreeClean(deps, tree, "https://example.invalid/x.git")).toEqual({ ok: true });

		const build = await defaultRun([process.execPath, "run", "build"], {
			cwd: tree,
			env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), NODE_ENV: "production" },
			timeoutMs: 300_000,
		});
		expect(build.code).toBe(0);
		expect(existsSync(join(tree, "dist", "server", "index.js"))).toBe(true);

		// a database to boot against, made the way a fresh install makes one
		const db = join(scratch, "boot.db");
		const sqlite = new Database(db, { create: true });
		sqlite.close();
		const version = JSON.parse(await Bun.file(join(tree, "package.json")).text()).version as string;
		const smoke = await smokeBoot({
			stagingDir: tree,
			entry: join("dist", "server", "index.js"),
			bunBin: process.execPath,
			sqlitePath: db,
			targetVersion: version,
			parentEnv: { PATH: process.env.PATH },
			fetchText: fetchCapped,
			timeoutMs: 60_000,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			now: Date.now,
		});
		expect(smoke.ok).toBe(true);

		const verdict = await checkTreeClean(deps, tree, "https://example.invalid/x.git");
		// named member: any stray file fails the test by name
		expect(verdict).toEqual({ ok: true });
	}, 400_000);
});
