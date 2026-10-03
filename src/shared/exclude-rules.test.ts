/**
 * The shared exclude-rules evaluator: can a user list directories whose
 * sessions should never be reported, checked on their own machine before
 * anything is sent? These tests drive src/shared/exclude-rules.ts against
 * the fixture matrix in __fixtures__/exclude-cases.json, which later
 * phases' shell and PowerShell parity tests consume unchanged — every
 * fixture here is a contract the other two evaluators must also satisfy.
 *
 * Every test uses its own mkdtemp'd home directory (on top of the ambient
 * test-home sandbox) and never touches a real `~/.agentpulse`.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExcludeFixtureCase,
	MAX_RULES_FILE_BYTES,
	type StatLike,
	collapseSeparators,
	evaluateExclusion,
	evaluateWindowsSecurity,
	isRootPath,
	isSkipHeaderValue,
	isSkipValue,
	isWindowsAbsolutePath,
	loadExcludeRules,
	matchesRule,
	mergeProvider,
	normalizeForCompare,
	reresolveRules,
	resolvePhysicalPath,
	resolveStepByStep,
	setInvalidMarker,
} from "./exclude-rules.js";
import { SKIP_HEADER_MAX_LENGTH } from "./hook-headers.js";

const fixturesRaw = readFileSync(
	join(import.meta.dir, "__fixtures__", "exclude-cases.json"),
	"utf-8",
);
const fixtures: ExcludeFixtureCase[] = JSON.parse(fixturesRaw).cases;

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "ap-exclude-rules-"));
}

function writeRulesFile(home: string, content: string): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "exclude");
	writeFileSync(path, content);
	return path;
}

function rawContentFor(fixture: ExcludeFixtureCase): string | undefined {
	if (fixture.rulesFileLinesRaw !== undefined) return fixture.rulesFileLinesRaw;
	if (fixture.rulesFileLines !== undefined) return `${fixture.rulesFileLines.join("\n")}\n`;
	return undefined;
}

function findFixture(name: string): ExcludeFixtureCase {
	const found = fixtures.find((f) => f.name === name);
	if (!found) throw new Error(`fixture not found: ${name}`);
	return found;
}

/**
 * The fixture's `cwd`/`home` are illustrative absolute strings, not real
 * paths on this machine — a cwd declared under the fixture's own `home` is
 * rewritten onto the real temp home used by the test, so a `~`-expanding
 * rule (which expands against the REAL home) still lines up with the cwd
 * being evaluated against it. A cwd that doesn't fall under the fixture's
 * declared home (e.g. a bare `/a/...` path, or the real filesystem root)
 * passes through unchanged.
 */
function rewriteUnderHome(
	cwd: string | null | undefined,
	fixtureHome: string | undefined,
	realHome: string,
): string | null {
	if (cwd === undefined || cwd === null) return null;
	if (fixtureHome && cwd.startsWith(fixtureHome)) return realHome + cwd.slice(fixtureHome.length);
	return cwd;
}

function isFixtureApplicable(fixture: ExcludeFixtureCase, platform: NodeJS.Platform): boolean {
	if (fixture.platform === "any") return true;
	if (fixture.platform === "posix") return platform !== "win32";
	return fixture.platform === platform;
}

/** Registration-time coverage tracker: every `dedicated: true` fixture must be named by an actual test, or the suite fails. */
const coveredDedicated = new Set<string>();
function dedicatedTest(name: string, fn: () => void): void {
	coveredDedicated.add(name);
	test(name, fn);
}
function dedicatedSkipIf(condition: boolean, name: string, fn: () => void): void {
	coveredDedicated.add(name);
	test.skipIf(condition)(name, fn);
}

/** Like dedicatedSkipIf, but for a fixture that's genuinely not constructible in this environment at all (not just "wrong platform") — a todo, not a guaranteed failure every time a win32 runner happens to execute it. */
function dedicatedTodo(name: string, reason: string): void {
	coveredDedicated.add(name);
	test.todo(`${name} — ${reason}`, () => {});
}

const isRoot = process.platform !== "win32" && process.getuid?.() === 0;

describe("exclude-cases.json fixture matrix", () => {
	test("contains every named case and holds the count floor", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(75);
		const requiredNames = [
			"exact-match",
			"descendant-match",
			"sibling-prefix-not-excluded",
			"trailing-slash-rule",
			"trailing-slash-cwd",
			"tilde-expansion-rule",
			"symlinked-cwd-into-excluded-dir",
			"symlinked-rule-target",
			"nonexistent-rule-dir",
			"relative-rule-invalid",
			"wildcard-rule-invalid-star",
			"wildcard-rule-invalid-question",
			"wildcard-rule-invalid-bracket-open",
			"wildcard-rule-invalid-bracket-close",
			"nul-byte-rule-invalid",
			"unreadable-file-invalid",
			"oversize-file-invalid",
			"not-owned-file-invalid",
			"missing-file-none",
			"bom-first-line",
			"crlf-line-endings",
			"trailing-spaces-and-tabs",
			"empty-file-none",
			"comment-lines-skipped",
			"blank-lines-skipped",
			"spaces-in-path",
			"quotes-in-path",
			"unicode-in-path",
			"skip-1",
			"skip-true",
			"skip-TRUE",
			"skip-yes",
			"skip-on",
			"skip-empty",
			"skip-0",
			"skip-false",
			"skip-no",
			"skip-2",
			"skip-literal-dollar-agentpulse-skip",
			"skip-literal-braced-dollar-agentpulse-skip",
			"darwin-case-insensitive-volume",
			"win32-case-and-separator",
			"symlink-file-invalid",
			"hardlink-file-invalid",
			"nonregular-file-invalid",
			"group-writable-file-invalid",
			"world-writable-file-invalid",
			"win32-not-owner-invalid",
			"win32-foreign-write-ace-invalid",
			"win32-system-and-admins-ace-valid",
			"root-rule-excludes-deep-cwd",
			"root-rule-excludes-root-cwd",
			"win32-drive-root-rule-excludes-deep-cwd",
			"agentpulse-dir-symlinked-good-target-ok",
			"agentpulse-dir-group-writable-invalid",
			"agentpulse-dir-world-writable-invalid",
			"rule-with-dotdot-invalid",
			"rule-with-dot-segment-invalid",
			"tilde-dotdot-invalid",
			"tilde-dot-segment-invalid",
			"cwd-with-unresolvable-dotdot-no-cwd",
			"symlink-dotdot-kernel-target-excluded",
			"symlink-dotdot-kernel-target-not-excluded-lexical-only",
			"win32-agentpulse-dir-foreign-write-ace-invalid",
			"duplicate-slashes-normalised",
			"symlinked-parent-rule-not-yet-created",
			"darwin-case-mismatch-nonexistent-leaf",
			"darwin-nfc-nfd-mismatch-nonexistent-leaf",
			"bom-trailing-space-tab-cr",
			"exact-cap-size-file-ok",
			"oversize-by-one-byte-invalid",
			"skip-leading-space-1",
			"skip-trailing-newline-1",
			"skip-trailing-space-true",
			"skip-tab-on-crlf",
			"skip-spaced-2",
			"skip-whitespace-only",
		];
		for (const name of requiredNames) {
			expect(
				fixtures.find((f) => f.name === name),
				`missing fixture: ${name}`,
			).toBeDefined();
		}
	});

	test("sibling-prefix-not-excluded runs and evaluates not-excluded", () => {
		const fixture = findFixture("sibling-prefix-not-excluded");
		const home = tempHome();
		try {
			writeRulesFile(home, rawContentFor(fixture) as string);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({
				cwd: fixture.cwd as string,
				skip: undefined,
				rules: loaded,
			});
			expect(result.excluded).toBe(false);
			expect(result.reason).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the literal unexpanded $AGENTPULSE_SKIP is not a skip value", () => {
		const fixture = findFixture("skip-literal-dollar-agentpulse-skip");
		expect(isSkipValue(fixture.skip)).toBe(false);
	});
});

