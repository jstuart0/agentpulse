import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { SupervisorRecord } from "../../shared/types.js";

/**
 * What a Hosts card says about the host's offline outbox, derived from what the host last reported. Its own
 * module so the dashboard, which shares hosts-view-state, does not carry it.
 */

/** How long after a flush a host still says what it delivered and lost. */
const OUTBOX_RECOVERED_MS = 24 * 60 * 60 * 1000;
/** A host offline longer than this is no longer described as keeping events for when it returns. */
const OFFLINE_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

export type HostOutboxNotice = {
	kind: "catching-up" | "recovered" | "offline";
	text: string;
	/** Events the host could not keep; the notice is amber only when this is above zero. */
	lost: number;
};

export const HOST_OUTBOX_OFFLINE_TEXT =
	"Offline. Events from its running sessions are kept on this host and sent when it reconnects.";

export type OutboxNoticeHost = Pick<
	SupervisorRecord,
	"outbox" | "status" | "heartbeatLeaseExpiresAt" | "enrollmentState" | "capabilities"
>;

const PLURALS = new Intl.PluralRules("en");

/** "1 event", "1,200 events" (the thousands separator follows the reader's locale). */
function events(n: number): string {
	return `${n.toLocaleString()} ${PLURALS.select(n) === "one" ? "event" : "events"}`;
}

const clockFormat = () =>
	new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = () =>
	new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** The time of day for today, else "Sun 2 Nov at 14:02": both as the reader's locale writes them. */
export function formatOutboxTime(iso: string | null | undefined, now: number): string | null {
	const ms = parseStoredTimestamp(iso ?? undefined);
	if (ms === null) return null;
	const at = new Date(ms);
	const today = new Date(now);
	const clock = clockFormat().format(at);
	const sameDay =
		at.getFullYear() === today.getFullYear() &&
		at.getMonth() === today.getMonth() &&
		at.getDate() === today.getDate();
	return sameDay ? clock : `${dayFormat().format(at)} at ${clock}`;
}

function leaseExpiryMs(lease: string | undefined): number | null {
	return parseStoredTimestamp(lease);
}

/**
 * The one notice a host card carries about its offline outbox:
 *  - catching up: the host is live and still holds events from while it was offline;
 *  - recovered: it is live, holds nothing, and flushed within a day (hidden when that moved nothing);
 *  - offline: its lease has run out (for up to 7 days) and it keeps its sessions' events until it returns.
 * Never for a revoked or pending host. The reported figures are the last the host sent, so the live
 * branches also need a live lease, as the exclude notice does.
 */
export function deriveHostOutboxNotice(
	supervisor: OutboxNoticeHost,
	now: number = Date.now(),
): HostOutboxNotice | null {
	if ((supervisor.enrollmentState ?? "active") !== "active") return null;
	const expiry = leaseExpiryMs(supervisor.heartbeatLeaseExpiresAt);
	if (expiry === null || expiry <= now) {
		if (!supervisor.capabilities?.features?.includes("offline_outbox")) return null;
		if (expiry !== null && now - expiry > OFFLINE_NOTICE_MS) return null;
		return { kind: "offline", text: HOST_OUTBOX_OFFLINE_TEXT, lost: 0 };
	}
	if (supervisor.status !== "connected") return null;
	const outbox = supervisor.outbox;
	if (!outbox) return null;
	if (outbox.pending > 0) {
		const oldest = formatOutboxTime(outbox.oldestPendingAt, now);
		return {
			kind: "catching-up",
			text: `Catching up: sending ${events(outbox.pending)} saved while this host was offline${
				oldest ? ` (oldest ${oldest})` : ""
			}.`,
			lost: 0,
		};
	}
	const flushedMs = parseStoredTimestamp(outbox.lastFlushAt ?? undefined);
	if (flushedMs === null || now - flushedMs > OUTBOX_RECOVERED_MS) return null;
	const delivered = outbox.lastFlushDelivered;
	const lost = outbox.lastFlushLost;
	if (delivered <= 0 && lost <= 0) return null;
	let text = `Back online since ${formatOutboxTime(outbox.lastFlushAt, now)}.`;
	if (delivered > 0) text += ` Sent ${events(delivered)} saved while offline.`;
	if (lost > 0) {
		text +=
			lost === 1
				? " 1 event was lost: the offline queue was full, or it was more than a day old."
				: ` ${lost.toLocaleString()} events were lost: the offline queue was full, or they were more than a day old.`;
	}
	return { kind: "recovered", text, lost };
}

/**
 * What a screen reader is told when a host's notice changes: the new notice's sentence when it changes
 * branch, "caught up." when the catching-up notice goes away, and nothing for a change in a count. With
 * several hosts on the page each announcement names its host ("build-box: caught up.").
 */
export function outboxAnnouncement(
	prev: HostOutboxNotice | null,
	next: HostOutboxNotice | null,
	hostName?: string,
): string | null {
	const named = (words: string) => (hostName ? `${hostName}: ${words}` : words);
	if (next && next.kind !== prev?.kind) return named(next.text);
	if (!next && prev?.kind === "catching-up") return named(hostName ? "caught up." : "Caught up.");
	return null;
}

/**
 * The line the Hosts page shows when its quiet refetch has failed since the last answer it took: the cards
 * are what the server last said, and nothing else on screen would say so. Null when the last refetch worked
 * (or there has not been an answer yet to point at).
 */
export function hostsRefreshNotice(
	refreshFailed: boolean,
	lastHeardAtMs: number | null,
	now: number,
): string | null {
	if (!refreshFailed || lastHeardAtMs === null) return null;
	const at = formatOutboxTime(new Date(lastHeardAtMs).toISOString(), now);
	return `Couldn't refresh hosts. Showing what we last heard at ${at}.`;
}

/** How often the page refetches hosts while one is catching up (`OUTBOX_POLL_MS`), and how often it refetches them quietly otherwise (`HOSTS_TICK_MS`), so a lease that ran out shows. Neither redraws on its own: the page's `now` moves only when a fetch succeeds. */
export const OUTBOX_POLL_MS = 15_000;
export const HOSTS_TICK_MS = 30_000;

/**
 * Whether the Hosts page should be refetching: some host is catching up, and the tab is in view. A hidden
 * tab does not poll; the next visibility change starts it again.
 */
export function shouldPollHosts(
	supervisors: Array<OutboxNoticeHost>,
	now: number,
	tabHidden: boolean,
): boolean {
	if (tabHidden) return false;
	return supervisors.some((s) => deriveHostOutboxNotice(s, now)?.kind === "catching-up");
}
