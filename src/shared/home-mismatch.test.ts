/**
 * homeMismatchWarning: the rules a user wrote under their account's home are
 * never read by a process that runs with another HOME, so everything is
 * reported. The sentence names both directories and says what to do; it is
 * produced only when a rules file really sits under the other one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeMismatchWarning } from "./exclude-rules.js";

let root: string;
let usedHome: string;
let accountHome: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-home-mismatch-")));
	usedHome = join(root, "service-home");
	accountHome = join(root, "account-home");
	mkdirSync(usedHome, { recursive: true });
	mkdirSync(join(accountHome, ".agentpulse"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const plantRules = (home: string) => writeFileSync(join(home, ".agentpulse", "exclude"), "/x\n");

describe("homeMismatchWarning", () => {
	test("a different HOME and a rules file under the account's home: one sentence naming both and what to do", () => {
		plantRules(accountHome);
		const warning = homeMismatchWarning(usedHome, accountHome);
		expect(warning).not.toBeNull();
		expect(warning).toContain(usedHome);
		expect(warning).toContain(accountHome);
		expect(warning).toContain(join(accountHome, ".agentpulse", "exclude"));
		expect(warning).toContain("not being applied");
		expect(warning).not.toContain("\n");
	});

	test("it does not matter whether the used HOME has rules of its own", () => {
		plantRules(accountHome);
		mkdirSync(join(usedHome, ".agentpulse"), { recursive: true });
		plantRules(usedHome);
		expect(homeMismatchWarning(usedHome, accountHome)).not.toBeNull();
	});

	test("nothing is said when there is no rules file under the account's home, when the homes are the same, or when either is unknown", () => {
		expect(homeMismatchWarning(usedHome, accountHome)).toBeNull();
		plantRules(accountHome);
		expect(homeMismatchWarning(accountHome, accountHome)).toBeNull();
		expect(homeMismatchWarning(`${accountHome}/`, accountHome)).toBeNull();
		expect(homeMismatchWarning(undefined, accountHome)).toBeNull();
		expect(homeMismatchWarning("", accountHome)).toBeNull();
		expect(homeMismatchWarning(usedHome, undefined)).toBeNull();
		expect(homeMismatchWarning(usedHome, "")).toBeNull();
	});

	test("two spellings of one directory (a symlink to it) are the same home", () => {
		plantRules(accountHome);
		const link = join(root, "link-to-account");
		symlinkSync(accountHome, link);
		expect(homeMismatchWarning(link, accountHome)).toBeNull();
	});

	test("a rules path that is a directory or a link still counts as a rules file (what the evaluators would trip over), and a missing account home is not an error", () => {
		mkdirSync(join(accountHome, ".agentpulse", "exclude"));
		expect(homeMismatchWarning(usedHome, accountHome)).not.toBeNull();
		expect(homeMismatchWarning(usedHome, join(root, "no-such-home"))).toBeNull();
	});
});