describe("fixture platform gating", () => {
	test("a win32-tagged fixture is inapplicable off win32, and a darwin-tagged fixture is inapplicable off darwin", () => {
		expect(isFixtureApplicable(findFixture("win32-case-and-separator"), "darwin")).toBe(false);
		expect(isFixtureApplicable(findFixture("win32-case-and-separator"), "linux")).toBe(false);
		expect(isFixtureApplicable(findFixture("win32-case-and-separator"), "win32")).toBe(true);
		expect(isFixtureApplicable(findFixture("darwin-case-insensitive-volume"), "win32")).toBe(false);
		expect(isFixtureApplicable(findFixture("darwin-case-insensitive-volume"), "darwin")).toBe(true);
	});

	test("a posix-tagged fixture is inapplicable on win32 only", () => {
		const fixture = findFixture("unreadable-file-invalid");
		expect(isFixtureApplicable(fixture, "win32")).toBe(false);
		expect(isFixtureApplicable(fixture, "darwin")).toBe(true);
		expect(isFixtureApplicable(fixture, "linux")).toBe(true);
	});

	test("every platform-specific, non-dedicated fixture is correctly excluded from this platform's run when inapplicable", () => {
		// Dedicated fixtures are individually test.skipIf-gated (asserted by
		// the "every dedicated fixture is covered" describe block below); this
		// covers the OTHER kind — a platform-specific row that still flows
		// through the generic, data-driven matching loop (e.g. a win32 rule
		// expressed in pure path-string logic, reproducible by a sh/PowerShell
		// harness too) — and checks the loop's own gating actually excludes it
		// here, rather than asserting that path only by inspection.
		const platformSpecificNonDedicated = fixtures.filter(
			(f) => f.platform !== "any" && f.platform !== "posix" && !f.dedicated,
		);
		expect(platformSpecificNonDedicated.length).toBeGreaterThan(0);
		for (const f of platformSpecificNonDedicated) {
			const applicable = isFixtureApplicable(f, process.platform);
			expect(applicable).toBe(f.platform === process.platform);
		}
	});
});

