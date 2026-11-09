/** AGEN-141: every break the OpenCode canary applies has its anchor exactly once in the filled plugin, and the broken text still loads. */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenCodePluginFiles } from "../src/shared/opencode-plugin.ts";
import {
	type Line,
	MUTATIONS,
	MUTATION_TARGETS,
	applyMutation,
} from "./lib/opencode-canary-mutations.ts";
import { scratchDir } from "./lib/opencode-plugin-kit.ts";

const files = buildOpenCodePluginFiles({ baseUrl: "http://127.0.0.1:1", direct: false });
const textOf = (line: Line) =>
	files.find((f) => f.name.includes(line === "v1" ? "-1" : "-2"))?.text as string;

describe("the canary's breaks", () => {
	test("population: the two breaks of the plan, each with a target and both lines", () => {
		expect(Object.keys(MUTATIONS).sort()).toEqual(["await-post", "throw-in-tool-hook"]);
		expect(Object.keys(MUTATION_TARGETS).sort()).toEqual(["await-post", "throw-in-tool-hook"]);
		for (const entry of Object.values(MUTATIONS)) {
			expect(entry.v1.length).toBeGreaterThan(0);
			expect(entry.v2.length).toBeGreaterThan(0);
		}
	});

	for (const [name, entry] of Object.entries(MUTATIONS)) {
		for (const line of ["v1", "v2"] as const) {
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

	test("an anchor that is missing or doubled is refused", () => {
		expect(() => applyMutation("await-post", "v1", "nothing here")).toThrow(/0 times/);
		const text = textOf("v1");
		const anchor = (MUTATIONS["await-post"]?.v1[0] as { anchor: string }).anchor;
		expect(() => applyMutation("await-post", "v1", `${text}\n${anchor}`)).toThrow(/2 times/);
		expect(() => applyMutation("nope", "v1", text)).toThrow(/unknown/);
	});
});
