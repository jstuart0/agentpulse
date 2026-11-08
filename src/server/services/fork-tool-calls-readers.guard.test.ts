/**
 * Structural guard for the owner-only record of what a fork's tool calls ran (AGEN-123, F23): outside the
 * database layer exactly one production file touches `fork_tool_calls` (the detail service, which redacts
 * before it writes and judges the reader before it reads), so no feed, push, search, embedding, Ask,
 * watcher, Summary or Telegram path can reach the text. And no MCP package file reaches the route.
 *
 * Scope is `src/` and `packages/`. Tests, test utilities and `src/server/db/` (schema, boot DDL) are
 * excluded. Modelled on embeddings-readers.guard.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const TABLE_ACCESS = /fork_tool_calls|\bforkToolCalls\b/;
const EXPECTED = ["src/server/services/fork-tool-detail.ts"];

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
	}
}

function isProduction(rel: string): boolean {
	if (/\.test\.tsx?$/.test(rel)) return false;
	if (rel.startsWith("src/server/db/")) return false;
	if (rel.includes("/test-utils/")) return false;
	return true;
}

async function productionSources(tops: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const top of tops) {
		for await (const file of walk(join(ROOT, top))) {
			const rel = relative(ROOT, file);
			if (isProduction(rel)) found.set(rel, await readFile(file, "utf8"));
		}
	}
	return found;
}

describe("fork_tool_calls readers", () => {
	test("outside the db layer only the detail service touches the table", async () => {
		const sources = await productionSources(["src", "packages"]);
		expect(sources.size).toBeGreaterThan(500); // a population floor: the walk saw the tree
		const touching = [...sources.entries()]
			.filter(([, source]) => TABLE_ACCESS.test(source))
			.map(([rel]) => rel)
			.sort();
		expect(touching).toEqual(EXPECTED);
	});

	test("the guard sees both spellings: the raw table name and the Drizzle identifier", () => {
		expect(TABLE_ACCESS.test("SELECT 1 FROM fork_tool_calls")).toBe(true);
		expect(TABLE_ACCESS.test("db.select().from(forkToolCalls)")).toBe(true);
		expect(TABLE_ACCESS.test("useForkToolCalls()")).toBe(false);
		expect(TABLE_ACCESS.test("// tool calls of a fork")).toBe(false);
	});

	test("no file under packages/ reaches the tool-calls routes: there is no MCP tool for detail", async () => {
		const sources = await productionSources(["packages"]);
		expect(sources.size).toBeGreaterThan(20);
		const reaching = [...sources.entries()]
			.filter(
				([, source]) =>
					/\/tool-calls\b/.test(source) || /getForkToolCall|listForkToolCalls/.test(source),
			)
			.map(([rel]) => rel);
		expect(reaching).toEqual([]);
	});

	test("the routes are the only readers of the service's read functions", async () => {
		const sources = await productionSources(["src"]);
		const readers = [...sources.entries()]
			.filter(([, source]) => /\b(listForkToolCalls|getForkToolCall)\b/.test(source))
			.map(([rel]) => rel)
			.filter((rel) => !rel.startsWith("src/web/"))
			.sort();
		expect(readers).toEqual([
			"src/server/routes/fork-tool-calls.ts",
			"src/server/services/fork-tool-detail.ts",
		]);
	});
});
