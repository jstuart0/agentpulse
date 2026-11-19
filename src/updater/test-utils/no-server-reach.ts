/**
 * The detector behind `no-server-reach.guard.test.ts`: imports that resolve into an updater directory, and
 * process spawns that name the updater, `update`, `launchctl` or `systemctl`, under the places that must never
 * start an update. Test-only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const GUARDED = ["src/server", "src/web", "packages/agentpulse-mcp/src"];

/** The source without comments, so a doc comment that names a protected file isn't a use of it. */
export function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name === "node_modules" || name === "__fixtures__") continue;
			walk(full, out);
		} else if (
			/\.tsx?$/.test(name) &&
			!/\.test\.tsx?$/.test(name) &&
			!full.includes("/test-utils/")
		) {
			out.push(full);
		}
	}
	return out;
}

const IMPORT_SPEC = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
const SPAWN =
	/(Bun\.spawn(?:Sync)?|\bspawnSync|\bspawn|\bexecFileSync|\bexecFile|\bexecSync|\bexec)\s*\(/g;
const UPDATE_WORDS = /updater|["'`]update["'`]|launchctl|systemctl/i;

/** Violations under `root`: imports that resolve into an updater directory, and process spawns naming the updater. */
export function findViolations(root: string): string[] {
	const found: string[] = [];
	for (const dir of GUARDED) {
		let files: string[] = [];
		try {
			files = walk(join(root, dir));
		} catch {
			continue;
		}
		for (const file of files) {
			const text = readFileSync(file, "utf-8");
			const rel = relative(root, file);
			for (const match of text.matchAll(IMPORT_SPEC)) {
				const spec = match[1] as string;
				if (/(^|\/)updater(\/|$)/.test(spec)) found.push(`${rel}: imports ${spec}`);
			}
			for (const match of text.matchAll(SPAWN)) {
				const window = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
				if (UPDATE_WORDS.test(window))
					found.push(`${rel}: ${match[1]}( near an updater or service-manager name`);
			}
			if (
				/\bchild_process\b/.test(text) &&
				UPDATE_WORDS.test(text.slice(text.indexOf("child_process")))
			) {
				// importing child_process in a file that also names the updater is enough to look at
				if (/agentpulse["'`,\s]+["'`]?update/.test(text))
					found.push(`${rel}: child_process with agentpulse update`);
			}
		}
	}
	return found;
}
