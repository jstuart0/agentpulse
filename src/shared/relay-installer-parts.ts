/**
 * Pulls the three client files out of the text of a `/setup-relay.sh`: the relay, the statusline and the
 * `exclude-check.sh` heredoc. The release builder runs it on a tag's installer and a relay runs it on the
 * installer its own server serves, so both read the same bytes the installer would write to disk.
 *
 * The delimiters are the ones `buildRelayInstaller` (src/server/installers.ts) writes and the installer's
 * own `ap_load_exclude_script` reads. A part is returned exactly as the installer writes it: the lines
 * between opener and terminator, each followed by a newline.
 */

export interface RelayInstallerParts {
	/** `relay.ts` as the installer writes it. */
	relay: string;
	/** `statusline.sh` as the installer writes it. */
	statusline: string;
	/** The exclude check in installer form (ASCII, with placeholders): pass it to `materializeExcludeScript`. */
	excludeHeredoc: string;
}

export type ExtractResult =
	| { ok: true; parts: RelayInstallerParts }
	| { ok: false; reason: string };

interface Heredoc {
	label: string;
	/** Matches the whole opener line. */
	opener: (line: string) => boolean;
	terminator: string;
}

const HEREDOCS = {
	relay: {
		label: "relay.ts",
		opener: (line) => line === `cat > "$SRC_DIR/relay.ts" << 'AGENTPULSE_RELAY_TS_EOF'`,
		terminator: "AGENTPULSE_RELAY_TS_EOF",
	},
	statusline: {
		label: "statusline.sh",
		opener: (line) => line === `cat > "$SRC_DIR/statusline.sh" << 'AGENTPULSE_STATUSLINE_SH_EOF'`,
		terminator: "AGENTPULSE_STATUSLINE_SH_EOF",
	},
	excludeHeredoc: {
		label: "the exclude check",
		opener: (line) =>
			line === "\tIFS= read -r -d '' ap_exclude_script_text <<'AP_EXCLUDE_SCRIPT_EOF' || true",
		terminator: "AP_EXCLUDE_SCRIPT_EOF",
	},
} as const satisfies Record<keyof RelayInstallerParts, Heredoc>;

type Extracted = { ok: true; text: string } | { ok: false; reason: string };

function extractOne(lines: readonly string[], spec: Heredoc): Extracted {
	const opens = lines.flatMap((line, i) => (spec.opener(line) ? [i] : []));
	if (opens.length !== 1) {
		return {
			ok: false,
			reason: `setup-relay.sh has ${opens.length} openers for ${spec.label}, expected exactly one`,
		};
	}
	const start = (opens[0] as number) + 1;
	const end = lines.indexOf(spec.terminator, start);
	if (end === -1) {
		return {
			ok: false,
			reason: `setup-relay.sh has no ${spec.terminator} line after ${spec.label}`,
		};
	}
	return { ok: true, text: `${lines.slice(start, end).join("\n")}\n` };
}

export function extractRelayInstallerParts(script: string): ExtractResult {
	const lines = script.split("\n");
	const out: Partial<RelayInstallerParts> = {};
	for (const key of Object.keys(HEREDOCS) as (keyof RelayInstallerParts)[]) {
		const found = extractOne(lines, HEREDOCS[key]);
		if (!found.ok) return found;
		out[key] = found.text;
	}
	return { ok: true, parts: out as RelayInstallerParts };
}

/** Just the exclude heredoc: a tag's checked-in `setup-relay.sh` holds it verbatim, the other two parts only as markers. */
export function extractExcludeHeredoc(script: string): Extracted {
	return extractOne(script.split("\n"), HEREDOCS.excludeHeredoc);
}

export interface ClientDigests {
	relay: string;
	statusline: string;
	excludeCheck: string;
}

async function sha256HexOfText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Buffer.from(digest).toString("hex");
}

/**
 * The full sha256 of each client file, the form the release manifest carries. The relay and statusline
 * hash with trailing whitespace trimmed, as `/health`'s `clients` always has (a trailing-newline-only
 * difference is not drift); the exclude check hashes the exact bytes of the installed file, so pass it
 * through `materializeExcludeScript` first.
 */
export async function clientDigests(files: {
	relay: string;
	statusline: string;
	excludeCheck: string;
}): Promise<ClientDigests> {
	return {
		relay: await sha256HexOfText(files.relay.trimEnd()),
		statusline: await sha256HexOfText(files.statusline.trimEnd()),
		excludeCheck: await sha256HexOfText(files.excludeCheck),
	};
}

/** The terminator lines of the heredocs a client file travels in. A file holding one on a line of its own can't be carried. */
export const HEREDOC_TERMINATORS: readonly string[] = [
	HEREDOCS.relay.terminator,
	HEREDOCS.statusline.terminator,
	HEREDOCS.excludeHeredoc.terminator,
];

/** Why a client file can't be carried inside the installer, or null when it can. */
export function heredocHazard(text: string): string | null {
	const lines = text.split("\n");
	for (const terminator of HEREDOC_TERMINATORS) {
		if (lines.includes(terminator)) return `a line equal to the heredoc terminator ${terminator}`;
	}
	// Built in two pieces: this file is embedded into scripts/relay.ts, which must not itself hold the marker.
	if (text.includes(`${"@@"}AGENTPULSE_`)) return "an installer marker (the @@ AGENTPULSE_ kind)";
	return null;
}
