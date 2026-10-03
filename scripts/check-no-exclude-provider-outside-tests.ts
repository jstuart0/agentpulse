#!/usr/bin/env bun
/**
 * Architecture guard: every test-injection seam in the exclude-rule
 * feature — the fs/uid provider argument of loadExcludeRules and
 * evaluateExclusion (src/shared/exclude-rules.ts), the rename-provider
 * override on writePrivateFileAtomicNoFollow and writeConfigFileAtomicNoFollow (src/shared/private-file.ts),
 * and the AGENTPULSE_TEST_FORCE_SHELL_RESULT env
 * var excludeCheck reads to force a TypeScript/shell disagreement
 * and the AGENTPULSE_TEST_ACCOUNT_HOME env var it reads in place of the
 * user database's home directory (in bin/cli.ts), and the same stand-in for the relay
 * (AGENTPULSE_TEST_RELAY_ACCOUNT_HOME, scripts/relay.ts) and the supervisor
 * (AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME, src/supervisor/services/exclude-rules-watch.ts) — exists for test injection only:
 * simulating a foreign owner without root, counting fs calls, forcing a
 * TOCTOU-swap or an ACL-query failure, forcing a crash between an atomic
 * write and its rename, or forcing a disagreement between the two
 * evaluators. A production code path quietly depending on any of this
 * test-only plumbing is a hard error.
 *
 * Two independent checks:
 *  1. Argument-count ceilings — each entry's ceiling is the max argument
 *     count a REAL (non-test) call site may legitimately pass. A call
 *     exceeding that ceiling outside a `*.test.ts` file is flagged.
 *     Detection walks each call site's argument list by paren depth
 *     rather than a single-line regex, so a call whose arguments span
 *     multiple lines is still caught correctly.
 *  2. Single-read-site env vars — a var that exists purely to let a test
 *     force a code path (not a real runtime knob) must have exactly one
 *     non-test reference: its designated production read site. A second
 *     non-test reference means some OTHER production code has started
 *     branching on test-only plumbing.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** function name -> max argument count a legitimate production call site may pass. */
const CALL_SPECS: Record<string, number> = {
	loadExcludeRules: 1,
	evaluateExclusion: 1,
	writePrivateFileAtomicNoFollow: 2,
	writeConfigFileAtomicNoFollow: 2,
	acquireExcludeLock: 1,
};

/** env var name -> max number of non-test files allowed to reference it (always 1: its designated production read site). */
const SINGLE_READ_SITE_ENV_VARS: Record<string, number> = {
	AGENTPULSE_TEST_FORCE_SHELL_RESULT: 1,
	AGENTPULSE_TEST_ACCOUNT_HOME: 1,
	AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: 1,
	AGENTPULSE_TEST_SUPERVISOR_ACCOUNT_HOME: 1,
};

async function* walkTs(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
			yield* walkTs(full);
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
			yield full;
		}
	}
}

/**
 * Given `content` and the index of a call's opening paren, returns the number of top-level
 * arguments the call passes: the comma-separated segments at paren depth 1 that hold anything
 * (so a trailing comma, which is what the formatter writes after the last argument of a call it
 * breaks over lines, adds nothing, and a call of string or number literals only still counts).
 * Commas inside nested parens/brackets/braces, string and template literals, and comments are
 * not separators. Returns 0 for a call with no arguments at all.
 */
export function countCallArguments(content: string, openParenIndex: number): number {
	let depth = 0;
	let inString: '"' | "'" | "`" | null = null;
	let segments = 0;
	let segmentHasContent = false;
	for (let i = openParenIndex; i < content.length; i++) {
		const ch = content[i] as string;
		if (inString) {
			if (ch === "\\") {
				i++; // skip escaped character
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === "/" && content[i + 1] === "/") {
			const end = content.indexOf("\n", i);
			i = end < 0 ? content.length : end;
			continue;
		}
		if (ch === "/" && content[i + 1] === "*") {
			const end = content.indexOf("*/", i + 2);
			i = end < 0 ? content.length : end + 1;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			if (depth >= 1) segmentHasContent = true;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			if (depth > 1) segmentHasContent = true;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0 && ch === ")") {
				return segmentHasContent ? segments + 1 : segments; // reached this call's own close
			}
			continue;
		}
		if (ch === "," && depth === 1) {
			if (segmentHasContent) segments++;
			segmentHasContent = false;
			continue;
		}
		if (depth >= 1 && !/\s/.test(ch)) segmentHasContent = true;
	}
	return 0; // unterminated — treat as no arguments rather than guessing
}

