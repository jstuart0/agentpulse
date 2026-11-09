import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EmbedInputs,
	SITE_MARKERS,
	buildPlugin,
	checkOpenCodePluginEmbed,
	sourceRuleViolations,
} from "./lib/opencode-plugin-embed.ts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const inputs = (): EmbedInputs => ({
	sources: {
		core: read("scripts/opencode-plugin/core.js"),
		v1: read("scripts/opencode-plugin/agentpulse-opencode-1.js"),
		v2: read("scripts/opencode-plugin/agentpulse-opencode-2.js"),
	},
	generatedModule: read("src/shared/opencode-plugin-text.generated.ts"),
	setupHooksSh: read("scripts/setup-hooks.sh"),
	installLocalPs1: read("scripts/install-local.ps1"),
	setupRelaySh: read("scripts/setup-relay.sh"),
	installShTemplate: read("scripts/opencode-installer/install.sh"),
	installPsTemplate: read("scripts/opencode-installer/install.ps1"),
	installerModule: read("src/shared/opencode-install-text.generated.ts"),
});

describe("L2 the test seam never ships", () => {
	test("the generated module and both installers carry no seam text", () => {
		for (const text of [
			read("src/shared/opencode-plugin-text.generated.ts"),
			read("scripts/setup-hooks.sh"),
			read("scripts/install-local.ps1"),
		]) {
			expect(text).not.toContain("AP_TEST_SEAM");
			expect(text).not.toContain("agentpulse.opencode.seam");
		}
	});

	test("a core that lost its seam markers fails the check", () => {
		const i = inputs();
		const errors = checkOpenCodePluginEmbed({
			...i,
			sources: { ...i.sources, core: i.sources.core.replace("// @@AP_TEST_SEAM ELSE\n", "") },
		});
		expect(errors.some((e) => e.includes("AP_TEST_SEAM"))).toBe(true);
	});

	test("the seam variant keeps the seam and the installed variant drops it, with one hash", () => {
		const i = inputs();
		const plain = buildPlugin(i.sources, "v1");
		const seam = buildPlugin(i.sources, "v1", { seam: true });
		expect(plain.text).not.toContain("AP_TEST_SEAM");
		expect(seam.text).toContain("AP_TEST_SEAM");
		expect(seam.hash).toBe(plain.hash);
	});
});

describe("check:opencode-plugin-embed", () => {
	test("the committed copies match the sources", () => {
		expect(checkOpenCodePluginEmbed(inputs())).toEqual([]);
	});

	test("a one-byte edit in the generated module fails", () => {
		const i = inputs();
		const errors = checkOpenCodePluginEmbed({
			...i,
			generatedModule: i.generatedModule.replace("AP_CONFIG", "AP_CONFIx"),
		});
		expect(errors.some((e) => e.includes("opencode-plugin-text.generated.ts"))).toBe(true);
	});

	test("a hand edit between the markers of either installer fails", () => {
		const i = inputs();
		const sh = checkOpenCodePluginEmbed({
			...i,
			setupHooksSh: i.setupHooksSh.replace(
				"const AP_SEND_STATUS = 42;",
				"const AP_SEND_STATUS = 43;",
			),
		});
		expect(sh.some((e) => e.includes("setup-hooks.sh"))).toBe(true);
		const ps = checkOpenCodePluginEmbed({
			...i,
			installLocalPs1: i.installLocalPs1.replace(
				"const AP_SEND_STATUS = 42;",
				"const AP_SEND_STATUS = 43;",
			),
		});
		expect(ps.some((e) => e.includes("install-local.ps1"))).toBe(true);
	});

	test("a duplicated marker pair, and a missing one, fail", () => {
		const i = inputs();
		const { begin, end } = SITE_MARKERS.v1;
		const dup = checkOpenCodePluginEmbed({
			...i,
			setupHooksSh: `${i.setupHooksSh}\n${begin}\n${end}\n`,
		});
		expect(dup.some((e) => e.includes("setup-hooks.sh") && e.includes("exactly one"))).toBe(true);
		const missing = checkOpenCodePluginEmbed({
			...i,
			installLocalPs1: i.installLocalPs1.replace(end, ""),
		});
		expect(missing.some((e) => e.includes("install-local.ps1"))).toBe(true);
		const noRelayMarker = checkOpenCodePluginEmbed({
			...i,
			setupRelaySh: i.setupRelaySh.replace("# @@AGENTPULSE_OPENCODE_PLUGIN_2@@\n", ""),
		});
		expect(noRelayMarker.some((e) => e.includes("setup-relay.sh"))).toBe(true);
	});

	test("the source rules reject a backtick, a ${, non-ASCII, a heredoc terminator, a line starting '@ and a non-node import", () => {
		for (const [name, bad] of [
			["backtick", "const a = `x`;"],
			["template", "const a = '${x}';"],
			["non-ascii", "const a = 'é';"],
			["heredoc", "x\nAP_OPENCODE_PLUGIN_1_EOF\ny"],
			["here-string", "x\n'@\ny"],
			["import", 'import x from "left-pad";'],
		] as const) {
			expect(sourceRuleViolations(bad, name).length, name).toBeGreaterThan(0);
		}
		expect(sourceRuleViolations('import fs from "node:fs";\nconst x = 1;', "ok")).toEqual([]);
	});
});
