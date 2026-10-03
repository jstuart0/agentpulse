import { describe, expect, test } from "bun:test";
import {
	ACTIVE_OPERATIONAL_STATUSES,
	type OperationalStatusInput,
	compareOperational,
	countOperationalStatuses,
	filterByOperationalStatus,
	getOperationalStatus,
	hasExplicitWait,
	isActiveOperationalSession,
	isAlreadyAcknowledged,
	needsAttention,
} from "./session-state.js";

const STOP = "2026-10-01T10:00:00.000Z";
const ACK_LATER = "2026-10-01T10:01:00.000Z";
const ACK_EARLIER = "2026-10-01T09:59:00.000Z";

/** Default fixture: active, not working, both timestamps null (legacy row). */
function make(overrides: Partial<OperationalStatusInput> = {}): OperationalStatusInput {
	return {
		status: "active",
		isWorking: false,
		isArchived: false,
		endedAt: null,
		semanticStatus: null,
		metadata: {},
		lastAgentTurnCompletedAt: null,
		lastUserAcknowledgedAt: null,
		...overrides,
	};
}

const PERMISSION_WAIT = { permissionWait: { ids: ["t1"], anon: 0, prevStatus: null } };

describe("getOperationalStatus — precedence", () => {
	test("ended / completed / archived flag / legacy archived status → completed, even if other flags are stale", () => {
		expect(getOperationalStatus(make({ status: "completed", isWorking: true }))).toBe("completed");
		expect(getOperationalStatus(make({ isArchived: true, semanticStatus: "waiting" }))).toBe(
			"completed",
		);
		expect(getOperationalStatus(make({ status: "archived" }))).toBe("completed");
		// Case G: endedAt alone excludes a non-failed row, whatever the
		// lifecycle status says. A failed row with endedAt is handled by the
		// AGEN describe block below — it is ERROR until acknowledged, not
		// unconditionally completed.
		expect(getOperationalStatus(make({ endedAt: STOP, lastAgentTurnCompletedAt: STOP }))).toBe(
			"completed",
		);
	});

	test("failed (not ended) → error, ahead of working and wait evidence", () => {
		expect(getOperationalStatus(make({ status: "failed" }))).toBe("error");
		expect(
			getOperationalStatus(make({ status: "failed", isWorking: true, semanticStatus: "waiting" })),
		).toBe("error");
	});

	test("isWorking=true → working, over a stale semanticStatus with no outstanding permission wait (case A)", () => {
		expect(getOperationalStatus(make({ isWorking: true }))).toBe("working");
		expect(getOperationalStatus(make({ isWorking: true, semanticStatus: "waiting" }))).toBe(
			"working",
		);
	});

	// AGEN: an open permission prompt always arrives mid-turn, so isWorking is
	// true the whole time it's outstanding — checking isWorking first (the
	// old rule) made a permission wait show as WORKING. New precedence: an
	// outstanding wait (a non-empty id list or a positive anon count) is
	// WAITING even while isWorking.
	test("an outstanding permission wait is WAITING even while isWorking", () => {
		expect(getOperationalStatus(make({ isWorking: true, metadata: PERMISSION_WAIT }))).toBe(
			"waiting",
		);
		expect(
			getOperationalStatus(
				make({ isWorking: true, semanticStatus: "waiting", metadata: PERMISSION_WAIT }),
			),
		).toBe("waiting");
	});

	test("a resolved-but-not-yet-cleared permission wait (empty ids/anon) does not override isWorking", () => {
		const resolved = { permissionWait: { ids: [], anon: 0, prevStatus: null } };
		expect(getOperationalStatus(make({ isWorking: true, metadata: resolved }))).toBe("working");
	});

	test("isWorking=true → working regardless of timestamps (case D: Stop then UserPromptSubmit)", () => {
		expect(
			getOperationalStatus(
				make({
					isWorking: true,
					lastAgentTurnCompletedAt: STOP,
					lastUserAcknowledgedAt: ACK_LATER,
				}),
			),
		).toBe("working");
		expect(
			getOperationalStatus(
				make({ isWorking: true, lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: null }),
			),
		).toBe("working");
	});

	test("explicit permission/input wait, not working → waiting (semanticStatus or metadata signal)", () => {
		expect(getOperationalStatus(make({ semanticStatus: "waiting" }))).toBe("waiting");
		expect(getOperationalStatus(make({ metadata: PERMISSION_WAIT }))).toBe("waiting");
	});

	test("an acknowledgement does not hide an active permission wait (case E)", () => {
		expect(
			getOperationalStatus(
				make({
					metadata: PERMISSION_WAIT,
					lastAgentTurnCompletedAt: STOP,
					lastUserAcknowledgedAt: ACK_LATER,
				}),
			),
		).toBe("waiting");
		expect(
			getOperationalStatus(
				make({
					semanticStatus: "waiting",
					lastAgentTurnCompletedAt: STOP,
					lastUserAcknowledgedAt: STOP,
				}),
			),
		).toBe("waiting");
	});

	test("Stop newer than ack, or no ack yet → waiting (case B)", () => {
		expect(
			getOperationalStatus(make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: null })),
		).toBe("waiting");
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe("waiting");
	});

	test("ack equal to or newer than Stop, not working → idle (case C / UserAcknowledge)", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("idle");
		expect(
			getOperationalStatus(make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: STOP })),
		).toBe("idle");
	});

	test("ack only (user prompted, no turn finished since, worker flag cleared) → idle", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: null, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("idle");
	});

	test("legacy row: both timestamps null, active, not working → idle (case F)", () => {
		expect(getOperationalStatus(make())).toBe("idle");
		expect(getOperationalStatus(make({ status: "idle" }))).toBe("idle");
		expect(getOperationalStatus(make({ semanticStatus: "planning" }))).toBe("idle");
	});

	// AGEN: an unparsable ack is treated as "no ack yet" (fails toward
	// WAITING, same as a genuinely missing ack). An unparsable turn
	// completion stamp that IS present (non-null) must also fail toward
	// WAITING, not fall through to IDLE as if nothing had happened — the
	// agent did report a finished turn, we just couldn't parse when.
	test("unparsable timestamps fail toward attention (WAITING), never toward IDLE", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: "not-a-date", lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("waiting");
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: "not-a-date" }),
			),
		).toBe("waiting");
	});

	test("other semantic statuses do not override working/idle", () => {
		expect(getOperationalStatus(make({ isWorking: true, semanticStatus: "implementing" }))).toBe(
			"working",
		);
		expect(
			getOperationalStatus(
				make({
					semanticStatus: "planning",
					lastAgentTurnCompletedAt: STOP,
					lastUserAcknowledgedAt: ACK_LATER,
				}),
			),
		).toBe("idle");
	});

	test("displayName, cwd, currentTask and lastActivityAt play no part", () => {
		const base = { lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER };
		const idle = make(base);
		const decorated = {
			...make(base),
			displayName: "renamed-owl",
			cwd: "/somewhere/else",
			currentTask: "something new",
			lastActivityAt: "2026-10-01T11:00:00.000Z",
		};
		expect(getOperationalStatus(idle)).toBe("idle");
		expect(getOperationalStatus(decorated)).toBe("idle");

		const waiting = { ...make({ lastAgentTurnCompletedAt: STOP }), lastActivityAt: STOP };
		const bumped = { ...waiting, lastActivityAt: "2026-10-01T12:00:00.000Z" };
		expect(getOperationalStatus(waiting)).toBe("waiting");
		expect(getOperationalStatus(bumped)).toBe("waiting");
	});
});

