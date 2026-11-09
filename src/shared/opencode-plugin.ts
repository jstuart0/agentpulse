/**
 * The OpenCode plugins an installer writes (AGEN-141): their file names, the
 * filled text, and the install plan. The text is generated from
 * scripts/opencode-plugin/ (`bun run embed:opencode-plugin`); this module only
 * fills its two holes and decides which entries to write or remove.
 *
 * OpenCode 1.x downloads its plugin SDK into the config directory as soon as
 * a plugin file is there, and while the package registry is unreachable each
 * start then waits about 70 seconds (measured, gate G9). The 1.x entry is
 * therefore written only when that cannot add a wait the person didn't
 * already have (P19). The 2.x plugin is a directory, which 1.x ignores and
 * which 2.x loads (gate G9b).
 */

import { assertValidHookBaseUrl } from "./hook-command.js";
import {
	OPENCODE_PLUGIN_V1_LINES,
	OPENCODE_PLUGIN_V2_LINES,
} from "./opencode-plugin-text.generated.js";

/** The G9b result this module was written against; the observations test pins every value to OBSERVATIONS.md. */
export type OpenCodeLayout = "flat_v1_gated" | "v1_flat_v2_dir" | "all_gated";
export const OPENCODE_LAYOUT = "v1_flat_v2_dir" as OpenCodeLayout;
export interface OpenCodeG9b {
	sdkRule: "sdk_present" | "sdk_and_foreign_plugin";
	sdkCheck: "marker_only" | "marker_and_package";
	foreignExts: "js_only" | "js_ts";
	foreignOpens: "yes" | "no";
	wording: "each_start" | "first_start";
	v2DirFiles: "index_only" | "index_and_package" | "n/a";
}
export const OPENCODE_G9B: OpenCodeG9b = {
	sdkRule: "sdk_present",
	sdkCheck: "marker_only",
	foreignExts: "js_ts",
	foreignOpens: "yes",
	wording: "each_start",
	v2DirFiles: "index_only",
};

export const OPENCODE_PLUGIN_HEADER_PREFIX = "// agentpulse-opencode-plugin ";
export const OPENCODE_SDK_MARKER = "node_modules/@opencode-ai/plugin/package.json";
export const OPENCODE_SDK_CONFIG_DEP = '"@opencode-ai/plugin"';
/**
 * Written by an installer, never by a plugin, and only in the all-gated layout: the force option is remembered
 * here so a routine re-run doesn't take the plugin away again. It is cleared only by the no-opencode option,
 * which removes the plugins as well. Outside that layout no installer writes it.
 */
export const OPENCODE_FORCE_MARKER = ".agentpulse/opencode-force";

const BASE_URL_HOLE = "@@AP_OPENCODE_BASE_URL@@";
const DIRECT_HOLE = "@@AP_OPENCODE_DIRECT@@";

export type OpenCodeEntryName =
	| "agentpulse-opencode-1.js"
	| "agentpulse-opencode-2.js"
	| "agentpulse-opencode-2";

export interface OpenCodePluginFile {
	/** Relative to the config directory's `plugins/`. */
	name: string;
	text: string;
}

export const OPENCODE_PLUGIN_TEMPLATES = {
	v1: OPENCODE_PLUGIN_V1_LINES.join("\n"),
	v2: OPENCODE_PLUGIN_V2_LINES.join("\n"),
} as const;

/** The plugin entries in `plugins/` for a layout: its name, which file inside carries which line, and whether the 1.x SDK gate applies. */
export function openCodeEntries(layout: OpenCodeLayout = OPENCODE_LAYOUT): Array<{
	entry: OpenCodeEntryName;
	file: string;
	line: "v1" | "v2";
	gated: boolean;
}> {
	if (layout === "v1_flat_v2_dir") {
		return [
			{
				entry: "agentpulse-opencode-1.js",
				file: "agentpulse-opencode-1.js",
				line: "v1",
				gated: true,
			},
			{
				entry: "agentpulse-opencode-2",
				file: "agentpulse-opencode-2/index.js",
				line: "v2",
				gated: false,
			},
		];
	}
	return [
		{
			entry: "agentpulse-opencode-1.js",
			file: "agentpulse-opencode-1.js",
			line: "v1",
			gated: true,
		},
		{
			entry: "agentpulse-opencode-2.js",
			file: "agentpulse-opencode-2.js",
			line: "v2",
			gated: layout === "all_gated",
		},
	];
}

