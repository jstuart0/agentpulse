import { describe, expect, test } from "bun:test";
import * as empty from "./dashboard-empty.js";
import * as groups from "./dashboard-groups.js";
import * as scope from "./dashboard-scope.js";
import * as viewState from "./dashboard-view-state.js";

/**
 * The wording and rules the dashboard's counts, captions, chips and card
 * controls follow, as pure functions. Inputs are partial fixtures: only the
 * fields a rule reads are filled in, so the functions are called untyped.
 */
// biome-ignore lint/suspicious/noExplicitAny: namespaces are indexed by name
type Fn = (...args: any[]) => any;
const fn = (ns: object, name: string): Fn => (ns as Record<string, Fn>)[name];

const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";

describe("tab lists: never 'none' while the badge says there is something", () => {
	const tabViewState = (input: object) => fn(empty, "tabViewState")(input);

	test("rows win; then loading; then 'more to look through'; empty only when the count agrees", () => {
		expect(tabViewState({ loaded: 3, settled: true, canLoadMore: false, badge: 3 })).toBe("rows");
		expect(tabViewState({ loaded: 0, settled: false, canLoadMore: false, badge: 4 })).toBe(
			"loading",
		);
		expect(tabViewState({ loaded: 0, settled: true, canLoadMore: true, badge: 4 })).toBe("more");
		expect(tabViewState({ loaded: 0, settled: true, canLoadMore: false, badge: 0 })).toBe("empty");
	});

	test("a finished look that found nothing while the badge says 4 is a recount, not an empty state", () => {
		expect(tabViewState({ loaded: 0, settled: true, canLoadMore: false, badge: 4 })).toBe(
			"recount",
		);
	});

	test("under a search the badge isn't the measure: no matches is simply empty, never a recount", () => {
		expect(
			tabViewState({ loaded: 0, settled: true, canLoadMore: false, badge: 4, searchActive: true }),
		).toBe("empty");
		expect(
			tabViewState({ loaded: 0, settled: true, canLoadMore: true, badge: 4, searchActive: true }),
		).toBe("more");
		expect(
			tabViewState({ loaded: 0, settled: false, canLoadMore: false, badge: 4, searchActive: true }),
		).toBe("loading");
		expect(
			tabViewState({ loaded: 3, settled: true, canLoadMore: false, badge: 4, searchActive: true }),
		).toBe("rows");
	});

	test("with no badge yet it waits rather than claiming emptiness", () => {
		expect(tabViewState({ loaded: 0, settled: true, canLoadMore: false, badge: undefined })).toBe(
			"loading",
		);
	});

	test("the caption: Showing N of M while more remain, Showing N of N once it's all there, matching under a search", () => {
		const caption = (input: object) => fn(empty, "tabListCaption")(input);
		expect(caption({ shown: 24, badge: 130, canLoadMore: true, searchActive: false })).toBe(
			"Showing 24 of 130",
		);
		expect(caption({ shown: 12, badge: 12, canLoadMore: false, searchActive: false })).toBe(
			"Showing 12 of 12",
		);
		expect(caption({ shown: 11, badge: 12, canLoadMore: false, searchActive: false })).toBe(
			"Showing 11 of 11",
		);
		expect(caption({ shown: 5, badge: 130, canLoadMore: true, searchActive: true })).toBe(
			"Showing 5 matching",
		);
	});
});

describe("the status chip", () => {
	const statusChipText = (input: object) => fn(viewState, "statusChipText")(input);

	test("without a search: the label and the list's own total", () => {
		expect(statusChipText({ label: "Waiting", listTotal: 68, cardCount: 68, search: "" })).toBe(
			"Showing: Waiting (68)",
		);
		expect(statusChipText({ label: "Waiting", listTotal: null, cardCount: 68, search: "" })).toBe(
			"Showing: Waiting (68)",
		);
	});

	test("with a search: what matched, of what the card counts", () => {
		expect(
			statusChipText({ label: "Waiting", listTotal: 21, cardCount: 68, search: " billing " }),
		).toBe('Waiting matching "billing": 21 of 68');
	});
});

describe("group headers while searching", () => {
	test("say 'N matching', with no 'of M' and no 'Show all'", () => {
		const group = {
			key: ALICE,
			label: "Alice Smith",
			pinned: false,
			sessions: [
				{
					sessionId: "a",
					cwd: "/x",
					agentType: "claude_code",
					isPinned: false,
					ownerUserId: ALICE,
					status: "active",
					isWorking: false,
					isArchived: false,
					endedAt: null,
				},
			],
		};
		const ctx = {
			viewerUserId: null,
			nameOf: () => "Alice Smith",
			teamHeaders: true,
			ownerStats: new Map([
				[
					ALICE,
					{
						ownerUserId: ALICE,
						ownerKind: "user",
						total: 90,
						active: 30,
						idle: 0,
						completed: 60,
						working: 1,
						waiting: 2,
						error: 0,
					},
				],
			]),
			tab: "active",
			statusFilter: null,
			currentOwner: "all",
			searchActive: true,
		};
		// biome-ignore lint/suspicious/noExplicitAny: fixture rows are partial
		const header = groups.groupHeader(group as any, "user", ctx as any);
		expect(header.countText).toBe("1 matching");
		expect(header.showAll).toBeNull();
	});
});

