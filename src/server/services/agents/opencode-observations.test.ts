/**
 * AGEN-141 phase 0: the measurement gates are recorded and filled in. This parses
 * `__fixtures__/opencode/OBSERVATIONS.md` and holds it to the plan's rules: exactly G1 to G9, G9b, G10 to G15,
 * every Answer and Result cell filled, every Result one of `pass`, `stop` or `branch-<X>`, no `stop` on G1 or
 * G2, a `stop` on G9 only with a valid G9b branch row (G9 re-plan), no `stop` on G9b (those return the plan to
 * re-planning), the machine-readable tokens present and well formed, every required capture
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
const GATES = [
	...Array.from({ length: 9 }, (_, i) => `G${i + 1}`),
	"G9b",
	...Array.from({ length: 6 }, (_, i) => `G${i + 10}`),
];
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
		.filter((l) => /^\| G\d+b? \|/.test(l))
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
const tokenIn = (row: Row | undefined, key: string): string | undefined =>
	row?.tokens.find((t) => t.startsWith(`${key}=`))?.slice(key.length + 1);
const tokenValue = (id: string, key: string): string | undefined => tokenIn(byGate(id), key);

const STALL_MS = 15_000;
type Tokens = Map<string, string>;
const tokenMap = (row: Row): Tokens =>
	new Map(row.tokens.map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]));

/** Run token prefixes of the plan's step 4b table: `_ms` and `_stall` always, `_loads`/`_noise` where listed. */
const RUNS: Array<{ id: string; prefix: string; loads?: boolean; noise?: boolean }> = [
	{ id: "r0", prefix: "control.v1_cold_empty" },
	{ id: "r1", prefix: "v1.cold_v2flat" },
	{ id: "r2", prefix: "v1.cold_v2dir", noise: true },
	{ id: "r2b", prefix: "v1.cold_v2dir_index_only", noise: true },
	{ id: "r3", prefix: "v2.cold_dir", loads: true },
	{ id: "r4", prefix: "v2.cold_dir_index_only", loads: true },
	{ id: "r5", prefix: "v1.warm_plugin", loads: true },
	{ id: "r6", prefix: "v1.warm_stale" },
	{ id: "r7a", prefix: "v1.cold_first_run" },
	{ id: "r7b", prefix: "v1.cold_second_run" },
	{ id: "r8", prefix: "v1.warm_no_pkgjson" },
	{ id: "r9", prefix: "v1.cold_ts_only" },
];

/** The rule of the plan's step 4b, verbatim: derived tokens and Result from the run tokens. */
function derive(t: Tokens) {
	const stall = (prefix: string) => t.get(`${prefix}_stall`) === "yes";
	const noise = (prefix: string) => t.get(`${prefix}_noise`);
	const loads = (prefix: string) => t.get(`${prefix}_loads`) === "yes";
	const dirIdxOK =
		!stall("v1.cold_v2dir_index_only") &&
		noise("v1.cold_v2dir_index_only") !== "terminal" &&
		loads("v2.cold_dir_index_only") &&
		!stall("v2.cold_dir_index_only");
	const dirPkgOK =
		!stall("v1.cold_v2dir") &&
		noise("v1.cold_v2dir") !== "terminal" &&
		loads("v2.cold_dir") &&
		!stall("v2.cold_dir");
	const layout = !stall("v1.cold_v2flat")
		? "flat_v1_gated"
		: dirIdxOK || dirPkgOK
			? "v1_flat_v2_dir"
			: "all_gated";
	const secondStalls = stall("v1.cold_second_run");
	return {
		layout,
		v2_dir_files:
			layout !== "v1_flat_v2_dir" ? "n/a" : dirIdxOK ? "index_only" : "index_and_package",
		sdk_rule: stall("v1.warm_stale") ? "sdk_and_foreign_plugin" : "sdk_present",
		sdk_check: stall("v1.warm_no_pkgjson") ? "marker_and_config_dep" : "marker_only",
		foreign_exts: stall("v1.cold_ts_only") ? "js_ts" : "js",
		foreign_opens: secondStalls ? "yes" : "no",
		wording: secondStalls ? "each_start" : "first_start",
		result:
			stall("v1.warm_plugin") || !loads("v1.warm_plugin")
				? "stop"
				: `branch-${layout.replace(/_/g, "-")}`,
	};
}

const PRECONDITIONS: Array<[string, (v: string | undefined) => boolean]> = [
	["control.v1_cold_empty_ms", (v) => /^\d+$/.test(v ?? "") && Number(v) < STALL_MS],
	["control.v1_cold_empty_stall", (v) => v === "no"],
	["v1.cold_first_run_stall", (v) => v === "yes"],
	["v1.cold_sdk_written", (v) => v === "no"],
	["control.cold_node_modules_after", (v) => v === "none"],
	["control.xdg_fresh", (v) => v === "yes"],
	["control.warm_scope", (v) => v === "config_only"],
	["control.warm_marker_before", (v) => v === "yes"],
	["control.warm_pkg_lists_sdk", (v) => v === "yes"],
	["control.network_profile", (v) => v === "g9"],
];
const BRANCHES = ["branch-flat-v1-gated", "branch-v1-flat-v2-dir", "branch-all-gated"];