/** The text after the holes are filled. A URL that could break out of a quoted string is refused. */
export function buildOpenCodePluginFiles(options: {
	baseUrl: string;
	direct: boolean;
}): OpenCodePluginFile[] {
	const { baseUrl } = options;
	if (/["\\\r\n]|@@/.test(baseUrl) || !/^https?:\/\//.test(baseUrl)) {
		throw new Error(
			`invalid AgentPulse base URL for the OpenCode plugin: ${JSON.stringify(baseUrl)}`,
		);
	}
	assertValidHookBaseUrl(baseUrl);
	const direct = options.direct ? "1" : "0";
	const fill = (template: string) =>
		template.split(BASE_URL_HOLE).join(baseUrl).split(DIRECT_HOLE).join(direct);
	return openCodeEntries().map((e) => ({
		name: e.file,
		text: fill(OPENCODE_PLUGIN_TEMPLATES[e.line]),
	}));
}

// ---- the 1.x SDK gate (P19) ------------------------------------------------------------

export type OpenCodeInstallSite =
	| "cli"
	| "setup-hooks"
	| "setup-sh"
	| "setup-relay"
	| "install-local-ps1";

/** What to tell the person to run, in each installer's own spelling (one literal can't be right everywhere). */
export const OPENCODE_FORCE_INVOCATION: Record<OpenCodeInstallSite, string> = {
	cli: "agentpulse setup --opencode-force",
	"setup-hooks": "setup-hooks.sh --opencode-force",
	"setup-sh": "your setup command with `| bash -s -- --opencode-force` in place of `| bash`",
	"setup-relay": "your setup command with `| bash -s -- --opencode-force` in place of `| bash`",
	"install-local-ps1":
		"install-local.ps1 with -OpenCodeForce (download it and run `powershell -ExecutionPolicy Bypass -File install-local.ps1 -OpenCodeForce`; the `irm ... | iex` form can't pass a switch)",
};

export const OPENCODE_NO_OPENCODE_INVOCATION: Record<OpenCodeInstallSite, string> = {
	cli: "agentpulse setup --no-opencode",
	"setup-hooks": "setup-hooks.sh --no-opencode",
	"setup-sh": "your setup command with `| bash -s -- --no-opencode` in place of `| bash`",
	"setup-relay": "your setup command with `| bash -s -- --no-opencode` in place of `| bash`",
	"install-local-ps1": "install-local.ps1 with -NoOpenCode",
};

const WAIT_PHRASE = OPENCODE_G9B.wording === "each_start" ? "each start" : "the first start";

/** Templates: `<dir>` is the config directory, `<force>` and `<no-opencode>` the site's own invocations. */
export const OPENCODE_SDK_SKIP_MESSAGE = `OpenCode 1.x plugin: not installed. OpenCode 1.x downloads its plugin SDK (@opencode-ai/plugin) into <dir> only when it finds a plugin there, and while it can't reach the package registry ${WAIT_PHRASE} then waits about 70 seconds. It hasn't downloaded the SDK here, so AgentPulse left its 1.x plugin out. To add it, run <force> while this machine is online: OpenCode 1.x downloads the SDK on its next start, and setup keeps the plugin from then on. If you don't use OpenCode 1.x, nothing is needed.`;

export const OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED = `OpenCode plugin: not installed. OpenCode 1.x downloads its plugin SDK (@opencode-ai/plugin) into <dir> only when it finds a plugin there, and while it can't reach the package registry ${WAIT_PHRASE} then waits about 70 seconds. It hasn't downloaded the SDK here, so AgentPulse left its plugin out. To add it, run <force> while this machine is online: OpenCode 1.x downloads the SDK on its next start, and setup keeps the plugin from then on. OpenCode 2 isn't affected by this; if you only use OpenCode 2, <force> is safe, and setup remembers it until you run <no-opencode>.`;

export const OPENCODE_SDK_FORCE_MESSAGE = `OpenCode 1.x will download its plugin SDK into <dir> on its next start; until it can reach the package registry, ${WAIT_PHRASE} waits about 70 seconds.`;

export function renderOpenCodeMessage(
	template: string,
	values: { dir: string; site: OpenCodeInstallSite },
): string {
	return template
		.split("<dir>")
		.join(values.dir)
		.split("<force>")
		.join(OPENCODE_FORCE_INVOCATION[values.site])
		.split("<no-opencode>")
		.join(OPENCODE_NO_OPENCODE_INVOCATION[values.site]);
}

export interface OpenCodeInstallInput {
	/** `<configDir>/node_modules/@opencode-ai/plugin/package.json` is a regular file (and, unless `sdkCheck` is `marker_only`, the config `package.json` names it). */
	sdkPresent: boolean;
	/** `plugins/` holds a `.js` (or `.ts`) entry that isn't ours. */
	foreignPluginPresent: boolean;
	forceFlag: boolean;
	/** The force marker file is present and trusted. Counts only in the all-gated layout. */
	forceRemembered: boolean;
}

export interface OpenCodeInstallPlan {
	write: Array<{ entry: OpenCodeEntryName; gated: boolean }>;
	/** Entries the site removes when line 1 is our header; it never removes a foreign file. */
	remove: OpenCodeEntryName[];
	/** Templates; fill with {@link renderOpenCodeMessage}. */
	messages: string[];
	forceMarker: "write" | "keep" | "none";
}

export interface OpenCodePlanConfig {
	layout: OpenCodeLayout;
	g9b: OpenCodeG9b;
}

/** The values this build ships with; tests pass others to cover the branches a real build embeds only one of. */
export const OPENCODE_PLAN_CONFIG: OpenCodePlanConfig = {
	layout: OPENCODE_LAYOUT,
	g9b: OPENCODE_G9B,
};

export function planOpenCodeInstall(
	input: OpenCodeInstallInput,
	config: OpenCodePlanConfig = OPENCODE_PLAN_CONFIG,
): OpenCodeInstallPlan {
	const allGated = config.layout === "all_gated";
	const force = input.forceFlag || (allGated && input.forceRemembered);
	const sdkOpens = config.g9b.sdkRule === "sdk_present" && input.sdkPresent;
	const foreignOpens = config.g9b.foreignOpens === "yes" && input.foreignPluginPresent;
	const ruleHolds = sdkOpens || foreignOpens;
	const open = force || ruleHolds;

	const write: OpenCodeInstallPlan["write"] = [];
	const remove: OpenCodeEntryName[] = [];
	for (const e of openCodeEntries(config.layout)) {
		if (!e.gated || open) write.push({ entry: e.entry, gated: e.gated });
		else remove.push(e.entry);
	}
	const messages: string[] = [];
	if (!open) {
		messages.push(allGated ? OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED : OPENCODE_SDK_SKIP_MESSAGE);
	} else if (force && !ruleHolds) {
		messages.push(OPENCODE_SDK_FORCE_MESSAGE);
	}
	let forceMarker: OpenCodeInstallPlan["forceMarker"] = "none";
	if (allGated && input.forceFlag) forceMarker = "write";
	else if (allGated && input.forceRemembered) forceMarker = "keep";
	return { write, remove, messages, forceMarker };
}

// ---- what the installers observe and print --------------------------------------------------

/** Printed whenever an installer writes or keeps an OpenCode plugin: an older server files OpenCode posts as junk Claude Code rows. */
export const OPENCODE_SERVER_FIRST_NOTE =
	"Upgrade the AgentPulse server first: an older server stores OpenCode events as ordinary Claude Code sessions.";

export const OPENCODE_SERVICE_SKIP_NOTE =
	"AGENTPULSE_SKIP set in your shell is not seen by a running OpenCode 2 background service; use an exclude rule (agentpulse exclude add <dir>), or stop the service so it restarts with your environment (opencode service stop).";

/** Our two flat names, whatever the layout: a file by either name is never "someone else's plugin". */
const OPENCODE_OWN_FLAT_NAMES: readonly string[] = [
	"agentpulse-opencode-1.js",
	"agentpulse-opencode-2.js",
];

/** A file in `plugins/` that counts as another plugin: not a dot file, not ours, with an extension 1.x loads. */
export function isForeignPluginName(
	name: string,
	foreignExts: OpenCodeG9b["foreignExts"] = OPENCODE_G9B.foreignExts,
): boolean {
	if (name === "" || name.startsWith(".") || OPENCODE_OWN_FLAT_NAMES.includes(name)) return false;
	const exts = foreignExts === "js_ts" ? [".js", ".ts"] : [".js"];
	return exts.some((ext) => name.length > ext.length && name.endsWith(ext));
}

/** `OPENCODE_CONFIG_DIR` (absolute), else `XDG_CONFIG_HOME` (absolute) plus `/opencode`, else `<home>/.config/opencode`. */
export function resolveOpenCodeConfigDir(
	env: Record<string, string | undefined>,
	home: string,
): { dir: string; fromEnv: boolean } {
	const isAbs = (v: string | undefined): v is string => typeof v === "string" && v.startsWith("/");
	const trim = (v: string) => v.replace(/\/+$/, "") || "/";
	if (isAbs(env.OPENCODE_CONFIG_DIR)) return { dir: trim(env.OPENCODE_CONFIG_DIR), fromEnv: true };
	if (isAbs(env.XDG_CONFIG_HOME))
		return { dir: `${trim(env.XDG_CONFIG_HOME)}/opencode`, fromEnv: false };
	return { dir: `${home}/.config/opencode`, fromEnv: false };
}

/** The data directory whose existence alone says OpenCode has run here. */
export function resolveOpenCodeDataDir(
	env: Record<string, string | undefined>,
	home: string,
): string {
	const x = env.XDG_DATA_HOME;
	const base =
		typeof x === "string" && x.startsWith("/") ? x.replace(/\/+$/, "") : `${home}/.local/share`;
	return `${base}/opencode`;
}
