import { describe, expect, test } from "bun:test";
import {
	activeCount,
	choiceForOwner,
	defaultOwner,
	nextRefreshDelay,
	othersActiveCount,
	ownerForChoice,
	ownerFromSelectValue,
	ownerOptions,
	parseScopeChoice,
	pollRefreshesLists,
	pressedSegment,
	scopeAnnouncement,
	scopeStorageKey,
	selectValueForOwner,
	stateHelp,
	tileTitles,
	viewKind,
} from "./dashboard-scope.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";
const CASEY = "9a8b7c6d-1111-4222-8333-444455556666";

describe("stored scope choice", () => {
	test("is kept per person", () => {
		expect(scopeStorageKey(ME)).toBe(`agentpulse.dashboard.scope.${ME}`);
		expect(scopeStorageKey(null)).toBe("agentpulse.dashboard.scope.anonymous");
		expect(scopeStorageKey(ME)).not.toBe(scopeStorageKey(ALICE));
	});

	test("reads only the two words it writes", () => {
		expect(parseScopeChoice("mine")).toBe("mine");
		expect(parseScopeChoice("everyone")).toBe("everyone");
		for (const bad of [null, "", "all", "me", "Mine", "{}"])
			expect(parseScopeChoice(bad)).toBeNull();
	});

	test("Mine is owner me; everything else is Everyone", () => {
		expect(choiceForOwner("me")).toBe("mine");
		for (const owner of ["all", ALICE, "unassigned", "service"]) {
			expect(choiceForOwner(owner)).toBe("everyone");
		}
		expect(ownerForChoice("mine")).toBe("me");
		expect(ownerForChoice("everyone")).toBe("all");
	});
});

describe("defaultOwner", () => {
	test("a stored choice wins over what the server says", () => {
		expect(defaultOwner({ stored: "everyone", ownSessions: 40 })).toBe("all");
		expect(defaultOwner({ stored: "mine", ownSessions: 0 })).toBe("me");
	});

	test("with no choice: Mine when the viewer owns any session, even ones outside the loaded page", () => {
		expect(defaultOwner({ stored: null, ownSessions: 10 })).toBe("me");
		expect(defaultOwner({ stored: null, ownSessions: 1 })).toBe("me");
	});

	test("with no choice and nothing owned, or no answer: Everyone", () => {
		expect(defaultOwner({ stored: null, ownSessions: 0 })).toBe("all");
		expect(defaultOwner({ stored: null, ownSessions: null })).toBe("all");
	});
});

describe("the owner select", () => {
	const people = [
		{ id: ALICE, displayName: "Alice Smith", disabled: false },
		{ id: ME, displayName: "jay", disabled: false },
		{ id: CASEY, displayName: "Casey Jones", disabled: true },
	];

	test("Everyone, you, the others by name, the disabled, then the two ownerless kinds", () => {
		expect(ownerOptions(people, ME, "all")).toEqual([
			{ value: "all", label: "Everyone" },
			{ value: ME, label: "You" },
			{ value: ALICE, label: "Alice Smith" },
			{ value: CASEY, label: "Casey Jones (disabled)" },
			{ value: "service", label: "Service keys" },
			{ value: "unassigned", label: "Unassigned" },
		]);
	});

	test("an owner the directory doesn't list yet is still offered, so the select never lies", () => {
		const options = ownerOptions(people, ME, "3f2a9c10-0000-4000-8000-000000000000");
		expect(options.some((o) => o.value === "3f2a9c10-0000-4000-8000-000000000000")).toBe(true);
		expect(options.find((o) => o.value.startsWith("3f2a"))?.label).toBe("User 3f2a");
	});

	test("Mine shows the viewer's own entry; choosing it is Mine again", () => {
		expect(selectValueForOwner("me", ME)).toBe(ME);
		expect(selectValueForOwner("all", ME)).toBe("all");
		expect(selectValueForOwner(ALICE, ME)).toBe(ALICE);
		expect(ownerFromSelectValue(ME, ME)).toBe("me");
		expect(ownerFromSelectValue(ALICE, ME)).toBe(ALICE);
		expect(ownerFromSelectValue("unassigned", ME)).toBe("unassigned");
	});
});

describe("scopeAnnouncement", () => {
	test("says what the view is now", () => {
		expect(scopeAnnouncement("me", null)).toBe("Showing your sessions.");
		expect(scopeAnnouncement("all", null)).toBe("Showing everyone's sessions.");
		expect(scopeAnnouncement(ALICE, "Alice Smith")).toBe("Showing Alice Smith's sessions.");
		expect(scopeAnnouncement("unassigned", null)).toBe("Showing unassigned sessions.");
		expect(scopeAnnouncement("service", null)).toBe("Showing sessions from service keys.");
	});
});

