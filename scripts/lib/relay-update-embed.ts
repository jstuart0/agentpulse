/**
 * The blocks of shared source that scripts/relay.ts carries so it can verify a signed release manifest and
 * refresh its own files without importing anything. Each block is one source file (or, for the exclude check's
 * installer form, the few declarations of hook-command.ts that turn it back into bytes) with its imports
 * removed, in dependency order, between a pair of marker comments. `scripts/embed-relay-update.ts` writes
 * them and `scripts/check-relay-update-embed.ts` (chained into `check:architecture`) fails on any drift, so
 * the relay's verifier and trust root are the repo's, never a hand-edited copy.
 */
import { type EmbedMarkers, checkBlock, replaceBlock, withoutImports } from "./relay-embed.ts";

export interface UpdateEmbedBlock {
	name: string;
	/** Repo-relative source files, for the marker's comment and for the reader of a drift message. */
	sources: readonly string[];
	build(read: (rel: string) => string): string;
}

export function updateBlockMarkers(
	block: Pick<UpdateEmbedBlock, "name" | "sources">,
): EmbedMarkers {
	return {
		start: `// BEGIN ${block.name} embed: generated from ${block.sources.join(" and ")} by \`bun run embed:relay-update\`; edit the source, never this block`,
		end: `// END ${block.name} embed`,
	};
}

function whole(rel: string): (read: (rel: string) => string) => string {
	return (read) => withoutImports(read(rel)).replace(/^\n+/, "").replace(/\n+$/, "\n");
}

function declarationOf(source: string, pattern: RegExp, what: string): string {
	const match = pattern.exec(source);
	if (!match)
		throw new Error(`hook-command.ts has no ${what} the exclude-materialize embed expects`);
	return match[0];
}

/** TAB, CR and BOM, the installer placeholders and `materializeExcludeScript`: what turns the heredoc into the file's bytes. */
function excludeMaterialize(read: (rel: string) => string): string {
	const source = read("src/shared/hook-command.ts");
	const chars = (["TAB", "CARRIAGE_RETURN", "BYTE_ORDER_MARK"] as const).map((name) =>
		declarationOf(source, new RegExp(`^const ${name} = [^\\n]*;$`, "m"), `\`const ${name}\``),
	);
	const placeholders = declarationOf(
		source,
		/^export const INSTALLER_SNIPPET_PLACEHOLDERS = \{[\s\S]*?\} as const;$/m,
		"INSTALLER_SNIPPET_PLACEHOLDERS",
	);
	const materialize = declarationOf(
		source,
		/^export function materializeExcludeScript\(installerForm: string\): string \{[\s\S]*?\n\}$/m,
		"materializeExcludeScript",
	);
	return `${chars.join("\n")}\n\n${placeholders}\n\n${materialize}\n`;
}

/** The agent-session marker lists and the check over them: `FORK_ENV_STRIP_EXACT` through `agentSessionMarker`. */
function agentSessionMarkers(read: (rel: string) => string): string {
	const source = read("src/shared/launch-env-policy.ts");
	const start = source.indexOf("export const FORK_ENV_STRIP_EXACT");
	const fn = source.indexOf("export function agentSessionMarker(");
	if (start === -1 || fn === -1) {
		throw new Error("launch-env-policy.ts no longer has the marker lists the embed expects");
	}
	const end = source.indexOf("\n}\n", fn);
	if (end === -1) throw new Error("launch-env-policy.ts: agentSessionMarker has no end");
	return `${source.slice(start, end + 2)}\n`;
}

/** In dependency order: a block only uses what the ones before it declare. */
export const UPDATE_EMBED_BLOCKS: readonly UpdateEmbedBlock[] = [
	{ name: "version", sources: ["src/shared/version.ts"], build: whole("src/shared/version.ts") },
	{
		name: "release-keys",
		sources: ["src/shared/release-keys.ts"],
		build: whole("src/shared/release-keys.ts"),
	},
	{
		name: "capped-fetch",
		sources: ["src/shared/capped-fetch.ts"],
		build: whole("src/shared/capped-fetch.ts"),
	},
	{
		name: "release-manifest",
		sources: ["src/shared/release-manifest.ts"],
		build: whole("src/shared/release-manifest.ts"),
	},
	{
		name: "relay-installer-parts",
		sources: ["src/shared/relay-installer-parts.ts"],
		build: whole("src/shared/relay-installer-parts.ts"),
	},
	{
		name: "exclude-materialize",
		sources: ["src/shared/hook-command.ts"],
		build: excludeMaterialize,
	},
	{
		name: "agent-session-markers",
		sources: ["src/shared/launch-env-policy.ts"],
		build: agentSessionMarkers,
	},
];

const FIX = "run `bun run embed:relay-update` and commit scripts/relay.ts";

export function replaceUpdateBlocks(relaySource: string, read: (rel: string) => string): string {
	let next = relaySource;
	for (const block of UPDATE_EMBED_BLOCKS) {
		next = replaceBlock(next, updateBlockMarkers(block), block.build(read));
	}
	return next;
}

/** Every reason a block in the relay is not what its sources generate; empty when none is. */
export function checkRelayUpdateEmbed(
	relaySource: string,
	read: (rel: string) => string,
): string[] {
	return UPDATE_EMBED_BLOCKS.flatMap((block) =>
		checkBlock(relaySource, updateBlockMarkers(block), block.build(read), block.name, FIX),
	);
}
