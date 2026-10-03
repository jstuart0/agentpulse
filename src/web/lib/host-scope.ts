/**
 * "Which machine's sessions is the dashboard showing", as one string and the few
 * functions that turn it into a request, a row test and a response check. The
 * value grammar is src/shared/machine-scope.ts's: empty for every machine, the
 * reserved token for sessions with none, otherwise an exact machine name. The
 * parsing, the row rule and the echo comparison are that module's own; this one
 * only adapts them to the dashboard's string-valued scope.
 *
 * A view, never an access decision: the name is self-declared by whatever sent
 * the events, so nothing here decides who may see or change a session.
 */
import {
	UNKNOWN_HOST_PARAM,
	hostEchoMatchesRequest,
	machineMatchesHost,
	parseHostParam,
	type ParsedHostParam,
} from "../../shared/machine-scope.js";
import { ScopeMismatchError } from "./owner-scope.js";

export type HostParam = string;

/** Every machine: the value no filter is applied for. */
export const HOST_ALL: HostParam = "";

/** Sessions with no machine at all. */
export const HOST_UNKNOWN: HostParam = UNKNOWN_HOST_PARAM;

/** What the value means; one the grammar refuses reads as every machine, so a bad stored value can't hide the list. */
export function parsedHost(host: HostParam | undefined): ParsedHostParam {
	return parseHostParam(host ?? HOST_ALL) ?? { kind: "all" };
}

/** The value in the grammar's own words (trimmed), or every machine when it isn't in it. */
export function normalizedHost(raw: string | null | undefined): HostParam {
	const parsed = parseHostParam(raw);
	if (!parsed || parsed.kind === "all") return HOST_ALL;
	return parsed.kind === "unknown" ? HOST_UNKNOWN : parsed.host;
}

/** Whether a response's echo of the machine filter it applied is the one that was asked for (see hostEchoMatchesRequest). */
export function echoMatchesHost(requested: HostParam | undefined, echo: unknown): boolean {
	return hostEchoMatchesRequest(parsedHost(requested), echo);
}

/** Throws {@link ScopeMismatchError} unless the response applied the machine filter that was asked for. */
export function assertHostEchoMatches(requested: HostParam | undefined, echo: unknown): void {
	if (!echoMatchesHost(requested, echo)) throw new ScopeMismatchError();
}

/**
 * Whether a live row belongs in the view for `host`. `unknown` is the answer for
 * a row that doesn't say which machine it is on (a card action's reply, an older
 * server): it can't be judged, so a filter keeps one it already shows and lets
 * the next poll decide the rest. A row whose machine is null says it has none.
 */
export type HostVerdict = "in" | "out" | "unknown";

export function hostVerdict(session: { machine?: string | null }, host: HostParam): HostVerdict {
	const parsed = parsedHost(host);
	if (parsed.kind === "all") return "in";
	if (session.machine === undefined) return "unknown";
	return machineMatchesHost(parsed, session.machine) ? "in" : "out";
}

const HOST_STORAGE_BASE = "agentpulse.dashboard.host";

/** Stored per person, like the grouping, so a shared browser doesn't carry one person's machine to the next. */
export function hostStorageKey(userId: string | null): string {
	return `${HOST_STORAGE_BASE}.${userId ?? "anonymous"}`;
}
