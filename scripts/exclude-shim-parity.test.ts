/**
 * Proves the generated POSIX `sh` exclusion-check snippet
 * (buildBashExcludeSnippet(), src/shared/hook-command.ts) agrees with the
 * TypeScript evaluator (src/shared/exclude-rules.ts) on every fixture in
 * the shared matrix — the same extraction-and-run-for-real approach
 * scripts/hook-command-parity.test.ts already uses for the Codex marker
 * snippet, not a reimplementation of the shell logic in TypeScript.
 *
 * Run under the real `/bin/sh` always, and under `dash`, `bash --posix`,
 * and `busybox sh` when each is present on PATH — every shell is named
 * individually in each case's test name, so a missing one shows as a
 * named skip (see the "shells available" describe block) rather than
 * silently narrowing coverage. `/bin/sh` and `bash --posix` are the SAME
 * interpreter binary on a host where `/bin/sh` is bash in POSIX mode (as
 * on this machine) — `bash --posix` is kept as its own named entry
 * anyway because that's not true on every host (Debian/Ubuntu's `/bin/sh`
 * is dash, for one), and it costs nothing to ask for it explicitly rather
 * than assume. On THIS machine `/bin/sh` is bash 3.2 in POSIX mode and
 * `dash` is a separate Homebrew install — exercising both is how
 * shell-specific differences (bracket-expression handling, the `pwd`
 * builtin's on-disk case) get caught. On macOS the snippet now folds
 * ASCII case itself before comparing, so the builtin's behaviour there
 * no longer matters.
 *
 * Every fixture from the shared matrix that isn't `dedicated: true` is
 * driven generically (home/cwd/rulesFileLines, same rewrite-under-a-real-
 * temp-home convention src/shared/exclude-rules.test.ts uses). A
 * `dedicated: true` fixture needs on-disk construction a declarative row
 * can't express (a symlink, a specific permission bit, a planted
 * oversize file) — this file re-derives each one in shell-constructible
 * form. A structural check (mirroring the TS side's) fails the suite if
 * any dedicated fixture has no shell-side counterpart registered.
 *
 * One named, accepted non-parity case: `nul-byte-rule-invalid`. An
 * embedded NUL byte can't be reliably represented in a POSIX `sh`
 * variable (see buildBashExcludeSnippet's own docstring for why the one
 * portable-looking detection trick doesn't work), so this is the one
 * fixture this suite does not assert shell/TypeScript agreement on.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExclusion, loadExcludeRules } from "../src/shared/exclude-rules.js";
import { buildBashExcludeSnippet } from "../src/shared/hook-command.js";
import {
	cwdHasDotSegment,
	isFixtureApplicable,
	loadFixtures,
	rawContentFor,
	rewriteForShell,
	rewriteRawContentForShell,
	rewriteUnderHome,
	tempHome,
} from "./exclude-parity-helpers.js";

const fixtures = loadFixtures();

type CasePlatform = "darwin" | "linux";
const CASE_PLATFORMS: CasePlatform[] = ["darwin", "linux"];
const scratchDir = mkdtempSync(join(tmpdir(), "ap-shim-parity-"));
// The marker ("AP_RESULT=") and the printf that emits it are test-only
// instrumentation appended OUTSIDE the generated snippet text — never
// part of the production artifact under test. The snippet is generated
// once per case-rule branch ("darwin" / "linux" forced) plus once with the
// production default (the real platform probe), so both branches run on
// every host.
function snippetFile(platform?: CasePlatform, preamble = "", transform?: SnippetTransform): string {
	const name = `snippet-${platform ?? "probe"}-${Buffer.from(preamble).toString("hex")}-${transform?.key ?? "plain"}.sh`;
	const path = join(scratchDir, name);
	if (!existsSync(path)) {
		const generated = buildBashExcludeSnippet(platform ? { platform } : undefined);
		const snippet = transform ? transform.apply(generated) : generated;
		writeFileSync(path, `${preamble}${snippet}\nprintf 'AP_RESULT=%s\\n' "$ap_excluded"\n`);
	}
	return path;
}

/** True when the scratch filesystem tells "a" and "A" apart; case-policy rows that need that are named skips on macOS's default volume. */
const FS_CASE_SENSITIVE = (() => {
	const probe = join(scratchDir, "case-probe");
	writeFileSync(probe, "");
	return !existsSync(join(scratchDir, "CASE-PROBE"));
})();

interface ShellHandle {
	name: string;
	bin: string;
	/** Flags passed before the script path — e.g. ["--posix"] for `bash --posix`, ["sh"] for `busybox sh`. */
	args?: string[];
}

function detectShell(name: string, bin: string, args: string[] = []): ShellHandle | null {
	try {
		execFileSync(bin, [...args, "-c", "true"], { stdio: "ignore" });
		return { name, bin, args };
	} catch {
		return null;
	}
}

const SH: ShellHandle = { name: "sh", bin: "/bin/sh" };
const DASH = detectShell("dash", "dash");
const BASH_POSIX = detectShell("bash --posix", "bash", ["--posix"]);
const BUSYBOX_SH = detectShell("busybox sh", "busybox", ["sh"]);
// sh is a fixed assumption (it must exist for the hook shim itself to run
// anywhere); every other candidate is probed and only added when present.
const CANDIDATE_SHELLS: { label: string; handle: ShellHandle | null }[] = [
	{ label: "dash", handle: DASH },
	{ label: "bash --posix", handle: BASH_POSIX },
	{ label: "busybox sh", handle: BUSYBOX_SH },
];
const SHELLS: ShellHandle[] = [
	SH,
	...CANDIDATE_SHELLS.map((c) => c.handle).filter((h): h is ShellHandle => h !== null),
];

const stubProbeResults = new Map<string, boolean>();
/**
 * True when the shell runs a stub placed first on PATH in place of the real
 * `ls`. A busybox built with its applets preferred over PATH (Debian/Ubuntu's
 * is) runs its own `ls` and `id` without looking at PATH, so a PATH stub never
 * executes there; the stub-based cases would then "refuse" nothing and prove
 * nothing. Probed per shell, not assumed from its name.
 */
