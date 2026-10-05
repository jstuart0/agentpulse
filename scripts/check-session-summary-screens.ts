#!/usr/bin/env bun
/**
 * AGEN-69: the screen captures are checked, not trusted. For every manifest entry the page that was
 * captured must be the page the screen is about (its final path), the capture's marker must have
 * been found, and a Summary panel screen must have been in the state its name says. Every entry has
 * a file, every named screen has an entry, and no two viewport shots are the same image.
 *
 *   bun scripts/check-session-summary-screens.ts <screens directory>
 *
 * The capture itself needs a headless browser and stays out of the repo; it writes `manifest.json`
 * with `finalPath`, `state` and `markerOk` for each file, and this reads it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCREENS } from "./session-summary-dev-seed.js";

export interface ScreenEntry {
	file: string;
	screen: string;
	width: number;
	theme: string;
	kind: "viewport" | "full";
	state: string | null;
	/** The page's path and query when the shot was taken. */
	finalPath: string;
	/** The screen's marker (a state, a piece of text or a focused heading) was found. */
	markerOk: boolean;
}

const SUMMARY = (name: string) => `^/sessions/scr-${name}\\?tab=summary$`;

/** Where each screen must have been taken, and the panel state it must show (when it shows the panel). */
const SUMMARY_STATES: Record<string, string> = {
	loading: "^loading/none/none$",
	"load-failed": "^load_failed/none/none$",
	"too-little-activity": "too_little_activity",
	empty: "^none/available/none$",
	"empty-free-provider": "^none/available/none$",
	"empty-team": "^none/available/none$",
	"no-provider": "blocked:no_provider",
	"no-provider-with-summary": "blocked:no_provider",
	"paused-no-summary": "blocked:ai_paused",
	"paused-with-summary": "blocked:ai_paused",
	"over-budget": "blocked:over_budget",
	"over-budget-with-summary": "blocked:over_budget",
	"generating-first": "^none/generating/none$",
	"generating-with-previous": "^ready/generating/none$",
	ready: "^ready/",
	"ready-long": "^ready/",
	"ready-corrected-outcome": "^ready/",
	"ready-partial-evidence": "^ready/",
	"ready-mostly-claims": "^ready/",
	"ready-validation-failed": "^ready/",
	"ready-empty-sections": "^ready/",
	stale: "^stale/",
	"stale-over-budget": "^stale/blocked:over_budget",
	"failed-no-summary": "failed-error$",
	"failed-with-summary": "failed-muted$",
	"cooling-down": "blocked:cooling_down",
	"evidence-shrunk-dialog": "^ready/",
	suspect: "^ready/",
	"rate-limited": "^none/available/none$",
	"suspect-note": "^ready/",
	"lost-contact": "^none/generating/none$",
};

export const EXPECTED: Record<string, { path: string; state?: string }> = {
	...Object.fromEntries(
		Object.entries(SUMMARY_STATES).map(([name, state]) => [name, { path: SUMMARY(name), state }]),
	),
	"ai-tab-pointer": { path: "^/sessions/scr-ai-tab-pointer\\?tab=ai$" },
	"dashboard-open-summary": { path: "^/$" },
	"digest-row": { path: "^/digest$" },
	"activity-after-evidence-link": { path: "^/sessions/scr-ready\\?tab=activity$" },
	"settings-labs-anchor": { path: "^/settings\\?panel=labs$" },
	"activity-mode-switched": { path: "^/sessions/scr-activity-mode-switched\\?tab=activity$" },
};

/** Problems found, empty when the capture is sound. `read` returns a file's bytes, or null if it isn't there. */
export function validateManifest(
	entries: ScreenEntry[],
	names: string[],
	read: (file: string) => Uint8Array | null,
): string[] {
	const problems: string[] = [];
	const seen = new Set(entries.map((e) => e.screen));
	for (const name of names) if (!seen.has(name)) problems.push(`missing screen ${name}`);
	for (const screen of seen) {
		if (!names.includes(screen)) problems.push(`unexpected screen ${screen}`);
	}
	const hashes = new Map<string, string[]>();
	for (const e of entries) {
		const bytes = read(e.file);
		if (!bytes) {
			problems.push(`no file for ${e.file}`);
			continue;
		}
		if (!e.markerOk) problems.push(`${e.file}: its marker was not found`);
		const expected = Object.hasOwn(EXPECTED, e.screen) ? EXPECTED[e.screen] : null;
		if (expected) {
			if (!new RegExp(expected.path).test(e.finalPath)) {
				problems.push(`${e.file}: it shows ${e.finalPath}, not a page matching ${expected.path}`);
			}
			if (expected.state && !new RegExp(expected.state).test(e.state ?? "")) {
				problems.push(`${e.file}: state ${e.state ?? "none"} does not match ${expected.state}`);
			}
		}
		if (e.kind === "viewport") {
			const hash = createHash("sha256").update(bytes).digest("hex");
			hashes.set(hash, [...(hashes.get(hash) ?? []), e.file]);
		}
	}
	for (const files of hashes.values()) {
		if (files.length > 1) problems.push(`identical images: ${files.join(", ")}`);
	}
	return problems;
}

function main(): number {
	const dir = process.argv[2];
	if (!dir || !existsSync(join(dir, "manifest.json"))) {
		console.error(
			"Usage: bun scripts/check-session-summary-screens.ts <directory with manifest.json>",
		);
		return 2;
	}
	const entries = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ScreenEntry[];
	const problems = validateManifest(
		entries,
		SCREENS.map((s) => s.name),
		(file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : null),
	);
	const viewport = entries.filter((e) => e.kind === "viewport").length;
	console.log(
		`${entries.length} entries (${viewport} viewport, ${entries.length - viewport} full-page) over ${new Set(entries.map((e) => e.screen)).size} screens`,
	);
	for (const p of problems) console.log(`FAIL ${p}`);
	if (problems.length === 0) console.log("ok: every check passes");
	return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
