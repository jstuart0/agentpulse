/**
 * AGEN-141: every break the OpenCode canary applies has its anchor exactly once in the text it patches, and the
 * broken text still loads (a plugin) or still parses (the scratch copy of the installer). The population is the
 * plan's mutation table (step 31, G9 re-plan: ten entries).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenCodePluginFiles } from "../src/shared/opencode-plugin.ts";
import {
	type Line,
	MUTATIONS,
	MUTATION_LINES,
	MUTATION_TARGETS,
	SETUP_MUTATIONS,
	applyMutation,
	applySetupMutation,
} from "./lib/opencode-canary-mutations.ts";
import { scratchDir } from "./lib/opencode-plugin-kit.ts";

const files = buildOpenCodePluginFiles({ baseUrl: "http://127.0.0.1:1", direct: true });
const textOf = (line: Line) =>
	files.find((f) => f.name.includes(line === "v1" ? "-1" : "-2"))?.text as string;
const SETUP_SH = readFileSync(join(import.meta.dir, "setup-hooks.sh"), "utf8");

const TABLE = [
	"await-post",
	"throw-in-tool-hook",
	"no-seen-set",
	"per-instance-queue",
	"no-claim",
	"ctx-dir-for-bus",
	"no-gate",
	"no-terminal-hold",
	"no-perm-link",
	"no-sdk-check",
];
const linesOf = (name: string): Line[] => MUTATION_LINES[name] ?? ["v1", "v2"];

describe("the canary's breaks", () => {
	test("population: the plan's ten breaks, each with a target scenario and its anchors", () => {
		expect(Object.keys(MUTATION_TARGETS).sort()).toEqual([...TABLE].sort());
		expect(
			[...Object.keys(MUTATIONS), ...Object.keys(SETUP_MUTATIONS)].sort(),
			"a break in neither table",
		).toEqual([...TABLE].sort());
		for (const name of TABLE) expect(MUTATION_TARGETS[name]?.length, name).toBeGreaterThan(0);
		for (const name of Object.keys(MUTATIONS)) {
			for (const line of linesOf(name)) {
				expect(MUTATIONS[name]?.[line].length, `${name} on ${line}`).toBeGreaterThan(0);
			}
		}
	});

	test("named members: ctx-dir-for-bus patches the two bus-event directory lookups of 2.x; no-sdk-check is the installer's", () => {
		expect(MUTATIONS["ctx-dir-for-bus"]?.v2.length).toBe(2);
		expect(linesOf("ctx-dir-for-bus")).toEqual(["v2"]);
		expect(SETUP_MUTATIONS["no-sdk-check"]?.length).toBe(1);
		expect(MUTATION_TARGETS["no-sdk-check"]?.[0]?.scenario).toBe("v1-cold-skip");
	});

	for (const [name, entry] of Object.entries(MUTATIONS)) {
		for (const line of linesOf(name)) {
			test(`${name} on ${line}: each anchor occurs once, and the broken text loads`, async () => {
				const text = textOf(line);
				for (const { anchor } of entry[line]) {
					expect(text.split(anchor).length - 1, anchor).toBe(1);
				}
				const broken = applyMutation(name, line, text);
				expect(broken).not.toBe(text);
				const file = join(scratchDir("anchor"), "broken.js");
				writeFileSync(file, broken);
				const mod = await import(`${file}?v=${name}-${line}`);
				expect(typeof (line === "v1" ? mod.AgentPulse : mod.default?.setup)).toBe("function");
			});
		}
	}

	test("no-sdk-check: the anchor occurs once in setup-hooks.sh and the scratch copy passes bash -n", () => {
		for (const { anchor } of SETUP_MUTATIONS["no-sdk-check"] ?? []) {
			expect(SETUP_SH.split(anchor).length - 1, anchor).toBe(1);
		}
		const broken = applySetupMutation("no-sdk-check", SETUP_SH);
		expect(broken).not.toBe(SETUP_SH);
		expect(broken).toContain("\tsdk=1\n");
		const file = join(scratchDir("anchor"), "setup-hooks-mutated.sh");
		writeFileSync(file, broken);
		// setup-hooks.sh is a bash script (#!/usr/bin/env bash, `[[ =~ ]]`): dash, which is /bin/sh on
		// Debian and Ubuntu, rejects it before and after the mutation alike. The mutation must keep it bash-valid.
		const r = Bun.spawnSync(["bash", "-n", file]);
		expect(r.exitCode, `bash -n: ${r.stderr.toString()}`).toBe(0);
	});

	test("an anchor that is missing or doubled is refused", () => {
		expect(() => applyMutation("await-post", "v1", "nothing here")).toThrow(/0 times/);
		const text = textOf("v1");
		const anchor = (MUTATIONS["await-post"]?.v1[0] as { anchor: string }).anchor;
		expect(() => applyMutation("await-post", "v1", `${text}\n${anchor}`)).toThrow(/2 times/);
		expect(() => applyMutation("nope", "v1", text)).toThrow(/unknown/);
		expect(() => applySetupMutation("no-sdk-check", "nothing here")).toThrow(/0 times/);
		expect(() => applySetupMutation("no-sdk-check", `${SETUP_SH}\n${SETUP_SH}`)).toThrow(/2 times/);
	});

	test("a break on a line with nothing to break leaves the text alone", () => {
		expect(applyMutation("no-claim", "v1", textOf("v1"))).toBe(textOf("v1"));
	});
});
