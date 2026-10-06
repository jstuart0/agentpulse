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
 *
 * The reserved token starts with a control character (U+001F). Machine names
 * are cleaned of control characters when they are reported, so no reported name
 * can equal the token, and `parseHostParam` refuses any other value that holds
 * one. Written in a URL it reads `host=%1Funknown`.
 */

import { containsUnsafeHostCharacters } from "./reported-host.js";

export const UNKNOWN_HOST_PARAM = "\u001funknown";

/** Longest machine name a request may carry: room for the reported cap (128) and for a supervisor's own, unchecked, host name. */
export const HOST_PARAM_MAX_LENGTH = 256;

export type HostScope = { kind: "unknown" } | { kind: "host"; host: string };
export type ParsedHostParam = { kind: "all" } | HostScope;

/** What a response says it applied; the same shape as the parsed value. */
export type HostFilterEcho = ParsedHostParam;

/** Null when the value isn't in the grammar. An absent, empty or blank value means every machine. */
export function parseHostParam(raw: string | null | undefined): ParsedHostParam | null {
	if (raw === undefined || raw === null) return { kind: "all" };
	if (raw === UNKNOWN_HOST_PARAM) return { kind: "unknown" };
	if (raw.length > HOST_PARAM_MAX_LENGTH) return null;
	if (containsUnsafeHostCharacters(raw)) return null;
	const host = raw.trim();
	return host === "" ? { kind: "all" } : { kind: "host", host };
}

/** The scope a query filters on; every machine is no scope at all. */
export function resolveHostScope(parsed: ParsedHostParam): HostScope | undefined {
	return parsed.kind === "all" ? undefined : parsed;
}

export function hostFilterEcho(parsed: ParsedHostParam): HostFilterEcho {
	return parsed;
}

/**
 * Whether a session whose effective machine is `machine` belongs in the view for
 * `scope`: the client's copy of what the server's SQL decides, so a live update
 * is included or left out by the same rule as a listed row. A blank name is no
 * machine. Nothing but a view reads this.
 */
export function machineMatchesHost(
	scope: ParsedHostParam,
	machine: string | null | undefined,
): boolean {
	if (scope.kind === "all") return true;
	const name = machine?.trim() || null;
	if (scope.kind === "unknown") return name === null;
	return name === scope.host;
}

/**
 * Whether a response's echo of the machine filter it applied is the one that
 * was asked for. Unlike the owner echo, a missing one is accepted only when no
 * filter was asked for: a server that doesn't know the parameter ignores it and
 * would otherwise pass off every machine's sessions as one machine's.
 */
export function hostEchoMatchesRequest(requested: ParsedHostParam, echo: unknown): boolean {
	if (echo === undefined) return requested.kind === "all";
	if (typeof echo !== "object" || echo === null) return false;
	const { kind, host } = echo as { kind?: unknown; host?: unknown };
	if (kind !== requested.kind) return false;
	return requested.kind !== "host" || host === requested.host;
}
