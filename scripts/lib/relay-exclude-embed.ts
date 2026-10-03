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

function withoutImports(source: string): string {
	return source.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
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

function markerIndexes(relaySource: string): { start: number; end: number } | string {
	const starts = relaySource.split(RELAY_EXCLUDE_BLOCK_START).length - 1;
	const ends = relaySource.split(RELAY_EXCLUDE_BLOCK_END).length - 1;
	if (starts !== 1 || ends !== 1) {
		return `scripts/relay.ts must contain exactly one start marker and one end marker (found ${starts} and ${ends})`;
	}
	const start = relaySource.indexOf(RELAY_EXCLUDE_BLOCK_START) + RELAY_EXCLUDE_BLOCK_START.length;
	const end = relaySource.indexOf(RELAY_EXCLUDE_BLOCK_END);
	if (end < start) return "the end marker comes before the start marker in scripts/relay.ts";
	return { start, end };
}

/** What is between the markers now (without the newline after the start marker). */
export function extractEmbeddedBlock(relaySource: string): string {
	const found = markerIndexes(relaySource);
	if (typeof found === "string") throw new Error(found);
	return relaySource.slice(found.start + 1, found.end);
}

export function replaceEmbeddedBlock(relaySource: string, block: string): string {
	const found = markerIndexes(relaySource);
	if (typeof found === "string") throw new Error(found);
	const body = block.endsWith("\n") ? block : `${block}\n`;
	return `${relaySource.slice(0, found.start)}\n${body}${relaySource.slice(found.end)}`;
}

/** Every reason the relay's block is not what the sources generate; empty when it is. */
export function checkRelayEmbed(sources: EmbedSources & { relaySource: string }): string[] {
	const fix = "run `bun run embed:exclude-rules` and commit scripts/relay.ts";
	const found = markerIndexes(sources.relaySource);
	if (typeof found === "string") return [`${found}; ${fix}`];
	const expected = buildEmbeddedBlock(sources);
	const actual = extractEmbeddedBlock(sources.relaySource);
	if (actual === expected) return [];
	const a = actual.split("\n");
	const e = expected.split("\n");
	let line = 0;
	while (line < Math.min(a.length, e.length) && a[line] === e[line]) line++;
	return [
		`the exclude-rules block in scripts/relay.ts differs from the sources at its line ${line + 1} (expected ${JSON.stringify(e[line] ?? "<end>")}, found ${JSON.stringify(a[line] ?? "<end>")}); ${fix}`,
	];
}