function honorsPathStubs(shell: ShellHandle): boolean {
	const cached = stubProbeResults.get(shell.name);
	if (cached !== undefined) return cached;
	const dir = mkdtempSync(join(tmpdir(), "ap-stub-probe-"));
	try {
		const stub = join(dir, "ls");
		writeFileSync(stub, "#!/bin/sh\necho STUB_RAN\n");
		chmodSync(stub, 0o755);
		const probe = spawnSync(shell.bin, [...(shell.args ?? []), "-c", "ls /"], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
			encoding: "utf-8",
		});
		const honors = (probe.stdout ?? "").includes("STUB_RAN");
		stubProbeResults.set(shell.name, honors);
		return honors;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const NO_PATH_STUBS_REASON =
	"this shell runs its built-in applets without consulting PATH, so a PATH stub never runs";

/** A case that bends `ls`/`id` through a PATH stub: a named skip in a shell that would never run the stub. */
function stubTest(shell: ShellHandle, name: string, fn: () => void): void {
	if (honorsPathStubs(shell)) test(`${name} [${shell.name}]`, fn);
	else test.skip(`${name} [${shell.name}] (skipped — ${NO_PATH_STUBS_REASON})`, () => {});
}

/** A test-only edit of the generated text at one named seam (e.g. to delete the rules file between two of its steps); applied exactly once, asserted. */
interface SnippetTransform {
	key: string;
	apply: (snippet: string) => string;
}

interface RunOptions {
	extraEnv?: Record<string, string | null>;
	/** Edits the generated snippet at a named seam before it runs. */
	transform?: SnippetTransform;
	/** Which case-rule branch the generated snippet is forced to; omitted = the production probe. */
	platform?: CasePlatform;
	/** Shell text run before the snippet (e.g. to delete the working directory). */
	preamble?: string;
	/** Run the shell with `-x` and return its trace in `trace`. */
	trace?: boolean;
}

interface ShellRunResult {
	excluded: boolean;
	stdout: string;
	stderr: string;
	trace: string;
}

function runShell(
	shell: ShellHandle,
	home: string,
	cwd: string,
	skip: string | undefined,
	extraEnv: Record<string, string | null> = {},
	opts: Omit<RunOptions, "extraEnv"> = {},
): ShellRunResult {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		AGENTPULSE_SKIP: skip ?? "",
	};
	for (const [key, value] of Object.entries(extraEnv)) {
		if (value === null) delete env[key];
		else env[key] = value;
	}
	const flags = opts.trace ? ["-x"] : [];
	const result = spawnSync(
		shell.bin,
		[...(shell.args ?? []), ...flags, snippetFile(opts.platform, opts.preamble, opts.transform)],
		{ cwd, env: env as NodeJS.ProcessEnv, encoding: "utf-8" },
	);
	const stdout = result.stdout ?? "";
	const rawStderr = result.stderr ?? "";
	const match = /AP_RESULT=(\d)/.exec(stdout);
	if (!match) {
		throw new Error(
			`${shell.name}: no AP_RESULT marker in output (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(rawStderr)})`,
		);
	}
	// Strip the test-only marker line before asserting stdout silence —
	// the snippet under test must still have produced nothing else.
	const productionStdout = stdout.replace(/AP_RESULT=\d\n?/, "");
	return {
		excluded: match[1] === "1",
		stdout: productionStdout,
		stderr: opts.trace ? "" : rawStderr,
		trace: opts.trace ? rawStderr : "",
	};
}

function writeRulesFile(home: string, content: string): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "exclude");
	writeFileSync(path, content);
	return path;
}

// Shell parity only ever runs on a POSIX host (sh/dash don't exist as the
// hook shim's interpreter on win32 — that's PowerShell's job); the win32
// drive-root fixture is correctly inapplicable here, same as the TS
// suite's own platform gating.
// Platform-tagged rows (darwin: case-insensitive compare; linux: case-
// sensitive) run on the host whose behaviour they describe, so the shell's
// own platform branch is held to the same fixture the TypeScript evaluator is.
const NUL_BYTE_FIXTURE = "nul-byte-rule-invalid"; // the one named, accepted non-parity case
// The shim's own cwd always comes from `pwd -P` and never contains a
// "."/".." segment (confirmed empirically against real Claude Code and
// Codex sessions) — a fixture whose cwd has one is exercising TypeScript-only
// dotted-cwd resolution (see buildBashExcludeSnippet's docstring) and has
// no meaningful shell-side counterpart; a real process also can't have a
// nonexistent cwd, which every such fixture's cwd deliberately is.
// A row with no cwd (the invalid-rule rows) runs from the home directory:
// the rules file alone decides it. Skip-value rows have their own sweep.
// Which case-rule branches a row is held to is decided per branch below.
const parityCandidates = fixtures.filter(
	(f) =>
		!f.dedicated &&
		!isDataCwdOnly(f) &&
		f.expectedSkip === undefined &&
		f.name !== NUL_BYTE_FIXTURE &&
		!cwdHasDotSegment(f.cwd) &&
		(["darwin", "linux"] as const).some((p) => isFixtureApplicable(f, p)),
);
/** A working directory handed over as data (a hook payload's cwd) can be any length; one a real process starts in cannot be longer than the OS path limit, so the shell is never asked about these. */
function isDataCwdOnly(f: unknown): boolean {
	return (f as { dataCwdOnly?: boolean }).dataCwdOnly === true;
}
const dataCwdOnlyFixtures = fixtures.filter(isDataCwdOnly);
const dottedCwdFixtures = fixtures.filter(
	(f) =>
		!f.dedicated &&
		f.cwd !== undefined &&
		isFixtureApplicable(f, process.platform) &&
		cwdHasDotSegment(f.cwd),
);

const coveredDedicated = new Set<string>();
function dedicatedTest(
	name: string,
	fn: (shell: ShellHandle) => void,
	opts: { needsPathStubs?: boolean } = {},
): void {
	coveredDedicated.add(name);
	for (const shell of SHELLS) {
		if (opts.needsPathStubs) stubTest(shell, name, () => fn(shell));
		else test(`${name} [${shell.name}]`, () => fn(shell));
	}
}

describe("exclude-shim-parity — data-only cwd fixtures are a named, documented exclusion", () => {
	test("the fixtures whose cwd is longer than any process can start in are named here, not silently dropped", () => {
		expect(dataCwdOnlyFixtures.map((f) => f.name)).toEqual([
			"cwd-exactly-4096-chars-still-matches",
			"cwd-over-4096-chars-is-no-cwd",
			"cwd-over-4096-chars-outside-every-rule-is-no-cwd",
			"cwd-over-4096-chars-with-no-rules-file-is-not-excluded",
		]);
	});
});

describe("exclude-shim-parity — dotted-cwd fixtures are a named, documented exclusion", () => {
	test("every non-dedicated fixture with a dotted cwd is named here, not silently dropped", () => {
		expect(dottedCwdFixtures.map((f) => f.name)).toEqual(["cwd-with-unresolvable-dotdot-no-cwd"]);
	});
});