// AGEN: getOperationalStatus (via parseStoredTimestamp) must reach the same
// precedence answer regardless of which stored shape each individual
// timestamp happens to be in -- unlike a raw SQL text comparison (see the
// server's isAppIsoTimestamp guard), this classifier always parses both
// sides to epoch ms before comparing, so a mix of shapes on the two
// columns being compared is not a bug surface here the way it is in SQL.
describe("getOperationalStatus — precedence across mixed stored-timestamp shapes", () => {
	// Same instant as STOP (2026-10-01T10:00:00.000Z) in each stored shape.
	const STOP_BARE = "2026-10-01 10:00:00"; // legacy SQLite, zone-less UTC
	const STOP_OFFSET = "2026-10-01 05:00:00-05"; // Postgres, explicit offset
	const ACK_LATER_BARE = "2026-10-01 10:01:00"; // one minute after STOP
	const ACK_EARLIER_OFFSET = "2026-10-01 04:59:00-05"; // one minute before STOP

	test("turn in SQLite-bare shape, ack in ISO shape, ack earlier -> waiting", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_BARE, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe("waiting");
	});

	test("turn in ISO shape, ack in SQLite-bare shape, ack later -> idle", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER_BARE }),
			),
		).toBe("idle");
	});

	test("turn in Postgres-offset shape, ack in ISO shape, ack earlier -> waiting", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_OFFSET, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe("waiting");
	});

	test("turn in ISO shape, ack in Postgres-offset shape, ack earlier -> waiting", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_EARLIER_OFFSET }),
			),
		).toBe("waiting");
	});

	test("a failed-and-dismissed row with endedAt bare and ack ISO (later) -> completed", () => {
		expect(
			getOperationalStatus(
				make({ status: "failed", endedAt: STOP_BARE, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("completed");
	});

	test("a failed-and-dismissed row with endedAt offset and ack bare (later) -> completed", () => {
		expect(
			getOperationalStatus(
				make({ status: "failed", endedAt: STOP_OFFSET, lastUserAcknowledgedAt: ACK_LATER_BARE }),
			),
		).toBe("completed");
	});

	test("all three shapes mixed across turn/ack/endedAt agree with a single-shape equivalent", () => {
		const mixed = getOperationalStatus(
			make({ lastAgentTurnCompletedAt: STOP_OFFSET, lastUserAcknowledgedAt: ACK_LATER_BARE }),
		);
		const uniform = getOperationalStatus(
			make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER }),
		);
		expect(mixed).toBe(uniform);
	});
});

