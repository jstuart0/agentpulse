import { describe, expect, test } from "bun:test";
import { canAcknowledgeSession } from "../lib/utils.js";
import {
	ACK_ACTION_LABEL,
	AUTO_ACK_DWELL_MS,
	type MarkAllPageResult,
	SEARCH_DEBOUNCE_MS,
	UNDO_WINDOW_MS,
	ackActionLabel,
	ackToastText,
	chunk,
	classifyAckResponse,
	collectMarkAllPages,
	connectCardDismissKey,
	deriveAckAction,
	deriveAckActionForViewer,
	deriveListView,
	groupByProjectKey,
	groupSessionsStable,
	markAllButtonLabel,
	markAllProgressText,
	mergeSearchRows,
	nextAckState,
	reconcileHeldOrder,
	restoreAllProgressText,
	rollbackAckState,
	selectMarkAllTargets,
	shouldAutoAcknowledge,
	shouldRaiseDismissToast,
	shouldRunHeldRefresh,
	shouldShowConnectCard,
	summarizeMarkAll,
	unfilteredTabCaption,
} from "./dashboard-view-state.js";

function baseSession(overrides: Record<string, unknown> = {}) {
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

describe("deriveListView", () => {
	test("no authoritative total yet falls back to loadedRows.length, never empty while rows exist", () => {
		const view = deriveListView({ loadedRows: [1, 2, 3], total: null, truncated: false });
		expect(view.showingText).toBe("Showing 3 of 3");
		expect(view.canLoadMore).toBe(false);
		expect(view.isEmpty).toBe(false);
	});

	test("a selected status with a positive total never reports empty while its page is still loading", () => {
		const view = deriveListView({ loadedRows: [], total: 37, truncated: false });
		expect(view.isEmpty).toBe(false);
		expect(view.showingText).toBe("Showing 0 of 37");
		expect(view.canLoadMore).toBe(true);
	});

	test("genuinely zero total is the only case that reports empty", () => {
		const view = deriveListView({ loadedRows: [], total: 0, truncated: false });
		expect(view.isEmpty).toBe(true);
		expect(view.showingText).toBe("Showing 0 of 0");
		expect(view.canLoadMore).toBe(false);
	});

	test("more pages available when loaded rows are fewer than the total", () => {
		const view = deriveListView({ loadedRows: Array(20).fill(0), total: 143, truncated: false });
		expect(view.canLoadMore).toBe(true);
		expect(view.showingText).toBe("Showing 20 of 143");
	});

	test("truncated flag passes through unchanged", () => {
		expect(deriveListView({ loadedRows: [], total: 5000, truncated: true }).truncated).toBe(true);
		expect(deriveListView({ loadedRows: [], total: 5000, truncated: false }).truncated).toBe(false);
	});
});

describe("nextAckState / rollbackAckState", () => {
	test("acknowledge stamps the given timestamp", () => {
		const session = { id: "s1", lastUserAcknowledgedAt: null as string | null };
		const next = nextAckState(session, "acknowledge", "2026-10-01T10:00:00.000Z");
		expect(next.lastUserAcknowledgedAt).toBe("2026-10-01T10:00:00.000Z");
		expect(next).not.toBe(session);
	});

	test("unacknowledge clears the timestamp regardless of the time passed", () => {
		const session = { id: "s1", lastUserAcknowledgedAt: "2026-10-01T09:00:00.000Z" };
		const next = nextAckState(session, "unacknowledge", "2026-10-01T10:00:00.000Z");
		expect(next.lastUserAcknowledgedAt).toBeNull();
	});

	test("rollback returns the exact original reference, not a copy", () => {
		const session = { id: "s1", lastUserAcknowledgedAt: null };
		expect(rollbackAckState(session)).toBe(session);
	});
});

describe("classifyAckResponse", () => {
	test("acknowledged:true -> applied", () => {
		expect(classifyAckResponse({ acknowledged: true })).toBe("applied");
	});
	test("unacknowledged:true -> applied (DELETE endpoint's field name)", () => {
		expect(classifyAckResponse({ unacknowledged: true })).toBe("applied");
	});
	test("not_owner reason -> not_owner", () => {
		expect(classifyAckResponse({ acknowledged: false, reason: "not_owner" })).toBe("not_owner");
	});
	test("falsy with no reason -> failed", () => {
		expect(classifyAckResponse({ acknowledged: false })).toBe("failed");
	});
	test("null (thrown error) -> failed", () => {
		expect(classifyAckResponse(null)).toBe("failed");
	});
});

describe("selectMarkAllTargets", () => {
	test("splits into targets and a not-owner skip count", () => {
		const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const { targets, skippedNotOwner } = selectMarkAllTargets(sessions, (s) => s.id !== "b");
		expect(targets.map((s) => s.id)).toEqual(["a", "c"]);
		expect(skippedNotOwner).toBe(1);
	});

	test("empty input yields no targets and no skips", () => {
		const { targets, skippedNotOwner, skippedPermissionWait } = selectMarkAllTargets(
			[],
			() => true,
		);
		expect(targets).toEqual([]);
		expect(skippedNotOwner).toBe(0);
		expect(skippedPermissionWait).toBe(0);
	});

	// AGEN: a session blocked on an outstanding permission prompt is never a
	// mark-all target, regardless of ownership -- acknowledging it can't
	// clear WAITING (see deriveAckAction), so it must not count toward "N
	// of M" either.
	test("excludes sessions with an outstanding permission wait, counted separately from not-owner", () => {
		const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const { targets, skippedNotOwner, skippedPermissionWait } = selectMarkAllTargets(
			sessions,
			(s) => s.id !== "c",
			(s) => s.id === "b",
		);
		expect(targets.map((s) => s.id)).toEqual(["a"]);
		expect(skippedNotOwner).toBe(1);
		expect(skippedPermissionWait).toBe(1);
	});

	test("permission-wait check takes precedence over the not-owner check for the same session", () => {
		const sessions = [{ id: "a" }];
		const { targets, skippedNotOwner, skippedPermissionWait } = selectMarkAllTargets(
			sessions,
			() => false,
			() => true,
		);
		expect(targets).toEqual([]);
		expect(skippedNotOwner).toBe(0);
		expect(skippedPermissionWait).toBe(1);
	});
});

describe("chunk", () => {
	test("splits into batches of the given size, last batch may be smaller", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});
	test("size larger than the array yields one batch", () => {
		expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
	});
	test("empty input yields no batches", () => {
		expect(chunk([], 5)).toEqual([]);
	});
	test("non-positive size throws rather than looping forever", () => {
		expect(() => chunk([1], 0)).toThrow();
	});
});

