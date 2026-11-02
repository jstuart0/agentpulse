import { describe, expect, test } from "bun:test";
import type { SupervisorOutboxState } from "../../shared/types.js";
import {
	HOST_OUTBOX_OFFLINE_TEXT,
	type OutboxNoticeHost,
	deriveHostOutboxNotice,
	formatOutboxTime,
	outboxAnnouncement,
	shouldPollHosts,
} from "./host-outbox-view-state.js";

// Local-time constructors; the expected text is built with the same Intl formatters the code uses, so the
// tests hold in any locale and time zone (what is checked is the words around the times).
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m, 0).getTime();
const NOW = at(5, 15, 30); // Thursday 5 Nov 2026, 15:30
const iso = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) =>
	new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const dayAndClock = (ms: number) =>
	`${new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms))} at ${clock(ms)}`;

const live = iso(NOW + 60_000);
const expired = iso(NOW - 1_000);

const host = (
	over: Partial<Omit<OutboxNoticeHost, "outbox">> & {
		outbox?: Partial<SupervisorOutboxState> | null;
	} = {},
): OutboxNoticeHost => {
	const { outbox, ...rest } = over;
	return {
		status: "connected",
		enrollmentState: "active",
		heartbeatLeaseExpiresAt: live,
		capabilities: { features: ["offline_outbox"] } as OutboxNoticeHost["capabilities"],
		...(outbox === null
			? {}
			: {
					outbox: {
						pending: 0,
						oldestPendingAt: null,
						lastFlushAt: iso(at(5, 14, 2)),
						lastFlushDelivered: 0,
						lastFlushLost: 0,
						...outbox,
					},
				}),
		...rest,
	} as OutboxNoticeHost;
};

describe("formatOutboxTime", () => {
	test("today is a time of day; another day adds the weekday and date, joined with 'at'", () => {
		expect(formatOutboxTime(iso(at(5, 9, 5)), NOW)).toBe(clock(at(5, 9, 5)));
		expect(formatOutboxTime(iso(at(2, 14, 2)), NOW)).toBe(dayAndClock(at(2, 14, 2)));
		expect(formatOutboxTime(iso(at(2, 14, 2)), NOW)).toContain(" at ");
	});

	test("unreadable or absent is null", () => {
		expect(formatOutboxTime(null, NOW)).toBeNull();
		expect(formatOutboxTime("yesterday", NOW)).toBeNull();
	});

	test("no hand-written weekday or month names are left in the source", async () => {
		const source = await Bun.file(new URL("./host-outbox-view-state.ts", import.meta.url)).text();
		expect(source).not.toContain('"Mon"');
		expect(source).not.toContain('"Nov"');
	});
});