// The shell's dot-segment check used to run on the
// RAW line, before `~` expansion — a `~/../x`-style line never looked
// like it had a dot segment at that point (there's no literal ".."
// adjacent to a "/" in "~/../x" until AFTER "~/" is expanded to the real
// home path), so it slipped through as if it were a normal, valid rule.
// Mirrors the two fixtures added to exclude-cases.json for the TypeScript
// side (tilde-dotdot-invalid, tilde-dot-segment-invalid); these two lack
// a cwd (same convention as their non-tilde siblings, rule-with-dotdot-
// invalid/rule-with-dot-segment-invalid), so the generic cwd-driven sweep
// doesn't reach them — exercised directly here instead.
describe("exclude-shim-parity — tilde expansion then dot-segment rejection", () => {
	for (const shell of SHELLS) {
		test(`tilde-dotdot-invalid [${shell.name}]`, () => {
			const home = tempHome();
			try {
				writeRulesFile(home, "~/../secret\n");
				const result = runShell(shell, home, home, undefined);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`tilde-dot-segment-invalid [${shell.name}]`, () => {
			const home = tempHome();
			try {
				writeRulesFile(home, "~/./work\n");
				const result = runShell(shell, home, home, undefined);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — a rule through a symlink that ends at a regular file", () => {
	// The deepest existing ancestor is a file, not a directory, so it can't
	// be `cd`'d into: resolution has to fall back to its parent. An empty
	// resolved prefix would match EVERY cwd, so this guards the
	// fail-wide direction.
	for (const shell of SHELLS) {
		test(`rule naming a file behind a symlinked directory excludes nothing else [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const real = join(home, "real");
				mkdirSync(real, { recursive: true });
				writeFileSync(join(real, "notes.txt"), "x");
				symlinkSync(real, join(home, "link"));
				const elsewhere = join(home, "elsewhere");
				mkdirSync(elsewhere);
				writeRulesFile(home, `${join(home, "link", "notes.txt")}\n`);
				const result = runShell(shell, home, elsewhere, undefined);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				const ts = evaluateExclusion({
					cwd: elsewhere,
					skip: undefined,
					rules: loadExcludeRules(home),
				});
				expect(ts.excluded).toBe(false);
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — shells available", () => {
	test("sh is always exercised", () => {
		expect(SHELLS.some((s) => s.name === "sh")).toBe(true);
	});

	// Each optional shell gets its own named test — present and exercised
	// (passes) or absent and explicitly skipped by name (a visible, named
	// skip, not a console.warn a CI summary can miss and not just fewer
	// tests with no record of why).
	for (const candidate of CANDIDATE_SHELLS) {
		if (candidate.handle) {
			test(`${candidate.label} is present and exercised`, () => {
				expect(SHELLS.some((s) => s.name === candidate.label)).toBe(true);
			});
		} else {
			test.skip(`${candidate.label} not found on PATH — parity coverage for this shell skipped this run`, () => {});
		}
	}
});

describe("exclude-shim-parity — generic fixture sweep", () => {
	test("the parity candidate set is non-trivially large", () => {
		expect(parityCandidates.length).toBeGreaterThanOrEqual(15);
	});

	test("the rows with no cwd (relative, wildcard, dot-segment rules) are part of the sweep", () => {
		const names = parityCandidates.map((f) => f.name);
		for (const name of [
			"relative-rule-invalid",
			"wildcard-rule-invalid-star",
			"wildcard-rule-invalid-question",
			"wildcard-rule-invalid-bracket-open",
			"wildcard-rule-invalid-bracket-close",
			"rule-with-dotdot-invalid",
			"rule-with-dot-segment-invalid",
		]) {
			expect(names, name).toContain(name);
		}
	});

	for (const platform of CASE_PLATFORMS) {
		for (const fixture of parityCandidates) {
			if (!isFixtureApplicable(fixture, platform)) continue;
			for (const shell of SHELLS) {
				const needsCaseSensitiveFs = fixture.platform === "linux" && !FS_CASE_SENSITIVE;
				const run = needsCaseSensitiveFs ? test.skip : test;
				run(`${fixture.name} [${shell.name}, ${platform} case rule]`, () => {
					const home = tempHome();
					const sandbox = tempHome(); // a second real temp root, standing in for the fixture's synthetic "/a" prefix
					try {
						const rawContent = rawContentFor(fixture);
						if (rawContent !== undefined) {
							writeRulesFile(home, rewriteRawContentForShell(rawContent, sandbox));
						}
						const rewrittenCwd = rewriteUnderHome(fixture.cwd, fixture.home, home) ?? home;
						const cwd = rewriteForShell(rewrittenCwd, sandbox);
						mkdirSync(cwd, { recursive: true });
						const result = runShell(shell, home, cwd, undefined, {}, { platform });
						expect(result.stdout).toBe("");
						expect(result.stderr).toBe("");
						// A direct three-way check, not just shell-vs-expected: the
						// TypeScript evaluator runs against the SAME on-disk
						// construction the shell just ran against, under the same
						// case rule, so a divergence between the two evaluators is
						// caught here too.
						const tsLoaded = loadExcludeRules(home);
						const tsResult = evaluateExclusion({ cwd, skip: undefined, rules: tsLoaded, platform });
						expect(result.excluded).toBe(fixture.expected.excluded);
						expect(tsResult.excluded).toBe(fixture.expected.excluded);
						expect(result.excluded).toBe(tsResult.excluded);
					} finally {
						rmSync(home, { recursive: true, force: true });
						rmSync(sandbox, { recursive: true, force: true });
					}
				});
			}
		}
	}
});

describe("exclude-shim-parity — skip-value sweep", () => {
	const skipFixtures = fixtures.filter((f) => f.expectedSkip !== undefined);

	test("the skip-value fixture set is non-trivially large", () => {
		expect(skipFixtures.length).toBeGreaterThanOrEqual(15);
	});

	for (const fixture of skipFixtures) {
		for (const shell of SHELLS) {
			test(`${fixture.name} [${shell.name}]`, () => {
				const home = tempHome();
				try {
					const result = runShell(shell, home, home, fixture.skip);
					expect(result.stdout).toBe("");
					expect(result.stderr).toBe("");
					expect(result.excluded).toBe(fixture.expectedSkip === true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			});
		}
	}
});

describe("exclude-shim-parity — dedicated on-disk constructions", () => {
	dedicatedTest("symlink-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const real = join(home, "real-exclude");
			writeFileSync(real, "/a/work\n");
			const dir = join(home, ".agentpulse");
			mkdirSync(dir, { recursive: true });
			symlinkSync(real, join(dir, "exclude"));
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("hardlink-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(dir, { recursive: true });
			const original = join(dir, "original");
			writeFileSync(original, "/a/work\n");
			linkSync(original, join(dir, "exclude"));
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("nonregular-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(join(dir, "exclude"), { recursive: true });
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("group-writable-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			chmodSync(path, 0o620);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("world-writable-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			chmodSync(path, 0o602);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-group-writable-invalid", (shell) => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			chmodSync(join(home, ".agentpulse"), 0o770);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
			chmodSync(join(home, ".agentpulse"), 0o700);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-world-writable-invalid", (shell) => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			chmodSync(join(home, ".agentpulse"), 0o707);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
			chmodSync(join(home, ".agentpulse"), 0o700);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-symlinked-good-target-ok", (shell) => {
		const home = tempHome();
		try {
			const realDir = join(home, "real-agentpulse");
			mkdirSync(realDir, { recursive: true });
			chmodSync(realDir, 0o700);
			writeFileSync(join(realDir, "exclude"), "/a/work\n");
			symlinkSync(realDir, join(home, ".agentpulse"));
			// Valid but non-matching — the snippet must not fail closed.
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	const isRoot = process.platform !== "win32" && process.getuid?.() === 0;

	// Simulates a foreign-owned file by putting a stub
	// `id` earlier on PATH that reports a fake uid for `id -u` — the same
	// technique the TypeScript suite uses (an injected getuid), ported to a
	// real shell process. The file's real owner (this test process) never
	// changes, so this runs on every host, not just as root.
	dedicatedTest(
		"not-owned-file-invalid",
		(shell) => {
			const home = tempHome();
			const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-id-"));
			try {
				const realId = execFileSync("which", ["id"], { encoding: "utf-8" }).trim();
				const stubPath = join(stubDir, "id");
				writeFileSync(
					stubPath,
					`#!/bin/sh\nif [ "$1" = "-u" ]; then echo 999999; exit 0; fi\nexec "${realId}" "$@"\n`,
				);
				chmodSync(stubPath, 0o755);
				writeRulesFile(home, "/a/work\n");
				const result = runShell(shell, home, home, undefined, {
					PATH: `${stubDir}:${process.env.PATH ?? ""}`,
				});
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(stubDir, { recursive: true, force: true });
			}
		},
		{ needsPathStubs: true },
	);

	// The rules file below is owned by this process (so the file's own
	// owner check passes); only the DIRECTORY's reported owner is faked,
	// by a stub `ls` that rewrites the uid column when asked about a
	// directory. Proves the directory owner check is its own refusal.
	for (const shell of SHELLS) {
		stubTest(shell, ".agentpulse directory owned by someone else is invalid", () => {
			const home = tempHome();
			const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-ls-"));
			try {
				const realLs = execFileSync("which", ["ls"], { encoding: "utf-8" }).trim();
				const stubPath = join(stubDir, "ls");
				writeFileSync(
					stubPath,
					`#!/bin/sh\nfor last; do :; done\nif [ -d "$last" ]; then "${realLs}" "$@" | awk '{ $3 = 999999; print }'; else exec "${realLs}" "$@"; fi\n`,
				);
				chmodSync(stubPath, 0o755);
				writeRulesFile(home, "/a/work\n");
				const plain = runShell(shell, home, home, undefined);
				expect(plain.excluded).toBe(false); // control: same layout, honest ls, is valid
				const result = runShell(shell, home, home, undefined, {
					PATH: `${stubDir}:${process.env.PATH ?? ""}`,
				});
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(stubDir, { recursive: true, force: true });
			}
		});
	}

	// A real-ownership version of the same case, for when root actually is
	// available (stronger integration evidence than the stub-id version
	// above gives, but not required for the fixture's coverage — mirrors
	// exclude-rules.test.ts's own real-chown/injected-uid pairing).
	(isRoot ? describe : describe.skip)("not-owned-file-invalid, real chown (root only)", () => {
		for (const shell of SHELLS) {
			test(`not-owned-file-invalid, real chown [${shell.name}]`, () => {
				const home = tempHome();
				try {
					const path = writeRulesFile(home, "/a/work\n");
					chownSync(path, 1, 1);
					const result = runShell(shell, home, home, undefined);
					expect(result.excluded).toBe(true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			});
		}
	});

	dedicatedTest("exact-cap-size-file-ok", (shell) => {
		const home = tempHome();
		try {
			const ruleLine = "/a/work\n";
			const padded = `${ruleLine}#${"x".repeat(65536 - ruleLine.length - 2)}\n`;
			expect(Buffer.byteLength(padded)).toBe(65536);
			writeRulesFile(home, padded);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("oversize-by-one-byte-invalid", (shell) => {
		const home = tempHome();
		try {
			const ruleLine = "/a/work\n";
			const padded = `${ruleLine}#${"x".repeat(65536 - ruleLine.length - 1)}\n`;
			expect(Buffer.byteLength(padded)).toBe(65537);
			writeRulesFile(home, padded);
			const result = runShell(shell, home, home, undefined);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("oversize-file-invalid", (shell) => {
		const home = tempHome();
		try {
			const big = "/a/work\n".repeat(10000);
			writeRulesFile(home, big);
			const result = runShell(shell, home, home, undefined);
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	const isRootForUnreadable = process.platform !== "win32" && process.getuid?.() === 0;
	(isRootForUnreadable ? dedicatedSkipAlways : dedicatedTest)(
		"unreadable-file-invalid",
		(shell) => {
			const home = tempHome();
			try {
				const path = writeRulesFile(home, "/a/work\n");
				chmodSync(path, 0o000);
				const result = runShell(shell, home, home, undefined);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	function dedicatedSkipAlways(name: string, _fn: (shell: ShellHandle) => void): void {
		coveredDedicated.add(name);
		test.skip(`${name} (skipped — root bypasses permission bits)`, () => {});
	}

	dedicatedTest("symlinked-cwd-into-excluded-dir", (shell) => {
		const home = tempHome();
		try {
			const real = join(home, "work");
			mkdirSync(real, { recursive: true });
			const link = join(home, "work-link");
			symlinkSync(real, link);
			writeRulesFile(home, `${real}\n`);
			const result = runShell(shell, home, link, undefined);
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("symlinked-rule-target", (shell) => {
		const home = tempHome();
		try {
			const real = join(home, "real-target");
			mkdirSync(real, { recursive: true });
			const link = join(home, "work-link");
			symlinkSync(real, link);
			writeRulesFile(home, `${link}\n`);
			const result = runShell(shell, home, real, undefined);
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("symlinked-parent-rule-not-yet-created", (shell) => {
		const home = tempHome();
		try {
			const realParent = join(home, "real-parent");
			mkdirSync(realParent, { recursive: true });
			const linkedParent = join(home, "linked-parent");
			symlinkSync(realParent, linkedParent);
			const rule = join(linkedParent, "not-yet-created");
			const cwd = join(rule, "sub");
			mkdirSync(join(realParent, "not-yet-created", "sub"), { recursive: true });
			writeRulesFile(home, `${rule}\n`);
			const result = runShell(shell, home, cwd, undefined);
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The symlink-then-".." kernel-vs-lexical scenario is TypeScript-cwd-
	// specific: the shim's own cwd always comes from `pwd -P` and never
	// contains a "."/".." segment (confirmed empirically against real
	// agent sessions), so the shell evaluator never needs — and this snippet never
	// implements — dotted-cwd resolution at all. No shell counterpart by
	// design, not by omission; registered here (as a named exception, not
	// silently dropped) so the structural check still passes.
	for (const name of [
		"symlink-dotdot-kernel-target-excluded",
		"symlink-dotdot-kernel-target-not-excluded-lexical-only",
	]) {
		coveredDedicated.add(name);
		test.skip(`${name} (TypeScript-cwd-only — the shim's cwd never has a dot segment)`, () => {});
	}

	(process.platform === "darwin" ? dedicatedTest : dedicatedSkipAlways)(
		"darwin-case-insensitive-volume",
		(shell) => {
			const home = tempHome();
			try {
				const real = join(home, "Work");
				mkdirSync(real, { recursive: true });
				writeRulesFile(home, `${real}\n`);
				mkdirSync(join(real, "sub"), { recursive: true });
				const variantCwd = join(home.toLowerCase(), "WORK", "sub");
				const result = runShell(shell, home, variantCwd, undefined);
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	// Both deliberately construct a cwd whose LEAF never exists on disk (the
	// whole point: case/NFC-NFD form can't be filesystem-corrected for a
	// path that isn't there). A real shell process can't have a cwd that
	// doesn't exist, so these are TypeScript-evaluator-specific the same
	// way the dotted-cwd fixtures are — named here rather than silently
	// dropped.
	for (const name of [
		"darwin-case-mismatch-nonexistent-leaf",
		"darwin-nfc-nfd-mismatch-nonexistent-leaf",
	]) {
		coveredDedicated.add(name);
		test.skip(`${name} (TypeScript-cwd-only — a real process can't have a nonexistent cwd)`, () => {});
	}

	for (const name of [
		"win32-not-owner-invalid",
		"win32-foreign-write-ace-invalid",
		"win32-system-and-admins-ace-valid",
		"win32-case-and-separator",
		"win32-agentpulse-dir-foreign-write-ace-invalid",
	]) {
		coveredDedicated.add(name);
		test.skip(`${name} (PowerShell-only — no sh/dash counterpart)`, () => {});
	}
});

describe("every dedicated fixture is covered by a shell-side test (or a named exception)", () => {
	test("the dedicated fixture set equals the registered-coverage set", () => {
		const dedicatedNames = fixtures.filter((f) => f.dedicated).map((f) => f.name);
		expect(dedicatedNames.length).toBeGreaterThan(0);
		for (const name of dedicatedNames) {
			expect(
				coveredDedicated.has(name),
				`dedicated fixture "${name}" has no shell-side counterpart registered`,
			).toBe(true);
		}
	});
});

const isRootUser = process.platform !== "win32" && process.getuid?.() === 0;

function agentpulseDir(home: string): string {
	return join(home, ".agentpulse");
}

function plantVictimMarker(home: string): string {
	const victim = join(home, "victim.txt");
	writeFileSync(victim, "precious");
	symlinkSync(victim, join(agentpulseDir(home), "exclude.invalid"));
	return victim;
}

describe("exclude-shim-parity — the invalid-rules marker is never written through a link or into an untrusted directory", () => {
	for (const shell of SHELLS) {
		test(`group-writable directory + a planted marker symlink: the victim keeps its content, event still dropped [${shell.name}]`, () => {
			const home = tempHome();
			try {
				writeRulesFile(home, "/a/work\n");
				const victim = plantVictimMarker(home);
				chmodSync(agentpulseDir(home), 0o770);
				const result = runShell(shell, home, home, undefined);
				chmodSync(agentpulseDir(home), 0o700);
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
				expect(lstatSync(join(agentpulseDir(home), "exclude.invalid")).isSymbolicLink()).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`a directory that is itself the problem gets no marker at all [${shell.name}]`, () => {
			const home = tempHome();
			try {
				writeRulesFile(home, "/a/work\n");
				chmodSync(agentpulseDir(home), 0o770);
				const result = runShell(shell, home, home, undefined);
				const markerExists = existsSync(join(agentpulseDir(home), "exclude.invalid"));
				chmodSync(agentpulseDir(home), 0o700);
				expect(result.excluded).toBe(true);
				expect(markerExists).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`trusted directory, invalid file, planted marker symlink: victim untouched [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const rulesPath = writeRulesFile(home, "/a/work\n");
				chmodSync(agentpulseDir(home), 0o700);
				chmodSync(rulesPath, 0o660);
				const victim = plantVictimMarker(home);
				const result = runShell(shell, home, home, undefined);
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
				expect(lstatSync(join(agentpulseDir(home), "exclude.invalid")).isSymbolicLink()).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`trusted directory, invalid file, no marker yet: the marker is created (positive control) [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const rulesPath = writeRulesFile(home, "/a/work\n");
				chmodSync(agentpulseDir(home), 0o700);
				chmodSync(rulesPath, 0o660);
				const result = runShell(shell, home, home, undefined);
				expect(result.excluded).toBe(true);
				expect(lstatSync(join(agentpulseDir(home), "exclude.invalid")).isFile()).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`a symlinked .agentpulse whose target is group-writable or world-writable is invalid [${shell.name}]`, () => {
			for (const mode of [0o770, 0o707]) {
				const home = tempHome();
				try {
					const real = join(home, "real-agentpulse");
					mkdirSync(real, { recursive: true });
					writeFileSync(join(real, "exclude"), "/a/work\n");
					symlinkSync(real, agentpulseDir(home));
					const control = runShell(shell, home, home, undefined);
					expect(control.excluded, "control: a 0755 target is valid").toBe(false);
					chmodSync(real, mode);
					const result = runShell(shell, home, home, undefined);
					chmodSync(real, 0o700);
					expect(result.stderr).toBe("");
					expect(result.excluded, mode.toString(8)).toBe(true);
					expect(
						existsSync(join(real, "exclude.invalid")),
						"no marker in an untrusted target",
					).toBe(false);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			}
		});
	}
});

describe("exclude-shim-parity — only 'not found' means 'no rules'", () => {
	for (const shell of SHELLS) {
		test.skipIf(isRootUser)(
			`an unsearchable .agentpulse directory is invalid, not 'no rules' [${shell.name}]`,
			() => {
				const home = tempHome();
				try {
					writeRulesFile(home, "/a/work\n");
					chmodSync(agentpulseDir(home), 0o000);
					const result = runShell(shell, home, tmpdir(), undefined);
					chmodSync(agentpulseDir(home), 0o700);
					expect(result.stderr).toBe("");
					expect(result.excluded).toBe(true);
				} finally {
					chmodSync(agentpulseDir(home), 0o700);
					rmSync(home, { recursive: true, force: true });
				}
			},
		);

		test.skipIf(isRootUser)(
			`an unsearchable home directory is invalid, not 'no rules' [${shell.name}]`,
			() => {
				const outer = tempHome();
				const home = join(outer, "home");
				try {
					mkdirSync(home);
					writeRulesFile(home, "/a/work\n");
					chmodSync(home, 0o000);
					const result = runShell(shell, home, tmpdir(), undefined);
					chmodSync(home, 0o700);
					expect(result.stderr).toBe("");
					expect(result.excluded).toBe(true);
				} finally {
					chmodSync(home, 0o700);
					rmSync(outer, { recursive: true, force: true });
				}
			},
		);

		test(`a missing .agentpulse is still 'no rules' (control) [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const result = runShell(shell, home, home, undefined);
				expect(result.excluded).toBe(false);
				expect(result.stderr).toBe("");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`an untrusted directory with no rules file is 'no rules', agreeing with the TypeScript evaluator [${shell.name}]`, () => {
			const home = tempHome();
			try {
				mkdirSync(agentpulseDir(home));
				chmodSync(agentpulseDir(home), 0o770);
				const result = runShell(shell, home, home, undefined);
				const ts = evaluateExclusion({ cwd: home, skip: undefined, rules: loadExcludeRules(home) });
				chmodSync(agentpulseDir(home), 0o700);
				expect(result.excluded).toBe(false);
				expect(ts.excluded).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — HOME unset or empty", () => {
	for (const shell of SHELLS) {
		for (const [label, value] of [
			["empty", ""],
			["unset", null],
		] as const) {
			test(`HOME ${label}: fail closed, never read /.agentpulse [${shell.name}]`, () => {
				const cwd = tempHome();
				try {
					const result = runShell(shell, "", cwd, undefined, { HOME: value });
					expect(result.stderr).toBe("");
					expect(result.stdout).toBe("");
					expect(result.excluded).toBe(true);
				} finally {
					rmSync(cwd, { recursive: true, force: true });
				}
			});
		}

		test(`HOME unset but AGENTPULSE_SKIP allowlisted: still excluded, still silent [${shell.name}]`, () => {
			const cwd = tempHome();
			try {
				const result = runShell(shell, "", cwd, "1", { HOME: null });
				expect(result.excluded).toBe(true);
				expect(result.stderr).toBe("");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — a deleted working directory", () => {
	for (const shell of SHELLS) {
		test(`with rules present: excluded (cwd unknown), nothing on stderr [${shell.name}]`, () => {
			const home = tempHome();
			try {
				writeRulesFile(home, `${join(home, "elsewhere")}\n`);
				const gone = join(home, "gone");
				mkdirSync(gone);
				const result = runShell(
					shell,
					home,
					gone,
					undefined,
					{ AP_GONE: gone },
					{ preamble: 'rmdir "$AP_GONE"\n' },
				);
				expect(result.stderr).toBe("");
				expect(result.stdout).toBe("");
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`with no rules at all: not excluded, nothing on stderr (control) [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const gone = join(home, "gone");
				mkdirSync(gone);
				const result = runShell(
					shell,
					home,
					gone,
					undefined,
					{ AP_GONE: gone },
					{ preamble: 'rmdir "$AP_GONE"\n' },
				);
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — the whole rules file is validated before the marker is decided", () => {
	for (const shell of SHELLS) {
		test(`an early match followed by an invalid line leaves another sender's marker in place [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const cwd = join(home, "work");
				mkdirSync(cwd);
				writeRulesFile(home, `${cwd}\nrelative/not-absolute\n`);
				chmodSync(agentpulseDir(home), 0o700);
				const marker = join(agentpulseDir(home), "exclude.invalid");
				writeFileSync(marker, "");
				const result = runShell(shell, home, cwd, undefined);
				expect(result.excluded).toBe(true);
				expect(existsSync(marker), "an invalid file must not clear the marker").toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`a fully valid file with an early match clears the stale marker (control) [${shell.name}]`, () => {
			const home = tempHome();
			try {
				const cwd = join(home, "work");
				mkdirSync(cwd);
				writeRulesFile(home, `${cwd}\n${join(home, "other")}\n`);
				chmodSync(agentpulseDir(home), 0o700);
				const marker = join(agentpulseDir(home), "exclude.invalid");
				writeFileSync(marker, "");
				const result = runShell(shell, home, cwd, undefined);
				expect(result.excluded).toBe(true);
				expect(existsSync(marker)).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

/**
 * Wraps the real `ls` so a test can change one thing about its `-ldn`
 * output: `awkBody` rewrites the fields of the line (`$1` mode, `$2` link
 * count, `$3` uid, `$5` size) when `applyTo` ("file" | "dir" | "any")
 * matches the path asked about.
 */
function stubLs(dir: string, applyTo: "file" | "dir" | "any", awkBody: string): void {
	const realLs = execFileSync("which", ["ls"], { encoding: "utf-8" }).trim();
	const test =
		applyTo === "file" ? '[ ! -d "$last" ]' : applyTo === "dir" ? '[ -d "$last" ]' : "true";
	const stubPath = join(dir, "ls");
	writeFileSync(
		stubPath,
		`#!/bin/sh\nfor last; do :; done\nif ${test}; then "${realLs}" "$@" | awk '{ ${awkBody}; print }'; else exec "${realLs}" "$@"; fi\n`,
	);
	chmodSync(stubPath, 0o755);
}

describe("exclude-shim-parity — `ls` output is parsed strictly and the call can't be bent by the environment", () => {
	for (const shell of SHELLS) {
		const withStub = (
			label: string,
			applyTo: "file" | "dir" | "any",
			awkBody: string,
			expectExcluded: boolean,
			env: Record<string, string> = {},
		) =>
			stubTest(shell, label, () => {
				const home = tempHome();
				const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-ls-"));
				try {
					writeRulesFile(home, `${join(home, "elsewhere")}\n`);
					stubLs(stubDir, applyTo, awkBody);
					const plain = runShell(shell, home, home, undefined);
					expect(plain.excluded, "control: honest ls is valid and not excluded").toBe(false);
					const result = runShell(shell, home, home, undefined, {
						PATH: `${stubDir}:${process.env.PATH ?? ""}`,
						...env,
					});
					expect(result.stderr).toBe("");
					expect(result.excluded).toBe(expectExcluded);
				} finally {
					rmSync(home, { recursive: true, force: true });
					rmSync(stubDir, { recursive: true, force: true });
				}
			});

		withStub("a non-numeric link count refuses", "file", '$2 = "x"', true);
		withStub("a non-numeric size refuses", "file", '$5 = "big"', true);
		withStub("a non-numeric uid refuses", "file", '$3 = "me"', true);
		withStub("a truncated mode string refuses", "file", "$1 = substr($1, 1, 6)", true);
		withStub("a mode string with a bad character refuses", "file", '$1 = "-rw-r!----"', true);
		withStub("a non-numeric size on the directory refuses", "dir", '$5 = "x"', true);
		withStub("garbage instead of a listing refuses", "any", '$0 = "garbage"; $1 = "garbage"', true);

		// A GNU-style ls that honours the block-size variables for `-l` sizes:
		// the snippet must pin them, or a 64 KiB + 1 file reads as small.
		stubTest(shell, "block-size variables in the environment can't shrink the size", () => {
			const home = tempHome();
			const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-ls-"));
			try {
				writeRulesFile(home, `/a/work\n#${"x".repeat(65536)}\n`);
				const realLs = execFileSync("which", ["ls"], { encoding: "utf-8" }).trim();
				const stubPath = join(stubDir, "ls");
				writeFileSync(
					stubPath,
					`#!/bin/sh\nbs=\${LS_BLOCK_SIZE:-\${BLOCK_SIZE:-\${BLOCKSIZE:-1}}}\n"${realLs}" "$@" | awk -v bs="$bs" '{ $5 = int(($5 + bs - 1) / bs); print }'\n`,
				);
				chmodSync(stubPath, 0o755);
				const result = runShell(shell, home, home, undefined, {
					PATH: `${stubDir}:${process.env.PATH ?? ""}`,
					BLOCK_SIZE: "1024",
					LS_BLOCK_SIZE: "1024",
					BLOCKSIZE: "1024",
				});
				expect(result.stderr).toBe("");
				expect(result.excluded, "oversize file must still be seen as oversize").toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(stubDir, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — owner checks are separate refusals", () => {
	for (const shell of SHELLS) {
		stubTest(shell, "a stub that changes only the FILE's reported owner refuses", () => {
			const home = tempHome();
			const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-ls-"));
			try {
				writeRulesFile(home, "/a/work\n");
				stubLs(stubDir, "file", "$3 = 999999");
				const result = runShell(shell, home, home, undefined, {
					PATH: `${stubDir}:${process.env.PATH ?? ""}`,
				});
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
				// ... and the directory is still trusted, so the marker may be written.
				expect(existsSync(join(agentpulseDir(home), "exclude.invalid"))).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(stubDir, { recursive: true, force: true });
			}
		});

		stubTest(
			shell,
			"a stub that changes only the DIRECTORY's reported owner refuses and writes no marker",
			() => {
				const home = tempHome();
				const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-ls-"));
				try {
					writeRulesFile(home, "/a/work\n");
					stubLs(stubDir, "dir", "$3 = 999999");
					const result = runShell(shell, home, home, undefined, {
						PATH: `${stubDir}:${process.env.PATH ?? ""}`,
					});
					expect(result.excluded).toBe(true);
					expect(existsSync(join(agentpulseDir(home), "exclude.invalid"))).toBe(false);
				} finally {
					rmSync(home, { recursive: true, force: true });
					rmSync(stubDir, { recursive: true, force: true });
				}
			},
		);
	}
});

describe("exclude-shim-parity — stderr stays empty whatever an external utility prints", () => {
	// A stub on PATH that ALWAYS writes a line to stderr (then delegates)
	// proves each external call carries its own stderr redirect, rather
	// than relying on provoking a real failure.
	for (const shell of SHELLS) {
		stubTest(shell, "noisy id, ls and rm", () => {
			const home = tempHome();
			const stubDir = mkdtempSync(join(tmpdir(), "ap-stub-noisy-"));
			try {
				for (const name of ["id", "ls", "rm"]) {
					const real = execFileSync("which", [name], { encoding: "utf-8" }).trim();
					const stubPath = join(stubDir, name);
					writeFileSync(
						stubPath,
						`#!/bin/sh\n"${real}" "$@"\nstatus=$?\necho "stub-${name}-noise" >&2\nexit $status\n`,
					);
					chmodSync(stubPath, 0o755);
				}
				writeRulesFile(home, `${join(home, "elsewhere")}\n`);
				chmodSync(agentpulseDir(home), 0o700);
				writeFileSync(join(agentpulseDir(home), "exclude.invalid"), "");
				const result = runShell(shell, home, home, undefined, {
					PATH: `${stubDir}:${process.env.PATH ?? ""}`,
				});
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(false);
				expect(existsSync(join(agentpulseDir(home), "exclude.invalid")), "rm really ran").toBe(
					false,
				);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(stubDir, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity — skip values: the explicit trim set, in every shell", () => {
	for (const shell of SHELLS) {
		for (const [value, expected] of [
			["1\f", false],
			[" 1 ", false],
			["\u000b1", false],
			[" \t1\r\n", true],
		] as const) {
			test(`${JSON.stringify(value)} -> ${expected} [${shell.name}]`, () => {
				const home = tempHome();
				try {
					const result = runShell(shell, home, home, value);
					expect(result.excluded).toBe(expected);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			});
		}
	}
});

describe("exclude-shim-parity — non-ASCII paths agree with the TypeScript evaluator", () => {
	const onDarwinHost = process.platform === "darwin";

	for (const shell of SHELLS) {
		test.skipIf(!onDarwinHost)(
			`a rule typed NFC excludes a directory stored NFD [${shell.name}]`,
			() => {
				const home = realpathSync(tempHome());
				try {
					const nfd = "École".normalize("NFD");
					const nfc = "École".normalize("NFC");
					mkdirSync(join(home, nfd, "sub"), { recursive: true });
					writeRulesFile(home, `${join(home, nfc)}\n`);
					const cwd = join(home, nfd, "sub");
					const ts = evaluateExclusion({ cwd, skip: undefined, rules: loadExcludeRules(home) });
					expect(ts.excluded, "TypeScript").toBe(true);
					const result = runShell(shell, home, cwd, undefined, {}, { platform: "darwin" });
					expect(result.stderr).toBe("");
					expect(result.excluded, "shell").toBe(true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			},
		);

		test.skipIf(!onDarwinHost)(
			`a rule typed with the wrong accent case excludes the real directory [${shell.name}]`,
			() => {
				const home = realpathSync(tempHome());
				try {
					mkdirSync(join(home, "Été", "sub"), { recursive: true });
					writeRulesFile(home, `${join(home, "étÉ")}\n`);
					const cwd = join(home, "Été", "sub");
					const ts = evaluateExclusion({ cwd, skip: undefined, rules: loadExcludeRules(home) });
					expect(ts.excluded, "TypeScript").toBe(true);
					const result = runShell(shell, home, cwd, undefined, {}, { platform: "darwin" });
					expect(result.stderr).toBe("");
					expect(result.excluded, "shell").toBe(true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			},
		);

		test.skipIf(!onDarwinHost)(
			`the cwd typed NFC while the directory is stored NFD still matches an NFD rule [${shell.name}]`,
			() => {
				const home = realpathSync(tempHome());
				try {
					const nfd = "École".normalize("NFD");
					const nfc = "École".normalize("NFC");
					mkdirSync(join(home, nfd, "sub"), { recursive: true });
					writeRulesFile(home, `${join(home, nfd)}\n`);
					const cwdTypedNfc = join(home, nfc, "sub");
					// PWD names the directory the way it was typed, as a shell that cd'd
					// there would leave it: bash's built-in pwd -P answers from that
					// string, so only the external pwd sees the on-disk spelling.
					const result = runShell(
						shell,
						home,
						cwdTypedNfc,
						undefined,
						{ PWD: cwdTypedNfc },
						{ platform: "darwin" },
					);
					expect(result.excluded).toBe(true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			},
		);

		test.skipIf(!FS_CASE_SENSITIVE)(
			`non-ASCII case is not folded: same behaviour as the TypeScript evaluator [${shell.name}]`,
			() => {
				const home = realpathSync(tempHome());
				try {
					mkdirSync(join(home, "été", "sub"), { recursive: true });
					writeRulesFile(home, `${join(home, "Été")}\n`);
					const cwd = join(home, "été", "sub");
					const ts = evaluateExclusion({
						cwd,
						skip: undefined,
						rules: loadExcludeRules(home),
						platform: "darwin",
					});
					const result = runShell(shell, home, cwd, undefined, {}, { platform: "darwin" });
					expect(ts.excluded).toBe(false);
					expect(result.excluded).toBe(false);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			},
		);
	}

	test("the external pwd runs only for a path with a byte outside printable ASCII (counted from a trace)", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "plain", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "plain")}\n`);
			const plain = runShell(
				SH,
				home,
				join(home, "plain", "sub"),
				undefined,
				{},
				{ platform: "darwin", trace: true },
			);
			expect(plain.excluded).toBe(true);
			expect(plain.trace.split("\n").filter((l) => l.includes("/bin/pwd"))).toEqual([]);

			mkdirSync(join(home, "café", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "café")}\n`);
			const accented = runShell(
				SH,
				home,
				join(home, "café", "sub"),
				undefined,
				{},
				{ platform: "darwin", trace: true },
			);
			expect(accented.excluded).toBe(true);
			expect(
				accented.trace.split("\n").filter((l) => l.includes("/bin/pwd")).length,
			).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// ─── A ~/.agentpulse that is a link to nowhere, or whose ancestors can't be searched ───

/** A dedicated row that needs a user who is not root (root can search any directory). */
function dedicatedUnlessRoot(name: string, fn: (shell: ShellHandle) => void): void {
	if (!isRootUser) {
		dedicatedTest(name, fn);
		return;
	}
	coveredDedicated.add(name);
	test.skip(`${name} (needs a non-root user: root can search any directory)`, () => {});
}

describe("exclude-shim-parity — an unresolvable ~/.agentpulse is invalid, never 'no rules'", () => {
	const invalidCases: [string, (home: string) => string][] = [
		[
			"agentpulse-dir-dangling-symlink-invalid",
			(home) => {
				symlinkSync(join(home, "nowhere"), join(home, ".agentpulse"));
				return home;
			},
		],
		[
			"agentpulse-dir-looping-symlink-invalid",
			(home) => {
				symlinkSync(join(home, ".agentpulse"), join(home, ".agentpulse"));
				return home;
			},
		],
	];
	for (const [name, build] of invalidCases) {
		dedicatedTest(name, (shell) => {
			const home = realpathSync(tempHome());
			try {
				build(home);
				const result = runShell(shell, home, home, undefined);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
				// the directory is the problem: no marker can be (or is) written
				expect(existsSync(join(home, "nowhere"))).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}

	dedicatedUnlessRoot("home-ancestor-unsearchable-invalid", (shell) => {
		const outer = realpathSync(tempHome());
		try {
			const home = join(outer, "locked", "home");
			mkdirSync(home, { recursive: true });
			chmodSync(join(outer, "locked"), 0o000);
			const cwd = outer; // the shell's own cwd must stay reachable
			const result = runShell(shell, home, cwd, undefined);
			chmodSync(join(outer, "locked"), 0o700);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			chmodSync(join(outer, "locked"), 0o700);
			rmSync(outer, { recursive: true, force: true });
		}
	});

	for (const shell of SHELLS) {
		test(`a home that does not exist at all is plain 'no rules', not invalid [${shell.name}]`, () => {
			const outer = realpathSync(tempHome());
			try {
				const result = runShell(shell, join(outer, "no-such-home"), outer, undefined);
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(outer, { recursive: true, force: true });
			}
		});

		test(`a home that is a file is plain 'no rules' (the lookup fails with 'not a directory') [${shell.name}]`, () => {
			const outer = realpathSync(tempHome());
			try {
				writeFileSync(join(outer, "a-file"), "");
				const result = runShell(shell, join(outer, "a-file"), outer, undefined);
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(outer, { recursive: true, force: true });
			}
		});
	}
});

// ─── A rules file that vanishes between the checks and the read ───

describe("exclude-shim-parity — a rules file that vanishes mid-read is invalid, never 'no match'", () => {
	const SEAM = "    ap_line_no=0\n";
	const deleteBeforeRead: SnippetTransform = {
		key: "delete-before-read",
		apply: (snippet) => {
			expect(snippet.split(SEAM).length - 1, "the read loop's seam appears once").toBe(1);
			return snippet.replace(SEAM, `    rm -f "$ap_rules"\n${SEAM}`);
		},
	};
	const keepBeforeRead: SnippetTransform = {
		key: "keep-before-read",
		apply: (snippet) => snippet.replace(SEAM, `    :\n${SEAM}`),
	};

	for (const shell of SHELLS) {
		test(`positive control: the same instrumented text with the file kept reads it normally and does not exclude [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				writeRulesFile(home, `${join(home, "elsewhere")}\n`);
				const result = runShell(shell, home, home, undefined, {}, { transform: keepBeforeRead });
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`the file removed between its checks and its read: excluded, with the invalid marker [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				writeRulesFile(home, `${join(home, "elsewhere")}\n`);
				const result = runShell(shell, home, home, undefined, {}, { transform: deleteBeforeRead });
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(true);
				expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

// ─── A stale invalid-rules marker once the rules file is gone ───

describe("exclude-shim-parity — a stale marker is cleared when the rules file is gone and the directory is trusted", () => {
	for (const shell of SHELLS) {
		test(`trusted directory, no rules file: the marker goes and the event is not excluded [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
				chmodSync(join(home, ".agentpulse"), 0o700);
				const marker = join(home, ".agentpulse", "exclude.invalid");
				writeFileSync(marker, "");
				const result = runShell(shell, home, home, undefined);
				expect(result.excluded).toBe(false);
				expect(existsSync(marker)).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test.skipIf(isRootUser)(
			`a group-writable directory with no rules file: the marker is left alone [${shell.name}]`,
			() => {
				const home = realpathSync(tempHome());
				try {
					mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
					const marker = join(home, ".agentpulse", "exclude.invalid");
					writeFileSync(marker, "");
					chmodSync(join(home, ".agentpulse"), 0o770);
					const result = runShell(shell, home, home, undefined);
					chmodSync(join(home, ".agentpulse"), 0o700);
					expect(result.excluded).toBe(false);
					expect(existsSync(marker)).toBe(true);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			},
		);

		test(`a marker that is a link is removed as the link, never its target [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
				chmodSync(join(home, ".agentpulse"), 0o700);
				const victim = join(home, "victim.txt");
				writeFileSync(victim, "precious");
				symlinkSync(victim, join(home, ".agentpulse", "exclude.invalid"));
				runShell(shell, home, home, undefined);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
				expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

// ─── The forced platform branches execute on every host ───

describe("exclude-shim-parity — the forced darwin and linux case rules run on every host", () => {
	// A rule typed `Proj` against a working directory spelled `proj`. The shell
	// compares the two spellings as text (neither path holds a link or a
	// non-ASCII byte), so the answer is the same on a case-sensitive and a
	// case-insensitive volume: only the platform rule decides.
	for (const shell of SHELLS) {
		test(`linux: the spellings differ, so the rule does not match [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, "proj", "sub"), { recursive: true });
				writeRulesFile(home, `${join(home, "Proj")}\n`);
				const result = runShell(
					shell,
					home,
					join(home, "proj", "sub"),
					undefined,
					{},
					{ platform: "linux" },
				);
				expect(result.excluded).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`darwin: the same pair matches, spelling folded [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, "proj", "sub"), { recursive: true });
				writeRulesFile(home, `${join(home, "Proj")}\n`);
				const result = runShell(
					shell,
					home,
					join(home, "proj", "sub"),
					undefined,
					{},
					{ platform: "darwin" },
				);
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test(`linux: the same spelling still matches (the control for the pair above) [${shell.name}]`, () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, "proj", "sub"), { recursive: true });
				writeRulesFile(home, `${join(home, "proj")}\n`);
				const result = runShell(
					shell,
					home,
					join(home, "proj", "sub"),
					undefined,
					{},
					{ platform: "linux" },
				);
				expect(result.excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

// ─── The external pwd: exactly one per non-ASCII path, and no other absolute-path program ───

describe("exclude-shim-parity — the external pwd runs exactly once per non-ASCII path (counted from a trace)", () => {
	const pwdLines = (trace: string) => trace.split("\n").filter((l) => l.includes("/bin/pwd"));
	/** Executed commands that start with an absolute path (a program named through a variable would show up here). */
	const absoluteCommands = (trace: string) =>
		trace
			.split("\n")
			.map((l) => /^\++ (\/[^ ]+)/.exec(l)?.[1])
			.filter((c): c is string => c !== undefined);

	// The read loop's group silences its own stderr (so a rules file that vanishes
	// before the read can't print an open error); a trace goes to stderr too, so
	// for counting the loop's commands the redirect is removed at that one seam.
	const traceInsideLoop: SnippetTransform = {
		key: "trace-inside-loop",
		apply: (snippet) => {
			const seam = '} 2>/dev/null < "$ap_rules"';
			expect(snippet.split(seam).length - 1, "the read loop's redirect appears once").toBe(1);
			return snippet.replace(seam, '} < "$ap_rules"');
		},
	};

	function traced(home: string, cwd: string): { excluded: boolean; trace: string } {
		const r = runShell(
			SH,
			home,
			cwd,
			undefined,
			{},
			{ platform: "darwin", trace: true, transform: traceInsideLoop },
		);
		return { excluded: r.excluded, trace: r.trace };
	}

	test("plain cwd and plain rule: none", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "plain", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "plain")}\n`);
			const r = traced(home, join(home, "plain", "sub"));
			expect(r.excluded).toBe(true);
			expect(pwdLines(r.trace)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a non-ASCII cwd with a plain rule: exactly one", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "plain"), { recursive: true });
			mkdirSync(join(home, "café", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "plain")}\n`);
			const r = traced(home, join(home, "café", "sub"));
			expect(r.excluded).toBe(false);
			expect(pwdLines(r.trace)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a plain cwd with a non-ASCII rule: exactly one", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "plain", "sub"), { recursive: true });
			mkdirSync(join(home, "café"), { recursive: true });
			writeRulesFile(home, `${join(home, "café")}\n`);
			const r = traced(home, join(home, "plain", "sub"));
			expect(r.excluded).toBe(false);
			expect(pwdLines(r.trace)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a non-ASCII cwd and a non-ASCII rule: exactly two (one each)", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "café", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "café")}\n`);
			const r = traced(home, join(home, "café", "sub"));
			expect(r.excluded).toBe(true);
			expect(pwdLines(r.trace)).toHaveLength(2);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("two non-ASCII rules and a plain cwd: exactly two (each rule once)", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "café"), { recursive: true });
			mkdirSync(join(home, "über"), { recursive: true });
			mkdirSync(join(home, "plain"), { recursive: true });
			writeRulesFile(home, `${join(home, "café")}\n${join(home, "über")}\n`);
			const r = traced(home, join(home, "plain"));
			expect(r.excluded).toBe(false);
			expect(pwdLines(r.trace)).toHaveLength(2);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("every executed command that starts with an absolute path is the external pwd, whatever built its name", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "café", "sub"), { recursive: true });
			writeRulesFile(home, `${join(home, "café")}\n`);
			const r = traced(home, join(home, "café", "sub"));
			const commands = absoluteCommands(r.trace);
			expect(commands.length).toBeGreaterThan(0);
			for (const command of commands) expect(command).toBe("/bin/pwd");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
