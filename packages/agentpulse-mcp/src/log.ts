/**
 * stderr-only logging for the MCP server (AGEN-12 Phase 2).
 *
 * The stdio transport owns stdout for the JSON-RPC protocol stream — a
 * stray console.log call anywhere in this package would corrupt it. Every
 * diagnostic message in this module routes through here instead of a bare
 * console.log. Enforced structurally by scripts/check-no-console-log-mcp.ts
 * (chained into check:architecture).
 */
export function stderrLog(message: string): void {
	process.stderr.write(`${message}\n`);
}
