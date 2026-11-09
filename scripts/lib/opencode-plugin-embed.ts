/**
 * Builds the OpenCode plugin texts (AGEN-141, P14) and checks every copy of
 * them. The sources are scripts/opencode-plugin/core.js (shared) plus one file
 * per OpenCode line. The core holds an empty `@@AP_GENERATED` block; this
 * module fills it from the shared constants (skip values, send status, file
 * names, SH_GATE_PIECE, the known error names), so the plugin carries the
 * same text the shell hooks run instead of a second hand-written copy.
 *
 * Output: src/shared/opencode-plugin-text.generated.ts (one string per line and
 * a content hash per file) and the bodies between the marker pairs in
 * setup-hooks.sh and install-local.ps1. setup-relay.sh has no committed copy;
 * src/server/installers.ts splices the same text in at serve time.
 */

import { createHash } from "node:crypto";
import { isSkipValue } from "../../src/shared/exclude-rules.ts";
import { SH_GATE_PIECE } from "../../src/shared/hook-command.ts";
import {
	DELIVERY_ID_HEADER,
	EXCLUDE_INVALID_MARKER_RELATIVE_PATH,
	EXCLUDE_RULES_RELATIVE_PATH,
	EXCLUDE_SCRIPT_RELATIVE_PATH,
	EXCLUDE_SCRIPT_SEND_STATUS,
	HOST_HEADER,
} from "../../src/shared/hook-headers.ts";
import { OPENCODE_KNOWN_ERROR_NAMES } from "../../src/shared/opencode-wire.ts";

export const GENERATED_BEGIN = "// @@AP_GENERATED BEGIN";
export const GENERATED_END = "// @@AP_GENERATED END";
export const AUTH_HEADER_FILE = "hook-auth-header";
const BUILD_PLACEHOLDER = "00000000000000";
const SKIP_CANDIDATES = ["1", "true", "yes", "on", "0", "false", "no", "off", ""];

export type PluginLine = "v1" | "v2";

export interface PluginSources {
	core: string;
	v1: string;
	v2: string;
}

export interface BuiltPlugin {
	/** The whole file with its `@@AP_OPENCODE_*@@` holes, header on line 1. */
	text: string;
	hash: string;
}

