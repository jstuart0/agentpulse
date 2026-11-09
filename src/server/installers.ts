/**
 * The installers this server hands out, embedded at build time (F165). Every
 * client pipes them into a shell, so they're never read from a directory at
 * request time: what's served is what was built, and /health checksums the
 * same strings, so the served relay and the drift check can't disagree.
 */
import installLocalPs1 from "../../scripts/install-local.ps1" with { type: "text" };
import installLocalSh from "../../scripts/install-local.sh" with { type: "text" };
// @ts-expect-error TypeScript resolves a .ts specifier as a module; Bun's text
// loader returns the file's contents. Bun caches by path, so tests import
// relay.ts as a module only via "relay.ts?module" (check-installers.ts).
import relayTs from "../../scripts/relay.ts" with { type: "text" };
import setupRelaySh from "../../scripts/setup-relay.sh" with { type: "text" };
import statuslineSh from "../../scripts/statusline.sh" with { type: "text" };
import {
	OPENCODE_PLUGIN_V1_LINES,
	OPENCODE_PLUGIN_V2_LINES,
} from "../shared/opencode-plugin-text.generated.js";

export type InstallerSources = {
	setupRelay: string;
	relay: string;
	statusline: string;
	opencodePlugin1: string;
	opencodePlugin2: string;
	installLocalSh: string;
	installLocalPs1: string;
};

export const INSTALLER_SOURCES: Readonly<InstallerSources> = Object.freeze({
	setupRelay: setupRelaySh,
	relay: relayTs as string,
	statusline: statuslineSh,
	opencodePlugin1: OPENCODE_PLUGIN_V1_LINES.join("\n"),
	opencodePlugin2: OPENCODE_PLUGIN_V2_LINES.join("\n"),
	installLocalSh,
	installLocalPs1,
});

// setup-relay.sh gets the relay and statusline spliced in at these marker
// lines as quoted heredocs, so it installs exactly the embedded bytes.
const RELAY_EMBEDS = [
	{
		marker: "# @@AGENTPULSE_RELAY_TS@@",
		key: "relay",
		file: "relay.ts",
		terminator: "AGENTPULSE_RELAY_TS_EOF",
	},
	{
		marker: "# @@AGENTPULSE_STATUSLINE_SH@@",
		key: "statusline",
		file: "statusline.sh",
		terminator: "AGENTPULSE_STATUSLINE_SH_EOF",
	},
	{
		marker: "# @@AGENTPULSE_OPENCODE_PLUGIN_1@@",
		key: "opencodePlugin1",
		file: "agentpulse-opencode-1.js",
		terminator: "AGENTPULSE_OPENCODE_PLUGIN_1_EOF",
	},
	{
		marker: "# @@AGENTPULSE_OPENCODE_PLUGIN_2@@",
		key: "opencodePlugin2",
		file: "agentpulse-opencode-2.js",
		terminator: "AGENTPULSE_OPENCODE_PLUGIN_2_EOF",
	},
] as const;
const REMOTE_URL_PLACEHOLDER = 'REMOTE_URL_DEFAULT=""';

export type BuiltInstaller = { ok: true; script: string } | { ok: false; reason: string };

/**
 * `remoteUrl` is spliced into a double-quoted shell string; the caller must
 * pass a URL that's already been checked for shell-safe characters.
 */
export function buildRelayInstaller(
	sources: Pick<
		InstallerSources,
		"setupRelay" | "relay" | "statusline" | "opencodePlugin1" | "opencodePlugin2"
	>,
	remoteUrl: string,
): BuiltInstaller {
	let script = sources.setupRelay;
	if (script.split(REMOTE_URL_PLACEHOLDER).length !== 2) {
		return { ok: false, reason: "setup-relay.sh lacks exactly one REMOTE_URL_DEFAULT placeholder" };
	}
	script = script.replace(REMOTE_URL_PLACEHOLDER, () => `REMOTE_URL_DEFAULT="${remoteUrl}"`);
	for (const embed of RELAY_EMBEDS) {
		const body = sources[embed.key].replace(/\n+$/, "");
		if (body === "") return { ok: false, reason: `${embed.file} is empty` };
		if (body.includes("@@AGENTPULSE_")) {
			return { ok: false, reason: `${embed.file} contains an installer marker` };
		}
		if (body.split("\n").includes(embed.terminator)) {
			return { ok: false, reason: `${embed.file} contains the line ${embed.terminator}` };
		}
		const lines = script.split("\n");
		const at = lines.indexOf(embed.marker);
		if (at === -1 || lines.lastIndexOf(embed.marker) !== at) {
			return { ok: false, reason: `setup-relay.sh lacks exactly one ${embed.marker} line` };
		}
		lines[at] =
			`cat > "$SRC_DIR/${embed.file}" << '${embed.terminator}'\n${body}\n${embed.terminator}`;
		script = lines.join("\n");
	}
	return { ok: true, script };
}
