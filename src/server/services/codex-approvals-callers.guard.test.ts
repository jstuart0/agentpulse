/**
 * Source-scan guards for Codex approvals (P8). Who may write the tables, who may
 * write a closed_reason, and who may call answerApproval, each pinned to a named
 * set with a population floor so the scan can't pass by looking at nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../..");
const SERVER = join(REPO, "src/server");

function walk(dir: string, found: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, found);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(full);
	}
	return found;
}
const rel = (file: string) => file.slice(REPO.length + 1);

// Test fixtures (src/server/test-utils) seed and wipe rows on purpose; production code is the population.
const serverFiles = walk(SERVER).filter((file) => !rel(file).startsWith("src/server/test-utils/"));
const source = new Map(serverFiles.map((file) => [rel(file), readFileSync(file, "utf8")]));

describe("the population is real", () => {
	test("the scans cover the server tree", () => {
		expect(serverFiles.length).toBeGreaterThanOrEqual(300);
		expect(source.has("src/server/services/codex-approvals.ts")).toBe(true);
	});
});

const CLOSE_MODULE = "src/server/services/codex-approvals-close.ts";

describe("closed_reason has one writer", () => {
	test("the set of files that assign a closed reason is exactly the close module", () => {
		const writers = [...source.entries()]
			.filter(([file]) => !file.startsWith("src/server/db/"))
			// An assignment into the row (`status: "closed", closedReason: ...`), not a read or a returned shape.
			.filter(([, text]) =>
				/status:\s*"closed",\s*closedReason:\s*reason\b|closed_reason\s*=/.test(text),
			)
			.map(([file]) => file)
			.sort();
		expect(writers.length).toBeGreaterThanOrEqual(1);
		expect(writers).toEqual([CLOSE_MODULE]);
	});

	test("in the close module, the one UPDATE that sets it is closeApproval's", () => {
		const text = source.get(CLOSE_MODULE) ?? "";
		const setters = [...text.matchAll(/status:\s*"closed",\s*closedReason:\s*reason\b/g)];
		expect(setters).toHaveLength(1);
		const start = text.indexOf("export async function closeApproval(");
		const end = text.indexOf("\n}\n", start);
		expect(start).toBeGreaterThan(0);
		const at = setters[0]?.index ?? -1;
		expect(at).toBeGreaterThan(start);
		expect(at).toBeLessThan(end);
	});

	test("decision is set by one statement, the answer's guarded update", () => {
		const text = source.get("src/server/services/codex-approvals.ts") ?? "";
		const setters = [...text.matchAll(/\n\t+decision,\n/g)];
		expect(setters.length).toBeGreaterThanOrEqual(1);
		const writes = [...text.matchAll(/\.update\(codexApprovals\)\s*\.set\(\{[^}]*\bdecision\b/g)];
		expect(writes).toHaveLength(1);
	});
});

describe("only the approval service writes its tables", () => {
	test("insert, update and delete on either table appear in the service, its close module and its fence, nowhere else", () => {
		const writers = [...source.entries()]
			.filter(([file]) => !file.startsWith("src/server/db/"))
			.filter(([, text]) =>
				/\.(insert|update|delete)\(\s*(codexApprovals|codexApprovalAudit)\s*\)/.test(text),
			)
			.map(([file]) => file)
			.sort();
		expect(writers).toEqual([
			CLOSE_MODULE,
			"src/server/services/codex-approvals-fence.ts",
			"src/server/services/codex-approvals.ts",
		]);
	});
});

describe("answerApproval has one caller, the person route", () => {
	test("the files that call it are exactly the approvals route, and no AI, Ask, Telegram or channel code is among them", () => {
		const callers = [...source.entries()]
			.filter(([file]) => file !== "src/server/services/codex-approvals.ts")
			.filter(([, text]) => /\banswerApproval\s*\(/.test(text))
			.map(([file]) => file)
			.sort();
		expect(callers.length).toBeGreaterThanOrEqual(1);
		expect(callers).toEqual(["src/server/routes/codex-approvals.ts"]);
	});

	test("nothing outside the server reaches it either (supervisor, web, MCP)", () => {
		const others = [
			...walk(join(REPO, "src/supervisor")),
			...walk(join(REPO, "src/web")),
			...walk(join(REPO, "packages/agentpulse-mcp/src")),
		];
		expect(others.length).toBeGreaterThanOrEqual(100);
		const callers = others.filter((file) =>
			/\banswerApproval\s*\(/.test(readFileSync(file, "utf8")),
		);
		expect(callers.map(rel)).toEqual([]);
	});
});

describe("the owner-of-record scan stays untouched", () => {
	test("the approval files read no raw supervisor id", () => {
		const marker = /\.supervisorId\b|(^|[^A-Za-z_])supervisor_id\b/g;
		const files = [...source.entries()].filter(([file]) => /codex-approval/.test(file));
		expect(files.length).toBeGreaterThanOrEqual(3);
		for (const [file, text] of files) {
			if (file.startsWith("src/server/db/")) continue;
			expect(text.match(marker) ?? [], file).toEqual([]);
		}
	});
});

describe("the Stop fence is a leaf", () => {
	const importsOf = (file: string): string[] =>
		[...(source.get(file) ?? "").matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)]
			.map((m) => m[1] as string)
			.sort();

	test("the close module imports only drizzle, the shared types and the schema", () => {
		const imports = importsOf(CLOSE_MODULE);
		expect(imports.length).toBeGreaterThanOrEqual(3);
		expect(imports).toEqual([
			"../../shared/codex-approvals.js",
			"../db/schema/index.js",
			"drizzle-orm",
		]);
	});

	test("the fence imports only drizzle, the schema and the close module", () => {
		const imports = importsOf("src/server/services/codex-approvals-fence.ts");
		expect(imports).toEqual(
			["./codex-approvals-close.js", "../db/schema/index.js", "drizzle-orm"].sort(),
		);
	});
});

describe("the race seam is not reachable from a request", () => {
	test("no other file that uses the approval service mentions `afterRead`", () => {
		const service = "src/server/services/codex-approvals.ts";
		expect(source.get(service) ?? "").toMatch(/\bafterRead\b/);
		const others = [...source.entries()]
			.filter(([file]) => file !== service)
			.filter(([, text]) => /codex-approvals(-close|-fence)?\.js"/.test(text))
			.filter(([, text]) => /\bafterRead\b/.test(text))
			.map(([file]) => file);
		expect(others).toEqual([]);
	});

	test("no route or supervisor file passes `deps` into the service", () => {
		const routes = [...source.entries()].filter(([file]) =>
			/^src\/server\/routes\/codex-approvals/.test(file),
		);
		expect(routes.length).toBeGreaterThanOrEqual(1);
		for (const [file, text] of routes) {
			expect(text.match(/\bdeps\b/g) ?? [], file).toEqual([]);
		}
	});
});
