/**
 * scripts/relay.ts is one self-contained file (the installers embed it as a
 * heredoc and it imports only node: builtins), so it cannot import the shared
 * exclude-rules evaluator. This module builds the text that stands in for the
 * import: the evaluator's source with its import statements removed, preceded
 * by the few constants it needs from hook-headers.ts. scripts/
 * embed-exclude-rules.ts writes it into relay.ts between two marker comments,
 * and scripts/check-relay-exclude-embed.ts fails when the block and what this
 * would generate differ. One implementation, mechanically embedded.
 */

import {
	type EmbedMarkers,
	checkBlock,
	extractBlock,
	replaceBlock,
	withoutImports,
} from "./relay-embed.ts";

export const RELAY_EXCLUDE_BLOCK_START =
	"// >>> exclude-rules: generated from src/shared/exclude-rules.ts and src/shared/hook-headers.ts by `bun run embed:exclude-rules`; edit those, never this block";
export const RELAY_EXCLUDE_BLOCK_END = "// <<< exclude-rules";

/** The hook-headers.ts constants the evaluator and the relay need, in the order they are carried. */
const HEADER_CONSTANTS = [
	"SKIP_HEADER",
	"SKIP_HEADER_MAX_LENGTH",
	"EXCLUDE_RULES_RELATIVE_PATH",
	"EXCLUDE_INVALID_MARKER_RELATIVE_PATH",
	"EXCLUDE_MAX_RULES",
] as const;

/** relay.ts declares this itself (it also needs it for its own private-file writes). */
const OWN_O_NOFOLLOW = "const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;";

export interface EmbedSources {
	exclusionSource: string;
	headersSource: string;
}

function headerConstant(headersSource: string, name: string): string {
	const match = new RegExp(`^export const ${name} =[^;]*;$`, "m").exec(headersSource);
	if (!match) throw new Error(`hook-headers.ts has no \`export const ${name} =\` declaration`);
	return match[0];
}

/** The text that goes between the markers. */
export function buildEmbeddedBlock({ exclusionSource, headersSource }: EmbedSources): string {
	const constants = HEADER_CONSTANTS.map((name) => headerConstant(headersSource, name)).join("\n");
	if (!exclusionSource.includes(OWN_O_NOFOLLOW)) {
		throw new Error("exclude-rules.ts no longer declares O_NOFOLLOW the way the embed expects");
	}
	const body = withoutImports(exclusionSource)
		.replace(`${OWN_O_NOFOLLOW}\n`, "")
		.replace(/^\n+/, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n+$/, "");
	return `${constants}\n\n${body}\n`;
}

const MARKERS: EmbedMarkers = { start: RELAY_EXCLUDE_BLOCK_START, end: RELAY_EXCLUDE_BLOCK_END };

/** What is between the markers now (without the newline after the start marker). */
export function extractEmbeddedBlock(relaySource: string): string {
	return extractBlock(relaySource, MARKERS);
}

export function replaceEmbeddedBlock(relaySource: string, block: string): string {
	return replaceBlock(relaySource, MARKERS, block);
}

/** Every reason the relay's block is not what the sources generate; empty when it is. */
export function checkRelayEmbed(sources: EmbedSources & { relaySource: string }): string[] {
	return checkBlock(
		sources.relaySource,
		MARKERS,
		buildEmbeddedBlock(sources),
		"exclude-rules",
		"run `bun run embed:exclude-rules` and commit scripts/relay.ts",
	);
}
