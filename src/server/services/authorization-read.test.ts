/**
 * canReadSession and sessionAudience: the two predicates every per-viewer live
 * channel asks (the mobile WebSocket today; push targeting and the inbox next).
 * Tables, so each cell of mode x actor x session is a stated outcome.
 */
import { describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import type { Actor } from "../auth/actor.js";

const { canReadSession, sessionAudience } = await import("./authorization.js");

const actor = (over: Partial<Actor>): Actor => ({ userId: "u1", label: "api_key", ...over });

const ME = actor({ userId: "u1", role: "member", mode: "team" });
const ADMIN = actor({ userId: "adm", role: "admin", mode: "team" });
const LOOSE_MEMBER = actor({ userId: null, role: "member", mode: "team" });
const LOOSE_ADMIN = actor({ userId: null, role: "admin", mode: "team" });
const HOST = actor({ userId: null, role: "none", mode: "team" });
const NO_ROLE = actor({ userId: "u1", role: undefined, mode: "team" });
const UNKNOWN_MODE = actor({ userId: "u1", role: "member", mode: undefined });
const GARBAGE_MODE = actor({ userId: "u1", role: "member", mode: "weird" as never });

const MINE = { ownerUserId: "u1" };
const THEIRS = { ownerUserId: "u2" };
const UNOWNED = { ownerUserId: null };
const NO_FIELD = {};

describe("canReadSession in team mode", () => {
	const table: Array<[string, Actor, { ownerUserId?: string | null }, boolean]> = [
		["member / own", ME, MINE, true],
		["member / another's", ME, THEIRS, false],
		["member / unowned", ME, UNOWNED, true],
		["member / owner field missing", ME, NO_FIELD, false],
		["admin / own-ish", ADMIN, MINE, true],
		["admin / another's", ADMIN, THEIRS, true],
		["admin / unowned", ADMIN, UNOWNED, true],
		["admin / owner field missing", ADMIN, NO_FIELD, true],
		["member without a user id / owned", LOOSE_MEMBER, MINE, false],
		[
			"member without a user id / unowned (not someone the instance knows)",
			LOOSE_MEMBER,
			UNOWNED,
			false,
		],
		["admin without a user id / owned", LOOSE_ADMIN, THEIRS, true],
		["admin without a user id / unowned", LOOSE_ADMIN, UNOWNED, true],
		["host credential / owned", HOST, MINE, false],
		["host credential / unowned", HOST, UNOWNED, false],
		["no role resolved / own", NO_ROLE, MINE, true],
		["no role resolved / another's", NO_ROLE, THEIRS, false],
		["unknown mode is judged as team / another's", UNKNOWN_MODE, THEIRS, false],
		["unknown mode is judged as team / own", UNKNOWN_MODE, MINE, true],
		["a garbage mode is judged as team / another's", GARBAGE_MODE, THEIRS, false],
	];
	for (const [name, who, session, expected] of table) {
		test(name, () => expect(canReadSession(who, session)).toBe(expected));
	}
});

describe("canReadSession in solo mode", () => {
	const solo = (over: Partial<Actor>) => actor({ mode: "solo", ...over });
	test("everyone reads everything, whoever owns it", () => {
		for (const who of [
			solo({ role: "member" }),
			solo({ role: "member", userId: null }),
			solo({ role: "admin" }),
			solo({ role: undefined }),
		]) {
			for (const session of [MINE, THEIRS, UNOWNED, NO_FIELD]) {
				expect(canReadSession(who, session)).toBe(true);
			}
		}
	});

	test("a host credential still reads nothing", () => {
		expect(canReadSession(solo({ role: "none", userId: null }), UNOWNED)).toBe(false);
	});
});

describe("sessionAudience", () => {
	const table: Array<[string, { ownerUserId?: string | null }, string, unknown]> = [
		["solo / owned -> everyone", THEIRS, "solo", "all"],
		["solo / unowned -> everyone", UNOWNED, "solo", "all"],
		["solo / owner field missing -> everyone", NO_FIELD, "solo", "all"],
		["team / owned -> the owner", THEIRS, "team", ["u2"]],
		["team / unowned -> everyone", UNOWNED, "team", "all"],
		["team / owner field missing -> nobody", NO_FIELD, "team", []],
		["unknown mode / owned -> the owner (judged as team)", THEIRS, "weird", ["u2"]],
		["unknown mode / owner field missing -> nobody", NO_FIELD, "weird", []],
	];
	for (const [name, session, mode, expected] of table) {
		test(name, () => expect(sessionAudience(session, mode as never)).toEqual(expected as never));
	}
});
