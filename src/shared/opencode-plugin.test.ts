import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE_PLUGIN_HASHES } from "./opencode-plugin-text.generated.js";
import {
	OPENCODE_FORCE_INVOCATION,
	OPENCODE_G9B,
	OPENCODE_LAYOUT,
	OPENCODE_NO_OPENCODE_INVOCATION,
	OPENCODE_PLUGIN_TEMPLATES,
	OPENCODE_SDK_FORCE_MESSAGE,
	OPENCODE_SDK_SKIP_MESSAGE,
	type OpenCodeInstallSite,
	buildOpenCodePluginFiles,
	openCodeEntries,
	planOpenCodeInstall,
	renderOpenCodeMessage,
} from "./opencode-plugin.js";

const OBSERVATIONS = readFileSync(
	join(import.meta.dir, "../server/services/agents/__fixtures__/opencode/OBSERVATIONS.md"),
	"utf8",
);
const g9bRow = OBSERVATIONS.split("\n").find((l) => l.startsWith("| G9b |")) as string;
const token = (name: string) => new RegExp(`\`${name}=([^\`]*)\``).exec(g9bRow)?.[1];

describe("the plugin is pinned to the G9b measurement (17u)", () => {
	test("OPENCODE_LAYOUT and OPENCODE_G9B equal the tokens in OBSERVATIONS.md", () => {
		expect(OPENCODE_LAYOUT).toBe(token("layout") as never);
		expect(OPENCODE_G9B.sdkRule).toBe(token("sdk_rule") as never);
		expect(OPENCODE_G9B.sdkCheck).toBe(token("sdk_check") as never);
		expect(OPENCODE_G9B.foreignExts).toBe(token("foreign_exts") as never);
		expect(OPENCODE_G9B.foreignOpens).toBe(token("foreign_opens") as never);
		expect(OPENCODE_G9B.wording).toBe(token("wording") as never);
		expect(OPENCODE_G9B.v2DirFiles).toBe(token("v2_dir_files") as never);
	});

	test("the entry names follow the layout: the 2.x plugin is a directory with index.js only", () => {
		expect(openCodeEntries().map((e) => e.file)).toEqual([
			"agentpulse-opencode-1.js",
			"agentpulse-opencode-2/index.js",
		]);
		const files = buildOpenCodePluginFiles({ baseUrl: "https://example.test", direct: true });
		expect(files.map((f) => f.name)).toEqual([
			"agentpulse-opencode-1.js",
			"agentpulse-opencode-2/index.js",
		]);
	});
});

describe("filling the template (17t)", () => {
	const ok = { baseUrl: "http://localhost:4000", direct: false };

	test("the holes are filled, line 1 is the header with the build hash, and direct only fills 1 or 0", () => {
		const [v1, v2] = buildOpenCodePluginFiles(ok);
		expect(v1?.text.split("\n")[0]).toBe(
			`// agentpulse-opencode-plugin ${OPENCODE_PLUGIN_HASHES.v1}`,
		);
		expect(v2?.text.split("\n")[0]).toBe(
			`// agentpulse-opencode-plugin ${OPENCODE_PLUGIN_HASHES.v2}`,
		);
		expect(v1?.text).toContain('baseUrl: "http://localhost:4000", direct: "0" === "1"');
		expect(buildOpenCodePluginFiles({ ...ok, direct: true })[0]?.text).toContain(
			'direct: "1" === "1"',
		);
		expect(v1?.text).not.toContain("@@AP_OPENCODE");
	});

	test("a base URL that could break out of the string, or that isn't http(s), is refused", () => {
		for (const bad of [
			'http://x"; process.exit(1); "',
			"http://x\\y",
			"http://x\nhttp://y",
			"http://a@@b",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"http://localhost:4000/path",
			"",
		]) {
			expect(
				() => buildOpenCodePluginFiles({ baseUrl: bad, direct: false }),
				JSON.stringify(bad),
			).toThrow();
		}
	});

	test("the filled text passes the source rules for the accepted inputs", () => {
		for (const baseUrl of [
			"http://localhost:4000",
			"https://agentpulse.example.com",
			"http://[::1]:3000",
		]) {
			for (const file of buildOpenCodePluginFiles({ baseUrl, direct: true })) {
				expect(file.text).not.toContain("`");
				expect(file.text).not.toContain("${");
				expect(/[^\t\n\x20-\x7e]/.test(file.text)).toBe(false);
			}
		}
		expect(OPENCODE_PLUGIN_TEMPLATES.v1.split("\n").some((l) => l.startsWith("'@"))).toBe(false);
	});
});