describe("summarizeMarkAll", () => {
	test("tallies applied/not_owner/failed outcomes on top of the pre-skip count", () => {
		const summary = summarizeMarkAll({
			totalWaiting: 10,
			preSkippedNotOwner: 3,
			outcomes: ["applied", "applied", "not_owner", "failed"],
		});
		expect(summary).toEqual({
			done: 2,
			skippedNotOwner: 4,
			skippedPermissionWait: 0,
			failed: 1,
			totalWaiting: 10,
		});
	});

	test("no attempts at all (everything pre-skipped)", () => {
		const summary = summarizeMarkAll({ totalWaiting: 3, preSkippedNotOwner: 3, outcomes: [] });
		expect(summary).toEqual({
			done: 0,
			skippedNotOwner: 3,
			skippedPermissionWait: 0,
			failed: 0,
			totalWaiting: 3,
		});
	});

	test("carries the pre-skipped permission-wait count through untouched", () => {
		const summary = summarizeMarkAll({
			totalWaiting: 5,
			preSkippedNotOwner: 1,
			preSkippedPermissionWait: 2,
			outcomes: ["applied", "applied"],
		});
		expect(summary).toEqual({
			done: 2,
			skippedNotOwner: 1,
			skippedPermissionWait: 2,
			failed: 0,
			totalWaiting: 5,
		});
	});
});