describe("Show all", () => {
	const user = (n: number) => ({
		key: ALICE,
		label: "Alice Smith",
		pinned: false,
		sessions: Array.from({ length: n }, (_, i) => ({
			sessionId: `s${i}`,
			cwd: "/x",
			agentType: "claude_code",
			isPinned: false,
			ownerUserId: ALICE,
			status: "active",
			isWorking: false,
			isArchived: false,
			endedAt: null,
		})),
	});
	const ctx = (total: number) => ({
		viewerUserId: null,
		nameOf: () => "Alice Smith",
		teamHeaders: true,
		ownerStats: new Map([
			[
				ALICE,
				{
					ownerUserId: ALICE,
					ownerKind: "user",
					total,
					active: total,
					idle: 0,
					completed: 0,
					working: 0,
					waiting: 0,
					error: 0,
				},
			],
		]),
		tab: "active",
		statusFilter: null,
		currentOwner: "all",
		searchActive: false,
	});

	test("is offered only while there is more of that person's than is shown", () => {
		// biome-ignore lint/suspicious/noExplicitAny: fixture rows are partial
		const more = groups.groupHeader(user(22) as any, "user", ctx(30) as any);
		// biome-ignore lint/suspicious/noExplicitAny: fixture rows are partial
		const all = groups.groupHeader(user(30) as any, "user", ctx(30) as any);
		expect(more.showAll?.label).toBe("Show all");
		expect(all.showAll).toBeNull();
	});
});

describe("Group by User with one owner in view", () => {
	test("still shows that owner's header", () => {
		const rows = [
			{
				sessionId: "a",
				cwd: "/x",
				agentType: "claude_code",
				isPinned: false,
				ownerUserId: ALICE,
				ownerKind: "user" as const,
			},
		];
		const result = groups.groupDashboardSessions(rows, "user", {
			viewerUserId: null,
			nameOf: () => "Alice Smith",
		});
		expect(result.flat).toBe(false);
		expect(result.groups).toHaveLength(1);
	});

	test("by project a single group is still flat", () => {
		const rows = [
			{ sessionId: "a", cwd: "/x", agentType: "claude_code", isPinned: false, ownerUserId: ALICE },
		];
		expect(
			groups.groupDashboardSessions(rows, "project", { viewerUserId: null, nameOf: () => "A" })
				.flat,
		).toBe(true);
	});
});

describe("what a card offers about acknowledging", () => {
	const deriveCardAckAction = (session: object, canAcknowledge: boolean) =>
		fn(viewState, "deriveCardAckAction")(session, canAcknowledge);
	const waiting = {
		status: "active",
		isWorking: false,
		isArchived: false,
		endedAt: null,
		lastAgentTurnCompletedAt: "2026-10-02T10:00:00Z",
		lastUserAcknowledgedAt: null,
		lastActivityAt: "2026-10-02T10:00:00Z",
	};
	const failed = {
		...waiting,
		status: "failed",
		endedAt: "2026-10-02T10:00:00Z",
		lastAgentTurnCompletedAt: null,
	};

	test("the viewer's own waiting session gets Mark as seen", () => {
		expect(deriveCardAckAction(waiting, true).kind).toBe("mark_seen");
	});

	test("another person's waiting session or error gets neither a button nor a note", () => {
		for (const session of [waiting, failed]) {
			expect(deriveCardAckAction(session, false)).toEqual({
				kind: null,
				permissionWaitNote: null,
				notOwnerNote: null,
			});
		}
	});

	test("an unowned session keeps the plain button (the viewer may act on it)", () => {
		expect(deriveCardAckAction(waiting, true).kind).toBe("mark_seen");
		expect(deriveCardAckAction(failed, true).kind).toBe("dismiss_error");
	});
});

describe("scope wording: two names", () => {
	test("the select and the announcements say Service keys and Unassigned", () => {
		const options = scope.ownerOptions([], null, "all");
		expect(options.map((option) => option.label)).toEqual([
			"Everyone",
			"Service keys",
			"Unassigned",
		]);
		expect(scope.scopeAnnouncement("unassigned", null)).toBe("Showing unassigned sessions.");
	});

	test("one person's help doesn't talk about the team", () => {
		const kind = fn(scope, "viewKind")(true, ALICE);
		for (const status of ["waiting", "error", "working", "idle"] as const) {
			expect(scope.stateHelp(kind, status)).not.toContain("team");
		}
		const titles = scope.tileTitles(kind);
		expect(JSON.stringify(titles)).not.toContain("team");
	});

	test("Everyone's help still says it does", () => {
		const kind = fn(scope, "viewKind")(true, "all");
		expect(scope.stateHelp(kind, "waiting")).toContain("team");
	});
});
