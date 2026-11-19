/**
 * A throwaway git repository for the release tooling's tests: a work tree plus a bare `origin`, with
 * global git config switched off and a fixed identity, so a test's commits depend on nothing outside it.
 * Test-only; no production code imports it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureRepo {
	dir: string;
	/** The bare repository `origin` points at. */
	origin: string;
	env: Record<string, string>;
	git(...args: string[]): string;
	/** Writes files (path to text), commits them, and returns the commit sha. */
	commit(files: Record<string, string>, message?: string): string;
	/** An annotated tag by default. */
	tag(name: string, sha: string, kind?: "annotated" | "lightweight", date?: string): void;
	pushMain(): void;
}

export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: tmpdir(),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
		...extra,
	};
}

export function createFixtureRepo(): FixtureRepo {
	const root = mkdtempSync(join(tmpdir(), "ap-release-fixture-"));
	const dir = join(root, "work");
	const origin = join(root, "origin.git");
	const env = gitEnv();
	const run = (cwd: string, args: string[], extraEnv: Record<string, string> = {}): string => {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd,
			env: { ...env, ...extraEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
		}
		return proc.stdout.toString().trim();
	};
	mkdirSync(dir, { recursive: true });
	run(root, ["init", "--bare", "--initial-branch=main", origin]);
	run(dir, ["init", "--initial-branch=main"]);
	run(dir, ["remote", "add", "origin", origin]);
	let counter = 0;
	return {
		dir,
		origin,
		env,
		git: (...args) => run(dir, args),
		commit(files, message = `commit ${++counter}`) {
			for (const [path, text] of Object.entries(files)) {
				const full = join(dir, path);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, text);
			}
			run(dir, ["add", "-A"]);
			run(dir, ["commit", "--allow-empty", "-m", message]);
			return run(dir, ["rev-parse", "HEAD"]);
		},
		tag(name, sha, kind, date) {
			const when: Record<string, string> = date ? { GIT_COMMITTER_DATE: date } : {};
			run(
				dir,
				(kind ?? "annotated") === "annotated"
					? ["tag", "-a", name, "-m", name, sha]
					: ["tag", name, sha],
				when,
			);
		},
		pushMain() {
			run(dir, ["push", "--force", "origin", "main"]);
			run(dir, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
		},
	};
}
