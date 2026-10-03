import { describe, expect, test } from "bun:test";
import { parseOwnerParam, resolveOwnerScope } from "./owner-scope.js";

const ID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

describe("parseOwnerParam", () => {
	test("absent, empty and all mean everyone", () => {
		for (const raw of [undefined, null, "", "all"]) {
			expect(parseOwnerParam(raw)).toEqual({ kind: "all" });
		}
	});

	test("the keywords and a user id are recognised", () => {
		expect(parseOwnerParam("me")).toEqual({ kind: "me" });
		expect(parseOwnerParam("unassigned")).toEqual({ kind: "unassigned" });
		expect(parseOwnerParam("service")).toEqual({ kind: "service" });
		expect(parseOwnerParam(ID)).toEqual({ kind: "user", userId: ID });
		// An uppercase spelling is the same user; the parsed id is the lowercase one.
		expect(parseOwnerParam(ID.toUpperCase())).toEqual({ kind: "user", userId: ID });
	});

	test("anything else is not in the grammar", () => {
		for (const raw of [
			"ME",
			"All",
			"bogus",
			"me,all",
			`${ID} `,
			`${ID}x`,
			"1 OR 1=1",
			"sso:alice",
		]) {
			expect({ raw, parsed: parseOwnerParam(raw) }).toEqual({ raw, parsed: null });
		}
	});
});

describe("resolveOwnerScope", () => {
	test("all is no scope", () => {
		expect(resolveOwnerScope({ kind: "all" }, ID)).toBeUndefined();
	});

	test("me becomes the caller's id, and is refused without one", () => {
		expect(resolveOwnerScope({ kind: "me" }, ID)).toEqual({ kind: "user", userId: ID });
		expect(resolveOwnerScope({ kind: "me" }, null)).toBeNull();
		expect(resolveOwnerScope({ kind: "me" }, undefined)).toBeNull();
		expect(resolveOwnerScope({ kind: "me" }, "")).toBeNull();
	});

	test("the other kinds pass through unchanged", () => {
		expect(resolveOwnerScope({ kind: "service" }, null)).toEqual({ kind: "service" });
		expect(resolveOwnerScope({ kind: "unassigned" }, ID)).toEqual({ kind: "unassigned" });
		expect(resolveOwnerScope({ kind: "user", userId: ID }, null)).toEqual({
			kind: "user",
			userId: ID,
		});
	});
});
