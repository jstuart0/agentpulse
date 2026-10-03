/**
 * The `host` query grammar shared by the server, the dashboard and the MCP
 * package: which machine's sessions a list or a count describes.
 *
 *   (absent) | empty   every machine
 *   <name>             sessions whose effective machine is exactly that name
 *   UNKNOWN_HOST_PARAM sessions with no machine at all
 *
 * The effective machine is the supervisor's host name for a session a
 * supervisor launched, else the name its relay reported. Display and
 * filtering only: nothing about who may see or change a session reads it.
 */

export const UNKNOWN_HOST_PARAM = "";
export const HOST_PARAM_MAX_LENGTH = 0;

export type HostScope = { kind: "unknown" } | { kind: "host"; host: string };
export type ParsedHostParam = { kind: "all" } | HostScope;

/** What a response says it applied; the same shape as the parsed value. */
export type HostFilterEcho = ParsedHostParam;

export function parseHostParam(_raw: string | null | undefined): ParsedHostParam | null {
	throw new Error("not implemented");
}

export function resolveHostScope(_parsed: ParsedHostParam): HostScope | undefined {
	throw new Error("not implemented");
}

export function hostFilterEcho(_parsed: ParsedHostParam): HostFilterEcho {
	throw new Error("not implemented");
}