describe("shouldAutoAcknowledge", () => {
	const ready = {
		operationalStatus: "waiting" as const,
		canAcknowledge: true,
		tabVisible: true,
		dwellMs: AUTO_ACK_DWELL_MS,
		alreadyAckedThisTurn: false,
	};

	test("fires once every condition holds", () => {
		expect(shouldAutoAcknowledge(ready)).toBe(true);
	});

	test("never fires for ERROR — only an explicit dismiss clears it", () => {
		expect(shouldAutoAcknowledge({ ...ready, operationalStatus: "error" })).toBe(false);
	});

	test("never fires for a session the viewer doesn't own", () => {
		expect(shouldAutoAcknowledge({ ...ready, canAcknowledge: false })).toBe(false);
	});

	test("never fires on a background/restored (not visible) tab", () => {
		expect(shouldAutoAcknowledge({ ...ready, tabVisible: false })).toBe(false);
	});

	test("never fires before the dwell time has elapsed", () => {
		expect(shouldAutoAcknowledge({ ...ready, dwellMs: AUTO_ACK_DWELL_MS - 1 })).toBe(false);
	});

	test("never fires twice for the same turn", () => {
		expect(shouldAutoAcknowledge({ ...ready, alreadyAckedThisTurn: true })).toBe(false);
	});

	test("idle and working never auto-acknowledge", () => {
		expect(shouldAutoAcknowledge({ ...ready, operationalStatus: "idle" })).toBe(false);
		expect(shouldAutoAcknowledge({ ...ready, operationalStatus: "working" })).toBe(false);
	});
});

describe("groupSessionsStable", () => {
	function session(cwd: string, isPinned = false) {
		return { cwd, isPinned };
	}

	test("pinned groups sort first regardless of label", () => {
		const groups = groupSessionsStable(
			[session("/z-project"), session("/a-project", true)],
			groupByProjectKey,
			(k) => k,
			(s) => s.isPinned,
		);
		expect(groups.map((g) => g.key)).toEqual(["/a-project", "/z-project"]);
	});

	test("unpinned groups sort by label, not by urgency", () => {
		const groups = groupSessionsStable(
			[session("/zebra"), session("/apple"), session("/mango")],
			groupByProjectKey,
			(k) => k,
			() => false,
		);
		expect(groups.map((g) => g.key)).toEqual(["/apple", "/mango", "/zebra"]);
	});

	test("groupByProjectKey falls back to Unknown for a null cwd", () => {
		expect(groupByProjectKey({ cwd: null })).toBe("Unknown");
	});

	test("sessions sharing a key land in one group, insertion order preserved", () => {
		const a = session("/x");
		const b = session("/x");
		const groups = groupSessionsStable(
			[a, b],
			groupByProjectKey,
			(k) => k,
			() => false,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.sessions).toEqual([a, b]);
	});
});

describe("UNDO_WINDOW_MS", () => {
	test("is a positive duration shared by cards, the detail page, and mark-all", () => {
		expect(UNDO_WINDOW_MS).toBeGreaterThan(0);
	});
});

const NO_ACTION_RESULT = { kind: null, permissionWaitNote: null, notOwnerNote: null };

describe("ACK_ACTION_LABEL", () => {
	test("has one label for every AckActionKind, matching the shared vocabulary", () => {
		expect(ACK_ACTION_LABEL.mark_seen).toBe("Mark as seen");
		expect(ACK_ACTION_LABEL.dismiss_error).toBe("Dismiss error");
		expect(ACK_ACTION_LABEL.restore_error).toBe("Restore error");
		expect(ACK_ACTION_LABEL.mark_unseen).toBe("Mark as unseen");
	});
});

