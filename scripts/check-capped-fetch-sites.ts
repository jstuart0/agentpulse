#!/usr/bin/env bun
/**
 * Architecture guard: outbound HTTP from server, supervisor, updater and relay code goes through `fetchCapped`
 * (src/shared/capped-fetch.ts: one deadline, one byte cap, no redirects, no cookies, no custom headers) or
 * through one of the sites below, each of which already has its own discipline (the LLM path's `llmFetch`, the
 * push relay client, the Telegram client, telemetry, the supervisor's authenticated request helper, and the
 * relay's own remote fetch). A bare `fetch(` in any other non-test file fails, so a new fetch to a release
 * origin, a feed or a URL taken from a response can't slip in without being named here.
 *
 * `bun scripts/check-capped-fetch-sites.ts --print` lists the files that hold one now.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_ROOT = new URL("..", import.meta.url).pathname;

/** The sites that hold a bare `fetch` today. Add a file here only with a reason in the review. */
export const ALLOWED_BARE_FETCH_FILES: readonly string[] = [
	"scripts/relay.ts",
	"src/server/services/ai/http.ts",
	"src/server/services/ai/llm/list-models.ts",
	"src/server/services/ai/metrics.ts",
	"src/server/services/channels/telegram.ts",
	"src/server/services/push/relay-client.ts",
	"src/server/services/telemetry.ts",
	"src/supervisor/index.ts",
];

const SCAN_DIRS = ["src/server", "src/supervisor", "src/updater"];
const SCAN_FILES = ["scripts/relay.ts"];
/** A call, or a reference used as a default (`options.fetch ?? fetch`). A method named fetch (`app.fetch(`) is not one. */
const BARE_FETCH = /(^|[^A-Za-z0-9_.$])fetch\s*\(|\?\?\s*fetch\b/m;

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const info = statSync(full);
		if (info.isDirectory()) {
			if (name === "node_modules" || name === "test-utils" || name === "__fixtures__") continue;
			walk(full, out);
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(full);
		}
	}
}

/** Repository-relative paths of every non-test file under the scanned places that holds a bare fetch. */
export function collectBareFetchFiles(root: string): string[] {
	const files: string[] = [];
	for (const dir of SCAN_DIRS) {
		try {
			walk(join(root, dir), files);
		} catch {
			// a missing directory is simply absent (the guard's own test builds a small tree)
		}
	}
	for (const file of SCAN_FILES) {
		try {
			statSync(join(root, file));
			files.push(join(root, file));
		} catch {
			// absent
		}
	}
	return files
		.filter((file) => BARE_FETCH.test(readFileSync(file, "utf-8")))
		.map((file) => relative(root, file))
		.sort();
}

export function checkCappedFetchSites(root: string): { unexpected: string[]; gone: string[] } {
	const found = collectBareFetchFiles(root);
	const allowed = new Set(ALLOWED_BARE_FETCH_FILES);
	return {
		unexpected: found.filter((file) => !allowed.has(file)),
		gone: ALLOWED_BARE_FETCH_FILES.filter((file) => !found.includes(file)),
	};
}

if (import.meta.main) {
	const flag = process.argv.indexOf("--root");
	const root = flag === -1 ? DEFAULT_ROOT : (process.argv[flag + 1] ?? DEFAULT_ROOT);
	if (process.argv.includes("--print")) {
		console.log(collectBareFetchFiles(root).join("\n"));
		process.exit(0);
	}
	const { unexpected, gone } = checkCappedFetchSites(root);
	if (unexpected.length > 0 || gone.length > 0) {
		for (const file of unexpected) {
			console.error(
				`ERROR: ${file} calls fetch() directly. Use fetchCapped (src/shared/capped-fetch.ts), or name the file in scripts/check-capped-fetch-sites.ts with a reason.`,
			);
		}
		for (const file of gone) {
			console.error(
				`ERROR: ${file} is listed as a bare-fetch site but no longer calls fetch(); remove it from the allowlist.`,
			);
		}
		process.exit(1);
	}
	console.log("OK: every bare fetch() is a named site");
}
