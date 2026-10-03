import { describe, expect, test } from "bun:test";
/**
 * Guard: no route file builds a `{ sessions: [...] }` response from a
 * raw `from(sessions)` select — every producer of session rows that reach
 * the wire must go through getSessions, getSessionSummaries, or
 * mapSessionDto, so a raw row (carrying ingestKeyId, missing ownerKind)
 * can never leak.
 *
 * Static source scan, same category as scripts/check-*-parity.ts's own
 * test files: reads real files, no DB, no app.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SANCTIONED_PRODUCERS = ["getSessions", "getSessionSummaries", "mapSessionDto"];

async function listRouteFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		out.push(join(dir, entry.name));
	}
	return out;
}

describe("session-response-guard: every { sessions: ... } response comes from a sanctioned producer", () => {
	test("no route file builds sessions rows from a raw from(sessions) select outside getSessions/getSessionSummaries/mapSessionDto", async () => {
		const routesDir = join(import.meta.dir);
		const files = await listRouteFiles(routesDir);
		const violations: string[] = [];

		for (const file of files) {
			const text = await readFile(file, "utf-8");
			if (!/\{\s*sessions\s*:/.test(text)) continue;

			// A file that returns a `sessions:` key is only compliant if every
			// raw `from(sessions)` select in it feeds a sanctioned producer
			// (i.e. the raw rows are never returned directly as `sessions:
			// rows`). Heuristic: a raw `.from(sessions)` select assigned to a
			// variable that is then returned bare as `sessions: <thatVar>`
			// (not wrapped in one of the sanctioned producer calls) is a
			// violation.
			const rawSelectVars = [
				...text.matchAll(/const\s+(\w+)\s*=\s*await\s+getDb\(\)[\s\S]*?\.from\(sessions\)/g),
			].map((m) => m[1]);

			for (const varName of rawSelectVars) {
				const bareReturnPattern = new RegExp(`sessions:\\s*${varName}(?!\\.map)\\b`);
				if (bareReturnPattern.test(text)) {
					const usesSanctionedProducer = SANCTIONED_PRODUCERS.some((fn) =>
						new RegExp(`${varName}\\.map\\(.*${fn}|${fn}\\(.*${varName}`).test(text),
					);
					if (!usesSanctionedProducer) {
						violations.push(`${file}: "sessions: ${varName}" from a raw from(sessions) select`);
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