describe("loadExcludeRules", () => {
	test("a missing file returns none, never throws", () => {
		const home = tempHome();
		try {
			expect(() => loadExcludeRules(home)).not.toThrow();
			expect(loadExcludeRules(home)).toEqual({ state: "none", rules: [] });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a valid file strips comments and blanks, keeps the real rule", () => {
		const fixture = findFixture("comment-lines-skipped");
		const home = tempHome();
		try {
			writeRulesFile(home, rawContentFor(fixture) as string);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("ok");
			expect(loaded.rules.map((r) => r.raw)).toEqual(["/a/work"]);
			expect(loaded.resolvedPath).toBe(join(realpathSync.native(home), ".agentpulse", "exclude"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("normalisation order — BOM, CRLF, trailing whitespace, and all four combined are accepted", () => {
		for (const name of [
			"bom-first-line",
			"crlf-line-endings",
			"trailing-spaces-and-tabs",
			"bom-trailing-space-tab-cr",
		]) {
			const fixture = findFixture(name);
			const home = tempHome();
			try {
				writeRulesFile(home, rawContentFor(fixture) as string);
				const loaded = loadExcludeRules(home);
				expect(loaded.state, `${name} should be valid after normalisation`).toBe("ok");
				expect(loaded.rules.map((r) => r.raw)).toEqual(["/a/work"]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		}
	});

	describe("invalid-line cases", () => {
		const invalidLineFixtures = [
			"relative-rule-invalid",
			"wildcard-rule-invalid-star",
			"wildcard-rule-invalid-question",
			"wildcard-rule-invalid-bracket-open",
			"wildcard-rule-invalid-bracket-close",
			"nul-byte-rule-invalid",
			"rule-with-dotdot-invalid",
			"rule-with-dot-segment-invalid",
			"tilde-dotdot-invalid",
			"tilde-dot-segment-invalid",
		];

		for (const name of invalidLineFixtures) {
			test(`${name} → invalid with the 1-based line number`, () => {
				const fixture = findFixture(name);
				const home = tempHome();
				try {
					writeRulesFile(home, rawContentFor(fixture) as string);
					const loaded = loadExcludeRules(home);
					expect(loaded.state).toBe("invalid");
					expect(loaded.line).toBe(fixture.expectedLine ?? 1);
				} finally {
					rmSync(home, { recursive: true, force: true });
				}
			});
		}

		test("a wildcard rule's message suggests the directory without the wildcard", () => {
			const fixture = findFixture("wildcard-rule-invalid-star");
			const home = tempHome();
			try {
				writeRulesFile(home, rawContentFor(fixture) as string);
				const loaded = loadExcludeRules(home);
				expect(loaded.reason).toContain("/a/work");
				expect(loaded.reason?.toLowerCase()).toContain("wildcard");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("a relative rule's message contains its absolute form", () => {
			const fixture = findFixture("relative-rule-invalid");
			const home = tempHome();
			try {
				writeRulesFile(home, rawContentFor(fixture) as string);
				const loaded = loadExcludeRules(home);
				expect(loaded.reason).toContain(join(home, "relative/path"));
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("the NUL-byte line's message names the actual problem", () => {
			const fixture = findFixture("nul-byte-rule-invalid");
			const home = tempHome();
			try {
				writeRulesFile(home, rawContentFor(fixture) as string);
				const loaded = loadExcludeRules(home);
				expect(loaded.reason?.toUpperCase()).toContain("NUL");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	});

	dedicatedSkipIf(isRoot, "unreadable-file-invalid", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			chmodSync(path, 0o000);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("unreadable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("oversize-file-invalid", () => {
		const home = tempHome();
		try {
			const big = `${"/a/work\n".repeat(10000)}`; // well over 64 KiB
			writeRulesFile(home, big);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("64 KiB");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("exact-cap-size-file-ok", () => {
		const home = tempHome();
		try {
			const ruleLine = "/a/work\n";
			const padded = `${ruleLine}#${"x".repeat(MAX_RULES_FILE_BYTES - ruleLine.length - 2)}\n`;
			expect(Buffer.byteLength(padded)).toBe(MAX_RULES_FILE_BYTES);
			writeRulesFile(home, padded);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("ok");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("oversize-by-one-byte-invalid", () => {
		const home = tempHome();
		try {
			const ruleLine = "/a/work\n";
			const padded = `${ruleLine}#${"x".repeat(MAX_RULES_FILE_BYTES - ruleLine.length - 1)}\n`;
			expect(Buffer.byteLength(padded)).toBe(MAX_RULES_FILE_BYTES + 1);
			writeRulesFile(home, padded);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("64 KiB");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// Simulates a foreign-owned file by injecting a fake current-uid rather
	// than requiring root to actually chown the file — the file's real owner
	// (this test process) never changes.
	dedicatedTest("not-owned-file-invalid", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const loaded = loadExcludeRules(home, { getuid: () => 999999 });
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("owned");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// A real-ownership version of the same case, for when root actually is
	// available (stronger integration evidence than the injected version
	// above gives, but not required for the fixture's coverage).
	(isRoot ? test : test.skip)(
		"a file not owned by the current user is invalid (real chown, root only)",
		() => {
			const home = tempHome();
			try {
				const path = writeRulesFile(home, "/a/work\n");
				chownSync(path, 1, 1);
				const loaded = loadExcludeRules(home);
				expect(loaded.state).toBe("invalid");
				expect(loaded.reason).toContain("owned");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	dedicatedTest("symlink-file-invalid", () => {
		const home = tempHome();
		try {
			const real = join(home, "real-exclude");
			writeFileSync(real, "/a/work\n");
			const path = join(home, ".agentpulse");
			mkdirSync(path, { recursive: true });
			symlinkSync(real, join(path, "exclude"));
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("symlink");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("hardlink-file-invalid", () => {
		const home = tempHome();
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(dir, { recursive: true });
			const original = join(dir, "original");
			writeFileSync(original, "/a/work\n");
			linkSync(original, join(dir, "exclude"));
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("hardlink");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("nonregular-file-invalid", () => {
		const home = tempHome();
		try {
			const dir = join(home, ".agentpulse");
			mkdirSync(join(dir, "exclude"), { recursive: true }); // a directory, not a regular file
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("regular file");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("group-writable-file-invalid", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			chmodSync(path, 0o620); // owner rw, group -w- (the write bit, not read)
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("writable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("world-writable-file-invalid", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			chmodSync(path, 0o602); // owner rw, other -w- (the write bit, not read)
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("writable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-symlinked-good-target-ok", () => {
		const home = tempHome();
		try {
			const realDir = join(home, "real-agentpulse");
			mkdirSync(realDir, { recursive: true, mode: 0o700 });
			chmodSync(realDir, 0o700);
			writeFileSync(join(realDir, "exclude"), "/a/work\n");
			symlinkSync(realDir, join(home, ".agentpulse"));
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("ok");
			expect(loaded.resolvedPath).toBe(join(realpathSync.native(realDir), "exclude"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-group-writable-invalid", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			chmodSync(join(home, ".agentpulse"), 0o770);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain(".agentpulse");
			expect(loaded.reason).toContain("writable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("agentpulse-dir-world-writable-invalid", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			chmodSync(join(home, ".agentpulse"), 0o707);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain(".agentpulse");
			expect(loaded.reason).toContain("writable");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(process.platform === "win32", "agentpulse-dir-dangling-symlink-invalid", () => {
		const home = tempHome();
		try {
			symlinkSync(join(home, "nowhere"), join(home, ".agentpulse"));
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain(".agentpulse");
			expect(evaluateExclusion({ cwd: home, skip: undefined, rules: loaded }).reason).toBe(
				"rules_invalid",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(process.platform === "win32", "agentpulse-dir-looping-symlink-invalid", () => {
		const home = tempHome();
		try {
			symlinkSync(join(home, ".agentpulse"), join(home, ".agentpulse"));
			expect(loadExcludeRules(home).state).toBe("invalid");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(
		isRoot || process.platform === "win32",
		"home-ancestor-unsearchable-invalid",
		() => {
			const outer = tempHome();
			try {
				const home = join(outer, "locked", "home");
				mkdirSync(home, { recursive: true });
				chmodSync(join(outer, "locked"), 0o000);
				expect(loadExcludeRules(home).state).toBe("invalid");
				chmodSync(join(outer, "locked"), 0o700);
			} finally {
				chmodSync(join(outer, "locked"), 0o700);
				rmSync(outer, { recursive: true, force: true });
			}
		},
	);

	test("a missing ~/.agentpulse (and a missing home) is still plain 'no rules', not invalid", () => {
		const home = tempHome();
		try {
			expect(loadExcludeRules(home).state).toBe("none");
			expect(loadExcludeRules(join(home, "no-such-home")).state).toBe("none");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The ok-state needs the POSIX owner and mode checks to pass; the platform-independent
	// part of the cap is covered by the two fixture rows in every evaluator, Windows included.
	test.skipIf(process.platform === "win32")(
		"a file with more than 500 rules is invalid, and the reason says why; exactly 500 is fine",
		() => {
			const home = tempHome();
			try {
				const lines = (n: number) =>
					`${Array.from({ length: n }, (_, i) => `/a/r${i}`).join("\n")}\n`;
				writeRulesFile(home, lines(500));
				chmodSync(join(home, ".agentpulse", "exclude"), 0o600);
				chmodSync(join(home, ".agentpulse"), 0o700);
				expect(loadExcludeRules(home).state).toBe("ok");
				writeRulesFile(home, lines(501));
				const over = loadExcludeRules(home);
				expect(over.state).toBe("invalid");
				expect(over.reason).toContain("more than 500 rules");
				expect(over.reason).toContain("every hook event");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"comments and blank lines don't count towards the 500",
		() => {
			const home = tempHome();
			try {
				const body = `${Array.from({ length: 500 }, (_, i) => `/a/r${i}\n\n# note ${i}`).join("\n")}\n`;
				writeRulesFile(home, body);
				chmodSync(join(home, ".agentpulse", "exclude"), 0o600);
				chmodSync(join(home, ".agentpulse"), 0o700);
				expect(loadExcludeRules(home).state).toBe("ok");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"setInvalidMarker(off) clears a stale marker in a trusted directory and leaves it in a group-writable one",
		() => {
			const home = tempHome();
			try {
				const dir = join(home, ".agentpulse");
				mkdirSync(dir, { mode: 0o700 });
				chmodSync(dir, 0o700);
				const marker = join(dir, "exclude.invalid");
				writeFileSync(marker, "");
				expect(setInvalidMarker(home, false)).toBe(true);
				expect(existsSync(marker)).toBe(false);

				writeFileSync(marker, "");
				chmodSync(dir, 0o770);
				expect(setInvalidMarker(home, false)).toBe(false);
				expect(existsSync(marker), "an untrusted directory's marker is not ours to remove").toBe(
					true,
				);
				chmodSync(dir, 0o700);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	// Simulates a TOCTOU swap: the fstat the implementation runs on the
	// just-opened descriptor reports a different inode than the lstat it
	// took beforehand, as if the file had been replaced in between. Must be
	// caught as invalid, not silently treated as "none" or read through.
	// Not backed by a matrix fixture — the matrix describes evaluator
	// outcomes a sh/PowerShell harness can reproduce; this one is specific to
	// this module's own TOCTOU-hardening internals (the fs provider
	// injection), which those harnesses have no equivalent of.
	test("a descriptor swapped between lstat and fstat is invalid, not silently read", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			const fakeFstat = (fd: number): StatLike => {
				const real = fstatSync(fd);
				return {
					dev: real.dev,
					ino: real.ino + 1,
					nlink: real.nlink,
					uid: real.uid,
					mode: real.mode,
					size: real.size,
					mtimeMs: real.mtimeMs,
					isSymbolicLink: () => real.isSymbolicLink(),
					isFile: () => real.isFile(),
					isDirectory: () => real.isDirectory(),
				};
			};
			const result = loadExcludeRules(home, { fstat: fakeFstat });
			expect(result.state).toBe("invalid");
			expect(result.reason).toContain("changed");
			expect(path).toBeTruthy();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the documented fs-call bound: one lstat for the file, one open, one fstat, one read, and one realpath per rule plus one for the directory", () => {
		const home = tempHome();
		try {
			const realDirs = ["rule-a", "rule-b", "rule-c"].map((name) => {
				const d = join(home, name);
				mkdirSync(d, { recursive: true });
				return d;
			});
			writeRulesFile(home, `${realDirs.join("\n")}\n`);

			const counts = { lstat: 0, open: 0, fstat: 0, readFd: 0, close: 0, getuid: 0, realpath: 0 };
			const result = loadExcludeRules(home, {
				lstat: (p) => {
					counts.lstat++;
					return lstatSync(p);
				},
				open: (p) => {
					counts.open++;
					return openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
				},
				fstat: (fd) => {
					counts.fstat++;
					return fstatSync(fd);
				},
				readFd: (fd) => {
					counts.readFd++;
					return readFileSync(fd, "utf-8");
				},
				close: (fd) => {
					counts.close++;
					closeSync(fd);
				},
				getuid: () => {
					counts.getuid++;
					return process.getuid?.();
				},
				realpath: (p) => {
					counts.realpath++;
					return realpathSync.native(p);
				},
			});

			expect(result.state).toBe("ok");
			expect(result.rules.length).toBe(3);
			expect(counts.lstat).toBe(2); // the .agentpulse directory, then the file
			expect(counts.open).toBe(1);
			expect(counts.fstat).toBe(1);
			expect(counts.readFd).toBe(1);
			expect(counts.close).toBe(1);
			expect(counts.getuid).toBe(1);
			expect(counts.realpath).toBe(4); // the directory, plus one per rule (all three exist, so one call each — no retries needed)
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// A real construction needs the file created and owned by a SECOND
	// Windows account, which a single-account CI runner can't do
	// non-destructively — this is a todo, not a guaranteed failure, because
	// unlike a wrong-platform skip (temporary, resolves itself on the right
	// host) this precondition can never be met on a single-account runner at
	// all. The decision logic itself (owner mismatch) has full,
	// platform-independent coverage below via evaluateWindowsSecurity's own
	// unit tests.
	dedicatedTodo(
		"win32-not-owner-invalid",
		"not constructible on a single-account Windows runner; see evaluateWindowsSecurity's own tests for the decision logic",
	);

	dedicatedSkipIf(process.platform !== "win32", "win32-foreign-write-ace-invalid", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "/a/work\n");
			execFileSync("icacls", [path, "/inheritance:r", "/grant:r", "Everyone:(W)"], {
				stdio: "ignore",
			});
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("invalid");
			expect(loaded.reason).toContain("write access");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The directory check reuses the same ACL evaluation
	// as the file check — this proves it's actually wired up on the
	// `.agentpulse` directory itself, not just the file inside it.
	dedicatedSkipIf(
		process.platform !== "win32",
		"win32-agentpulse-dir-foreign-write-ace-invalid",
		() => {
			const home = tempHome();
			try {
				writeRulesFile(home, "/a/work\n");
				const dirPath = join(home, ".agentpulse");
				execFileSync("icacls", [dirPath, "/inheritance:r", "/grant:r", "Everyone:(W)"], {
					stdio: "ignore",
				});
				const loaded = loadExcludeRules(home);
				expect(loaded.state).toBe("invalid");
				expect(loaded.reason).toContain(".agentpulse");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	dedicatedSkipIf(process.platform !== "win32", "win32-system-and-admins-ace-valid", () => {
		const home = tempHome();
		try {
			const path = writeRulesFile(home, "C:\\Users\\alice\\work\n");
			const username = process.env.USERNAME || "";
			execFileSync(
				"icacls",
				[
					path,
					"/inheritance:r",
					"/grant:r",
					`${username}:(R,W)`,
					"/grant:r",
					"SYSTEM:(F)",
					"/grant:r",
					"Administrators:(F)",
				],
				{ stdio: "ignore" },
			);
			const loaded = loadExcludeRules(home);
			expect(loaded.state).toBe("ok");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("setInvalidMarker creates and removes the marker file", () => {
		const home = tempHome();
		try {
			mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
			chmodSync(join(home, ".agentpulse"), 0o700);
			const markerPath = join(home, ".agentpulse", "exclude.invalid");
			expect(existsSync(markerPath)).toBe(false);
			setInvalidMarker(home, true);
			expect(existsSync(markerPath)).toBe(true);
			setInvalidMarker(home, false);
			expect(existsSync(markerPath)).toBe(false);
			expect(() => setInvalidMarker(home, false)).not.toThrow();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("evaluateExclusion — matching semantics", () => {
	const matchable = fixtures.filter((f) => !f.dedicated && f.cwd !== undefined);

	test("the matching fixture set is non-trivially large", () => {
		expect(matchable.length).toBeGreaterThanOrEqual(20);
	});

	for (const fixture of matchable) {
		test.skipIf(!isFixtureApplicable(fixture, process.platform))(fixture.name, () => {
			const home = tempHome();
			try {
				const content = rawContentFor(fixture);
				if (content !== undefined) writeRulesFile(home, content);
				const loaded = loadExcludeRules(home);
				const effectiveCwd = rewriteUnderHome(fixture.cwd, fixture.home, home);
				const result = evaluateExclusion({ cwd: effectiveCwd, skip: undefined, rules: loaded });
				expect(result.excluded).toBe(fixture.expected.excluded);
				expect(result.reason).toBe(fixture.expected.reason ?? null);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}

	dedicatedTest("symlinked-cwd-into-excluded-dir", () => {
		const home = tempHome();
		try {
			const real = join(home, "work");
			mkdirSync(real, { recursive: true });
			const link = join(home, "work-link");
			symlinkSync(real, link);
			writeRulesFile(home, `${real}\n`);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd: link, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("symlinked-rule-target", () => {
		const home = tempHome();
		try {
			const real = join(home, "real-target");
			mkdirSync(real, { recursive: true });
			const link = join(home, "work-link");
			symlinkSync(real, link);
			writeRulesFile(home, `${link}\n`);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd: real, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedTest("symlinked-parent-rule-not-yet-created", () => {
		const home = tempHome();
		try {
			const realParent = join(home, "real-parent");
			mkdirSync(realParent, { recursive: true });
			const linkedParent = join(home, "linked-parent");
			symlinkSync(realParent, linkedParent);
			const rule = join(linkedParent, "not-yet-created");
			const cwd = join(rule, "sub");
			writeRulesFile(home, `${rule}\n`);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The scenario the module docstring names: `a/link` -> `b/c` (the
	// symlink's own apparent parent, `a`, differs from its target's real
	// parent, `b`). cwd = `a/link/../x`. The KERNEL resolves this to `b/x`
	// (exit the symlink's real target, then apply ".."); a purely lexical
	// reading — collapsing "link/.." as if "link" were a real directory —
	// would wrongly conclude `a/x`. Both directions are asserted from the
	// same construction: excluded by a rule for the kernel's real answer,
	// NOT excluded by a rule for the lexical-only (wrong) answer.
	(() => {
		function buildScenario(home: string): { cwd: string } {
			const a = join(home, "a");
			const b = join(home, "b");
			const c = join(b, "c");
			mkdirSync(a, { recursive: true });
			mkdirSync(c, { recursive: true });
			mkdirSync(join(b, "x"), { recursive: true }); // so realpath of the whole cwd succeeds
			symlinkSync(c, join(a, "link"));
			// Built by string concatenation, not path.join/path.resolve — both
			// would lexically collapse the ".." themselves before this test
			// ever got to exercise the implementation's own handling of it.
			return { cwd: `${a}/link/../x` };
		}

		dedicatedTest("symlink-dotdot-kernel-target-excluded", () => {
			const home = tempHome();
			try {
				const { cwd } = buildScenario(home);
				writeRulesFile(home, `${join(home, "b")}\n`); // the kernel's real target's parent
				const loaded = loadExcludeRules(home);
				const result = evaluateExclusion({ cwd, skip: undefined, rules: loaded });
				expect(result.excluded).toBe(true);
				expect(result.reason).toBe("path");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		dedicatedTest("symlink-dotdot-kernel-target-not-excluded-lexical-only", () => {
			const home = tempHome();
			try {
				const { cwd } = buildScenario(home);
				writeRulesFile(home, `${join(home, "a")}\n`); // only the WRONG lexical answer's parent
				const loaded = loadExcludeRules(home);
				const result = evaluateExclusion({ cwd, skip: undefined, rules: loaded });
				expect(result.excluded).toBe(false);
				expect(result.reason).toBeNull();
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	})();

	dedicatedSkipIf(process.platform !== "darwin", "darwin-case-insensitive-volume", () => {
		const home = tempHome();
		try {
			const real = join(home, "Work");
			mkdirSync(real, { recursive: true });
			writeRulesFile(home, `${real}\n`);
			const loaded = loadExcludeRules(home);
			const variantCwd = join(home.toLowerCase(), "WORK", "sub");
			mkdirSync(join(real, "sub"), { recursive: true });
			const result = evaluateExclusion({ cwd: variantCwd, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(process.platform !== "darwin", "darwin-case-mismatch-nonexistent-leaf", () => {
		const home = tempHome();
		try {
			// Neither "Work" nor "work" is ever created — only `home` itself
			// (the ancestor both resolve to) exists, so neither side's leaf
			// case can be filesystem-corrected. Under the explicit
			// case-insensitive-on-macOS comparison policy, a rule and a cwd
			// differing only in that unresolved leaf's case now DO match —
			// this used to be a TypeScript-only gap (no filesystem signal to
			// resolve it by), closed by comparing case-insensitively
			// regardless of whether anything on disk exists to probe.
			const rule = join(home, "Work");
			const cwd = join(home, "work", "sub");
			writeRulesFile(home, `${rule}\n`);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(process.platform !== "darwin", "darwin-nfc-nfd-mismatch-nonexistent-leaf", () => {
		const home = tempHome();
		try {
			const rule = join(home, "caf\u00e9"); // NFC: e with U+00E9
			const cwd = join(home, "cafe\u0301", "sub"); // NFD: e + U+0301
			writeRulesFile(home, `${rule}\n`);
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(false);
			expect(result.reason).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	dedicatedSkipIf(process.platform !== "win32", "win32-case-and-separator", () => {
		const home = tempHome();
		try {
			const real = join(home, "Work");
			mkdirSync(real, { recursive: true });
			writeRulesFile(home, `${real}\n`);
			const loaded = loadExcludeRules(home);
			mkdirSync(join(real, "sub"), { recursive: true });
			const variantCwd = `${real.toLowerCase().replace(/\\/g, "/")}/sub`;
			const result = evaluateExclusion({ cwd: variantCwd, skip: undefined, rules: loaded });
			expect(result.excluded).toBe(true);
			expect(result.reason).toBe("path");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("evaluateExclusion never throws, even fed each fixture's rule line as a cwd", () => {
		for (const fixture of fixtures) {
			if (fixture.cwd === undefined && fixture.rulesFileLines === undefined) continue;
			const home = tempHome();
			try {
				const content = rawContentFor(fixture);
				if (content !== undefined) writeRulesFile(home, content);
				const loaded = loadExcludeRules(home);
				const probeCwd = fixture.rulesFileLines?.[0] ?? fixture.cwd ?? null;
				expect(() =>
					evaluateExclusion({ cwd: probeCwd, skip: undefined, rules: loaded }),
				).not.toThrow();
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		}
	});

	test("precedence — skip beats path rules beats included", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const loaded = loadExcludeRules(home);

			const skipped = evaluateExclusion({ cwd: "/a/elsewhere", skip: "1", rules: loaded });
			expect(skipped).toEqual({ excluded: true, reason: "env" });

			const pathExcluded = evaluateExclusion({ cwd: "/a/work/sub", skip: "", rules: loaded });
			expect(pathExcluded.excluded).toBe(true);
			expect(pathExcluded.reason).toBe("path");

			const included = evaluateExclusion({ cwd: "/a/elsewhere", skip: "", rules: loaded });
			expect(included).toEqual({ excluded: false, reason: null });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an empty-string cwd is treated as unknown (no_cwd) when rules exist", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd: "", skip: undefined, rules: loaded });
			expect(result).toEqual({ excluded: true, reason: "no_cwd" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a relative cwd is treated as unknown (no_cwd) when rules exist", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const loaded = loadExcludeRules(home);
			const result = evaluateExclusion({ cwd: "relative/dir", skip: undefined, rules: loaded });
			expect(result).toEqual({ excluded: true, reason: "no_cwd" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an empty-string or relative cwd is NOT excluded when there are no rules", () => {
		const home = tempHome();
		try {
			const loaded = loadExcludeRules(home); // no file written — state "none"
			expect(evaluateExclusion({ cwd: "", skip: undefined, rules: loaded })).toEqual({
				excluded: false,
				reason: null,
			});
			expect(evaluateExclusion({ cwd: "relative/dir", skip: undefined, rules: loaded })).toEqual({
				excluded: false,
				reason: null,
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("isSkipHeaderValue — the header form of the allowlist", () => {
	test("accepts exactly what isSkipValue accepts, up to the cap", () => {
		for (const v of ["1", "true", "YES", "On", " \t1\r\n"]) {
			expect(isSkipHeaderValue(v), JSON.stringify(v)).toBe(true);
		}
		for (const v of ["", "0", "false", "off", "$AGENTPULSE_SKIP", null, undefined]) {
			expect(isSkipHeaderValue(v), String(v)).toBe(false);
		}
	});

	test("a value longer than the cap is not looked at, even when it would be allowlisted once trimmed", () => {
		const padded = `${" ".repeat(SKIP_HEADER_MAX_LENGTH)}1`;
		expect(padded.length).toBe(SKIP_HEADER_MAX_LENGTH + 1);
		expect(isSkipValue(padded)).toBe(true);
		expect(isSkipHeaderValue(padded)).toBe(false);
		expect(isSkipHeaderValue(`${" ".repeat(SKIP_HEADER_MAX_LENGTH - 1)}1`)).toBe(true);
	});
});

describe("isSkipValue", () => {
	const skipFixtures = fixtures.filter((f) => f.expectedSkip !== undefined);

	test("at least 18 skip-value fixtures are present", () => {
		expect(skipFixtures.length).toBeGreaterThanOrEqual(18);
	});

	for (const fixture of skipFixtures) {
		const expectedSkip = fixture.expectedSkip as boolean;
		test(`${fixture.name}`, () => {
			expect(isSkipValue(fixture.skip)).toBe(expectedSkip);
		});
	}

	test("undefined and null are not skip values", () => {
		expect(isSkipValue(undefined)).toBe(false);
		expect(isSkipValue(null)).toBe(false);
	});
});

describe("evaluateWindowsSecurity (pure, runs on every platform)", () => {
	const currentUserSid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
	const otherUserSid = "S-1-5-21-1111111111-2222222222-3333333333-1002";
	const SYSTEM_SID = "S-1-5-18";
	const ADMINISTRATORS_SID = "S-1-5-32-544";

	test("a directory made on a CI runner: the user, SYSTEM and Administrators each hold an inherited full-control ACE, and the owner is the user or Administrators — valid", () => {
		const threeAces = [
			{
				principalSid: currentUserSid,
				rights: "FullControl",
				type: "Allow" as const,
				isInherited: true,
			},
			{
				principalSid: SYSTEM_SID,
				rights: "FullControl",
				type: "Allow" as const,
				isInherited: true,
			},
			{
				principalSid: ADMINISTRATORS_SID,
				rights: "FullControl",
				type: "Allow" as const,
				isInherited: true,
			},
		];
		for (const ownerSid of [currentUserSid, ADMINISTRATORS_SID, SYSTEM_SID]) {
			expect(
				evaluateWindowsSecurity({ ownerSid, aces: threeAces }, currentUserSid),
				ownerSid,
			).toEqual({ valid: true });
		}
	});

	test("the same three ACEs plus one write ACE for anyone else are invalid", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [
					{ principalSid: currentUserSid, rights: "FullControl", type: "Allow", isInherited: true },
					{ principalSid: SYSTEM_SID, rights: "FullControl", type: "Allow", isInherited: true },
					{
						principalSid: ADMINISTRATORS_SID,
						rights: "FullControl",
						type: "Allow",
						isInherited: true,
					},
					{ principalSid: "S-1-5-11", rights: "Modify", type: "Allow", isInherited: true },
				],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reason).toContain("S-1-5-11");
	});

	test("owner SID mismatch is invalid", () => {
		const verdict = evaluateWindowsSecurity({ ownerSid: otherUserSid, aces: [] }, currentUserSid);
		expect(verdict.valid).toBe(false);
		expect(verdict.reason).toContain(otherUserSid);
	});

	test("an owner SID that can't be translated is never exempt", () => {
		const verdict = evaluateWindowsSecurity({ ownerSid: null, aces: [] }, currentUserSid);
		expect(verdict.valid).toBe(false);
	});

	const writeCapableRightNames = [
		"WriteData",
		"AppendData",
		"WriteAttributes",
		"WriteExtendedAttributes",
		"WriteDac",
		"ChangePermissions",
		"WriteOwner",
		"TakeOwnership",
		"Delete",
		"DeleteSubdirectoriesAndFiles",
		"Modify",
		"FullControl",
		"Write",
		"GenericWrite",
		"GenericAll",
	];

	for (const rights of writeCapableRightNames) {
		test(`a write ACE naming ${rights} for a non-exempt SID is invalid`, () => {
			const verdict = evaluateWindowsSecurity(
				{
					ownerSid: currentUserSid,
					aces: [{ principalSid: otherUserSid, rights, type: "Allow" }],
				},
				currentUserSid,
			);
			expect(verdict.valid).toBe(false);
			expect(verdict.reason).toContain(otherUserSid);
		});
	}

	for (const rights of ["ReadAndExecute", "Read", "Synchronize"]) {
		test(`a read-only ACE naming ${rights} stays valid`, () => {
			const verdict = evaluateWindowsSecurity(
				{
					ownerSid: currentUserSid,
					aces: [{ principalSid: otherUserSid, rights, type: "Allow" }],
				},
				currentUserSid,
			);
			expect(verdict.valid).toBe(true);
		});
	}

	test("a comma-separated combined rights value with one write-capable name is invalid", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: otherUserSid, rights: "ReadAndExecute, Write", type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
	});

	test("a comma-separated combination of only read-only names stays valid", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [
					{ principalSid: otherUserSid, rights: "ReadAndExecute, Synchronize", type: "Allow" },
				],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(true);
	});

	test("a numeric mask with a write-capable bit set is invalid", () => {
		const fullControlMask = "2032127"; // 0x1F01FF
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: otherUserSid, rights: fullControlMask, type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
	});

	test("a numeric mask with only read-capable bits set stays valid", () => {
		const readMask = "131209"; // 0x20089 (ReadData|ReadExtendedAttributes|ReadAttributes|ReadPermissions)
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: otherUserSid, rights: readMask, type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(true);
	});

	test("write ACEs only for the owner, SYSTEM and Administrators SIDs are ok", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [
					{ principalSid: currentUserSid, rights: "FullControl", type: "Allow" },
					{ principalSid: SYSTEM_SID, rights: "FullControl", type: "Allow" },
					{ principalSid: ADMINISTRATORS_SID, rights: "FullControl", type: "Allow" },
				],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(true);
	});

	test("a deny ACE for a non-exempt SID does not itself make the file invalid", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: otherUserSid, rights: "Write", type: "Deny" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(true);
	});

	test("an inherited write ACE for a non-exempt SID is still invalid", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: otherUserSid, rights: "Write", type: "Allow", isInherited: true }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
	});

	test("an ACE whose principal can't be translated to a SID is never exempt", () => {
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: null, rights: "Write", type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
	});

	test("a localized Administrators group name is irrelevant — only its SID matters", () => {
		// Display names aren't part of WindowsAce at all any more (matching
		// is SID-only) — this fixture exists to document that a localized
		// name like "Administradores" or "Administrateurs" needs no special
		// casing, since only principalSid is ever consulted.
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: ADMINISTRATORS_SID, rights: "FullControl", type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(true);
	});

	test("a group literally named Administrators but with a different SID is NOT exempt", () => {
		// The point of matching by SID: a custom group that happens to be
		// named "Administrators" (principalSid below is an arbitrary,
		// non-built-in SID) must not be exempted just because of its name —
		// evaluateWindowsSecurity never sees display names at all, so this
		// is really a restatement that the exemption set is exactly
		// {currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID}.
		const impersonatingSid = "S-1-5-21-9999999999-8888888888-7777777777-5000";
		const verdict = evaluateWindowsSecurity(
			{
				ownerSid: currentUserSid,
				aces: [{ principalSid: impersonatingSid, rights: "FullControl", type: "Allow" }],
			},
			currentUserSid,
		);
		expect(verdict.valid).toBe(false);
	});
});

describe("isWindowsAbsolutePath (pure, runs on every platform)", () => {
	test("accepts a drive root and a deeper path, backslash or forward slash", () => {
		expect(isWindowsAbsolutePath("C:\\")).toBe(true);
		expect(isWindowsAbsolutePath("C:/")).toBe(true);
		expect(isWindowsAbsolutePath("C:\\Users\\alice\\work")).toBe(true);
		expect(isWindowsAbsolutePath("C:/Users/alice/work")).toBe(true);
	});

	test("rejects a bare drive letter — Windows reads it as the current directory on that drive", () => {
		expect(isWindowsAbsolutePath("C:")).toBe(false);
	});

	test("rejects a drive-relative path", () => {
		expect(isWindowsAbsolutePath("C:foo")).toBe(false);
		expect(isWindowsAbsolutePath("C:Users\\alice")).toBe(false);
	});

	test("rejects a UNC path", () => {
		expect(isWindowsAbsolutePath("\\\\server\\share")).toBe(false);
		expect(isWindowsAbsolutePath("\\\\server\\share\\dir")).toBe(false);
	});

	test("rejects a plain relative path", () => {
		expect(isWindowsAbsolutePath("relative\\path")).toBe(false);
	});
});

describe("Windows drive-root path handling (pure, runs on every platform via an injected provider)", () => {
	// A splitter bug once collapsed a drive root to the bare string "C:",
	// which Windows reads as "current directory on drive C", not the root —
	// these pin the fix at the path-algebra level, with an identity
	// realpath provider so the whole thing runs on any host, not only a
	// real Windows machine.
	const identityProvider = mergeProvider({ realpath: (p: string) => p });

	test("a drive root collapses to 'C:/' (with the separator), never bare 'C:'", () => {
		expect(collapseSeparators("C:\\")).toBe("C:/");
		expect(collapseSeparators("C:/")).toBe("C:/");
		expect(isRootPath(collapseSeparators("C:\\"))).toBe(true);
		expect(isRootPath("C:")).toBe(false);
	});

	test("a root rule excludes a deep cwd on the same drive", () => {
		const rule = normalizeForCompare(collapseSeparators("C:\\"));
		const cwd = normalizeForCompare(
			resolvePhysicalPath("C:\\Users\\alice\\work", identityProvider),
		);
		expect(matchesRule(cwd, rule)).toBe(true);
	});

	test("a root rule excludes the drive root cwd itself", () => {
		const rule = normalizeForCompare(collapseSeparators("C:\\"));
		const cwd = normalizeForCompare(resolvePhysicalPath("C:\\", identityProvider));
		expect(cwd).toBe("c:/");
		expect(matchesRule(cwd, rule)).toBe(true);
	});

	test("a dotted cwd on a drive resolves through the drive-root prefix correctly", () => {
		// The walk's starting point (realpath(prefix)) must itself be the
		// well-formed "C:/" root, not the bare "C:" the old splitter
		// produced — otherwise the very first realpath call in the walk is
		// already wrong before any segment is even applied.
		const resolved = resolveStepByStep("C:\\Users\\alice\\temp\\..\\work", identityProvider);
		expect(resolved).toBe("C:/Users/alice/work");
	});

	test("a rule on one drive does not match a cwd on another drive", () => {
		const rule = normalizeForCompare(collapseSeparators("D:\\"));
		const cwd = normalizeForCompare(
			resolvePhysicalPath("C:\\Users\\alice\\work", identityProvider),
		);
		expect(matchesRule(cwd, rule)).toBe(false);
	});
});

describe("every dedicated fixture is covered by a real, registered test", () => {
	test("the dedicated fixture set equals the registered-coverage set", () => {
		const dedicatedNames = fixtures.filter((f) => f.dedicated).map((f) => f.name);
		expect(dedicatedNames.length).toBeGreaterThan(0);
		for (const name of dedicatedNames) {
			expect(coveredDedicated.has(name), `dedicated fixture "${name}" has no registered test`).toBe(
				true,
			);
		}
		for (const name of coveredDedicated) {
			expect(
				dedicatedNames,
				`test "${name}" is registered as dedicated coverage but no fixture is tagged dedicated:true with that name`,
			).toContain(name);
		}
	});
});

describe("normalizeForCompare — platform case policy (pure, runs on every host)", () => {
	test("darwin folds ASCII case only", () => {
		expect(normalizeForCompare("/Vol/Alice/Work", "darwin")).toBe("/vol/alice/work");
		// Non-ASCII case folding is a documented limitation: the sh snippet can't do it portably.
		expect(normalizeForCompare("/a/\u00c9t\u00e9", "darwin")).toBe("/a/\u00c9t\u00e9");
	});

	test("win32 folds case and normalises separators, even for a POSIX-shaped value", () => {
		expect(normalizeForCompare("C:\\Vol\\Alice\\Work", "win32")).toBe("c:/vol/alice/work");
		expect(normalizeForCompare("/Vol/Alice", "win32")).toBe("/vol/alice");
	});

	test("linux compares case-sensitively", () => {
		expect(normalizeForCompare("/Vol/Alice/Work", "linux")).toBe("/Vol/Alice/Work");
	});

	test("a drive-letter value is Windows-resolved whatever the host says", () => {
		expect(normalizeForCompare("C:\\Vol\\Alice", "linux")).toBe("c:/vol/alice");
	});
});

const posixOnly = process.platform === "win32";

describe("setInvalidMarker — never writes through a link or into an untrusted directory", () => {
	function trustedDir(home: string, mode = 0o700): string {
		const dir = join(home, ".agentpulse");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, mode);
		return dir;
	}

	test.skipIf(posixOnly)(
		"a marker path that is a symlink is left alone: the target keeps its content",
		() => {
			const home = tempHome();
			try {
				const dir = trustedDir(home);
				const victim = join(home, "victim.txt");
				writeFileSync(victim, "precious");
				symlinkSync(victim, join(dir, "exclude.invalid"));
				expect(setInvalidMarker(home, true)).toBe(false);
				expect(readFileSync(victim, "utf-8")).toBe("precious");
				expect(lstatSync(join(dir, "exclude.invalid")).isSymbolicLink()).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(posixOnly)(
		"a group-writable directory gets no marker, and a planted link keeps its target intact",
		() => {
			const home = tempHome();
			try {
				const dir = trustedDir(home, 0o770);
				const victim = join(home, "victim.txt");
				writeFileSync(victim, "precious");
				symlinkSync(victim, join(dir, "exclude.invalid"));
				expect(setInvalidMarker(home, true)).toBe(false);
				expect(readFileSync(victim, "utf-8")).toBe("precious");

				rmSync(join(dir, "exclude.invalid"));
				expect(setInvalidMarker(home, true)).toBe(false);
				expect(existsSync(join(dir, "exclude.invalid"))).toBe(false);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(posixOnly)("a trusted directory with no marker gets one (positive control)", () => {
		const home = tempHome();
		try {
			const dir = trustedDir(home);
			expect(setInvalidMarker(home, true)).toBe(true);
			expect(lstatSync(join(dir, "exclude.invalid")).isFile()).toBe(true);
			expect(setInvalidMarker(home, true)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test.skipIf(posixOnly)("a missing directory is not created just to hold a marker", () => {
		const home = tempHome();
		try {
			expect(setInvalidMarker(home, true)).toBe(false);
			expect(existsSync(join(home, ".agentpulse"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("loadExcludeRules — only 'not found' means 'no rules'", () => {
	test.skipIf(posixOnly || isRoot)("an unsearchable .agentpulse directory is invalid", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const dir = join(home, ".agentpulse");
			chmodSync(dir, 0o000);
			const loaded = loadExcludeRules(home);
			chmodSync(dir, 0o700);
			expect(loaded.state).toBe("invalid");
			const result = evaluateExclusion({ cwd: "/somewhere", skip: undefined, rules: loaded });
			expect(result).toEqual({ excluded: true, reason: "rules_invalid" });
		} finally {
			chmodSync(join(home, ".agentpulse"), 0o700);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a lookup error other than not-found on the rules file is invalid", () => {
		const home = tempHome();
		try {
			writeRulesFile(home, "/a/work\n");
			const real = mergeProvider({});
			for (const code of ["EACCES", "EIO", "ELOOP"]) {
				const loaded = loadExcludeRules(home, {
					lstat: (path) => {
						if (/[\\/]exclude$/.test(path)) {
							throw Object.assign(new Error(code), { code });
						}
						return real.lstat(path);
					},
				});
				expect(loaded.state, code).toBe("invalid");
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("not-found and not-a-directory on the rules file both mean none", () => {
		const home = tempHome();
		try {
			mkdirSync(join(home, ".agentpulse"), { recursive: true });
			const real = mergeProvider({});
			for (const code of ["ENOENT", "ENOTDIR"]) {
				const loaded = loadExcludeRules(home, {
					lstat: (path) => {
						if (/[\\/]exclude$/.test(path)) throw Object.assign(new Error(code), { code });
						return real.lstat(path);
					},
				});
				expect(loaded.state, code).toBe("none");
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test.skipIf(posixOnly)(
		"an untrusted directory with no rules file is none (matches the shell, which never looks)",
		() => {
			const home = tempHome();
			try {
				const dir = join(home, ".agentpulse");
				mkdirSync(dir, { recursive: true });
				chmodSync(dir, 0o770);
				expect(loadExcludeRules(home).state).toBe("none");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(posixOnly)(
		"a symlinked .agentpulse whose target is group- or world-writable is invalid",
		() => {
			for (const mode of [0o770, 0o707]) {
				const home = tempHome();
				try {
					const real = join(home, "real-agentpulse");
					mkdirSync(real, { recursive: true });
					writeFileSync(join(real, "exclude"), "/a/work\n");
					chmodSync(real, mode);
					symlinkSync(real, join(home, ".agentpulse"));
					const loaded = loadExcludeRules(home);
					expect(loaded.state, mode.toString(8)).toBe("invalid");
					expect(loaded.reason).toContain("writable");
				} finally {
					chmodSync(join(home, "real-agentpulse"), 0o700);
					rmSync(home, { recursive: true, force: true });
				}
			}
		},
	);
});

describe("isSkipValue — the trim set is exactly space, tab, CR, LF", () => {
	test("form feed, vertical tab, NBSP, line separator and BOM never count as whitespace", () => {
		for (const value of [
			"1\f",
			"\ftrue",
			"\u000byes\u000b",
			"\u00a0yes\u00a0",
			"on\u2028",
			"\ufeff1",
		]) {
			expect(isSkipValue(value), JSON.stringify(value)).toBe(false);
		}
	});

	test("the four trimmed characters still do", () => {
		for (const value of [" 1", "1 ", "\t1", "1\r", "\n1\n", " \t\r\nTRUE \t\r\n"]) {
			expect(isSkipValue(value), JSON.stringify(value)).toBe(true);
		}
	});
});

describe("evaluateExclusion — the platform case rule is selectable, so every branch runs on every host", () => {
	const noSuchPath = (): never => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	const rules = {
		state: "ok" as const,
		rules: [{ line: 1, raw: "/a/Work", resolved: "/a/Work" }],
	};

	test("darwin folds ASCII case", () => {
		const result = evaluateExclusion(
			{ cwd: "/a/work/sub", skip: undefined, rules, platform: "darwin" },
			{ realpath: noSuchPath },
		);
		expect(result.excluded).toBe(true);
	});

	test("linux does not", () => {
		const result = evaluateExclusion(
			{ cwd: "/a/work/sub", skip: undefined, rules, platform: "linux" },
			{ realpath: noSuchPath },
		);
		expect(result.excluded).toBe(false);
	});

	test("win32 folds case", () => {
		const result = evaluateExclusion(
			{ cwd: "/a/work/sub", skip: undefined, rules, platform: "win32" },
			{ realpath: noSuchPath },
		);
		expect(result.excluded).toBe(true);
	});
});

describe("normalizeForCompare — non-ASCII letters keep their case on every platform", () => {
	test("an accented capital is not folded on darwin, linux or win32-shaped POSIX values on linux", () => {
		expect(normalizeForCompare("/a/\u00c9t\u00e9", "darwin")).toBe("/a/\u00c9t\u00e9");
		expect(normalizeForCompare("/a/\u00c9t\u00e9", "linux")).toBe("/a/\u00c9t\u00e9");
	});
});

describe.skipIf(process.platform !== "darwin")(
	"darwin: a rule resolves to the on-disk spelling, accents included",
	() => {
		test("a rule typed NFC excludes a directory stored NFD", () => {
			const home = realpathSync(tempHome());
			try {
				const nfd = "E\u0301cole".normalize("NFD");
				const nfc = "\u00c9cole".normalize("NFC");
				mkdirSync(join(home, nfd, "sub"), { recursive: true });
				writeRulesFile(home, `${join(home, nfc)}\n`);
				const loaded = loadExcludeRules(home);
				const cwd = realpathSync.native(join(home, nfd, "sub"));
				expect(evaluateExclusion({ cwd, skip: undefined, rules: loaded }).excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("a rule typed with the wrong accent case excludes the real directory", () => {
			const home = realpathSync(tempHome());
			try {
				mkdirSync(join(home, "\u00c9t\u00e9", "sub"), { recursive: true });
				writeRulesFile(home, `${join(home, "\u00e9t\u00c9")}\n`);
				const loaded = loadExcludeRules(home);
				const cwd = realpathSync.native(join(home, "\u00c9t\u00e9", "sub"));
				expect(evaluateExclusion({ cwd, skip: undefined, rules: loaded }).excluded).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	},
);

describe("reresolveRules", () => {
	test("follows a symlink that was created or retargeted after the rules were read, keeping line and raw text", () => {
		const home = realpathSync(tempHome());
		try {
			const a = join(home, "a");
			const b = join(home, "b");
			mkdirSync(a);
			mkdirSync(b);
			const link = join(home, "link");
			symlinkSync(a, link);
			writeRulesFile(home, `# note\n${link}\n${join(home, "later")}\n`);
			const loaded = loadExcludeRules(home);
			expect(loaded.rules.map((r) => r.resolved)).toEqual([a, join(home, "later")]);

			rmSync(link);
			symlinkSync(b, link);
			symlinkSync(a, join(home, "later"));
			const next = reresolveRules(loaded.rules, home);
			expect(next.map((r) => r.resolved)).toEqual([b, a]);
			expect(next.map((r) => [r.line, r.raw])).toEqual(loaded.rules.map((r) => [r.line, r.raw]));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an unchanged rule comes back as the same object, and the cost is one resolution per rule", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "d"));
			writeRulesFile(home, `${join(home, "d")}\n`);
			const loaded = loadExcludeRules(home);
			const calls: string[] = [];
			const next = reresolveRules(loaded.rules, home, {
				realpath: (p) => {
					calls.push(p);
					return realpathSync.native(p);
				},
			});
			expect(next[0]).toBe(loaded.rules[0]);
			expect(calls).toEqual([join(home, "d")]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a rule written with ~ is expanded against the home it is given", () => {
		const home = realpathSync(tempHome());
		try {
			mkdirSync(join(home, "proj"));
			writeRulesFile(home, "~/proj\n");
			const loaded = loadExcludeRules(home);
			expect(reresolveRules(loaded.rules, home)[0]?.resolved).toBe(join(home, "proj"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
