/**
 * Loads the recorded Claude Code 2.1.318 stream lines (AGEN-117 P3). `out` is a line Claude printed, `in` a
 * line a driver sent it. The files are scrubbed copies of real runs; see `manifest.json` for each one's
 * source and whether its argv held `--restricted`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_FIXTURE_DIR = join(import.meta.dir, "claude-2.1.318");
/** Recorded with Claude Code 2.1.319 (AGEN-119..123 measurement): interrupts, subagents, MCP. Same line format. */
export const CLAUDE_FIXTURE_DIR_2_1_319 = join(import.meta.dir, "claude-2.1.319");

export type RecordedLine = { dir: "in" | "out"; frame: Record<string, any> };

export function readClaudeFixture(name: string, dir: string = CLAUDE_FIXTURE_DIR): RecordedLine[] {
	const file = name.endsWith(".jsonl") ? name : `${name}.jsonl`;
	return readFileSync(join(dir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RecordedLine);
}

export const outLines = (name: string, dir: string = CLAUDE_FIXTURE_DIR) =>
	readClaudeFixture(name, dir)
		.filter((l) => l.dir === "out")
		.map((l) => l.frame);
export const inLines = (name: string, dir: string = CLAUDE_FIXTURE_DIR) =>
	readClaudeFixture(name, dir)
		.filter((l) => l.dir === "in")
		.map((l) => l.frame);

export function readClaudeJson(name: string): any {
	return JSON.parse(readFileSync(join(CLAUDE_FIXTURE_DIR, name), "utf8"));
}

export function claudeManifest(
	dir: string = CLAUDE_FIXTURE_DIR,
): Record<string, { restricted: boolean; source: string }> {
	return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

/** The wire text of a recorded frame, as a driver would have sent or read it. */
export const wireText = (frame: unknown) => JSON.stringify(frame);

export function fixtureNames(dir: string = CLAUDE_FIXTURE_DIR): string[] {
	return Object.keys(claudeManifest(dir)).filter((n) => n.endsWith(".jsonl"));
}
