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

/** Fills the generated block and prepends the header; the hash covers everything but the header and the hash itself. */
export function buildPlugin(sources: PluginSources, line: PluginLine): BuiltPlugin {
	const lineSource = line === "v1" ? sources.v1 : sources.v2;
	const withPlaceholder = `${replaceBlock(sources.core, generatedBlockBody(BUILD_PLACEHOLDER))}${lineSource}`;
	const hash = createHash("sha256").update(withPlaceholder).digest("hex").slice(0, 14);
	const body = `${replaceBlock(sources.core, generatedBlockBody(hash))}${lineSource}`;
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
	return errors;
}
