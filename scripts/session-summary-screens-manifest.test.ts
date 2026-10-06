/**
 * TC-8.12: the screens' manifest, checked when the screens directory is present. The directory is
 * outside the repo (the plan folder), so point SESSION_SUMMARY_SCREENS_DIR at it; without it this
 * is skipped, by name, with that reason.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ScreenEntry, validateManifest } from "./check-session-summary-screens.js";
import { SCREENS } from "./session-summary-dev-seed.js";

const DIR = process.env.SESSION_SUMMARY_SCREENS_DIR ?? "";
const present = DIR !== "" && existsSync(join(DIR, "manifest.json"));
const suite = present ? describe : describe.skip;

suite(
	"TC-8.12 the screens manifest (skipped: set SESSION_SUMMARY_SCREENS_DIR to the screens directory, which lives outside the repo)",
	() => {
		test("every entry has a file, every screen is named, no two viewport images match, and each shows the right page", () => {
			const entries = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as ScreenEntry[];
			const problems = validateManifest(
				entries,
				SCREENS.map((s) => s.name),
				(f) => (existsSync(join(DIR, f)) ? readFileSync(join(DIR, f)) : null),
			);
			expect(problems).toEqual([]);
			expect(new Set(entries.map((e) => e.screen)).size).toBe(SCREENS.length);
		});
	},
);