describe("isActiveOperationalSession / hasExplicitWait", () => {
	test("active set excludes ended, completed, archived; keeps lifecycle idle and failed-not-ended", () => {
		expect(isActiveOperationalSession(make())).toBe(true);
		expect(isActiveOperationalSession(make({ status: "idle" }))).toBe(true);
		expect(isActiveOperationalSession(make({ status: "failed" }))).toBe(true);
		expect(isActiveOperationalSession(make({ endedAt: STOP }))).toBe(false);
		expect(isActiveOperationalSession(make({ status: "completed" }))).toBe(false);
		expect(isActiveOperationalSession(make({ status: "archived" }))).toBe(false);
		expect(isActiveOperationalSession(make({ isArchived: true }))).toBe(false);
	});

	test("explicit wait is evidence only", () => {
		expect(hasExplicitWait(make({ semanticStatus: "waiting" }))).toBe(true);
		expect(hasExplicitWait(make({ metadata: PERMISSION_WAIT }))).toBe(true);
		expect(hasExplicitWait(make({ metadata: { permissionWait: null } }))).toBe(false);
		expect(hasExplicitWait(make({ metadata: null }))).toBe(false);
		expect(hasExplicitWait(make({ semanticStatus: "planning" }))).toBe(false);
	});
});

describe("needsAttention", () => {
	test("only waiting and error need the operator", () => {
		expect(needsAttention(make({ semanticStatus: "waiting" }))).toBe(true);
		expect(needsAttention(make({ lastAgentTurnCompletedAt: STOP }))).toBe(true);
		expect(needsAttention(make({ status: "failed" }))).toBe(true);
		expect(needsAttention(make({ isWorking: true }))).toBe(false);
		expect(
			needsAttention(make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER })),
		).toBe(false);
		expect(needsAttention(make({ status: "completed" }))).toBe(false);
	});
});

