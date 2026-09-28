/**
 * Shared extraction/comparison helpers for the campaign's drift guards
 * (check-hook-event-parity.ts, check-agent-type-parity.ts). Extracted from
 * check-hook-event-parity.ts (F22) so a second parity guard doesn't
 * duplicate the same regex-extraction plumbing.
 */

/**
 * Strict PascalCase quoted-token extraction — the hook-event shape (e.g.
 * "SessionStart", never snake_case). Shared by every site that parses a
 * hook-event list slice, so there's exactly one strictness definition, not
 * one per call site.
 */
export function extractQuotedTokens(slice: string): string[] {
	return [...slice.matchAll(/"([A-Z][A-Za-z]+)"/g)].map((m) => m[1]);
}

/**
 * Find every non-overlapping occurrence of `marker` in `content`, and for
 * each, extract quoted PascalCase tokens between the marker and the next
 * `terminator` character. Returns one array of event names per occurrence.
 */
export function extractQuotedListBlocks(
	content: string,
	marker: RegExp,
	terminator: string,
): string[][] {
	const blocks: string[][] = [];
	const globalMarker = new RegExp(
		marker.source,
		marker.flags.includes("g") ? marker.flags : `${marker.flags}g`,
	);
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop idiom
	while ((match = globalMarker.exec(content)) !== null) {
		const start = match.index + match[0].length;
		const end = content.indexOf(terminator, start);
		if (end === -1) continue;
		const slice = content.slice(start, end);
		blocks.push(extractQuotedTokens(slice));
		globalMarker.lastIndex = end;
	}
	return blocks;
}

/** Extract `event = "X"` key/value tokens between marker and terminator (install-local.ps1's Codex hash-array shape). */
export function extractKeyValueListBlock(
	content: string,
	marker: RegExp,
	terminator: string,
): string[] {
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`marker not found: ${marker}`);
	const end = content.indexOf(terminator, idx);
	if (end === -1) throw new Error(`terminator not found after marker: ${marker}`);
	const slice = content.slice(idx, end);
	return [...slice.matchAll(/event\s*=\s*"([A-Z][A-Za-z]+)"/g)].map((m) => m[1]);
}

/**
 * Extract a literal-union type's quoted members, e.g.
 * `export type ClaudeCodeEvent = "SessionStart" | "Stop";`.
 *
 * Strict PascalCase by default (the hook-event union shape). The
 * agent-type guard's unions carry snake_case identifiers
 * ("claude_code") — pass `{ allowUnderscore: true }` for those callers
 * explicitly, rather than silently widening the shared default and
 * risking a lowercase/underscored quoted string inside a PascalCase-only
 * union false-matching.
 */
export function extractUnion(
	content: string,
	typeName: string,
	opts?: { allowUnderscore?: boolean },
): string[] {
	const marker = new RegExp(`export type ${typeName} =`);
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`type not found in types.ts: ${typeName}`);
	const end = content.indexOf(";", idx);
	if (end === -1) throw new Error(`unterminated type: ${typeName}`);
	const slice = content.slice(idx, end);
	const pattern = opts?.allowUnderscore ? /"([A-Za-z_]+)"/g : /"([A-Za-z]+)"/g;
	return [...slice.matchAll(pattern)].map((m) => m[1]);
}

/**
 * Extract a const `as const` tuple's string literals, e.g.
 * `export const AGENT_TYPES = ["claude_code", "codex_cli"] as const;`.
 */
export function extractConstTuple(content: string, constName: string): string[] {
	const marker = new RegExp(`export const ${constName} =`);
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`const not found: ${constName}`);
	const end = content.indexOf("as const", idx);
	if (end === -1) throw new Error(`unterminated 'as const' tuple: ${constName}`);
	const slice = content.slice(idx, end);
	return [...slice.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]);
}

/**
 * Extract a zod `z.enum([...])` call's string literals, e.g.
 * `export const OBSERVED_AGENT_TYPE_ENUM = z.enum(["claude_code", "codex_cli"]);`.
 */
export function extractZodEnum(content: string, constName: string): string[] {
	const marker = new RegExp(`export const ${constName} = z\\.enum\\(\\[`);
	const idx = content.search(marker);
	if (idx === -1) throw new Error(`zod enum not found: ${constName}`);
	const end = content.indexOf("]", idx);
	if (end === -1) throw new Error(`unterminated zod enum: ${constName}`);
	const slice = content.slice(idx, end);
	return [...slice.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]);
}

export function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((v, i) => v === sortedB[i]);
}

/** True iff every element of `subset` also appears in `superset`. */
export function isSubsetOf(subset: string[], superset: string[]): boolean {
	const supersetSet = new Set(superset);
	return subset.every((v) => supersetSet.has(v));
}

export function describe(events: string[]): string {
	return `[${[...events].sort().join(", ")}]`;
}
