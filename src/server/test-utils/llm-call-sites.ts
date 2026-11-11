/**
 * Finds the production code that calls a model. Shared by the structural guards
 * (`llm-call-sites.guard.test.ts`, `prompt-framing.guard.test.ts`). Not a test file.
 *
 * It reads source text. It finds `.complete(`, `.completeStream(`, a bracketed
 * `["complete"]` and `streamWithFallback(`, with any argument. It cannot see a call
 * through an alias (`const f = adapter.complete; f(x)`) or an adapter method added
 * under another name.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const ROOT = join(import.meta.dir, "../../..");
export const SERVER = join(ROOT, "src/server");

export async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (/\.ts$/.test(entry.name)) yield full;
	}
}

/** The source of each `.complete({ ... })` or `streamWithFallback(x, { ... })` object literal in `source`. */
export function requestLiterals(source: string): string[] {
	const found: string[] = [];
	const opener = /(?:\.complete\(|streamWithFallback\([^,]+,\s*)\{/g;
	for (let m = opener.exec(source); m; m = opener.exec(source)) {
		let depth = 1;
		let i = m.index + m[0].length;
		while (i < source.length && depth > 0) {
			if (source[i] === "{") depth++;
			else if (source[i] === "}") depth--;
			i++;
		}
		found.push(source.slice(m.index + m[0].length - 1, i));
	}
	return found;
}

const MODEL_CALL_RE =
	/\.complete\(|\.completeStream\(|\[\s*["'`]complete(?:Stream)?["'`]\s*\]|\bstreamWithFallback\(/;

/** Whether `source` calls a model, literal request or not. */
export function callsModel(source: string): boolean {
	return MODEL_CALL_RE.test(source);
}

/** Production files under `src/server` that is not an adapter or a forwarder. Relative to the repo root. */
export async function* productionFiles(): AsyncGenerator<{ rel: string; source: string }> {
	for await (const file of walk(SERVER)) {
		const rel = relative(ROOT, file);
		if (/\.test\.ts$/.test(rel) || rel.includes("/test-utils/")) continue;
		if (rel.startsWith("src/server/services/ai/llm/")) continue;
		// Forwards the caller's own request to a provider; sets nothing itself.
		if (rel === "src/server/services/ai/fast-provider.ts") continue;
		yield { rel, source: await readFile(file, "utf8") };
	}
}

/** Every production file that calls a model, relative to the repo root, sorted. */
export async function modelCallSites(): Promise<string[]> {
	const found: string[] = [];
	for await (const { rel, source } of productionFiles()) {
		if (callsModel(source)) found.push(rel);
	}
	return found.sort();
}
