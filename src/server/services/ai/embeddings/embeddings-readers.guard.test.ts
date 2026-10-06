/**
 * Structural guard for the table that caused the 2026-10-04 outage: outside
 * the database layer, exactly two production files may touch
 * `event_embeddings` (the embedding service, which writes and does keyed
 * reads, and the bounded scan), and every statement that selects
 * `v.vector` must carry both a LIMIT and the named index.
 *
 * Scope is `src/` and `packages/`; `scripts/` is deliberately not scanned so
 * the manual benchmark can seed and read the table. Tests, test utilities and
 * `src/server/db/` (schema, boot DDL) are excluded.
 */
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../../..");
const TABLE_ACCESS = /(?:FROM|INTO|JOIN)\s+event_embeddings|\beventEmbeddings\b/;
const EXPECTED = [
	"src/server/services/ai/embeddings/embedding-service.ts",
	"src/server/services/ai/embeddings/vector-scan.ts",
];

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

async function filesTouchingTheTable(): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const top of ["src", "packages"]) {
		for await (const file of walk(join(ROOT, top))) {
			const rel = relative(ROOT, file);
			if (!isProduction(rel)) continue;
			const source = await readFile(file, "utf8");
			if (TABLE_ACCESS.test(source)) found.set(rel, source);
		}
	}
	return found;
}

/** Every string or template literal in `source` that selects `v.vector`. */
function vectorSelectingStatements(source: string): string[] {
	const literals = source.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) ?? [];
	return literals.filter((text) => /\bv\.vector\b/.test(text));
}

describe("event_embeddings readers", () => {
	test("outside the db layer only the embedding service and the scan touch the table, and the scan is one of them", async () => {
		const files = [...(await filesTouchingTheTable()).keys()].sort();
		expect(files).toEqual(EXPECTED);
	});

	test("every statement selecting v.vector has a LIMIT and names the scan index", async () => {
		const files = await filesTouchingTheTable();
		const scanSource = files.get("src/server/services/ai/embeddings/vector-scan.ts") ?? "";
		const statements = [...files.values()].flatMap(vectorSelectingStatements);
		expect(statements.length).toBeGreaterThan(0);
		expect(vectorSelectingStatements(scanSource).length).toBeGreaterThan(0);
		for (const statement of statements) {
			expect(statement).toMatch(/\bLIMIT\b/);
			expect(statement).toMatch(/INDEXED BY idx_event_embeddings_model_dim_event/);
		}
	});

	test("the guard sees both spellings: the raw table name and the Drizzle identifier", () => {
		expect(TABLE_ACCESS.test("SELECT 1 FROM event_embeddings v")).toBe(true);
		expect(TABLE_ACCESS.test("INSERT INTO event_embeddings (x)")).toBe(true);
		expect(TABLE_ACCESS.test("db.select().from(eventEmbeddings)")).toBe(true);
		expect(TABLE_ACCESS.test("// the event_embeddings table is big")).toBe(false);
	});
});