describe("countOperationalStatuses / filterByOperationalStatus", () => {
	const fleet = [
		make({ isWorking: true }), // working
		make({ isWorking: true, semanticStatus: "waiting", metadata: PERMISSION_WAIT }), // waiting — an outstanding permission wait overrides isWorking
		make({ lastAgentTurnCompletedAt: STOP }), // waiting (B)
		make({ metadata: PERMISSION_WAIT, lastUserAcknowledgedAt: ACK_LATER }), // waiting (E)
		make(), // idle (F, legacy: no timing data at all)
		make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER }), // idle (C)
		make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: STOP }), // idle (equal)
		make({ status: "failed" }), // error (no endedAt, unacknowledged)
		make({ endedAt: STOP }), // excluded (G)
		make({ status: "completed" }), // excluded
		make({ isArchived: true, lastAgentTurnCompletedAt: STOP }), // excluded
	];

	test("counts cover the four states over the active set only, including idle", () => {
		expect(countOperationalStatuses(fleet)).toEqual({
			waiting: 3,
			working: 1,
			idle: 3,
			error: 1,
		});
		// AGEN: canonical card/sort order is Waiting, Error, Working, Idle —
		// the same order OPERATIONAL_STATUS_RANK ranks by. This is also the
		// order the dashboard renders status cards in (it maps directly over
		// this array), so the two must never drift apart again.
		expect(ACTIVE_OPERATIONAL_STATUSES).toEqual(["waiting", "error", "working", "idle"]);
	});

	test("null filter → all active sessions; a status → exactly the rows the classifier puts there", () => {
		const all = filterByOperationalStatus(fleet, null);
		expect(all).toHaveLength(8);
		expect(all.every(isActiveOperationalSession)).toBe(true);

		const counts = countOperationalStatuses(fleet);
		for (const status of ACTIVE_OPERATIONAL_STATUSES) {
			const rows = filterByOperationalStatus(fleet, status);
			expect(rows).toHaveLength(counts[status]);
			expect(rows.every((s) => getOperationalStatus(s) === status)).toBe(true);
		}
		// The four buckets partition the active set — no row is counted twice or dropped.
		const total = ACTIVE_OPERATIONAL_STATUSES.reduce((n, s) => n + counts[s], 0);
		expect(total).toBe(all.length);
	});
});

describe("compareOperational", () => {
	test("orders waiting, error, working, idle, completed; recency breaks ties", () => {
		const t = (iso: string, o: Partial<OperationalStatusInput>) => ({
			...make(o),
			lastActivityAt: iso,
		});
		const list = [
			t("2026-01-01T00:00:05Z", { status: "completed" }),
			t("2026-01-01T00:00:01Z", { isWorking: true }),
			t("2026-01-01T00:00:09Z", { isWorking: true }),
			t("2026-01-01T00:00:02Z", { lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: STOP }),
			t("2026-01-01T00:00:03Z", { status: "failed" }),
			t("2026-01-01T00:00:00Z", { semanticStatus: "waiting" }),
		];
		const ordered = [...list].sort(compareOperational).map((s) => getOperationalStatus(s));
		expect(ordered).toEqual(["waiting", "error", "working", "working", "idle", "completed"]);
		const working = [...list].sort(compareOperational).filter((s) => s.isWorking);
		expect(working[0].lastActivityAt).toBe("2026-01-01T00:00:09Z");
	});
});

