/**
 * AGEN-79 structural guard: every model call that produces an answer or a
 * decision turns reasoning off and names its own time limit.
 *
 * A reasoning model that is left to think spends the call's token budget on
 * its chain of thought, so the call returns nothing (the adapter now says so
 * as an error) or, before that, returned the truncated thinking as the answer.
 * The flag is per request, and the adapter only sends it when asked, so a new
 * call site that forgets it reintroduces the failure on exactly the servers
 * that need it. The check reads the source of each `.complete(` call.
 */
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SERVER = join(ROOT, "src/server");

/** Call sites whose request is built elsewhere, each with where the flags are pinned. */
const REQUEST_BUILT_ELSEWHERE: Record<string, string> = {
	"src/server/services/session-summary-service.ts":
		"the request spreads SUMMARY_CALL_OPTIONS (ai/session-summary/prompt-limits.ts), asserted below",
};

/** Sites that keep the adapter's 60 s default, with why. */
const TIMEOUT_FROM_ADAPTER_DEFAULT: Record<string, string> = {
	"src/server/services/ai/runner.ts":
		"the watcher is dormant for hook-observed sessions (finding 5a); its limits wait for that product decision",
};

/** The calls this guard must find, so an emptied search cannot pass. */
const EXPECTED_SITES = [
	"src/server/services/ai/alert-rule-evaluator.ts",
	"src/server/services/ai/runner.ts",
	"src/server/services/ai/semantic-enricher.ts",
	"src/server/services/ask/ask-qa-handler.ts",
	"src/server/services/ask/ask-service.ts",
	"src/server/services/ask/launch-intent-detector.ts",
	"src/server/services/session-summary-service.ts",
];

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (/\.ts$/.test(entry.name)) yield full;
	}
}

/** The source of each `.complete({ ... })` or `streamWithFallback(x, { ... })` object literal in `source`. */
function requestLiterals(source: string): string[] {
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

async function productionCallSites(): Promise<Map<string, string[]>> {
	const sites = new Map<string, string[]>();
	for await (const file of walk(SERVER)) {
		const rel = relative(ROOT, file);
		if (/\.test\.ts$/.test(rel) || rel.includes("/test-utils/")) continue;
		if (rel.startsWith("src/server/services/ai/llm/")) continue;
		// Forwards the caller's own request to a provider; sets nothing itself.
		if (rel === "src/server/services/ai/fast-provider.ts") continue;
		const literals = requestLiterals(await readFile(file, "utf8"));
		if (literals.length > 0) sites.set(rel, literals);
	}
	return sites;
}

describe("model call sites", () => {
	test("the search finds the known call sites", async () => {
		const found = [...(await productionCallSites()).keys()];
		for (const expected of EXPECTED_SITES) {
			if (REQUEST_BUILT_ELSEWHERE[expected]) continue;
			expect(found).toContain(expected);
		}
	});

	test("every call that builds its request inline sets disableReasoning: true and a timeout from config", async () => {
		const offenders: string[] = [];
		for (const [file, literals] of await productionCallSites()) {
			for (const literal of literals) {
				if (!/disableReasoning:\s*true/.test(literal))
					offenders.push(`${file}: no disableReasoning`);
				if (
					!TIMEOUT_FROM_ADAPTER_DEFAULT[file] &&
					!/timeoutMs:\s*config\.\w+\s*\*\s*1000/.test(literal)
				)
					offenders.push(`${file}: timeout not from config`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the summary request carries both through its limits", async () => {
		const { SUMMARY_CALL_OPTIONS } = await import("./session-summary/prompt-limits.js");
		expect(SUMMARY_CALL_OPTIONS.disableReasoning).toBe(true);
	});

	test("only the small helper calls can use the fast provider; answers and summaries never do", async () => {
		const importers: string[] = [];
		for await (const file of walk(SERVER)) {
			const rel = relative(ROOT, file);
			if (/\.test\.ts$/.test(rel) || rel === "src/server/services/ai/fast-provider.ts") continue;
			if (
				/from\s+"[^"]*fast-provider\.js"|import\("[^"]*fast-provider\.js"\)/.test(
					await readFile(file, "utf8"),
				)
			) {
				importers.push(rel);
			}
		}
		expect(importers.sort()).toEqual([
			"src/server/services/ai/alert-rule-evaluator.ts",
			"src/server/services/ai/semantic-enricher.ts",
			"src/server/services/ask/launch-intent-detector.ts",
		]);
	});

	test("planted negative: a call without the flag is reported", () => {
		const planted = "await adapter.complete({ systemPrompt: s, model: m, maxTokens: 800 });";
		const [literal] = requestLiterals(planted);
		expect(literal).toBeDefined();
		expect(/disableReasoning:\s*true/.test(literal ?? "")).toBe(false);
	});
});
