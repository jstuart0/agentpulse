// Shared by the leaf-module allowlist tests (session-ownership, supervisor-liveness).

// Static `import`/`export ... from` (single or multi-line, including bare
// side-effect imports). The statement may carry a trailing same-line comment
// (F29): the offending text runs to the end of the line the statement ends on,
// so a comment can't hide it from the scan.
const STATIC_MODULE_REF =
	/^[ \t]*(import|export)\s+(type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["'][^\n]*/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["'][^\n]*/g;
const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["'][^\n]*/g;

/**
 * Module references in `source` whose specifier isn't in the allowlist.
 * Type-only imports and re-exports are erased at runtime and skipped.
 */
export function findOffendingLeafImports(
	source: string,
	allowedValueSpecifiers: Set<string>,
): string[] {
	const offending: string[] = [];
	for (const m of source.matchAll(STATIC_MODULE_REF)) {
		if (m[2]) continue;
		if (!allowedValueSpecifiers.has(m[3])) offending.push(m[0].trim());
	}
	for (const pattern of [DYNAMIC_IMPORT, REQUIRE_CALL]) {
		for (const m of source.matchAll(pattern)) {
			if (!allowedValueSpecifiers.has(m[1])) offending.push(m[0].trim());
		}
	}
	return offending;
}
