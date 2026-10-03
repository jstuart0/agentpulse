import { describe, expect, test } from "bun:test";
import { planSessionMessage, shouldAcceptLiveEvent } from "./ws-owner-filter.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";
const mine = { ownerUserId: ME, ownerKind: "user" as const };
const hers = { ownerUserId: ALICE, ownerKind: "user" as const };
const nobody = { ownerUserId: null, ownerKind: "unassigned" as const };

const team = (owner: string) => ({ owner, viewerUserId: ME, teamMode: true });
const solo = { owner: "all", viewerUserId: null, teamMode: false };

describe("under Mine", () => {
	test("another user's new session isn't added and raises no notification", () => {
		expect(planSessionMessage(hers, false, team("me"))).toEqual({ store: "ignore", notify: false });
	});

	test("the viewer's own new session is added and may notify", () => {
		expect(planSessionMessage(mine, false, team("me"))).toEqual({ store: "upsert", notify: true });
	});

	test("a row whose owner changed away is removed, silently", () => {
		expect(planSessionMessage(hers, true, team("me"))).toEqual({ store: "remove", notify: false });
	});

	test("a row that was someone else's and is now the viewer's is added", () => {
		expect(planSessionMessage(mine, false, team("me")).store).toBe("upsert");
	});

	test("an unowned session is neither shown nor notified", () => {
		expect(planSessionMessage(nobody, false, team("me"))).toEqual({
			store: "ignore",
			notify: false,
		});
	});
});

describe("under Everyone in team mode", () => {
	test("another user's session appears, with no notification", () => {
		expect(planSessionMessage(hers, false, team("all"))).toEqual({
			store: "upsert",
			notify: false,
		});
	});

	test("the viewer's own session appears and does notify", () => {
		expect(planSessionMessage(mine, false, team("all"))).toEqual({ store: "upsert", notify: true });
	});

	test("an unowned session appears, with no notification", () => {
		expect(planSessionMessage(nobody, true, team("all"))).toEqual({
			store: "upsert",
			notify: false,
		});
	});
});

describe("the viewer's own sessions notify whatever the view", () => {
	test("while looking at another person's sessions, the viewer's own finishing still tells them", () => {
		expect(planSessionMessage(mine, false, team(ALICE))).toEqual({
			store: "ignore",
			notify: true,
		});
		expect(planSessionMessage(mine, true, team(ALICE))).toEqual({ store: "remove", notify: true });
	});

	test("another person's session never tells them, in any view", () => {
		for (const owner of ["me", "all", ALICE, "unassigned", "service"]) {
			expect(planSessionMessage(hers, true, team(owner)).notify).toBe(false);
		}
	});
});

describe("a row that says nothing about its owner (an older server)", () => {
	const legacy = {};

	test("under a narrowed view it is kept if already shown and ignored otherwise", () => {
		expect(planSessionMessage(legacy, true, team("me")).store).toBe("upsert");
		expect(planSessionMessage(legacy, false, team("me")).store).toBe("ignore");
	});

	test("it never notifies in team mode, where ownership decides who is told", () => {
		expect(planSessionMessage(legacy, true, team("all")).notify).toBe(false);
	});
});

describe("narrowed to one other person", () => {
	test("that person's rows are kept and don't notify; the viewer's own are not shown", () => {
		expect(planSessionMessage(hers, true, team(ALICE))).toEqual({ store: "upsert", notify: false });
		expect(planSessionMessage(mine, false, team(ALICE))).toEqual({
			store: "ignore",
			notify: true,
		});
	});
});

describe("solo", () => {
	test("everything is added and everything notifies, as before", () => {
		expect(planSessionMessage(hers, false, solo)).toEqual({ store: "upsert", notify: true });
		expect(planSessionMessage({}, false, solo)).toEqual({ store: "upsert", notify: true });
		expect(planSessionMessage(nobody, true, solo)).toEqual({ store: "upsert", notify: true });
	});
});

describe("live events (only a session id)", () => {
	const known = [
		{ sessionId: "s-mine", ...mine },
		{ sessionId: "s-hers", ...hers },
	];

	test("an event for a session the store doesn't hold is dropped in team mode", () => {
		expect(shouldAcceptLiveEvent("s-elsewhere", known, team("me"))).toBe(false);
		expect(shouldAcceptLiveEvent("s-elsewhere", known, team("all"))).toBe(false);
	});

	test("unless that session's detail page is open", () => {
		const watching = { ...team("me"), watchedSessionId: "s-elsewhere" };
		expect(shouldAcceptLiveEvent("s-elsewhere", known, watching)).toBe(true);
		expect(shouldAcceptLiveEvent("s-other", known, watching)).toBe(false);
	});

	test("solo accepts events for sessions it doesn't hold", () => {
		expect(shouldAcceptLiveEvent("s-elsewhere", known, solo)).toBe(true);
	});

	test("an event for a session the store knows and the view excludes is dropped", () => {
		expect(shouldAcceptLiveEvent("s-hers", known, team("me"))).toBe(false);
		expect(shouldAcceptLiveEvent("s-mine", known, team("me"))).toBe(true);
	});

	test("everyone keeps every event", () => {
		expect(shouldAcceptLiveEvent("s-hers", known, team("all"))).toBe(true);
		expect(shouldAcceptLiveEvent("s-hers", known, solo)).toBe(true);
	});
});
