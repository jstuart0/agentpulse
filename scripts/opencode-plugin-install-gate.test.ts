/**
 * AGEN-141 plan step 29: the generated decision functions against planOpenCodeInstall, the foreign-plugin scan
 * against the TypeScript one, and a static check of the PowerShell block (nothing here can run it; `pwsh` runs the
 * same table when it exists, and the test says so when it doesn't).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foreignPluginPresent } from "../src/shared/opencode-install.ts";
import {
	OPENCODE_PLAN_CONFIG,
	OPENCODE_SDK_SKIP_MESSAGE,
	type OpenCodeG9b,
	type OpenCodeLayout,
	type OpenCodePlanConfig,
	planOpenCodeInstall,
	renderOpenCodeMessage,
} from "../src/shared/opencode-plugin.ts";
import { renderPsInstaller, renderShInstaller } from "./lib/opencode-plugin-embed.ts";

const ROOT = join(import.meta.dir, "..");
const SH_TEMPLATE = readFileSync(join(ROOT, "scripts/opencode-installer/install.sh"), "utf8");
const PS_TEMPLATE = readFileSync(join(ROOT, "scripts/opencode-installer/install.ps1"), "utf8");
const PS1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf8");

const LAYOUTS: OpenCodeLayout[] = ["flat_v1_gated", "v1_flat_v2_dir", "all_gated"];
const G9B_VARIANTS: Array<Partial<OpenCodeG9b>> = [
	{ sdkRule: "sdk_present", foreignOpens: "yes", foreignExts: "js_ts", sdkCheck: "marker_only" },
	{
		sdkRule: "sdk_present",
		foreignOpens: "no",
		foreignExts: "js_only",
		sdkCheck: "marker_and_package",
	},
	{
		sdkRule: "sdk_and_foreign_plugin",
		foreignOpens: "yes",
		foreignExts: "js_only",
		sdkCheck: "marker_only",
	},
	{
		sdkRule: "sdk_and_foreign_plugin",
		foreignOpens: "no",
		foreignExts: "js_ts",
		sdkCheck: "marker_and_package",
	},
];
const CONFIGS: OpenCodePlanConfig[] = LAYOUTS.flatMap((layout) =>
	G9B_VARIANTS.map((v) => ({ layout, g9b: { ...OPENCODE_PLAN_CONFIG.g9b, ...v } as OpenCodeG9b })),
);

/** The sixteen inputs: sdk, foreign, force, remembered. */
const INPUTS = Array.from({ length: 16 }, (_, i) => ({
	sdkPresent: (i & 8) !== 0,
	foreignPluginPresent: (i & 4) !== 0,
	forceFlag: (i & 2) !== 0,
	forceRemembered: (i & 1) !== 0,
}));
const bit = (b: boolean) => (b ? 1 : 0);

function gatedWritten(config: OpenCodePlanConfig, input: (typeof INPUTS)[number]): boolean {
	return planOpenCodeInstall(input, config).write.some((w) => w.gated);
}

/** The data and the two generated functions of a rendered shell block, without the install functions. */
function shGateScript(config: OpenCodePlanConfig): string {
	const block = renderShInstaller(SH_TEMPLATE, "setup-hooks", config);
	const end = block.indexOf("# ap_oc_fill <text>");
	return block.slice(0, end);
}

describe("step 29: the generated shell gate equals planOpenCodeInstall on every input", () => {
	test("sixteen inputs in each of the twelve configurations, run with /bin/sh", () => {
		expect(INPUTS.length).toBe(16);
		for (const config of CONFIGS) {
			const calls = INPUTS.map(
				(i) =>
					`if ap_oc_gate_open ${bit(i.sdkPresent)} ${bit(i.foreignPluginPresent)} ${bit(i.forceFlag)} ${bit(i.forceRemembered)}; then printf 1; else printf 0; fi`,
			).join("\n");
			const proc = Bun.spawnSync(["/bin/sh", "-c", `${shGateScript(config)}\n${calls}`], {
				env: { PATH: "/usr/bin:/bin" },
			});
			expect(proc.exitCode).toBe(0);
			const got = proc.stdout.toString();
			const want = INPUTS.map((i) => (gatedWritten(config, i) ? "1" : "0")).join("");
			expect(got).toBe(want);
		}
	});

	test("the shipped configuration opens on the SDK or another plugin and closes on nothing; a remembered force counts only when every entry is gated", () => {
		const open = (o: Partial<(typeof INPUTS)[number]>) =>
			gatedWritten(OPENCODE_PLAN_CONFIG, { ...INPUTS[0], ...o } as (typeof INPUTS)[number]);
		expect(open({})).toBe(false);
		expect(open({ forceFlag: true })).toBe(true);
	});
});

