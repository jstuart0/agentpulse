/**
 * scripts/relay.ts is one self-contained file (the installers embed it as a heredoc and it imports only
 * `node:` builtins), so shared source it needs is copied into it between marker comments. This is the
 * mechanism, parameterized by the marker lines: each embed (the exclude-rules evaluator, the release
 * verifier and its helpers) supplies its own markers and the text that belongs between them, and the
 * drift check compares the two. One implementation, mechanically embedded.
 */

export interface EmbedMarkers {
	start: string;
	end: string;
}

function indexes(source: string, markers: EmbedMarkers): { start: number; end: number } | string {
	const starts = source.split(markers.start).length - 1;
	const ends = source.split(markers.end).length - 1;
	if (starts !== 1 || ends !== 1) {
		return `scripts/relay.ts must contain exactly one start marker and one end marker for \`${markers.end}\` (found ${starts} and ${ends})`;
	}
	const start = source.indexOf(markers.start) + markers.start.length;
	const end = source.indexOf(markers.end);
	if (end < start) return `the end marker comes before the start marker for \`${markers.end}\``;
	return { start, end };
}

/** What is between the markers now (without the newline after the start marker). */
export function extractBlock(source: string, markers: EmbedMarkers): string {
	const found = indexes(source, markers);
	if (typeof found === "string") throw new Error(found);
	return source.slice(found.start + 1, found.end);
}

export function replaceBlock(source: string, markers: EmbedMarkers, block: string): string {
	const found = indexes(source, markers);
	if (typeof found === "string") throw new Error(found);
	const body = block.endsWith("\n") ? block : `${block}\n`;
	return `${source.slice(0, found.start)}\n${body}${source.slice(found.end)}`;
}

/** Why the block in `source` is not `expected`, one line per problem; empty when it is. */
export function checkBlock(
	source: string,
	markers: EmbedMarkers,
	expected: string,
	label: string,
	fix: string,
): string[] {
	const found = indexes(source, markers);
	if (typeof found === "string") return [`${found}; ${fix}`];
	const actual = extractBlock(source, markers);
	if (actual === expected) return [];
	const a = actual.split("\n");
	const e = expected.split("\n");
	let line = 0;
	while (line < Math.min(a.length, e.length) && a[line] === e[line]) line++;
	return [
		`the ${label} block in scripts/relay.ts differs from the sources at its line ${line + 1} (expected ${JSON.stringify(e[line] ?? "<end>")}, found ${JSON.stringify(a[line] ?? "<end>")}); ${fix}`,
	];
}

/** Source text without its import statements (the embedded blocks are in one scope, so nothing is imported). */
export function withoutImports(source: string): string {
	return source.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
}
