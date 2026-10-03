import { describe, expect, test } from "bun:test";
import { echoMatchesRequest, matchesOwnerScope, personOwnerId, scopeQuery } from "./owner-scope.js";

const ME = "0b5e3a52-1f2b-4c52-9a53-0d5a7c1e9a01";
const ALICE = "7d1c2a90-3b1e-4a0f-8e44-5c2f9b6a1d02";

describe("scopeQuery", () => {
	test("everyone with scratch shown sends nothing", () => {
		expect(scopeQuery({ owner: "all", excludeScratch: false })).toEqual({});
	});

	test("an owner and the scratch toggle are the whole of it", () => {
		expect(scopeQuery({ owner: "me", excludeScratch: true })).toEqual({
			owner: "me",
			excludeScratch: true,
		});
		expect(scopeQuery({ owner: ALICE, excludeScratch: false })).toEqual({ owner: ALICE });
		expect(scopeQuery({ owner: "unassigned", excludeScratch: true })).toEqual({
			owner: "unassigned",
			excludeScratch: true,
		});
		expect(scopeQuery({ owner: "service", excludeScratch: false })).toEqual({ owner: "service" });
	});
});

describe("matchesOwnerScope", () => {
	const mine = { ownerUserId: ME, ownerKind: "user" as const };
	const hers = { ownerUserId: ALICE, ownerKind: "user" as const };
	const keyOnly = { ownerUserId: null, ownerKind: "service" as const };
	const nobody = { ownerUserId: null, ownerKind: "unassigned" as const };

	test("everyone matches every row", () => {
		for (const row of [mine, hers, keyOnly, nobody]) {
			expect(matchesOwnerScope(row, "all", ME)).toBe(true);
		}
	});

	test("me is the viewer's own rows and nothing else", () => {
		expect(matchesOwnerScope(mine, "me", ME)).toBe(true);
		expect(matchesOwnerScope(hers, "me", ME)).toBe(false);
		expect(matchesOwnerScope(keyOnly, "me", ME)).toBe(false);
		expect(matchesOwnerScope(nobody, "me", ME)).toBe(false);
	});

	test("me with no known viewer matches nothing rather than everything", () => {
		expect(matchesOwnerScope(mine, "me", null)).toBe(false);
	});

	test("a user id is that user's rows", () => {
		expect(matchesOwnerScope(hers, ALICE, ME)).toBe(true);
		expect(matchesOwnerScope(mine, ALICE, ME)).toBe(false);
		expect(matchesOwnerScope(nobody, ALICE, ME)).toBe(false);
	});

	test("unassigned and service split the ownerless rows by kind", () => {
		expect(matchesOwnerScope(nobody, "unassigned", ME)).toBe(true);
		expect(matchesOwnerScope(keyOnly, "unassigned", ME)).toBe(false);
		expect(matchesOwnerScope(keyOnly, "service", ME)).toBe(true);
		expect(matchesOwnerScope(nobody, "service", ME)).toBe(false);
		expect(matchesOwnerScope(hers, "service", ME)).toBe(false);
		expect(matchesOwnerScope(hers, "unassigned", ME)).toBe(false);
	});

	test("a row from a server that sends no kind: ownerless is unassigned, never service", () => {
		expect(matchesOwnerScope({ ownerUserId: null }, "unassigned", ME)).toBe(true);
		expect(matchesOwnerScope({ ownerUserId: null }, "service", ME)).toBe(false);
		expect(matchesOwnerScope({}, "me", ME)).toBe(false);
	});
});

describe("echoMatchesRequest", () => {
	test("no echo (an older server) is accepted", () => {
		expect(echoMatchesRequest("me", ME, undefined)).toBe(true);
		expect(echoMatchesRequest("all", ME, undefined)).toBe(true);
	});

	test("the scope that was asked for, in each shape the server might echo it", () => {
		expect(echoMatchesRequest("all", ME, "all")).toBe(true);
		expect(echoMatchesRequest("all", ME, null)).toBe(true);
		expect(echoMatchesRequest("all", ME, { kind: "all" })).toBe(true);
		expect(echoMatchesRequest("me", ME, "me")).toBe(true);
		expect(echoMatchesRequest("me", ME, ME)).toBe(true);
		expect(echoMatchesRequest("me", ME, { kind: "user", userId: ME })).toBe(true);
		expect(echoMatchesRequest(ALICE, ME, ALICE)).toBe(true);
		expect(echoMatchesRequest(ALICE, ME, { kind: "user", userId: ALICE })).toBe(true);
		expect(echoMatchesRequest("unassigned", ME, "unassigned")).toBe(true);
		expect(echoMatchesRequest("service", ME, { kind: "service" })).toBe(true);
	});

	test("a different scope than asked for is refused", () => {
		expect(echoMatchesRequest("me", ME, { kind: "user", userId: ALICE })).toBe(false);
		expect(echoMatchesRequest("me", ME, "all")).toBe(false);
		expect(echoMatchesRequest("me", ME, null)).toBe(false);
		expect(echoMatchesRequest("all", ME, { kind: "user", userId: ME })).toBe(false);
		expect(echoMatchesRequest(ALICE, ME, ME)).toBe(false);
		expect(echoMatchesRequest("unassigned", ME, "service")).toBe(false);
		expect(echoMatchesRequest("service", ME, { kind: "unassigned" })).toBe(false);
	});

	test("an echo that can't be read is refused for a narrowed view", () => {
		expect(echoMatchesRequest("me", ME, 42)).toBe(false);
		expect(echoMatchesRequest("me", ME, { odd: true })).toBe(false);
	});
});

describe("personOwnerId", () => {
	test("a user id is a person; the keywords are not", () => {
		expect(personOwnerId(ALICE)).toBe(ALICE);
		for (const keyword of ["all", "me", "unassigned", "service"]) {
			expect(personOwnerId(keyword)).toBeNull();
		}
	});
});

describe("echoMatchesRequest with the server's echo shapes", () => {
	test("me is echoed as me with the viewer's id", () => {
		expect(echoMatchesRequest("me", ME, { kind: "me", userId: ME })).toBe(true);
		expect(echoMatchesRequest("me", ME, { kind: "me", userId: ALICE })).toBe(false);
		expect(echoMatchesRequest("me", ME, { kind: "all" })).toBe(false);
	});

	test("a person is echoed as user with their id", () => {
		expect(echoMatchesRequest(ALICE, ME, { kind: "user", userId: ALICE })).toBe(true);
		expect(echoMatchesRequest(ALICE, ME, { kind: "user", userId: ME })).toBe(false);
	});

	test("the keywords are echoed as themselves", () => {
		expect(echoMatchesRequest("unassigned", ME, { kind: "unassigned" })).toBe(true);
		expect(echoMatchesRequest("service", ME, { kind: "unassigned" })).toBe(false);
		expect(echoMatchesRequest("all", ME, { kind: "all" })).toBe(true);
		expect(echoMatchesRequest("all", ME, { kind: "me", userId: ME })).toBe(false);
	});
});