describe("the install plan", () => {
	const combos = [false, true].flatMap((sdkPresent) =>
		[false, true].flatMap((foreignPluginPresent) =>
			[false, true].flatMap((forceFlag) =>
				[false, true].map((forceRemembered) => ({
					sdkPresent,
					foreignPluginPresent,
					forceFlag,
					forceRemembered,
				})),
			),
		),
	);

	test("install plan: all 16 combinations of the four inputs", () => {
		expect(combos.length).toBe(16);
		const v1 = "agentpulse-opencode-1.js";
		for (const input of combos) {
			const plan = planOpenCodeInstall(input);
			const opens = input.forceFlag || input.sdkPresent || input.foreignPluginPresent;
			const written = plan.write.map((w) => w.entry);
			expect(written.includes(v1), JSON.stringify(input)).toBe(opens);
			// The ungated 2.x directory is written in every combination.
			expect(written.includes("agentpulse-opencode-2")).toBe(true);
			if (!opens) {
				expect(plan.remove).toEqual([v1]);
				expect(plan.messages).toEqual([OPENCODE_SDK_SKIP_MESSAGE]);
			} else {
				expect(plan.remove).toEqual([]);
				const ruleHolds = input.sdkPresent || input.foreignPluginPresent;
				expect(plan.messages).toEqual(
					input.forceFlag && !ruleHolds ? [OPENCODE_SDK_FORCE_MESSAGE] : [],
				);
			}
			// A remembered force counts only in the all-gated layout, which this is not.
			expect(plan.forceMarker).toBe("none");
		}
	});

	test("install plan: the named member writes no 1.x-visible entry", () => {
		const plan = planOpenCodeInstall({
			sdkPresent: false,
			foreignPluginPresent: false,
			forceFlag: false,
			forceRemembered: false,
		});
		expect(plan.write.map((w) => w.entry)).toEqual(["agentpulse-opencode-2"]);
		expect(plan.write.some((w) => w.entry.endsWith(".js"))).toBe(false);
	});

	test("install plan: forceRemembered changes nothing outside the all-gated layout", () => {
		for (const base of combos.filter((c) => !c.forceRemembered)) {
			expect(planOpenCodeInstall({ ...base, forceRemembered: true })).toEqual(
				planOpenCodeInstall(base),
			);
		}
	});

	test("install plan: the wording follows the measurement, and each site's message holds only its own invocation", () => {
		expect(OPENCODE_SDK_SKIP_MESSAGE).toContain(
			OPENCODE_G9B.wording === "each_start" ? "each start" : "the first start",
		);
		const sites = Object.keys(OPENCODE_FORCE_INVOCATION) as OpenCodeInstallSite[];
		expect(sites.length).toBe(5);
		for (const site of sites) {
			const text = renderOpenCodeMessage(OPENCODE_SDK_SKIP_MESSAGE, { dir: "/cfg", site });
			expect(text).toContain(OPENCODE_FORCE_INVOCATION[site]);
			expect(text).toContain("/cfg");
			expect(text).not.toContain("<force>");
			for (const other of sites) {
				if (OPENCODE_FORCE_INVOCATION[other] !== OPENCODE_FORCE_INVOCATION[site]) {
					expect(
						text.includes(OPENCODE_FORCE_INVOCATION[other]),
						`${site} holds ${other}'s text`,
					).toBe(false);
				}
			}
		}
		expect(OPENCODE_FORCE_INVOCATION["install-local-ps1"]).toContain("-OpenCodeForce");
		expect(OPENCODE_FORCE_INVOCATION["install-local-ps1"]).not.toContain("--opencode-force");
		expect(OPENCODE_FORCE_INVOCATION["setup-sh"]).toContain("| bash -s -- --opencode-force");
		expect(OPENCODE_NO_OPENCODE_INVOCATION["install-local-ps1"]).toContain("-NoOpenCode");
	});
});
