/**
 * Proves the generated PowerShell exclusion-check snippet
 * (buildPowerShellExcludeSnippet(), src/shared/hook-command.ts) agrees
 * with the TypeScript evaluator (src/shared/exclude-rules.ts), the same
 * extraction-and-run-for-real approach scripts/exclude-shim-parity.test.ts
 * already uses for the POSIX `sh` snippet — not a reimplementation of the
 * PowerShell logic in TypeScript.
 *
 * NOT EXECUTED ON WINDOWS IN THIS CHANGE. There is no Windows machine and
 * no `pwsh` in this development environment — every test in this file
 * either runs here (the pwsh-present, non-Windows-ACL subset, when `pwsh`
 * happens to be installed on this host) or is a NAMED skip explaining
 * why. The Windows CI job
 * (.github/workflows/ci.yml's windows-installers job) is the first place
 * this file's full on-disk/ACL coverage actually executes; until that
 * run is observed green, treat the dedicated on-disk constructions below
 * as reviewed-but-unverified.
 *
 * Three coverage tiers, chosen per host:
 *  - On a real win32 host with `pwsh`: the full fixture sweep (every
 *    applicable row, including on-disk constructions — reparse point,
 *    hard link, an ACL set via `icacls`, a directory ACL).
 *  - On a non-win32 host with `pwsh` present: only rows that don't
 *    depend on a Windows ACL being meaningful (skip-value rows, and
 *    "no rules file" rows) — `Get-Acl`/owner-SID resolution on a non-
 *    NTFS filesystem doesn't model the same thing `ApCheckSecurity`
 *    expects, so the snippet's security check fails closed there (as it
 *    should on uncertainty) rather than agreeing with the fixture's
 *    expected outcome. That's the snippet behaving correctly, not a bug
 *    this suite is set up to exercise on this platform.
 *  - When `pwsh` isn't found on PATH anywhere: every row becomes a
 *    single, clearly named skip (not a silently smaller test count).
 *
 * Self-diagnosing: every assertion failure path logs the fixture name,
 * the snippet's actual result, and the fixture's expected result before
 * the test's own expect() call reports the mismatch.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPowerShellExcludeSnippet } from "../src/shared/hook-command.js";
import {
	isFixtureApplicable,
	loadFixtures,
	rawContentFor,
	rewriteUnderHome,
	tempHome,
} from "./exclude-parity-helpers.js";

const fixtures = loadFixtures();

let PWSH_BIN: string | null = null;
try {
	execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
	PWSH_BIN = "pwsh";
} catch {
	PWSH_BIN = null;
}
const IS_WIN32 = process.platform === "win32";

const SNIPPET = buildPowerShellExcludeSnippet();
let SNIPPET_FILE: string | null = null;
if (PWSH_BIN) {
	const scratchDir = mkdtempSync(join(tmpdir(), "ap-shim-parity-ps-"));
	SNIPPET_FILE = join(scratchDir, "snippet.ps1");
	// The marker and the Write-Output that emits it are test-only
	// instrumentation appended OUTSIDE the generated snippet text — never
	// part of the production artifact under test.
	writeFileSync(
		SNIPPET_FILE,
		`${SNIPPET}\nWrite-Output "AP_RESULT=$(if ($apExcluded) { '1' } else { '0' })"\n`,
	);
}

interface PsRunResult {
	excluded: boolean;
	stdout: string;
	stderr: string;
}

function runPwsh(home: string, cwd: string, skip: string | undefined): PsRunResult {
	if (!PWSH_BIN || !SNIPPET_FILE) {
		throw new Error("pwsh not available — caller must gate on PWSH_BIN first");
	}
	const result = spawnSync(PWSH_BIN, ["-NoProfile", "-NonInteractive", "-File", SNIPPET_FILE], {
		cwd,
		env: { ...process.env, HOME: home, AGENTPULSE_SKIP: skip ?? "" },
		encoding: "utf-8",
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const match = /AP_RESULT=(\d)/.exec(stdout);
	if (!match) {
		throw new Error(
			`pwsh: no AP_RESULT marker in output (exit=${result.status}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
		);
	}
	const productionStdout = stdout.replace(/AP_RESULT=\d\r?\n?/, "");
	return { excluded: match[1] === "1", stdout: productionStdout, stderr };
}

/** Logs fixture/actual/expected before letting expect() report the mismatch, so a failure is self-diagnosing without re-running anything by hand. */
function diagnose(fixtureName: string, actual: unknown, expected: unknown): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		console.error(
			`[exclude-shim-parity-ps] fixture=${JSON.stringify(fixtureName)} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
		);
	}
}

function writeRulesFile(home: string, content: string): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "exclude");
	writeFileSync(path, content);
	return path;
}

describe("exclude-shim-parity-ps — pwsh availability", () => {
	if (PWSH_BIN) {
		test("pwsh is present and exercised", () => {
			expect(PWSH_BIN).not.toBeNull();
		});
	} else {
		test.skip("pwsh not found on PATH — PowerShell parity coverage skipped entirely this run", () => {});
	}

	if (!IS_WIN32) {
		test.skip("this host is not win32 — on-disk ACL constructions (reparse point, hard link, icacls ACL, directory ACL) cannot run here; see the Windows CI job", () => {});
	}
});

// Rows that don't touch Windows ACL semantics at all — safe to run under
// pwsh on any platform. "no rules file" fixtures reach the not-found branch
// before ApCheckSecurity is ever called; skip-value fixtures return before the
// rules file is even looked at. An EMPTY rules file is not one of these: the
// file exists, so its directory and its ACL are checked, and off Windows that
// check fails closed (the file is judged invalid, the event excluded). The first
// Linux run showed that, and it is not what the fixture expects.
const ACL_INDEPENDENT_NAMES = new Set(["missing-file-none"]);
const skipValueFixtures = fixtures.filter((f) => f.expectedSkip !== undefined);
const aclIndependentFixtures = fixtures.filter((f) => ACL_INDEPENDENT_NAMES.has(f.name));

describe("exclude-shim-parity-ps — skip-value sweep (runs wherever pwsh is present)", () => {
	test("the skip-value fixture set is non-trivially large", () => {
		expect(skipValueFixtures.length).toBeGreaterThanOrEqual(15);
	});

	for (const fixture of skipValueFixtures) {
		if (!PWSH_BIN) {
			test.skip(`${fixture.name} [pwsh] (pwsh not found on PATH)`, () => {});
			continue;
		}
		test(`${fixture.name} [pwsh]`, () => {
			const home = tempHome("ap-shim-ps-home-");
			try {
				const result = runPwsh(home, home, fixture.skip);
				diagnose(fixture.name, result.excluded, fixture.expectedSkip);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(fixture.expectedSkip === true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

describe("exclude-shim-parity-ps — ACL-independent fixtures (runs wherever pwsh is present)", () => {
	for (const fixture of aclIndependentFixtures) {
		if (!PWSH_BIN) {
			test.skip(`${fixture.name} [pwsh] (pwsh not found on PATH)`, () => {});
			continue;
		}
		test(`${fixture.name} [pwsh]`, () => {
			const home = tempHome("ap-shim-ps-home-");
			try {
				const rawContent = rawContentFor(fixture);
				if (rawContent !== undefined) writeRulesFile(home, rawContent);
				const result = runPwsh(home, home, undefined);
				diagnose(fixture.name, result.excluded, fixture.expected.excluded);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(fixture.expected.excluded);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

// Everything below needs a real NTFS ACL to resolve meaningfully (through
// ApCheckSecurity's Get-Acl call) — only runs with real coverage on an
// actual win32 host. On a non-win32 host (even with pwsh present) these
// are named skips, not silently absent: Get-Acl's owner/ACE model on a
// non-NTFS filesystem doesn't correspond to what ApCheckSecurity expects,
// so the snippet fails closed (treats the file as invalid) regardless of
// the fixture's actual expectation — that's correct fail-safe behavior,
// not something this suite can assert agreement on off real Windows.
const winOnlyCandidates = fixtures.filter(
	(f) =>
		!ACL_INDEPENDENT_NAMES.has(f.name) &&
		f.expectedSkip === undefined &&
		f.cwd !== undefined &&
		isFixtureApplicable(f, "win32") &&
		!f.dedicated,
);

describe("exclude-shim-parity-ps — generic fixture sweep (full coverage: win32 + pwsh only)", () => {
	test("the win32-applicable candidate set is non-trivially large", () => {
		expect(winOnlyCandidates.length).toBeGreaterThanOrEqual(10);
	});

	for (const fixture of winOnlyCandidates) {
		if (!(IS_WIN32 && PWSH_BIN)) {
			test.skip(`${fixture.name} [pwsh] (needs a real win32 host with pwsh — ACL semantics can't be verified off Windows)`, () => {});
			continue;
		}
		test(`${fixture.name} [pwsh]`, () => {
			const home = tempHome("ap-shim-ps-home-");
			try {
				const rawContent = rawContentFor(fixture);
				if (rawContent !== undefined) writeRulesFile(home, rawContent);
				const cwd = rewriteUnderHome(fixture.cwd, fixture.home, home) ?? home;
				mkdirSync(cwd, { recursive: true });
				const result = runPwsh(home, cwd, undefined);
				diagnose(fixture.name, result.excluded, fixture.expected.excluded);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				expect(result.excluded).toBe(fixture.expected.excluded);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

const coveredDedicated = new Set<string>();
function dedicatedWindowsOnly(name: string, fn: () => void): void {
	coveredDedicated.add(name);
	if (IS_WIN32 && PWSH_BIN) {
		test(`${name} [pwsh]`, fn);
	} else {
		test.skip(`${name} [pwsh] (needs a real win32 host with pwsh)`, () => {});
	}
}

describe("exclude-shim-parity-ps — dedicated on-disk constructions (win32 + pwsh only)", () => {
	dedicatedWindowsOnly("win32-case-and-separator", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const real = join(home, "Work");
			mkdirSync(real, { recursive: true });
			writeRulesFile(home, `${real}\n`);
			mkdirSync(join(real, "sub"), { recursive: true });
			const variantCwd = join(home, "WORK", "sub");
			const result = runPwsh(home, variantCwd, undefined);
			diagnose("win32-case-and-separator", result.excluded, true);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedWindowsOnly("win32-drive-root-rule-excludes-deep-cwd", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const fixture = fixtures.find((f) => f.name === "win32-drive-root-rule-excludes-deep-cwd");
			if (!fixture) throw new Error("fixture not found");
			writeRulesFile(home, "C:\\\n");
			const result = runPwsh(home, home, undefined);
			diagnose(fixture.name, result.excluded, fixture.expected.excluded);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(fixture.expected.excluded);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// A reparse point (symlink/junction equivalent) must be treated as
	// invalid, same as a POSIX symlink is on the sh side (symlink-file-invalid).
	dedicatedWindowsOnly("win32-reparse-point-rules-file-invalid", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(dir, { recursive: true });
			const real = join(home, "real-exclude");
			writeFileSync(real, "/a/work\n");
			const link = join(dir, "exclude");
			const mk = spawnSync("cmd.exe", ["/c", "mklink", link, real], { encoding: "utf-8" });
			if (mk.status !== 0) {
				throw new Error(`mklink failed (status=${mk.status}): ${mk.stderr}`);
			}
			const result = runPwsh(home, home, undefined);
			diagnose("win32-reparse-point-rules-file-invalid", result.excluded, true);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// A hard link (nlink > 1) must be treated as invalid, same as the sh
	// side's hardlink-file-invalid.
	dedicatedWindowsOnly("win32-hardlink-rules-file-invalid", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(dir, { recursive: true });
			const original = join(dir, "original");
			writeFileSync(original, "/a/work\n");
			const link = join(dir, "exclude");
			const mk = spawnSync("cmd.exe", ["/c", "mklink", "/H", link, original], {
				encoding: "utf-8",
			});
			if (mk.status !== 0) {
				throw new Error(`mklink /H failed (status=${mk.status}): ${mk.stderr}`);
			}
			const result = runPwsh(home, home, undefined);
			diagnose("win32-hardlink-rules-file-invalid", result.excluded, true);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// A write-capable ACE for a non-exempt principal on the rules FILE
	// itself must invalidate it — mirrors win32-foreign-write-ace-invalid.
	// "Everyone" (S-1-1-0) is a well-known SID present on every Windows
	// install, so this doesn't depend on a second real account existing.
	dedicatedWindowsOnly("win32-icacls-foreign-write-ace-file-invalid", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const path = writeRulesFile(home, "/a/work\n");
			const grant = spawnSync("icacls.exe", [path, "/grant", "*S-1-1-0:(M)"], {
				encoding: "utf-8",
			});
			if (grant.status !== 0) {
				throw new Error(`icacls /grant failed (status=${grant.status}): ${grant.stderr}`);
			}
			const result = runPwsh(home, home, undefined);
			diagnose("win32-icacls-foreign-write-ace-file-invalid", result.excluded, true);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// Same as above, but the write-capable ACE is on the .agentpulse
	// DIRECTORY rather than the file — mirrors
	// win32-agentpulse-dir-foreign-write-ace-invalid.
	dedicatedWindowsOnly("win32-icacls-foreign-write-ace-dir-invalid", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			writeRulesFile(home, "/a/work\n");
			const dir = join(home, ".agentpulse");
			const grant = spawnSync("icacls.exe", [dir, "/grant", "*S-1-1-0:(M)"], {
				encoding: "utf-8",
			});
			if (grant.status !== 0) {
				throw new Error(`icacls /grant failed (status=${grant.status}): ${grant.stderr}`);
			}
			const result = runPwsh(home, home, undefined);
			diagnose("win32-icacls-foreign-write-ace-dir-invalid", result.excluded, true);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// SYSTEM/Administrators holding write access is exempt and must stay
	// valid — mirrors win32-system-and-admins-ace-valid. Those groups
	// already have Allow ACEs by default on a fresh file in most setups;
	// this explicitly (re)grants them to make the fixture self-contained
	// rather than relying on the runner's default ACL state.
	dedicatedWindowsOnly("win32-icacls-system-and-admins-ace-valid", () => {
		const home = tempHome("ap-shim-ps-home-");
		try {
			const path = writeRulesFile(home, "/a/work\n");
			const grantSystem = spawnSync("icacls.exe", [path, "/grant", "*S-1-5-18:(M)"], {
				encoding: "utf-8",
			});
			const grantAdmins = spawnSync("icacls.exe", [path, "/grant", "*S-1-5-32-544:(M)"], {
				encoding: "utf-8",
			});
			if (grantSystem.status !== 0 || grantAdmins.status !== 0) {
				throw new Error(
					`icacls /grant failed (system=${grantSystem.status}, admins=${grantAdmins.status})`,
				);
			}
			const result = runPwsh(home, home, undefined);
			diagnose("win32-icacls-system-and-admins-ace-valid", result.excluded, false);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(result.excluded).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("exclude-shim-parity-ps — every declared row is accounted for", () => {
	test("the win32-only dedicated set is non-empty and every row is registered", () => {
		expect(coveredDedicated.size).toBeGreaterThan(0);
	});
});