/** True when `match.index` is the name of a `function name(...)` declaration rather than a call site — its own parameter list (with a default value) can look exactly like a call's argument list to the paren-depth walker above. */
function isFunctionDeclaration(content: string, matchIndex: number): boolean {
	const before = content.slice(Math.max(0, matchIndex - 20), matchIndex);
	return /\bfunction\s+$/.test(before);
}

/** Every call in `content` that passes more arguments than its documented ceiling, as one error line each. */
export function findCallOffences(rel: string, content: string): string[] {
	const errors: string[] = [];
	for (const [name, maxArgs] of Object.entries(CALL_SPECS)) {
		const callRe = new RegExp(`\\b${name}\\s*\\(`, "g");
		for (const match of content.matchAll(callRe)) {
			if (isFunctionDeclaration(content, match.index)) continue;
			const openParenIndex = match.index + match[0].length - 1;
			const argCount = countCallArguments(content, openParenIndex);
			if (argCount > maxArgs) {
				const lineNo = content.slice(0, match.index).split("\n").length;
				errors.push(
					`${rel}:${lineNo}: ${name}() called with ${argCount} arguments (max ${maxArgs} outside a test file)`,
				);
			}
		}
	}
	return errors;
}

async function main() {
	const errors: string[] = [];
	const envVarNonTestRefCounts: Record<string, number> = Object.fromEntries(
		Object.keys(SINGLE_READ_SITE_ENV_VARS).map((name) => [name, 0]),
	);

	for (const topDir of ["src", "scripts", "bin", "packages"]) {
		let exists = true;
		try {
			await readdir(join(ROOT, topDir));
		} catch {
			exists = false;
		}
		if (!exists) continue;

		for await (const filePath of walkTs(join(ROOT, topDir))) {
			const rel = relative(ROOT, filePath);
			if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
			if (rel === join("src", "shared", "exclude-rules.ts")) continue; // the module's own internal calls, none pass a provider
			if (rel === join("scripts", "check-no-exclude-provider-outside-tests.ts")) continue; // this file's own doc comment + spec table name the seams by name

			const content = await readFile(filePath, "utf8");
			errors.push(...findCallOffences(rel, content));

			for (const envVarName of Object.keys(SINGLE_READ_SITE_ENV_VARS)) {
				if (content.includes(envVarName)) {
					envVarNonTestRefCounts[envVarName] = (envVarNonTestRefCounts[envVarName] ?? 0) + 1;
				}
			}
		}
	}

	for (const [envVarName, maxFiles] of Object.entries(SINGLE_READ_SITE_ENV_VARS)) {
		const actual = envVarNonTestRefCounts[envVarName] ?? 0;
		if (actual > maxFiles) {
			errors.push(
				`${envVarName}: referenced in ${actual} non-test files (max ${maxFiles}) — this env var exists only to let a test force a code path; a second production reference means some other code has started depending on it too`,
			);
		}
	}

	if (errors.length > 0) {
		console.error(
			[
				`ERROR: an exclude-rule test-injection seam is production-reachable (${errors.length} hit${errors.length === 1 ? "" : "s"}):`,
				"",
				...errors,
				"",
				"Each function listed below must be called with no more than its",
				"documented number of real arguments outside tests — the extra",
				"argument exists only for a *.test.ts file to inject a fake:",
				...Object.entries(CALL_SPECS).map(
					([name, max]) => `  ${name}: max ${max} real argument${max === 1 ? "" : "s"}`,
				),
				"",
				"Each env var listed below exists only to let a test force a code",
				"path, and must have exactly its documented number of non-test",
				"references (its designated production read site):",
				...Object.entries(SINGLE_READ_SITE_ENV_VARS).map(
					([name, max]) => `  ${name}: max ${max} non-test file reference${max === 1 ? "" : "s"}`,
				),
			].join("\n"),
		);
		process.exit(1);
	}

	console.log("OK: every exclude-rule test-injection seam is passed only from test files");
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