describe("wording per view", () => {
	test("solo: exactly the sentences the page has always had", () => {
		expect(viewKind(false, "all")).toBe("plain");
		expect(stateHelp("plain", "waiting")).toBe(
			'The agent finished a turn, or has an outstanding permission prompt, and is waiting on a person. "Mark as seen" clears it.',
		);
		expect(stateHelp("plain", "error")).toBe(
			'The session ended in failure and hasn\'t been dismissed. "Dismiss error" clears it.',
		);
		expect(stateHelp("plain", "working")).toBe(
			"The agent is actively working on a turn right now.",
		);
		expect(stateHelp("plain", "idle")).toBe("Nothing is waiting and the agent isn't working.");
		expect(tileTitles("plain")).toEqual({
			active:
				"Sessions currently WAITING, WORKING, IDLE, or ERROR — the sum of the four status cards above. One definition of 'active' everywhere on this page.",
			today: "Sessions started since local midnight.",
			toolUses: "Total tool invocations across sessions started today.",
			total: "Every session ever recorded, including completed and archived.",
		});
	});

	test("Mine: waiting for you", () => {
		expect(viewKind(true, "me")).toBe("mine");
		expect(stateHelp("mine", "waiting")).toBe(
			'Your agent finished a turn, or has an outstanding permission prompt, and is waiting on you. "Mark as seen" clears it.',
		);
		expect(stateHelp("mine", "error")).toContain("Your session ended in failure");
		expect(tileTitles("mine").total).toBe(
			"Every session of yours ever recorded, including completed and archived.",
		);
	});

	test("Everyone: whose, across the team; one other owner has wording of its own", () => {
		expect(viewKind(true, "all")).toBe("shared");
		expect(viewKind(true, ALICE)).toBe("owner");
		expect(viewKind(true, "unassigned")).toBe("owner");
		expect(stateHelp("shared", "waiting")).toBe(
			"An agent finished a turn, or has an outstanding permission prompt, and is waiting on someone across the team. Its owner (or an admin) can mark it as seen.",
		);
		expect(stateHelp("shared", "error")).toContain("across the team");
		expect(tileTitles("shared").active).toContain("across the team");
		expect(tileTitles("shared").today).toBe(
			"Sessions started since local midnight, across the team.",
		);
	});
});

describe("nextRefreshDelay", () => {
	test("the usual quiet period when nothing is waiting yet", () => {
		expect(
			nextRefreshDelay({ now: 1000, firstPendingAt: null, debounceMs: 500, maxWaitMs: 5000 }),
		).toBe(500);
	});

	test("shortens as the first waiting change approaches the maximum wait", () => {
		expect(
			nextRefreshDelay({ now: 4800, firstPendingAt: 1000, debounceMs: 500, maxWaitMs: 5000 }),
		).toBe(500);
		expect(
			nextRefreshDelay({ now: 5700, firstPendingAt: 1000, debounceMs: 500, maxWaitMs: 5000 }),
		).toBe(300);
	});

	test("never negative once the maximum wait has passed", () => {
		expect(
			nextRefreshDelay({ now: 9000, firstPendingAt: 1000, debounceMs: 500, maxWaitMs: 5000 }),
		).toBe(0);
	});
});

describe("the Owner select when the directory has not loaded", () => {
	test("the viewer's own entry is offered, as You, even if the directory is empty or lacks them", () => {
		const options = ownerOptions([], ME, "me");
		expect(options.find((option) => option.value === ME)).toEqual({ value: ME, label: "You" });
		expect(options.find((option) => option.value === selectValueForOwner("me", ME))?.label).toBe(
			"You",
		);
	});

	test("the viewer is listed once when the directory has them", () => {
		const options = ownerOptions([{ id: ME, displayName: "jay", disabled: false }], ME, "me");
		expect(options.filter((option) => option.value === ME)).toHaveLength(1);
	});

	test("with no known viewer there is no entry for them and Mine reads as Everyone", () => {
		expect(ownerOptions([], null, "all").map((option) => option.value)).toEqual([
			"all",
			"service",
			"unassigned",
		]);
		expect(selectValueForOwner("me", null)).toBe("all");
	});
});

describe("pollRefreshesLists", () => {
	test("the poll reloads the paged lists only when the live socket isn't carrying the changes", () => {
		expect(pollRefreshesLists("connected")).toBe(false);
		expect(pollRefreshesLists("reconnecting")).toBe(true);
		expect(pollRefreshesLists("paused")).toBe(true);
	});
});

describe("othersActiveCount", () => {
	const everyone = (waiting: number, working: number, idle: number, error: number) => ({
		operational: { waiting, working, idle, error },
	});

	test("everyone's active count minus this view's", () => {
		expect(othersActiveCount(everyone(30, 20, 10, 5), 22)).toBe(43);
	});

	test("never negative, and silent without the count", () => {
		expect(othersActiveCount(everyone(1, 1, 1, 1), 9)).toBe(0);
		expect(othersActiveCount(null, 9)).toBe(0);
	});

	test("active is the sum of the four", () => {
		expect(activeCount({ waiting: 1, working: 2, idle: 3, error: 4 })).toBe(10);
	});
});

describe("the Mine | Everyone switch and the Owner select are one control", () => {
	test("a segment is pressed only for the owner it stands for", () => {
		expect(pressedSegment("me")).toBe("me");
		expect(pressedSegment("all")).toBe("all");
	});

	test("with a person, Service keys or Unassigned chosen, neither segment is pressed", () => {
		expect(pressedSegment("u-123")).toBeNull();
		expect(pressedSegment("service")).toBeNull();
		expect(pressedSegment("unassigned")).toBeNull();
	});

	test("before the default is known, neither is pressed", () => {
		expect(pressedSegment(null)).toBeNull();
	});
});