/** A double-quoted JS literal with every `$`, backtick and non-ASCII character as a `\u` escape. */
export function escapedLiteral(value: string): string {
	return JSON.stringify(value).replace(/[^\x20-\x7e]|[$`]/g, (ch) => {
		return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

/** Decode a literal written by {@link escapedLiteral}. */
export function decodeLiteral(literal: string): string {
	return JSON.parse(literal) as string;
}

function lastSegment(relative: string): string {
	return relative.split("/").slice(-1)[0] as string;
}

export function generatedBlockBody(build: string): string {
	const skipValues = SKIP_CANDIDATES.filter((v) => isSkipValue(v));
	const lines = [
		`const AP_BUILD = ${escapedLiteral(build)};`,
		`const AP_SKIP_VALUES = JSON.parse(${escapedLiteral(JSON.stringify(skipValues))});`,
		`const AP_SEND_STATUS = ${EXCLUDE_SCRIPT_SEND_STATUS};`,
		`const AP_AGENTPULSE_DIR = ${escapedLiteral(EXCLUDE_RULES_RELATIVE_PATH.split("/")[0] as string)};`,
		`const AP_RULES_FILE = ${escapedLiteral(lastSegment(EXCLUDE_RULES_RELATIVE_PATH))};`,
		`const AP_MARKER_FILE = ${escapedLiteral(lastSegment(EXCLUDE_INVALID_MARKER_RELATIVE_PATH))};`,
		`const AP_SCRIPT_FILE = ${escapedLiteral(lastSegment(EXCLUDE_SCRIPT_RELATIVE_PATH))};`,
		`const AP_AUTH_HEADER_FILE = ${escapedLiteral(AUTH_HEADER_FILE)};`,
		`const AP_DELIVERY_HEADER = ${escapedLiteral(DELIVERY_ID_HEADER)};`,
		`const AP_HOST_HEADER = ${escapedLiteral(HOST_HEADER)};`,
		`const AP_KNOWN_ERROR_NAMES = JSON.parse(${escapedLiteral(JSON.stringify([...OPENCODE_KNOWN_ERROR_NAMES]))});`,
		`const AP_GATE_PIECE = ${escapedLiteral(SH_GATE_PIECE)};`,
	];
	return lines.join("\n");
}

function replaceBlock(core: string, body: string): string {
	const begin = core.indexOf(GENERATED_BEGIN);
	const end = core.indexOf(GENERATED_END);
	if (
		begin === -1 ||
		end === -1 ||
		end < begin ||
		core.indexOf(GENERATED_BEGIN, begin + 1) !== -1
	) {
		throw new Error("core.js must hold exactly one @@AP_GENERATED BEGIN/END pair");
	}
	return `${core.slice(0, begin + GENERATED_BEGIN.length)}\n${body}\n${core.slice(end)}`;
}

function headerLine(hash: string): string {
	return `// agentpulse-opencode-plugin ${hash}`;
}

export const SEAM_BEGIN = "// @@AP_TEST_SEAM BEGIN";
export const SEAM_ELSE = "// @@AP_TEST_SEAM ELSE";
export const SEAM_END = "// @@AP_TEST_SEAM END";

/** The core with its test-seam section resolved: the seam variant for the test kit, the plain one for every installed copy. */
export function selectSeam(core: string, seam: boolean): string {
	const lines = core.split("\n");
	const b = lines.indexOf(SEAM_BEGIN);
	const e = lines.indexOf(SEAM_ELSE);
	const x = lines.indexOf(SEAM_END);
	if (
		b === -1 ||
		!(b < e && e < x) ||
		lines.lastIndexOf(SEAM_BEGIN) !== b ||
		lines.lastIndexOf(SEAM_ELSE) !== e ||
		lines.lastIndexOf(SEAM_END) !== x
	) {
		throw new Error("core.js must hold exactly one @@AP_TEST_SEAM BEGIN/ELSE/END triple, in order");
	}
	const kept = seam ? lines.slice(b + 1, e) : lines.slice(e + 1, x);
	return [...lines.slice(0, b), ...kept, ...lines.slice(x + 1)].join("\n");
}

/**
 * Fills the generated block and prepends the header; the hash covers everything but the header and the hash
 * itself, and is the same for the seam variant (tests only), which is never embedded.
 */
export function buildPlugin(
	sources: PluginSources,
	line: PluginLine,
	options: { seam?: boolean } = {},
): BuiltPlugin {
	const lineSource = line === "v1" ? sources.v1 : sources.v2;
	const plainCore = selectSeam(sources.core, false);
	const withPlaceholder = `${replaceBlock(plainCore, generatedBlockBody(BUILD_PLACEHOLDER))}${lineSource}`;
	const hash = createHash("sha256").update(withPlaceholder).digest("hex").slice(0, 14);
	const core = options.seam ? selectSeam(sources.core, true) : plainCore;
	const body = `${replaceBlock(core, generatedBlockBody(hash))}${lineSource}`;
	return { text: `${headerLine(hash)}\n${body}`, hash };
}

/** The reasons a final plugin text is not safe to embed in a heredoc, a PowerShell here-string or a template. */
export function sourceRuleViolations(text: string, label: string): string[] {
	const problems: string[] = [];
	if (text.includes("`")) problems.push(`${label}: contains a backtick`);
	if (text.includes("${")) problems.push(`${label}: contains \${`);
	if (/[^\t\n\x20-\x7e]/.test(text))
		problems.push(`${label}: contains a non-ASCII or control character`);
	const lines = text.split("\n");
	for (const terminator of HEREDOC_TERMINATORS) {
		if (lines.includes(terminator)) problems.push(`${label}: contains the line ${terminator}`);
	}
	if (lines.some((l) => l.startsWith("'@") || l.startsWith('"@'))) {
		problems.push(`${label}: a line starts with '@ or "@`);
	}
	for (const match of text.matchAll(/^import .* from "([^"]+)";$/gm)) {
		if (!(match[1] as string).startsWith("node:")) problems.push(`${label}: imports ${match[1]}`);
	}
	return problems;
}

export const HEREDOC_TERMINATORS = [
	"AP_OPENCODE_PLUGIN_1_EOF",
	"AP_OPENCODE_PLUGIN_2_EOF",
	"AGENTPULSE_OPENCODE_PLUGIN_1_EOF",
	"AGENTPULSE_OPENCODE_PLUGIN_2_EOF",
];

// ---- src/shared/opencode-plugin-text.generated.ts ---------------------------------

const GENERATED_TS_HEADER =
	"// Generated by `bun run embed:opencode-plugin` from scripts/opencode-plugin/. Edit those, never this file.\n";

export function generatedModuleText(built: Record<PluginLine, BuiltPlugin>): string {
	// Shaped the way Biome formats it, so `biome check` has nothing to say about the generated file.
	const lines = (b: BuiltPlugin) =>
		`[\n${b.text
			.split("\n")
			.map((l) => `\t${JSON.stringify(l)},`)
			.join("\n")}\n]`;
	return [
		GENERATED_TS_HEADER,
		"export const OPENCODE_PLUGIN_HASHES = {",
		`\tv1: ${JSON.stringify(built.v1.hash)},`,
		`\tv2: ${JSON.stringify(built.v2.hash)},`,
		"} as const;\n",
		`export const OPENCODE_PLUGIN_V1_LINES: readonly string[] = ${lines(built.v1)};\n`,
		`export const OPENCODE_PLUGIN_V2_LINES: readonly string[] = ${lines(built.v2)};\n`,
	].join("\n");
}

// ---- the marker pairs in the two installers ---------------------------------------

export const SITE_MARKERS = {
	v1: {
		begin: "# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ BEGIN",
		end: "# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ END",
	},
	v2: {
		begin: "# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ BEGIN",
		end: "# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ END",
	},
} as const;

export type Site = "sh" | "ps1";

export function siteBody(site: Site, line: PluginLine, built: BuiltPlugin): string {
	const n = line === "v1" ? 1 : 2;
	if (site === "sh") {
		return [
			`ap_opencode_plugin_${n}_template() {`,
			`cat <<'AP_OPENCODE_PLUGIN_${n}_EOF'`,
			built.text,
			`AP_OPENCODE_PLUGIN_${n}_EOF`,
			"}",
		].join("\n");
	}
	return [`$ApOpenCodePlugin${n}Template = @'`, built.text, "'@"].join("\n");
}

export function markerCount(source: string, marker: string): number {
	return source.split("\n").filter((l) => l === marker).length;
}

export function replaceSiteBody(source: string, line: PluginLine, body: string): string {
	const { begin, end } = SITE_MARKERS[line];
	if (markerCount(source, begin) !== 1 || markerCount(source, end) !== 1) {
		throw new Error(`expected exactly one ${begin} / ${end} pair`);
	}
	const lines = source.split("\n");
	const b = lines.indexOf(begin);
	const e = lines.indexOf(end);
	if (e < b) throw new Error(`${end} comes before ${begin}`);
	return [...lines.slice(0, b + 1), body, ...lines.slice(e)].join("\n");
}

export function siteBodyNow(source: string, line: PluginLine): string {
	const { begin, end } = SITE_MARKERS[line];
	const lines = source.split("\n");
	const b = lines.indexOf(begin);
	const e = lines.indexOf(end);
	if (markerCount(source, begin) !== 1 || markerCount(source, end) !== 1 || e < b) {
		throw new Error(`expected exactly one ${begin} / ${end} pair`);
	}
	return lines.slice(b + 1, e).join("\n");
}

// ---- the whole check --------------------------------------------------------------

export interface EmbedInputs {
	sources: PluginSources;
	generatedModule: string;
	setupHooksSh: string;
	installLocalPs1: string;
	setupRelaySh: string;
	installShTemplate: string;
	installPsTemplate: string;
	installerModule: string;
}

export function buildAll(sources: PluginSources): Record<PluginLine, BuiltPlugin> {
	return { v1: buildPlugin(sources, "v1"), v2: buildPlugin(sources, "v2") };
}

/** Every reason the committed copies differ from what the sources generate; empty when they match. */
export function checkOpenCodePluginEmbed(input: EmbedInputs): string[] {
	const fix = "run `bun run embed:opencode-plugin` and commit the result";
	const errors: string[] = [];
	let built: Record<PluginLine, BuiltPlugin>;
	try {
		built = buildAll(input.sources);
	} catch (e) {
		return [(e as Error).message];
	}
	for (const line of ["v1", "v2"] as const) {
		errors.push(...sourceRuleViolations(built[line].text, `the ${line} plugin text`));
		if (/AP_TEST_SEAM|agentpulse\.opencode\.seam|@@AP_TEST_SEAM/.test(built[line].text)) {
			errors.push(`the ${line} plugin text carries the test seam`);
		}
		if (!built[line].text.includes("@@AP_OPENCODE_BASE_URL@@")) {
			errors.push(`the ${line} plugin text has lost its AP_CONFIG hole`);
		}
	}
	if (input.generatedModule !== generatedModuleText(built)) {
		errors.push(`src/shared/opencode-plugin-text.generated.ts differs from the sources; ${fix}`);
	}
	for (const [label, source, site] of [
		["setup-hooks.sh", input.setupHooksSh, "sh"],
		["install-local.ps1", input.installLocalPs1, "ps1"],
	] as const) {
		for (const line of ["v1", "v2"] as const) {
			try {
				if (siteBodyNow(source, line) !== siteBody(site, line, built[line])) {
					errors.push(
						`${label} holds a different ${line} plugin than the sources generate; ${fix}`,
					);
				}
			} catch (e) {
				errors.push(`${label}: ${(e as Error).message}`);
			}
		}
	}
	for (const line of ["v1", "v2"] as const) {
		const n = line === "v1" ? 1 : 2;
		const marker = `# @@AGENTPULSE_OPENCODE_PLUGIN_${n}@@`;
		if (markerCount(input.setupRelaySh, marker) !== 1) {
			errors.push(`setup-relay.sh must hold exactly one ${marker} line`);
		}
	}
	try {
		const wanted: Array<[string, string, "sh" | "ps1", string]> = [
			[
				"setup-hooks.sh",
				input.setupHooksSh,
				"sh",
				renderShInstaller(input.installShTemplate, "setup-hooks"),
			],
			[
				"setup-relay.sh",
				input.setupRelaySh,
				"sh",
				renderShInstaller(input.installShTemplate, "setup-relay"),
			],
			[
				"install-local.ps1",
				input.installLocalPs1,
				"ps1",
				renderPsInstaller(input.installPsTemplate),
			],
		];
		for (const [label, source, kind, body] of wanted) {
			try {
				if (installBodyNow(source, kind) !== body) {
					errors.push(
						`${label} holds a different OpenCode installer step than the templates generate; ${fix}`,
					);
				}
			} catch (e) {
				errors.push(`${label}: ${(e as Error).message}`);
			}
		}
		if (
			input.installerModule !==
			installerModuleText(renderShInstaller(input.installShTemplate, "setup-sh"))
		) {
			errors.push(
				`src/shared/opencode-install-text.generated.ts differs from the templates; ${fix}`,
			);
		}
	} catch (e) {
		errors.push((e as Error).message);
	}
	return errors;
}

// ---- the installer step (AGEN-141, P19) ----------------------------------------------
// scripts/opencode-installer/install.sh and install.ps1 are templates. Their @@AP_OC_*@@ lines are
// filled here from src/shared/opencode-plugin.ts, so the shell and PowerShell decision functions are
// generated from the same data planOpenCodeInstall reads.

import {
	OPENCODE_PLAN_CONFIG,
	OPENCODE_PLUGIN_HEADER_PREFIX,
	OPENCODE_SDK_CONFIG_DEP,
	OPENCODE_SDK_FORCE_MESSAGE,
	OPENCODE_SDK_MARKER,
	OPENCODE_SDK_SKIP_MESSAGE,
	OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED,
	OPENCODE_SERVER_FIRST_NOTE,
	OPENCODE_SERVICE_SKIP_NOTE,
	type OpenCodeInstallSite,
	type OpenCodePlanConfig,
	openCodeEntries,
	renderOpenCodeMessage,
} from "../../src/shared/opencode-plugin.ts";

export const INSTALL_MARKERS = {
	sh: {
		begin: "# >>> agentpulse-opencode-install",
		end: "# <<< agentpulse-opencode-install",
	},
	ps1: {
		begin: "# >>> agentpulse-opencode-install",
		end: "# <<< agentpulse-opencode-install",
	},
} as const;

export type ShSite = "setup-hooks" | "setup-sh" | "setup-relay";

const shQuote = (value: string) => `'${value.split("'").join("'\\''")}'`;
const psQuote = (value: string) => `'${value.split("'").join("''")}'`;

function messagesFor(config: OpenCodePlanConfig, site: OpenCodeInstallSite) {
	const allGated = config.layout === "all_gated";
	const fill = (template: string) =>
		// <dir> stays: it is the config folder the installer found at run time.
		renderOpenCodeMessage(template, { dir: "<dir>", site });
	return {
		skip: fill(allGated ? OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED : OPENCODE_SDK_SKIP_MESSAGE),
		force: fill(OPENCODE_SDK_FORCE_MESSAGE),
	};
}

function replaceTokenLine(text: string, token: string, replacement: string | null): string {
	const lines = text.split("\n");
	const at = lines.indexOf(token);
	if (at === -1 || lines.lastIndexOf(token) !== at) {
		throw new Error(`the installer template must hold exactly one ${token} line`);
	}
	if (replacement === null) lines.splice(at, 1);
	else lines.splice(at, 1, replacement);
	return lines.join("\n");
}

/** The shell installer step for one site, from install.sh. */
export function renderShInstaller(
	template: string,
	site: ShSite,
	config: OpenCodePlanConfig = OPENCODE_PLAN_CONFIG,
): string {
	const remembers = config.layout === "all_gated";
	const msg = messagesFor(config, site);
	const entries = openCodeEntries(config.layout)
		.map(
			(e) =>
				`${e.entry}|${e.file}|${e.line === "v1" ? 1 : 2}|${e.gated ? 1 : 0}|${e.file === e.entry ? "file" : "dir"}`,
		)
		.join("\n");
	const exts = config.g9b.foreignExts === "js_ts" ? "js ts" : "js";
	const data = [
		`AP_OC_SDK_MARKER=${shQuote(OPENCODE_SDK_MARKER)}`,
		`AP_OC_SDK_CONFIG_DEP=${shQuote(OPENCODE_SDK_CONFIG_DEP)}`,
		`AP_OC_SDK_RULE=${shQuote(config.g9b.sdkRule)}`,
		`AP_OC_SDK_CHECK=${shQuote(config.g9b.sdkCheck)}`,
		`AP_OC_FOREIGN_EXTS=${shQuote(exts)}`,
		`AP_OC_FOREIGN_OPENS=${shQuote(config.g9b.foreignOpens)}`,
		`AP_OC_LAYOUT=${shQuote(config.layout)}`,
		`AP_OC_REMEMBERS_FORCE=${remembers ? 1 : 0}`,
		`AP_OC_HEADER_PREFIX=${shQuote(OPENCODE_PLUGIN_HEADER_PREFIX)}`,
		`AP_OC_ENTRIES=${shQuote(entries)}`,
		`AP_OC_MSG_SKIP=${shQuote(msg.skip)}`,
		`AP_OC_MSG_FORCE=${shQuote(msg.force)}`,
		`AP_OC_NOTE_SERVER_FIRST=${shQuote(OPENCODE_SERVER_FIRST_NOTE)}`,
		`AP_OC_NOTE_SERVICE_SKIP=${shQuote(OPENCODE_SERVICE_SKIP_NOTE)}`,
	].join("\n");
	const gate = [
		"# ap_oc_gate_open <sdk> <foreign> <force> <remembered>, each 0 or 1: exit 0 when the gated entries are written.",
		"ap_oc_gate_open() {",
		'\t[ "$3" = 1 ] && return 0',
		'\t[ "$AP_OC_REMEMBERS_FORCE" = 1 ] && [ "$4" = 1 ] && return 0',
		'\t[ "$AP_OC_SDK_RULE" = sdk_present ] && [ "$1" = 1 ] && return 0',
		'\t[ "$AP_OC_FOREIGN_OPENS" = yes ] && [ "$2" = 1 ] && return 0',
		"\treturn 1",
		"}",
		"",
		"# ap_oc_foreign_plugin_present <plugins dir>: a plain file there that is not a dot file, not ours, and has a listed extension.",
		"ap_oc_foreign_plugin_present() {",
		'\tlocal p="$1" f n e',
		'\t[ -d "$p" ] || return 1',
		'\tfor f in "$p"/*; do',
		'\t\t[ -f "$f" ] || continue',
		'\t\tn="${f##*/}"',
		'\t\tcase "$n" in .*|agentpulse-opencode-1.js|agentpulse-opencode-2.js) continue ;; esac',
		"\t\tfor e in $AP_OC_FOREIGN_EXTS; do",
		'\t\t\tcase "$n" in ?*."$e") return 0 ;; esac',
		"\t\tdone",
		"\tdone",
		"\treturn 1",
		"}",
	].join("\n");
	const remembered = remembers
		? [
				'\tif [ -L "$marker" ]; then',
				'\t\techo "  - Ignoring $marker: it is not a plain file of yours."',
				'\telif [ -e "$marker" ]; then',
				'\t\tif [ -f "$marker" ] && [ -O "$marker" ]; then',
				"\t\t\tremembered=1",
				"\t\telse",
				'\t\t\techo "  - Ignoring $marker: it is not a plain file of yours."',
				"\t\tfi",
				"\tfi",
			].join("\n")
		: null;
	const noopMarker = remembers
		? [
				'\t\tif [ -e "$marker" ] || [ -L "$marker" ]; then',
				'\t\t\trm -f -- "$marker"',
				'\t\t\techo "  ✓ Removed $marker"',
				"\t\tfi",
			].join("\n")
		: null;
	const writeMarker = remembers
		? [
				'\tif [ "$force" = 1 ]; then',
				'\t\tap_write_private_no_follow "$marker" "1"$\'\\n\' || return 1',
				"\tfi",
			].join("\n")
		: null;
	let out = replaceTokenLine(template, "@@AP_OC_DATA@@", data);
	out = replaceTokenLine(out, "@@AP_OC_GATE@@", gate);
	out = replaceTokenLine(out, "@@AP_OC_REMEMBERED@@", remembered);
	out = replaceTokenLine(out, "@@AP_OC_NOOP_MARKER@@", noopMarker);
	out = replaceTokenLine(out, "@@AP_OC_WRITE_MARKER@@", writeMarker);
	return out.replace(/\n+$/, "");
}

/** The PowerShell installer step, from install.ps1. */
export function renderPsInstaller(
	template: string,
	config: OpenCodePlanConfig = OPENCODE_PLAN_CONFIG,
): string {
	const remembers = config.layout === "all_gated";
	const msg = messagesFor(config, "install-local-ps1");
	const exts = config.g9b.foreignExts === "js_ts" ? ["js", "ts"] : ["js"];
	const data = [
		`$script:ApOcSdkMarker = ${psQuote(OPENCODE_SDK_MARKER)}`,
		`$script:ApOcSdkConfigDep = ${psQuote(OPENCODE_SDK_CONFIG_DEP)}`,
		`$script:ApOcSdkRule = ${psQuote(config.g9b.sdkRule)}`,
		`$script:ApOcSdkCheck = ${psQuote(config.g9b.sdkCheck)}`,
		`$script:ApOcForeignExts = @(${exts.map(psQuote).join(", ")})`,
		`$script:ApOcForeignOpens = ${psQuote(config.g9b.foreignOpens)}`,
		`$script:ApOcLayout = ${psQuote(config.layout)}`,
		`$script:ApOcRemembersForce = $${remembers ? "true" : "false"}`,
		`$script:ApOcHeaderPrefix = ${psQuote(OPENCODE_PLUGIN_HEADER_PREFIX)}`,
		"$script:ApOcFromEnv = $false",
		"$script:ApOcEntries = @(",
		openCodeEntries(config.layout)
			.map(
				(e) =>
					`  [pscustomobject]@{ Name = ${psQuote(e.entry)}; File = ${psQuote(e.file)}; Line = ${e.line === "v1" ? 1 : 2}; Gated = $${e.gated ? "true" : "false"}; Kind = ${psQuote(e.file === e.entry ? "file" : "dir")} }`,
			)
			.join("\n"),
		")",
		`$script:ApOcMsgSkip = ${psQuote(msg.skip)}`,
		`$script:ApOcMsgForce = ${psQuote(msg.force)}`,
		`$script:ApOcNoteServerFirst = ${psQuote(OPENCODE_SERVER_FIRST_NOTE)}`,
		`$script:ApOcNoteServiceSkip = ${psQuote(OPENCODE_SERVICE_SKIP_NOTE)}`,
	].join("\n");
	const gate = [
		"# Test-ApOcGateOpen: $true when the gated entries are written (the same table as ap_oc_gate_open and planOpenCodeInstall).",
		"function Test-ApOcGateOpen {",
		"  param([bool]$Sdk, [bool]$Foreign, [bool]$Force, [bool]$Remembered)",
		"  if ($Force) { return $true }",
		"  if ($script:ApOcRemembersForce -and $Remembered) { return $true }",
		"  if ($script:ApOcSdkRule -eq 'sdk_present' -and $Sdk) { return $true }",
		"  if ($script:ApOcForeignOpens -eq 'yes' -and $Foreign) { return $true }",
		"  return $false",
		"}",
		"",
		"# A plain file in plugins that is not a dot file, not ours, and has a listed extension.",
		"function Test-ApOcForeignPlugin {",
		"  param([Parameter(Mandatory = $true)][string]$Plugins)",
		"  if (-not (Test-Path -LiteralPath $Plugins -PathType Container)) { return $false }",
		"  foreach ($f in @(Get-ChildItem -LiteralPath $Plugins -File -Force)) {",
		"    $n = $f.Name",
		"    if ($n.StartsWith('.')) { continue }",
		"    if ($n -eq 'agentpulse-opencode-1.js' -or $n -eq 'agentpulse-opencode-2.js') { continue }",
		"    foreach ($e in $script:ApOcForeignExts) {",
		'      if ($n.Length -gt $e.Length + 1 -and $n.EndsWith(".$e")) { return $true }',
		"    }",
		"  }",
		"  return $false",
		"}",
	].join("\n");
	const marker = "(Join-Path $HOME '.agentpulse\\opencode-force')";
	const remembered = remembers
		? [
				"  $remembered = $false",
				`  $markerPath = ${marker}`,
				"  $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue",
				"  if ($markerItem) {",
				"    if ((Get-Item -LiteralPath $markerPath -Force).LinkType -or $markerItem.PSIsContainer -or (Get-Acl -LiteralPath $markerPath).Owner -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) {",
				'      Write-Step "Ignoring $markerPath: it is not a plain file of yours."',
				"    } else {",
				"      $remembered = $true",
				"    }",
				"  }",
			].join("\n")
		: "  $remembered = $false";
	const noopMarker = remembers
		? [
				`    $markerPath = ${marker}`,
				"    if (Test-Path -LiteralPath $markerPath) {",
				"      Remove-Item -LiteralPath $markerPath -Force",
				'      Write-Step "Removed $markerPath"',
				"    }",
			].join("\n")
		: null;
	const writeMarker = remembers
		? ["  if ($Force) {", `    Write-ApPrivateFile -Path ${marker} -Content "1\`n"`, "  }"].join(
				"\n",
			)
		: null;
	let out = replaceTokenLine(template, "@@AP_OC_DATA@@", data);
	out = replaceTokenLine(out, "@@AP_OC_GATE@@", gate);
	out = replaceTokenLine(out, "@@AP_OC_REMEMBERED@@", remembered);
	out = replaceTokenLine(out, "@@AP_OC_NOOP_MARKER@@", noopMarker);
	out = replaceTokenLine(out, "@@AP_OC_WRITE_MARKER@@", writeMarker);
	return out.replace(/\n+$/, "");
}

export function replaceInstallBody(source: string, kind: "sh" | "ps1", body: string): string {
	const { begin, end } = INSTALL_MARKERS[kind];
	if (markerCount(source, begin) !== 1 || markerCount(source, end) !== 1) {
		throw new Error(`expected exactly one ${begin} / ${end} pair`);
	}
	const lines = source.split("\n");
	const b = lines.indexOf(begin);
	const e = lines.indexOf(end);
	if (e < b) throw new Error(`${end} comes before ${begin}`);
	return [...lines.slice(0, b + 1), body, ...lines.slice(e)].join("\n");
}

export function installBodyNow(source: string, kind: "sh" | "ps1"): string {
	const { begin, end } = INSTALL_MARKERS[kind];
	const lines = source.split("\n");
	const b = lines.indexOf(begin);
	const e = lines.indexOf(end);
	if (markerCount(source, begin) !== 1 || markerCount(source, end) !== 1 || e < b) {
		throw new Error(`expected exactly one ${begin} / ${end} pair`);
	}
	return lines.slice(b + 1, e).join("\n");
}

const INSTALLER_GENERATED_HEADER =
	"// Generated by `bun run embed:opencode-plugin` from scripts/opencode-installer/. Edit those, never this file.\n";

/** The /setup.sh template's copy: the one shell block the server interpolates. */
export function installerModuleText(setupShBlock: string): string {
	return [
		INSTALLER_GENERATED_HEADER,
		`export const OPENCODE_SH_INSTALLER_SETUP_SH_LINES: readonly string[] = [\n${setupShBlock
			.split("\n")
			.map((l) => `\t${JSON.stringify(l)},`)
			.join("\n")}\n];\n`,
	].join("\n");
}