describe("step 29: the foreign-plugin scan, shell against TypeScript", () => {
	const NAMES: Array<[string, "file" | "dir" | "link" | "dangling"]> = [
		["theirs.js", "file"],
		["theirs.ts", "file"],
		[".hidden.js", "file"],
		[".hidden.ts", "file"],
		["theirs.mjs", "file"],
		["notes.json", "file"],
		[".js", "file"],
		["js", "file"],
		["agentpulse-opencode-1.js", "file"],
		["agentpulse-opencode-2.js", "file"],
		["folder.js", "dir"],
		["link.js", "link"],
		["dangling.js", "dangling"],
	];
	for (const exts of ["js_only", "js_ts"] as const) {
		test(`each name alone, ${exts}`, () => {
			const config: OpenCodePlanConfig = {
				layout: "v1_flat_v2_dir",
				g9b: { ...OPENCODE_PLAN_CONFIG.g9b, foreignExts: exts },
			};
			const script = shGateScript(config);
			for (const [name, kind] of NAMES) {
				const dir = mkdtempSync(join(tmpdir(), "ap-oc-foreign-"));
				const plugins = join(dir, "plugins");
				mkdirSync(plugins);
				const target = join(dir, "target.txt");
				writeFileSync(target, "x");
				if (kind === "file") writeFileSync(join(plugins, name), "// theirs\n");
				else if (kind === "dir") mkdirSync(join(plugins, name));
				else if (kind === "link") symlinkSync(target, join(plugins, name));
				else symlinkSync(join(dir, "nowhere"), join(plugins, name));
				const proc = Bun.spawnSync(
					[
						"bash",
						"-c",
						`${script}\nif ap_oc_foreign_plugin_present "$1"; then printf 1; else printf 0; fi`,
						"t",
						plugins,
					],
					{ env: { PATH: "/usr/bin:/bin" } },
				);
				const sh = proc.stdout.toString();
				const ts = foreignPluginPresent(plugins, exts) ? "1" : "0";
				expect({ name, sh }).toEqual({ name, sh: ts });
			}
		});
	}

	test("a dot-prefixed .js or .ts file never counts (bob's confirm-pass Low 3), in either language", () => {
		const dir = mkdtempSync(join(tmpdir(), "ap-oc-foreign-"));
		mkdirSync(join(dir, "plugins"));
		writeFileSync(join(dir, "plugins", ".swap.js"), "x");
		writeFileSync(join(dir, "plugins", ".swap.ts"), "x");
		expect(foreignPluginPresent(join(dir, "plugins"), "js_ts")).toBe(false);
		const ps = renderPsInstaller(PS_TEMPLATE);
		expect(ps).toContain("if ($n.StartsWith('.')) { continue }");
	});
});

// ---- PowerShell, statically ---------------------------------------------------------------------

function psBlock(text: string = PS1): string {
	const begin = "# >>> agentpulse-opencode-install";
	const end = "# <<< agentpulse-opencode-install";
	return text.slice(text.indexOf(begin) + begin.length, text.indexOf(end));
}

function installFunction(block: string): string {
	return block.slice(block.indexOf("function Install-ApOpenCode"));
}

interface PsCheck {
	name: string;
	/** True when the block satisfies it. */
	holds: (block: string) => boolean;
	/** A copy of the block with that line removed. */
	without: (block: string) => string;
}

const dropLine = (re: RegExp) => (block: string) =>
	block
		.split("\n")
		.filter((l) => !re.test(l))
		.join("\n");

