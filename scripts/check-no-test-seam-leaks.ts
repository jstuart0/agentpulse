#!/usr/bin/env bun
/**
 * Architecture guard: a `_...ForTest`-suffixed exported function is a
 * deliberate hole poked in production code so a test can control something
 * that would otherwise be unreachable (a background task, a race window,
 * an injected failure). That hole must only ever be used by a test.
 *
 * Several exist in production files (event-processor.ts's
 * _setPreInsertRaceHookForTest, ingest.ts's
 * _setEnqueueHookProcessingOverrideForTest, and more). Nothing stopped a
 * real caller reaching one of them — or reaching it through a test-utils/
 * wrapper — without anyone noticing that the code path under test is no
 * longer the code path that actually runs. This scans src for every such
 * export (functions and consts, "ForTest" and "ForTests", directly or
 * through an export list) and fails if anything outside a test file or a
 * test-utils/ directory references one, if production code in the seam's own
 * file calls it, or if production code imports from test-utils/.
 */
import { collectTestSeamViolations } from "./lib/test-seam-utils.js";

const DEFAULT_ROOT = new URL("..", import.meta.url).pathname;

/** `--root <dir>` points the scan at another checkout's tree (used by this guard's own test). */
function repoRoot(): string {
	const flag = process.argv.indexOf("--root");
	const value = flag === -1 ? undefined : process.argv[flag + 1];
	if (flag !== -1 && !value) throw new Error("--root needs a directory");
	return value ? `${value.replace(/\/$/, "")}/` : DEFAULT_ROOT;
}

async function main() {
	const root = repoRoot();
	const violations = await collectTestSeamViolations(root, [`${root}src`]);

	if (violations.length > 0) {
		console.error(
			[
				`ERROR: test-only seam misuse (${violations.length} hit${violations.length === 1 ? "" : "s"}):`,
				"",
				...violations,
				"",
				"A ...ForTest / ...ForTests export exists so a test can control something",
				"production code can't reach any other way. Move the reference into the",
				"*.test.ts file that needs it, or into a test-utils/ directory, instead of",
				"calling it from real code; and production code must not import test-utils/.",
			].join("\n"),
		);
		process.exit(1);
	}

	console.log("OK: no test-only seam is used by production code");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
