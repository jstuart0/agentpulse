/**
 * AGEN-141 phase 0: the measurement gates are recorded and filled in. This parses
 * `__fixtures__/opencode/OBSERVATIONS.md` and holds it to the plan's rules: exactly G1 to G15, every Answer and
 * Result cell filled, every Result one of `pass`, `stop` or `branch-<X>`, no `stop` on G1, G2 or G9 (those
 * return the plan to re-planning), the machine-readable tokens present and well formed, every required capture
 * on disk, every manifest entry honest, and the committed files free of anything environment-specific.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	REQUIRED_CAPTURES,
	hygienePatterns,
} from "../../../../scripts/opencode-canary-scenarios/emit.js";

const DIR = join(import.meta.dir, "__fixtures__", "opencode");
const GATES = Array.from({ length: 15 }, (_, i) => `G${i + 1}`);
const RESULT = /^(pass|stop|branch-[A-Za-z0-9_-]+)$/;
const FILLER = /^(|tbd|\?+|todo|n\/a)$/i;
/** `key=value`; the value may hold the separators the analysis uses between list items. */
const TOKEN = /^[A-Za-z0-9_.]+=[A-Za-z0-9_+.>/:@-]*$/;

interface Row {
	gate: string;
	question: string;
	answer: string;
	result: string;
	tokens: string[];
	version: string;
	command: string;
}

function parseRows(): Row[] {
	const text = readFileSync(join(DIR, "OBSERVATIONS.md"), "utf8");
	return text
		.split("\n")
		.filter((l) => /^\| G\d+ \|/.test(l))
		.map((line) => {
			const cells = line
				.slice(1, -1)
				.split(/(?<!\\)\|/)
				.map((c) => c.trim().replace(/\\\|/g, "|"));
			const [gate, question, answer, result, tokens, version, command] = cells as string[];
			return {
				gate: gate as string,
				question: question as string,
				answer: answer as string,
				result: result as string,
				tokens: [...(tokens ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string),
				version: version as string,
				command: (command ?? "").replace(/^`|`$/g, ""),
			};
		});
}

const rows = parseRows();
const byGate = (id: string) => rows.find((r) => r.gate === id) as Row;
const tokenValue = (id: string, key: string): string | undefined =>
	byGate(id)
		.tokens.find((t) => t.startsWith(`${key}=`))
		?.slice(key.length + 1);

describe("OBSERVATIONS.md", () => {
	test("has exactly G1 to G15, once each, in order", () => {
		expect(rows.map((r) => r.gate)).toEqual(GATES);
	});

	test("every Answer and Result cell is filled, and every Result is pass, stop or branch-<X>", () => {
		for (const r of rows) {
			expect(FILLER.test(r.answer), `${r.gate} answer`).toBe(false);
			expect(FILLER.test(r.result), `${r.gate} result`).toBe(false);
			expect(RESULT.test(r.result), `${r.gate} result ${r.result}`).toBe(true);
			expect(r.version).toContain("/");
			expect(r.command.length).toBeGreaterThan(0);
		}
	});

	test("G1, G2 and G9 are not stop (a stop returns the plan to re-planning)", () => {
		for (const id of ["G1", "G2", "G9"]) {
			expect(byGate(id).result, `${id} reads stop: the plan needs a re-plan`).not.toBe("stop");
		}
	});

	test("every token is well formed, and every gate has at least one", () => {
		for (const r of rows) {
			expect(r.tokens.length, `${r.gate} tokens`).toBeGreaterThan(0);
			for (const t of r.tokens) expect(TOKEN.test(t), `${r.gate} token ${t}`).toBe(true);
		}
	});

	test("the tokens the later phases read are present with allowed values", () => {
		expect(["part_error", "after_error", "none"]).toContain(
			tokenValue("G3", "v1.fail_signal") as string,
		);
		expect(["after_then_part", "part_then_after"]).toContain(
			tokenValue("G3", "v1.order") as string,
		);
		expect(["status_error", "none"]).toContain(tokenValue("G3", "v2.fail_signal") as string);
		expect(["yes", "no"]).toContain(tokenValue("G4", "shared") as string);
		expect(["yes", "no"]).toContain(tokenValue("G15", "tool_hook_fanout") as string);
	});
});

describe("the captures", () => {
	const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
		fixtures: Array<{
			line: "v1" | "v2";
			name: string;
			status: string;
			file?: string;
			waiver?: string;
		}>;
	};

	test("every required capture is in the manifest, once per line", () => {
		for (const line of ["v1", "v2"] as const) {
			const names = manifest.fixtures.filter((f) => f.line === line).map((f) => f.name);
			expect(names.sort()).toEqual([...REQUIRED_CAPTURES[line]].sort());
		}
	});

	test("a captured entry names an existing file; a synthetic one carries a waiver that cites a gate", () => {
		let captured = 0;
		for (const f of manifest.fixtures) {
			if (f.status === "captured") {
				captured++;
				expect(existsSync(join(DIR, f.file as string)), `${f.line}/${f.name}`).toBe(true);
				const body = JSON.parse(readFileSync(join(DIR, f.file as string), "utf8"));
				expect(Array.isArray(body.records) && body.records.length > 0, `${f.file} records`).toBe(
					true,
				);
			} else {
				expect(f.status).toBe("synthetic");
				expect(f.waiver ?? "").toMatch(/\bG(1[0-5]|[1-9])\b/);
			}
		}
		// A floor: most of the required captures were actually taken.
		expect(captured).toBeGreaterThanOrEqual(18);
	});

	test("the captured surface lists the events, hooks and ctx keys of each line", () => {
		const surface = JSON.parse(readFileSync(join(DIR, "captured-surface.json"), "utf8"));
		for (const line of ["v1", "v2"] as const) {
			expect(surface[line].busEvents.length).toBeGreaterThan(5);
			expect(surface[line].ctxKeys.length).toBeGreaterThan(3);
			expect(surface[line].hooks.length).toBeGreaterThan(1);
		}
		expect(Array.isArray(surface.v1.reducedCtxGivenV2File)).toBe(true);
	});
});

describe("fixture hygiene", () => {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(DIR);

	test("positive control: each pattern catches what it names, and the placeholder home passes", () => {
		const samples: Record<string, string> = {
			"a home directory": "/Users/someone/dev",
			"a private temp path": "/private/tmp/work/x",
			"a private address": "192.168.1.5",
			"an internal host name": "box.internal",
			"the account name": `path of ${userInfo().username}`,
			"an API key shape": "Authorization: Bearer abcdefghijklmnop",
		};
		const patterns = hygienePatterns();
		expect(patterns.length).toBe(Object.keys(samples).length);
		for (const [what, pattern] of patterns) {
			expect(pattern.test(samples[what] as string), what).toBe(true);
		}
		expect(patterns.some(([, p]) => p.test("/home/person/.config"))).toBe(false);
	});

	test("there are files to scan", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	test("no committed file names a real home, a private path or address, a domain or a key", () => {
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			for (const [what, pattern] of hygienePatterns()) {
				const m = pattern.exec(text);
				expect(m, `${file.slice(DIR.length)} contains ${what}: ${m?.[0]}`).toBeNull();
			}
		}
	});
});