describe("deriveHostOutboxNotice", () => {
	test("catching up: the count and the oldest time", () => {
		expect(
			deriveHostOutboxNotice(
				host({ outbox: { pending: 12, oldestPendingAt: iso(at(5, 9, 5)) } }),
				NOW,
			),
		).toEqual({
			kind: "catching-up",
			text: `Catching up: sending 12 events saved while this host was offline (oldest ${clock(at(5, 9, 5))}).`,
			lost: 0,
		});
	});

	test("catching up: singular, an earlier day, the thousands separator, and no time when it is unknown", () => {
		expect(
			deriveHostOutboxNotice(
				host({ outbox: { pending: 1, oldestPendingAt: iso(at(2, 14, 2)) } }),
				NOW,
			)?.text,
		).toBe(
			`Catching up: sending 1 event saved while this host was offline (oldest ${dayAndClock(at(2, 14, 2))}).`,
		);
		expect(deriveHostOutboxNotice(host({ outbox: { pending: 2 } }), NOW)?.text).toBe(
			"Catching up: sending 2 events saved while this host was offline.",
		);
		expect(deriveHostOutboxNotice(host({ outbox: { pending: 1200 } }), NOW)?.text).toContain(
			`sending ${(1200).toLocaleString()} events`,
		);
	});

	test("recovered: back online since, then the sent and lost clauses only when above zero", () => {
		const recovered = (delivered: number, lost: number) =>
			deriveHostOutboxNotice(
				host({ outbox: { lastFlushDelivered: delivered, lastFlushLost: lost } }),
				NOW,
			);
		const since = `Back online since ${clock(at(5, 14, 2))}.`;
		expect(recovered(1, 0)?.text).toBe(`${since} Sent 1 event saved while offline.`);
		expect(recovered(30, 0)?.text).toBe(`${since} Sent 30 events saved while offline.`);
		expect(recovered(0, 1)?.text).toBe(
			`${since} 1 event was lost: the offline queue was full, or it was more than a day old.`,
		);
		expect(recovered(30, 2)).toEqual({
			kind: "recovered",
			text: `${since} Sent 30 events saved while offline. 2 events were lost: the offline queue was full, or they were more than a day old.`,
			lost: 2,
		});
	});

	test("recovered is hidden when nothing moved, when the flush is over a day old, and while anything is pending", () => {
		expect(deriveHostOutboxNotice(host(), NOW)).toBeNull();
		const flushed = (hours: number) =>
			host({ outbox: { lastFlushDelivered: 3, lastFlushAt: iso(NOW - hours * 3_600_000) } });
		expect(deriveHostOutboxNotice(flushed(25), NOW)).toBeNull();
		expect(deriveHostOutboxNotice(flushed(23), NOW)).not.toBeNull();
		expect(
			deriveHostOutboxNotice(host({ outbox: { lastFlushDelivered: 3, lastFlushAt: null } }), NOW),
		).toBeNull();
	});

	test("an earlier day's flush names the day", () => {
		expect(
			deriveHostOutboxNotice(
				host({ outbox: { lastFlushDelivered: 1, lastFlushAt: iso(at(4, 23, 40)) } }),
				NOW,
			)?.text,
		).toBe(`Back online since ${dayAndClock(at(4, 23, 40))}. Sent 1 event saved while offline.`);
	});

	test("offline: the lease has run out, the enrollment is active and the host keeps events offline", () => {
		expect(
			deriveHostOutboxNotice(host({ heartbeatLeaseExpiresAt: expired, outbox: null }), NOW),
		).toEqual({
			kind: "offline",
			text: HOST_OUTBOX_OFFLINE_TEXT,
			lost: 0,
		});
		expect(HOST_OUTBOX_OFFLINE_TEXT).toBe(
			"Offline. Events from its running sessions are kept on this host and sent when it reconnects.",
		);
		expect(
			deriveHostOutboxNotice(
				host({
					heartbeatLeaseExpiresAt: expired,
					outbox: null,
					capabilities: { features: [] } as unknown as OutboxNoticeHost["capabilities"],
				}),
				NOW,
			),
		).toBeNull();
	});

	test("offline is not said for a host gone more than 7 days", () => {
		const gone = (days: number) =>
			host({ heartbeatLeaseExpiresAt: iso(NOW - days * 86_400_000), outbox: null });
		expect(deriveHostOutboxNotice(gone(6), NOW)?.kind).toBe("offline");
		expect(deriveHostOutboxNotice(gone(8), NOW)).toBeNull();
	});

	test("an expired lease never shows the last reported figures, only the offline sentence", () => {
		expect(
			deriveHostOutboxNotice(
				host({ heartbeatLeaseExpiresAt: expired, outbox: { pending: 99 } }),
				NOW,
			)?.kind,
		).toBe("offline");
	});

	test("never for a revoked or pending host, in any branch", () => {
		for (const enrollmentState of ["revoked", "pending"] as const) {
			expect(
				deriveHostOutboxNotice(host({ enrollmentState, outbox: { pending: 5 } }), NOW),
			).toBeNull();
			expect(
				deriveHostOutboxNotice(
					host({ enrollmentState, heartbeatLeaseExpiresAt: expired, outbox: null }),
					NOW,
				),
			).toBeNull();
		}
	});

	test("a live host that isn't connected, and one that never reported, show nothing", () => {
		expect(
			deriveHostOutboxNotice(host({ status: "stale", outbox: { pending: 5 } }), NOW),
		).toBeNull();
		expect(deriveHostOutboxNotice(host({ outbox: null }), NOW)).toBeNull();
	});
});

describe("shouldPollHosts", () => {
	const catching = host({ outbox: { pending: 3 } });
	const quiet = host();

	test("polls while any host is catching up and the tab is in view", () => {
		expect(shouldPollHosts([quiet, catching], NOW, false)).toBe(true);
	});

	test("stops when none is catching up", () => {
		expect(shouldPollHosts([quiet, quiet], NOW, false)).toBe(false);
		expect(shouldPollHosts([], NOW, false)).toBe(false);
	});

	test("stops while the tab is hidden", () => {
		expect(shouldPollHosts([catching], NOW, true)).toBe(false);
	});

	test("a catching-up host whose lease has run out no longer counts (it shows the offline notice)", () => {
		expect(
			shouldPollHosts(
				[host({ outbox: { pending: 3 }, heartbeatLeaseExpiresAt: expired })],
				NOW,
				false,
			),
		).toBe(false);
	});

	test("a revoked host catching up does not keep the poll alive", () => {
		expect(
			shouldPollHosts([host({ enrollmentState: "revoked", outbox: { pending: 3 } })], NOW, false),
		).toBe(false);
	});
});

describe("outboxAnnouncement", () => {
	const notice = (kind: "catching-up" | "recovered" | "offline", text: string = kind) => ({
		kind,
		text,
		lost: 0,
	});

	test("a change of branch announces the new branch's sentence", () => {
		expect(outboxAnnouncement(null, notice("catching-up", "Catching up."))).toBe("Catching up.");
		expect(
			outboxAnnouncement(notice("catching-up"), notice("recovered", "Back online since 14:02.")),
		).toBe("Back online since 14:02.");
		expect(outboxAnnouncement(notice("offline"), notice("catching-up", "Catching up."))).toBe(
			"Catching up.",
		);
	});

	test('"Caught up." when the notice goes away from catching up, and nothing for other clearings', () => {
		expect(outboxAnnouncement(notice("catching-up"), null)).toBe("Caught up.");
		expect(outboxAnnouncement(notice("recovered"), null)).toBeNull();
		expect(outboxAnnouncement(notice("offline"), null)).toBeNull();
	});

	test("a count changing inside the same branch announces nothing", () => {
		expect(
			outboxAnnouncement(notice("catching-up", "3 events."), notice("catching-up", "2 events.")),
		).toBeNull();
		expect(outboxAnnouncement(null, null)).toBeNull();
	});
});