describe("deriveAckAction", () => {
	test("WAITING, owned, no permission wait -> mark_seen", () => {
		const session = baseSession({ lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z" });
		expect(deriveAckAction(session, true)).toEqual({
			kind: "mark_seen",
			permissionWaitNote: null,
			notOwnerNote: null,
		});
	});

	test("WAITING with an outstanding permission wait -> no button, a note, even for the owner", () => {
		const session = baseSession({
			isWorking: true,
			metadata: { permissionWait: { ids: ["t1"], anon: 0 } },
		});
		const result = deriveAckAction(session, true);
		expect(result.kind).toBeNull();
		expect(result.permissionWaitNote).not.toBeNull();
		expect(result.notOwnerNote).toBeNull();
	});

	test("WAITING, not owned -> no button, a not-owner note (permission wait note takes no part)", () => {
		const session = baseSession({ lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z" });
		const result = deriveAckAction(session, false);
		expect(result.kind).toBeNull();
		expect(result.notOwnerNote).not.toBeNull();
		expect(result.permissionWaitNote).toBeNull();
	});

	test("ERROR, owned -> dismiss_error", () => {
		const session = baseSession({ status: "failed", endedAt: "2026-10-01T09:00:00.000Z" });
		expect(deriveAckAction(session, true).kind).toBe("dismiss_error");
	});

	test("ERROR, not owned -> no button, a not-owner note", () => {
		const session = baseSession({ status: "failed", endedAt: "2026-10-01T09:00:00.000Z" });
		const result = deriveAckAction(session, false);
		expect(result.kind).toBeNull();
		expect(result.notOwnerNote).not.toBeNull();
	});

	test("a dismissed failure (classifies completed, status stays failed) -> restore_error", () => {
		const session = baseSession({
			status: "failed",
			endedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
		expect(deriveAckAction(session, true).kind).toBe("restore_error");
	});

	test("an acknowledged IDLE session -> mark_unseen", () => {
		const session = baseSession({
			lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
		expect(deriveAckAction(session, true).kind).toBe("mark_unseen");
	});

	test("IDLE with nothing ever acknowledged -> no action at all", () => {
		const session = baseSession({});
		expect(deriveAckAction(session, true)).toEqual(NO_ACTION_RESULT);
	});

	test("WORKING -> no action", () => {
		const session = baseSession({ isWorking: true });
		expect(deriveAckAction(session, true)).toEqual(NO_ACTION_RESULT);
	});

	test("a genuinely completed (not failed) session -> no action even though acknowledged", () => {
		const session = baseSession({
			status: "completed",
			endedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
		expect(deriveAckAction(session, true)).toEqual(NO_ACTION_RESULT);
	});
});

describe("an admin acting for the owner (explicit buttons only)", () => {
	const waiting = () => baseSession({ lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z" });
	const errored = () => baseSession({ status: "failed", endedAt: "2026-10-01T09:00:00.000Z" });
	const dismissed = () =>
		baseSession({
			status: "failed",
			endedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
	const idleSeen = () =>
		baseSession({
			lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
	const admin = { isOwnerOrUnowned: false, adminForOwnerName: "Alice", teamMode: true };

	test("the labels name the owner for the two explicit buttons, and only for them", () => {
		expect(ackActionLabel("mark_seen", "Alice")).toBe("Mark as seen for Alice");
		expect(ackActionLabel("dismiss_error", "Alice")).toBe("Dismiss error for Alice");
		expect(ackActionLabel("restore_error", "Alice")).toBe("Restore error");
		expect(ackActionLabel("mark_unseen", "Alice")).toBe("Mark as unseen");
		expect(ackActionLabel("mark_seen")).toBe("Mark as seen");
		expect(ackActionLabel("mark_seen", null)).toBe("Mark as seen");
	});

	test("a very long owner name is cut so the button stays one line", () => {
		const long = "maximilian.featherstonehaugh-wolfeschlegelstein_contractor.2026x";
		const label = ackActionLabel("mark_seen", long);
		expect(label).toBe("Mark as seen for maximilian.featherstone…");
		expect(ackActionLabel("dismiss_error", "a".repeat(24))).toBe(
			`Dismiss error for ${"a".repeat(24)}`,
		);
	});

	test("WAITING and ERROR on someone else's session: the admin gets the button, naming the owner", () => {
		expect(deriveAckActionForViewer(waiting(), admin)).toMatchObject({
			kind: "mark_seen",
			forOwnerName: "Alice",
		});
		expect(deriveAckActionForViewer(errored(), admin)).toMatchObject({
			kind: "dismiss_error",
			forOwnerName: "Alice",
		});
	});

	test("restore and mark-unseen are not offered to an admin on someone else's session", () => {
		expect(deriveAckActionForViewer(dismissed(), admin).kind).toBeNull();
		expect(deriveAckActionForViewer(idleSeen(), admin).kind).toBeNull();
	});

	test("the owner (or an unowned session) gets the plain button, no owner named", () => {
		const own = { isOwnerOrUnowned: true, adminForOwnerName: null, teamMode: true };
		expect(deriveAckActionForViewer(waiting(), own)).toMatchObject({
			kind: "mark_seen",
			forOwnerName: null,
		});
		expect(deriveAckActionForViewer(idleSeen(), own).kind).toBe("mark_unseen");
	});

	test("a member on someone else's session gets the note, worded for owner or admin", () => {
		const member = { isOwnerOrUnowned: false, adminForOwnerName: null, teamMode: true };
		expect(deriveAckActionForViewer(waiting(), member).notOwnerNote).toBe(
			"Only the owner or an admin can mark this as seen",
		);
		expect(deriveAckActionForViewer(errored(), member).notOwnerNote).toBe(
			"Only the owner or an admin can dismiss this error",
		);
	});

	test("in solo mode no admin override exists, so the note keeps its original words", () => {
		const solo = { isOwnerOrUnowned: false, adminForOwnerName: null, teamMode: false };
		expect(deriveAckActionForViewer(waiting(), solo).notOwnerNote).toBe(
			"Only the owner can mark this as seen",
		);
		expect(deriveAckActionForViewer(errored(), solo).notOwnerNote).toBe(
			"Only the owner can dismiss this error",
		);
	});

	test("an outstanding permission prompt still wins over the admin button", () => {
		const prompt = baseSession({
			isWorking: true,
			metadata: { permissionWait: { ids: ["t1"], anon: 0 } },
		});
		const result = deriveAckActionForViewer(prompt, admin);
		expect(result.kind).toBeNull();
		expect(result.permissionWaitNote).not.toBeNull();
	});
});

describe("shouldRunHeldRefresh", () => {
	test("not interacting -> always runs now", () => {
		expect(shouldRunHeldRefresh({ isInteracting: false, heldMs: 0, maxHoldMs: 5000 })).toBe(true);
	});

	test("interacting, under the bound -> held", () => {
		expect(shouldRunHeldRefresh({ isInteracting: true, heldMs: 100, maxHoldMs: 5000 })).toBe(false);
	});

	// AGEN: a permanently-interacting grid (stuck hover, a person who never
	// moves the pointer away) must not starve the refresh forever.
	test("interacting, bound reached -> runs anyway", () => {
		expect(shouldRunHeldRefresh({ isInteracting: true, heldMs: 5000, maxHoldMs: 5000 })).toBe(true);
		expect(shouldRunHeldRefresh({ isInteracting: true, heldMs: 9000, maxHoldMs: 5000 })).toBe(true);
	});
});

describe("collectMarkAllPages", () => {
	function fakeFetcher(
		all: number[],
	): (offset: number, limit: number) => Promise<MarkAllPageResult<number>> {
		return async (offset, limit) => ({
			sessions: all.slice(offset, offset + limit),
			total: all.length,
		});
	}

	test("pages through the full set across multiple server pages", async () => {
		const all = Array.from({ length: 182 }, (_, i) => i);
		const collected = await collectMarkAllPages(fakeFetcher(all), { pageSize: 50 });
		expect(collected).toEqual(all);
	});

	test("stops at total even when the hard cap is much larger", async () => {
		const all = [1, 2, 3];
		const collected = await collectMarkAllPages(fakeFetcher(all), { pageSize: 100, hardCap: 5000 });
		expect(collected).toEqual([1, 2, 3]);
	});

	test("stops fetching further pages once the hard cap is reached (last page may slightly overshoot it)", async () => {
		const all = Array.from({ length: 50 }, (_, i) => i);
		const collected = await collectMarkAllPages(fakeFetcher(all), { pageSize: 10, hardCap: 25 });
		// offset crosses 25 after the 3rd page of 10 (offset=30) -> stops there.
		expect(collected).toHaveLength(30);
	});

	test("empty set yields an empty array, one call", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls += 1;
			return { sessions: [], total: 0 };
		};
		const collected = await collectMarkAllPages(fetchPage);
		expect(collected).toEqual([]);
		expect(calls).toBe(1);
	});
});

describe("markAllProgressText / markAllButtonLabel", () => {
	test("progress text names done and total", () => {
		expect(markAllProgressText(60, 182)).toBe("Marking 60 of 182…");
	});

	test("button label: every waiting session is a target -> 'Mark all N as seen'", () => {
		expect(
			markAllButtonLabel({
				targetCount: 182,
				totalWaiting: 182,
				skippedNotOwner: 0,
				skippedPermissionWait: 0,
			}),
		).toBe("Mark all 182 as seen");
	});

	test("button label: some skipped for ownership -> 'Mark M of N as seen (the rest belong to others)'", () => {
		expect(
			markAllButtonLabel({
				targetCount: 12,
				totalWaiting: 37,
				skippedNotOwner: 25,
				skippedPermissionWait: 0,
			}),
		).toBe("Mark 12 of 37 as seen (the rest belong to others)");
	});

	test("button label: some skipped for a permission wait -> names that reason", () => {
		expect(
			markAllButtonLabel({
				targetCount: 8,
				totalWaiting: 10,
				skippedNotOwner: 0,
				skippedPermissionWait: 2,
			}),
		).toBe("Mark 8 of 10 as seen (the rest have an open permission prompt)");
	});

	test("button label: both reasons present -> names both", () => {
		expect(
			markAllButtonLabel({
				targetCount: 5,
				totalWaiting: 10,
				skippedNotOwner: 3,
				skippedPermissionWait: 2,
			}),
		).toBe("Mark 5 of 10 as seen (the rest belong to others or have an open permission prompt)");
	});

	test("zero targets never claims 'all'", () => {
		expect(
			markAllButtonLabel({
				targetCount: 0,
				totalWaiting: 0,
				skippedNotOwner: 0,
				skippedPermissionWait: 0,
			}),
		).toBe("Mark 0 of 0 as seen");
	});
});

describe("restoreAllProgressText", () => {
	test("names done and total for an in-flight bulk undo", () => {
		expect(restoreAllProgressText(60, 182)).toBe("Restoring 60 of 182…");
	});
});

describe("shouldRaiseDismissToast", () => {
	test("dismissing an error always raises a toast -- the card may unmount before its banner is seen", () => {
		expect(shouldRaiseDismissToast("dismissed")).toBe(true);
	});

	test("marking as seen relies on the inline banner alone -- the card stays visible either way", () => {
		expect(shouldRaiseDismissToast("seen")).toBe(false);
	});
});

describe("unfilteredTabCaption", () => {
	test("nothing to say when every loaded row is already shown", () => {
		expect(
			unfilteredTabCaption({ shownCount: 24, totalCount: 24, searchActive: false }),
		).toBeNull();
	});

	test("nothing to say when the total is not known yet", () => {
		expect(
			unfilteredTabCaption({ shownCount: 24, totalCount: undefined, searchActive: false }),
		).toBeNull();
	});

	test("names the gap when fewer rows are loaded than the tab's total", () => {
		expect(unfilteredTabCaption({ shownCount: 24, totalCount: 182, searchActive: false })).toBe(
			"Showing 24 of 182",
		);
	});

	// AGEN: a search narrows the loaded page to a handful of matches -- the
	// pre-search total (182) is no longer a meaningful denominator and would
	// wrongly imply hundreds of hidden matches.
	test("while a search is active, reports the match count instead of comparing against the pre-search total", () => {
		expect(unfilteredTabCaption({ shownCount: 2, totalCount: 182, searchActive: true })).toBe(
			"Showing 2 matching",
		);
	});

	test("a search matching zero rows still reports its own count, not null", () => {
		expect(unfilteredTabCaption({ shownCount: 0, totalCount: 182, searchActive: true })).toBe(
			"Showing 0 matching",
		);
	});
});

describe("SEARCH_DEBOUNCE_MS", () => {
	test("is a positive, keystroke-scale duration", () => {
		expect(SEARCH_DEBOUNCE_MS).toBeGreaterThan(0);
		expect(SEARCH_DEBOUNCE_MS).toBeLessThan(1000);
	});
});

describe("reconcileHeldOrder", () => {
	test("empty previousOrder (not held) is equivalent to the fresh sort", () => {
		expect(reconcileHeldOrder([], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});

	test("a status change that would move an id in the fresh sort keeps its held position instead", () => {
		// "a" was first; a fresh sort (e.g. after acknowledging) would move
		// it to last -- held order keeps it where it was.
		const held = reconcileHeldOrder(["a", "b", "c"], ["b", "c", "a"]);
		expect(held).toEqual(["a", "b", "c"]);
	});

	test("an id removed from the fresh set (session deleted/filtered out) is dropped, not kept as a ghost", () => {
		const held = reconcileHeldOrder(["a", "b", "c"], ["b", "c"]);
		expect(held).toEqual(["b", "c"]);
	});

	test("a brand-new id not in previousOrder is appended, in its fresh-sort relative order", () => {
		const held = reconcileHeldOrder(["a", "b"], ["a", "b", "c", "d"]);
		expect(held).toEqual(["a", "b", "c", "d"]);
	});

	test("mixes kept order with newly-appended ids in one call", () => {
		const held = reconcileHeldOrder(["x", "y"], ["new1", "y", "new2", "x"]);
		// x, y keep their relative order from previousOrder; new1/new2 are
		// new, appended in their relative fresh-sort order.
		expect(held).toEqual(["x", "y", "new1", "new2"]);
	});
});

describe("the second user's 'Connect your machine' card", () => {
	const fresh = {
		showTeamCopy: true,
		keysLoaded: true,
		ownActiveKeys: 0,
		ownSessions: 0,
		dismissed: false,
	};

	test("shown to someone in team mode with no key of their own and no session", () => {
		expect(shouldShowConnectCard(fresh)).toBe(true);
	});

	test("never in solo mode", () => {
		expect(shouldShowConnectCard({ ...fresh, showTeamCopy: false })).toBe(false);
	});

	test("not before the key list has loaded: no flash for someone who has keys", () => {
		expect(shouldShowConnectCard({ ...fresh, keysLoaded: false })).toBe(false);
	});

	test("gone once they have a key or a session", () => {
		expect(shouldShowConnectCard({ ...fresh, ownActiveKeys: 1 })).toBe(false);
		expect(shouldShowConnectCard({ ...fresh, ownSessions: 2 })).toBe(false);
	});

	test("'Not now' is remembered", () => {
		expect(shouldShowConnectCard({ ...fresh, dismissed: true })).toBe(false);
	});

	test("the dismissal is remembered per user", () => {
		expect(connectCardDismissKey("u1")).toBe("agentpulse.connectCardDismissed.u1");
		expect(connectCardDismissKey("u2")).not.toBe(connectCardDismissKey("u1"));
		expect(connectCardDismissKey(null)).toBe("agentpulse.connectCardDismissed.anonymous");
	});
});

describe("ackToastText", () => {
	test("marking as seen says so, and for whom when an admin acts for the owner", () => {
		expect(ackToastText("mark_seen")).toBe("Marked as seen");
		expect(ackToastText("mark_seen", "Alice")).toBe("Marked as seen for Alice");
	});

	test("dismissing an error keeps its own wording", () => {
		expect(ackToastText("dismiss_error")).toBe("Error dismissed");
		expect(ackToastText("dismiss_error", "Alice")).toBe("Error dismissed for Alice");
	});

	test("the two reversals carry no toast of their own", () => {
		expect(ackToastText("mark_unseen")).toBeNull();
		expect(ackToastText("restore_error")).toBeNull();
	});
});

describe("mergeSearchRows", () => {
	const row = (id: string) => ({ sessionId: id });

	test("no server answer yet: the in-page matches, so typing still reacts at once", () => {
		expect(mergeSearchRows(null, [row("a"), row("b")])).toEqual([row("a"), row("b")]);
	});

	test("server matches first, then in-page matches the server didn't return, with no repeats", () => {
		expect(
			mergeSearchRows([row("old-1"), row("a")], [row("a"), row("task-match")]).map(
				(r) => r.sessionId,
			),
		).toEqual(["old-1", "a", "task-match"]);
	});

	test("a server answer with nothing and nothing in the page is empty", () => {
		expect(mergeSearchRows([], [])).toEqual([]);
	});
});

describe("mark all as seen never reaches for sessions the viewer doesn't own", () => {
	const waiting = (sessionId: string, ownerUserId: string | null) => ({ sessionId, ownerUserId });

	test("with the real ownership predicate: the viewer's own and unowned sessions are marked; another person's never", () => {
		const rows = [
			waiting("mine", "me-id"),
			waiting("hers", "alice-id"),
			waiting("hers-too", "alice-id"),
			waiting("nobody", null),
		];
		const { targets, skippedNotOwner } = selectMarkAllTargets(
			rows,
			(session) => canAcknowledgeSession(session, "me-id", false),
			() => false,
		);
		expect(targets.map((t) => t.sessionId)).toEqual(["mine", "nobody"]);
		expect(skippedNotOwner).toBe(2);
	});

	test("an admin gets no exception: the override is for single sessions on their own page", () => {
		const { targets } = selectMarkAllTargets(
			[waiting("hers", "alice-id")],
			(session) => canAcknowledgeSession(session, "admin-id", false),
			() => false,
		);
		expect(targets).toEqual([]);
	});
});