// AGEN: a failed session must be reachable as ERROR. markSessionFailed always
// sets endedAt in the same write as status:"failed", so the old rule ("ended
// -> completed, checked before failed") made ERROR dead code in production —
// every real failed row also has endedAt set. New rule: failed is ERROR while
// the failure is unacknowledged (no ack, or ack strictly before endedAt), and
// completed once acknowledged (ack at or after endedAt). Archived always wins
// over failed, acknowledged or not.
describe("getOperationalStatus — a failed session is ERROR until acknowledged (AGEN)", () => {
	test("failed + endedAt set + never acknowledged -> error, not completed", () => {
		expect(getOperationalStatus(make({ status: "failed", endedAt: STOP }))).toBe("error");
	});

	test("failed + endedAt set + acknowledged strictly before the failure -> still error", () => {
		expect(
			getOperationalStatus(
				make({ status: "failed", endedAt: STOP, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe("error");
	});

	test("failed + acknowledged at or after endedAt -> completed (dismissed)", () => {
		expect(
			getOperationalStatus(make({ status: "failed", endedAt: STOP, lastUserAcknowledgedAt: STOP })),
		).toBe("completed");
		expect(
			getOperationalStatus(
				make({ status: "failed", endedAt: STOP, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("completed");
	});

	test("archived wins over failed regardless of acknowledgement", () => {
		expect(getOperationalStatus(make({ status: "failed", endedAt: STOP, isArchived: true }))).toBe(
			"completed",
		);
	});
});

// AGEN: both timestamps null (a brand-new or pre-acknowledgement-model row)
// means nothing has finished yet, so nothing is awaiting the user — IDLE, not
// WAITING. An explicit permission/input wait still wins (checked first).
describe("getOperationalStatus — no timing data at all is IDLE, not WAITING (AGEN)", () => {
	test("brand-new active session, not working, no wait evidence -> idle", () => {
		expect(getOperationalStatus(make())).toBe("idle");
	});

	test("lifecycle idle (inactivity sweep), no timing data -> idle", () => {
		expect(getOperationalStatus(make({ status: "idle" }))).toBe("idle");
	});

	test("an unrelated semanticStatus value, no timing data -> idle", () => {
		expect(getOperationalStatus(make({ semanticStatus: "planning" }))).toBe("idle");
	});

	test("an explicit permission wait still wins over the no-timing-data default", () => {
		expect(getOperationalStatus(make({ semanticStatus: "waiting" }))).toBe("waiting");
	});
});

// AGEN: lastAgentTurnCompletedAt/lastUserAcknowledgedAt can arrive in any of
// the three stored forms the shared parser handles — SQLite's bare
// "YYYY-MM-DD HH:MM:SS", an ISO "Z" string, or Postgres's "+HH" offset form
// — and the classifier must agree on the answer regardless of which one a
// given dialect/write-path produced.
describe("getOperationalStatus — mixed stored-timestamp formats classify consistently (AGEN)", () => {
	// 10:00:00 UTC, in each of the three forms.
	const STOP_SQLITE = "2026-10-01 10:00:00";
	const STOP_ISO = "2026-10-01T10:00:00.000Z";
	const STOP_PG_OFFSET = "2026-10-01T12:00:00+02:00"; // same instant as STOP_ISO

	test("a SQLite-bare turn stamp with an ISO ack after it -> idle", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_SQLITE, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe("idle");
	});

	test("a Postgres-offset turn stamp with no ack -> waiting", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_PG_OFFSET, lastUserAcknowledgedAt: null }),
			),
		).toBe("waiting");
	});

	test("an ISO turn stamp vs a same-instant Postgres-offset ack -> idle (equal, not newer)", () => {
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_ISO, lastUserAcknowledgedAt: STOP_PG_OFFSET }),
			),
		).toBe("idle");
	});

	test("a SQLite-bare turn stamp newer than a Postgres-offset ack -> waiting", () => {
		const earlierOffsetAck = "2026-10-01T11:59:00+02:00"; // 09:59:00 UTC, before STOP_SQLITE
		expect(
			getOperationalStatus(
				make({ lastAgentTurnCompletedAt: STOP_SQLITE, lastUserAcknowledgedAt: earlierOffsetAck }),
			),
		).toBe("waiting");
	});
});

// AGEN: isAlreadyAcknowledged backs the acknowledge route's idempotency —
// a call that wouldn't change the turn/failure signal performs no write,
// stores no event, and broadcasts nothing.
describe("isAlreadyAcknowledged", () => {
	test("failed session: true once acknowledged at/after endedAt, false before", () => {
		expect(
			isAlreadyAcknowledged(
				make({ status: "failed", endedAt: STOP, lastUserAcknowledgedAt: STOP }),
			),
		).toBe(true);
		expect(
			isAlreadyAcknowledged(
				make({ status: "failed", endedAt: STOP, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe(false);
		expect(isAlreadyAcknowledged(make({ status: "failed", endedAt: STOP }))).toBe(false);
	});

	test("no turn completed at all: already acknowledged trivially (nothing pending)", () => {
		expect(isAlreadyAcknowledged(make())).toBe(true);
		expect(isAlreadyAcknowledged(make({ lastUserAcknowledgedAt: ACK_LATER }))).toBe(true);
	});

	test("turn completed, ack at/after it: already acknowledged", () => {
		expect(
			isAlreadyAcknowledged(make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: STOP })),
		).toBe(true);
		expect(
			isAlreadyAcknowledged(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe(true);
	});

	test("turn completed, no ack or stale ack: not yet acknowledged", () => {
		expect(isAlreadyAcknowledged(make({ lastAgentTurnCompletedAt: STOP }))).toBe(false);
		expect(
			isAlreadyAcknowledged(
				make({ lastAgentTurnCompletedAt: STOP, lastUserAcknowledgedAt: ACK_EARLIER }),
			),
		).toBe(false);
	});

	test("turn stamp present but unparsable: treated as still pending, not already acknowledged", () => {
		expect(
			isAlreadyAcknowledged(
				make({ lastAgentTurnCompletedAt: "not-a-date", lastUserAcknowledgedAt: ACK_LATER }),
			),
		).toBe(false);
	});
});