const PS_CHECKS: PsCheck[] = [
	{
		name: "1 a link refusal (LinkType) comes before any removal or write",
		holds: (b) => {
			const fn = installFunction(b);
			const refusal = fn.indexOf("Test-ApOcLink -Path $p");
			const firstRemove = fn.indexOf("Remove-ApOcOurs");
			const firstWrite = fn.indexOf("Write-ApOcEntry");
			return (
				b.includes(".LinkType") &&
				refusal !== -1 &&
				refusal < firstRemove &&
				refusal < firstWrite &&
				!/Remove-Item|Write-ApFileNoFollow|New-Item/.test(fn.slice(0, refusal))
			);
		},
		without: (b) => b.replace("if (Test-ApOcLink -Path $p) {", "if ($false) {"),
	},
	{
		name: "2 the SDK marker is tested as a leaf, and the dependency by Select-String -SimpleMatch unless marker_only",
		holds: (b) =>
			/Test-Path -LiteralPath \(Join-Path \$cfg \$script:ApOcSdkMarker\) -PathType Leaf/.test(b) &&
			/\$script:ApOcSdkCheck -ne 'marker_only'/.test(b) &&
			/Select-String -LiteralPath \$pkg -SimpleMatch \$script:ApOcSdkConfigDep -Quiet/.test(b),
		without: dropLine(/Select-String -LiteralPath \$pkg -SimpleMatch/),
	},
	{
		name: "3 another plugin is found with Get-ChildItem -File, by the generated extensions, excluding our names",
		holds: (b) =>
			/Get-ChildItem -LiteralPath \$Plugins -File/.test(b) &&
			/foreach \(\$e in \$script:ApOcForeignExts\)/.test(b) &&
			b.includes("'agentpulse-opencode-1.js'") &&
			b.includes("$n.StartsWith('.')"),
		without: dropLine(/foreach \(\$e in \$script:ApOcForeignExts\)/),
	},
	{
		name: "4 the decision is the generated Test-ApOcGateOpen",
		holds: (b) =>
			/Test-ApOcGateOpen -Sdk \$sdk -Foreign \$foreign -Force \$Force -Remembered \$remembered/.test(
				installFunction(b),
			),
		without: dropLine(/\$open = Test-ApOcGateOpen/),
	},
	{
		name: "5 on the closed branch only our own entry is removed, after a header check, and nothing creates plugins",
		holds: (b) => {
			const fn = installFunction(b);
			const removeFn = b.slice(
				b.indexOf("function Remove-ApOcOurs"),
				b.indexOf("function Write-ApOcEntry"),
			);
			const writeCall = fn.indexOf("Write-ApOcEntry");
			const elseAt = fn.lastIndexOf("} else {", writeCall);
			return (
				/if \(\$entry\.Gated -and -not \$open\) \{\s*Remove-ApOcOurs/.test(fn) &&
				removeFn.includes("if (Test-ApOcOurHeader -Path $top)") &&
				removeFn.includes("if (-not (Test-ApOcOurHeader -Path $index))") &&
				/Remove-Item -LiteralPath \$top -Force/.test(removeFn) &&
				!fn.includes("New-Item") &&
				elseAt !== -1 &&
				elseAt < writeCall
			);
		},
		without: (b) =>
			b
				.replace("if (Test-ApOcOurHeader -Path $top)", "if ($true)")
				.replace("if (-not (Test-ApOcOurHeader -Path $index))", "if ($false)"),
	},
	{
		name: "7 the skip message names -OpenCodeForce and the download-and-run form, and not --opencode-force",
		holds: (b) => {
			const line = b.split("\n").find((l) => l.startsWith("$script:ApOcMsgSkip = ")) ?? "";
			const text = line.slice("$script:ApOcMsgSkip = ".length).slice(1, -1).split("''").join("'");
			return (
				text ===
					renderOpenCodeMessage(OPENCODE_SDK_SKIP_MESSAGE, {
						dir: "<dir>",
						site: "install-local-ps1",
					}) &&
				text.includes("-OpenCodeForce") &&
				text.includes(
					"powershell -ExecutionPolicy Bypass -File install-local.ps1 -OpenCodeForce",
				) &&
				!text.includes("--opencode-force")
			);
		},
		without: (b) => b.replace(/-OpenCodeForce/g, "--opencode-force"),
	},
	{
		name: "8 outside the all-gated layout nothing refers to the force marker",
		holds: (b) => !b.includes("opencode-force"),
		without: (b) => `${b}\n$m = '.agentpulse\\opencode-force'`,
	},
];

describe("step 29: the PowerShell block, statically (it has never been executed)", () => {
	const block = psBlock();
	for (const check of PS_CHECKS) {
		test(`${check.name}: holds, and fails without it`, () => {
			expect(check.holds(block)).toBe(true);
			const broken = check.without(block);
			expect(broken).not.toBe(block);
			expect(check.holds(broken)).toBe(false);
		});
	}

	test("6 -OpenCodeForce and -NoOpenCode are in param(, and the call site passes both", () => {
		const params = PS1.slice(PS1.indexOf("param("), PS1.indexOf(")\n", PS1.indexOf("param(")));
		expect(params).toContain("[switch]$OpenCodeForce");
		expect(params).toContain("[switch]$NoOpenCode");
		expect(PS1).toMatch(
			/Install-ApOpenCode -BaseUrl \$PublicUrl -Direct \$true -Force \(\[bool\]\$OpenCodeForce\) -NoOpenCode \(\[bool\]\$NoOpenCode\)/,
		);
		expect(PS1).toMatch(/if \(\$NoOpenCode -or \(Test-ApOcDetected\)\)/);
	});

	test("8 in the all-gated layout the force marker is written by the private-file helper, read as a plain file of the user's, and cleared by -NoOpenCode", () => {
		const a3 = renderPsInstaller(PS_TEMPLATE, {
			layout: "all_gated",
			g9b: OPENCODE_PLAN_CONFIG.g9b,
		});
		expect(a3).toContain(
			"Write-ApPrivateFile -Path (Join-Path $HOME '.agentpulse\\opencode-force')",
		);
		expect(a3).toContain("(Get-Acl -LiteralPath $markerPath).Owner");
		expect(a3).toMatch(/Remove-Item -LiteralPath \$markerPath -Force/);
		expect(a3).toContain("$script:ApOcRemembersForce = $true");
	});

	test("the embedded plugin bodies hold no line starting '@ or \"@, each marker pair occurs once, and the block uses the shared writer", () => {
		for (const n of [1, 2]) {
			for (const edge of ["BEGIN", "END"]) {
				expect(
					PS1.split("\n").filter((l) => l === `# @@AGENTPULSE_OPENCODE_PLUGIN_${n}@@ ${edge}`)
						.length,
				).toBe(1);
			}
		}
		for (const marker of [
			"# >>> agentpulse-opencode-install",
			"# <<< agentpulse-opencode-install",
		]) {
			expect(PS1.split("\n").filter((l) => l === marker).length).toBe(1);
		}
		// Inside each plugin template (the only text we generate into a here-string) no line may start with '@ or "@.
		for (const n of [1, 2]) {
			const begin = PS1.indexOf(`# @@AGENTPULSE_OPENCODE_PLUGIN_${n}@@ BEGIN`);
			const end = PS1.indexOf(`# @@AGENTPULSE_OPENCODE_PLUGIN_${n}@@ END`);
			const body = PS1.slice(begin, end).split("\n").slice(1);
			// The first line opens the here-string and the last closes it.
			const inner = body.slice(1, body.lastIndexOf("'@"));
			expect(inner.filter((l) => l.startsWith("'@") || l.startsWith('"@'))).toEqual([]);
			expect(body.filter((l) => l === "'@").length).toBe(1);
		}
		expect(psBlock()).toContain("Write-ApFileNoFollow -Path $abs -Content $text");
	});

	const pwsh = Bun.which("pwsh");
	test.skipIf(!pwsh)("pwsh parses the script and Test-ApOcGateOpen equals the table", () => {
		const parse = Bun.spawnSync([
			pwsh as string,
			"-NoProfile",
			"-Command",
			"[void][scriptblock]::Create((Get-Content -Raw $args[0]))",
			join(ROOT, "scripts/install-local.ps1"),
		]);
		expect(parse.exitCode).toBe(0);
		const fnText = psBlock().slice(0, psBlock().indexOf("function Test-ApOcLink"));
		for (const input of INPUTS) {
			const call = `Test-ApOcGateOpen -Sdk $${input.sdkPresent} -Foreign $${input.foreignPluginPresent} -Force $${input.forceFlag} -Remembered $${input.forceRemembered}`;
			const proc = Bun.spawnSync([pwsh as string, "-NoProfile", "-Command", `${fnText}\n${call}`]);
			expect(proc.stdout.toString().trim()).toBe(
				gatedWritten(OPENCODE_PLAN_CONFIG, input) ? "True" : "False",
			);
		}
	});
	if (!pwsh) {
		test("pwsh is not installed on this runner: the PowerShell parse and the gate table were not run", () => {
			expect(pwsh).toBeNull();
		});
	}
});
