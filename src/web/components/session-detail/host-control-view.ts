/**
 * What the session page says when the host that runs a managed session can't
 * take a stop or a prompt (AGEN-66). Pure functions, so the copy is tested
 * without rendering. The refusal codes live here, in the session chunk, and
 * not in the shared error table, which every page's bundle carries.
 *
 * An absent `hostControl` (a list row, a push, an older server) means "can't
 * tell", and reads as controllable: the server still refuses if it isn't.
 */
import type { HostControl, Session } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";
import { parseDate } from "../../lib/utils.js";

export type HostRefusalCode = "host_offline" | "host_gone";

const UNNAMED_HOST = "This session's host";

const REFUSALS: Record<HostRefusalCode, (host: string) => string> = {
	host_offline: (host) =>
		`${host} is offline, so this session can't be controlled right now. Nothing was sent.`,
	host_gone: () =>
		"This session's host was removed from AgentPulse, so it can't be controlled. You can archive it.",
};

function hostNameOf(session: Pick<Session, "managedSession">): string {
	return session.managedSession?.hostName?.trim() || UNNAMED_HOST;
}

/** The host's state when the server told us; null when it didn't (unmanaged, a list row, an older server). */
export function hostControlOf(session: Pick<Session, "hostControl">): HostControl | null {
	return session.hostControl ?? null;
}

/** False only when the server said the host is offline or gone. */
export function hostCanControl(session: Pick<Session, "hostControl">): boolean {
	const host = hostControlOf(session);
	return host === null || host.state === "live";
}

/** Why Stop and the composer are off, in the words a refused request would have used; null when they're on. */
export function controlBlockedReason(
	session: Pick<Session, "hostControl" | "managedSession">,
): string | null {
	const host = hostControlOf(session);
	if (host === null || host.state === "live") return null;
	return REFUSALS[host.state === "gone" ? "host_gone" : "host_offline"](hostNameOf(session));
}

function defaultFormatTime(iso: string): string {
	const ms = parseDate(iso);
	return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

const ARCHIVE_CLAUSE = " You can archive it.";

/**
 * The standing notice under the header, or null when the host is live (or unknown). While Codex has
 * an approval open on the session, archiving isn't the next step, so that clause is left off.
 */
export function hostControlHint(
	session: Pick<Session, "hostControl" | "managedSession"> & Partial<Pick<Session, "metadata">>,
	formatTime: (iso: string) => string = defaultFormatTime,
): string | null {
	const host = hostControlOf(session);
	if (host === null || host.state === "live") return null;
	const archive = hasPendingCodexApproval(session) ? "" : ARCHIVE_CLAUSE;
	if (host.state === "gone") {
		return REFUSALS.host_gone(hostNameOf(session)).replace(ARCHIVE_CLAUSE, archive);
	}
	const name = hostNameOf(session);
	const since = host.lastSeenAt ? ` since ${formatTime(host.lastSeenAt)}` : "";
	return `${name} has been offline${since}. If you re-enrolled it, this session stays with the old enrollment and can't be controlled from the new one.${archive}`;
}

/** The sentence for a refused stop, prompt or retry; null for any other error, which keeps its usual text. */
export function hostRefusalMessage(
	error: unknown,
	session: Pick<Session, "managedSession">,
): string | null {
	if (!(error instanceof ApiError) || error.status !== 409 || error.code === null) return null;
	if (!Object.hasOwn(REFUSALS, error.code)) return null;
	return REFUSALS[error.code as HostRefusalCode](hostNameOf(session));
}

/** The provider-sync pill describes a connection that isn't there when the host isn't live. */
export function showProviderSyncState(session: Pick<Session, "hostControl">): boolean {
	return hostCanControl(session);
}