/** Everything wrong with the G9b row (empty when sound). */
function g9bProblems(g9b: Row): string[] {
	const problems: string[] = [];
	const t = tokenMap(g9b);
	for (const [key, ok] of PRECONDITIONS) {
		if (!t.has(key)) problems.push(`G9b precondition ${key} missing`);
		else if (!ok(t.get(key))) problems.push(`G9b precondition ${key}=${t.get(key)} fails`);
	}
	if (!t.has("v1.cold_first_run_stall")) problems.push("G9b positive control missing");
	else if (t.get("v1.cold_first_run_stall") !== "yes") problems.push("G9b positive control failed");
	if (!t.has("control.xdg_fresh")) problems.push("G9b XDG not fresh");
	for (const { id, prefix, loads, noise } of RUNS) {
		const ms = t.get(`${prefix}_ms`);
		const stall = t.get(`${prefix}_stall`);
		if (!/^\d+$/.test(ms ?? "")) problems.push(`G9b ${id} ${prefix}_ms missing or not an integer`);
		if (!["yes", "no"].includes(stall ?? "")) problems.push(`G9b ${id} ${prefix}_stall missing`);
		if (loads && !["yes", "no"].includes(t.get(`${prefix}_loads`) ?? ""))
			problems.push(`G9b ${id} ${prefix}_loads missing`);
		if (noise && !["terminal", "log", "silent"].includes(t.get(`${prefix}_noise`) ?? ""))
			problems.push(`G9b ${id} ${prefix}_noise missing`);
		if (/^\d+$/.test(ms ?? "") && ["yes", "no"].includes(stall ?? "")) {
			if (Number(ms) > STALL_MS && stall !== "yes")
				problems.push(
					`G9b ms/stall inconsistent: ${prefix}_ms=${ms} with ${prefix}_stall=${stall}`,
				);
			if (stall === "no" && Number(ms) > STALL_MS)
				problems.push(`G9b ms/stall inconsistent: ${prefix}`);
		}
	}
	if (!["yes", "no"].includes(t.get("v1.cold_sdk_written") ?? ""))
		problems.push("G9b v1.cold_sdk_written missing");
	if (problems.length > 0) return problems;
	const derived = derive(t);
	for (const [key, want] of Object.entries(derived)) {
		if (key === "result") continue;
		if (t.get(key) !== want)
			problems.push(
				`G9b derived tokens disagree with its runs: ${key}=${t.get(key)}, runs say ${want}`,
			);
	}
	if (g9b.result !== derived.result)
		problems.push(
			`G9b derived tokens disagree with its runs: Result ${g9b.result}, runs say ${derived.result}`,
		);
	if (derived.result === "stop") problems.push("G9b stop returns the plan to re-planning");
	else if (!BRANCHES.includes(g9b.result))
		problems.push(`G9b Result ${g9b.result} is not a branch`);
	return problems;
}

/** What is wrong with G9 and G9b in `all`; empty when the plan can go on. */
function g9Problems(all: readonly Row[]): string[] {
	const g9 = all.find((r) => r.gate === "G9");
	const g9b = all.find((r) => r.gate === "G9b");
	if (g9?.result === "stop" && !g9b) return ["G9 stop without G9b"];
	return g9b ? g9bProblems(g9b) : [];
}

const withToken = (all: readonly Row[], edit: (tokens: string[]) => string[]): Row[] =>
	all.map((r) => (r.gate === "G9b" ? { ...r, tokens: edit(r.tokens) } : r));
const setToken = (key: string, value: string) => (tokens: string[]) =>
	tokens.map((t) => (t.startsWith(`${key}=`) ? `${key}=${value}` : t));
const dropToken = (key: string) => (tokens: string[]) =>
	tokens.filter((t) => !t.startsWith(`${key}=`));

describe("OBSERVATIONS.md", () => {
	test("has exactly G1-G9, G9b, G10-G15, once each, in order", () => {
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

	test("G1 and G2 are not stop (a stop returns the plan to re-planning)", () => {
		for (const id of ["G1", "G2"]) {
			expect(byGate(id).result, `${id} reads stop: the plan needs a re-plan`).not.toBe("stop");
		}
	});

	test("G9 stop is allowed only with a sound G9b branch row", () => {
		expect(g9Problems(rows)).toEqual([]);
		expect(byGate("G9b").tokens.length).toBeGreaterThanOrEqual(40);
	});

	describe("the named negative copies each fail, and the real file passes", () => {
		const cases: Array<[string, Row[]]> = [
			["G9 stop without G9b", rows.filter((r) => r.gate !== "G9b")],
			[
				"G9b derived tokens disagree with its runs",
				withToken(rows, (t) =>
					setToken(
						"layout",
						tokenValue("G9b", "layout") === "all_gated" ? "flat_v1_gated" : "all_gated",
					)(t),
				),
			],
			["G9b positive control missing", withToken(rows, dropToken("v1.cold_first_run_stall"))],
			["G9b positive control failed", withToken(rows, setToken("v1.cold_first_run_stall", "no"))],
			["G9b XDG not fresh", withToken(rows, dropToken("control.xdg_fresh"))],
			[
				"G9b ms/stall inconsistent",
				withToken(rows, (t) =>
					setToken("v1.cold_v2flat_stall", "no")(setToken("v1.cold_v2flat_ms", "72000")(t)),
				),
			],
		];
		// A floor: all six plan-named members are here.
		test("six named members", () => expect(cases.length).toBe(6));
		for (const [name, copy] of cases) {
			test(name, () => {
				const g9Stop = copy.map((r) => (r.gate === "G9" ? { ...r, result: "stop" } : r));
				expect(g9Problems(g9Stop).join("\n")).toContain(name);
				expect(g9Problems(rows)).toEqual([]);
			});
		}
	});

	test("G9b stop returns the plan to re-planning", () => {
		const stalled = withToken(rows, (t) =>
			setToken("v1.warm_plugin_stall", "yes")(setToken("v1.warm_plugin_ms", "72000")(t)),
		).map((r) => (r.gate === "G9b" ? { ...r, result: "stop" } : r));
		expect(g9Problems(stalled)).toContain("G9b stop returns the plan to re-planning");
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
