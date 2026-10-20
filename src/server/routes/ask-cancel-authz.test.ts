/**
 * Who may stop a running Ask turn, with no Ask fixture: a turn is listed by hand (`registerRunningTurn`)
 * and the real route is called, so this runs on Postgres as well as SQLite.
 *
 * The rule: the person who asked, or any key of the one person in solo mode, or an admin in team mode.
 * A respond key (a phone's) is narrower: it stops only a turn it asked, by user or by key, whatever its
 * owner's role and whatever the mode (`ownOnly`, the same flag the thread read rule uses).
 * Everything else is the same 404 as "nothing is running", so a thread's busyness isn't an oracle.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import "../db/__test_db.js";
import type { Actor } from "../auth/actor.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { setLabsFlag } = await import("../services/labs-service.js");
const { invalidateAiFlagsCache } = await import("../services/ai/feature.js");
const { cancelRunningTurn, registerRunningTurn, isThreadRunning } = await import(
	"../services/ask/running-turns.js"
);

beforeAll(() => initializeDatabase(), 60_000);
const finishers: Array<() => void> = [];
beforeEach(async () => {
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	invalidateAiFlagsCache();
	await setLabsFlag("askAssistant", true);
}, 60_000);
afterEach(async () => {
	for (const finish of finishers.splice(0)) finish();
	await resetIdentityState();
	await clearInstanceSettings();
	await setLabsFlag("askAssistant", false);
	await upsertSetting("ai.enabled", false, { allowProtected: true });
	invalidateAiFlagsCache();
}, 60_000);

function running(threadId: string, who: { userId: string | null; keyId: string | null }) {
	const handle = registerRunningTurn(threadId, who);
	if (!handle) throw new Error("a turn was already listed on that thread");
	finishers.push(handle.finish);
	return handle;
}

const cancel = (threadId: string, headers: Headers) =>
	app.request(`/api/v1/ai/ask/threads/${threadId}/cancel`, jsonRequest("POST", {}, headers));

describe("cancelRunningTurn, as a table", () => {
	const actor = (over: Partial<Actor>): Actor => ({
		userId: null,
		label: "api_key",
		role: "member",
		mode: "team",
		...over,
	});
	// [name, caller actor, caller key, the turn's asker (userId, keyId), may stop it]
	const CASES: Array<
		[string, Actor, string | null, { userId: string | null; keyId: string | null }, boolean]
	> = [
		[
			"team: the asker, by user",
			actor({ userId: "u1" }),
			null,
			{ userId: "u1", keyId: null },
			true,
		],
		[
			"team: the asker, by user, on another of their keys",
			actor({ userId: "u1" }),
			"k9",
			{ userId: "u1", keyId: "k1" },
			true,
		],
		["team: another member", actor({ userId: "u2" }), null, { userId: "u1", keyId: null }, false],
		[
			"team: an admin",
			actor({ userId: "root", role: "admin" }),
			null,
			{ userId: "u1", keyId: null },
			true,
		],
		[
			"team: an ownerless key stopping its own turn",
			actor({}),
			"k1",
			{ userId: null, keyId: "k1" },
			true,
		],
		["team: another ownerless key", actor({}), "k2", { userId: null, keyId: "k1" }, false],
		[
			"team: an ownerless key against a person's turn",
			actor({}),
			"k1",
			{ userId: "u1", keyId: "k1" },
			false,
		],
		["team: no user and no key at all", actor({}), null, { userId: null, keyId: null }, false],
		[
			"team: a person against an ownerless key's turn",
			actor({ userId: "u1" }),
			null,
			{ userId: null, keyId: "k1" },
			false,
		],
		[
			"solo: any caller",
			actor({ mode: "solo", userId: "u3" }),
			"k7",
			{ userId: "u1", keyId: "k1" },
			true,
		],
	];
	for (const [name, caller, keyId, asker, may] of CASES) {
		test(name, () => {
			const turn = running("t-table", asker);
			expect(cancelRunningTurn("t-table", { actor: caller, keyId })).toBe(may);
			expect(turn.isCancelled()).toBe(may);
		});
	}

	// The same callers as respond keys (ownOnly): the admin and solo shortcuts are gone.
	const OWN_ONLY_CASES: typeof CASES = [
		[
			"ownOnly, team: an admin's respond key against a member's turn",
			actor({ userId: "root", role: "admin" }),
			"k9",
			{ userId: "u1", keyId: null },
			false,
		],
		[
			"ownOnly, team: an admin's respond key against its own turn",
			actor({ userId: "root", role: "admin" }),
			"k9",
			{ userId: "root", keyId: null },
			true,
		],
		[
			"ownOnly, solo: a respond key against another person's turn",
			actor({ mode: "solo", userId: "u3" }),
			"k7",
			{ userId: "u1", keyId: "k1" },
			false,
		],
		[
			"ownOnly, solo: a respond key against its person's own turn",
			actor({ mode: "solo", userId: "u1" }),
			"k7",
			{ userId: "u1", keyId: "k1" },
			true,
		],
		[
			"ownOnly, solo: an ownerless respond key against another key's turn",
			actor({ mode: "solo" }),
			"k7",
			{ userId: null, keyId: "k1" },
			false,
		],
		[
			"ownOnly, solo: an ownerless respond key against its own turn",
			actor({ mode: "solo" }),
			"k1",
			{ userId: null, keyId: "k1" },
			true,
		],
		[
			"ownOnly, team: a member's respond key against its owner's turn",
			actor({ userId: "u1" }),
			"k9",
			{ userId: "u1", keyId: null },
			true,
		],
	];
	for (const [name, caller, keyId, asker, may] of OWN_ONLY_CASES) {
		test(name, () => {
			const turn = running("t-table-own", asker);
			expect(cancelRunningTurn("t-table-own", { actor: caller, keyId, ownOnly: true })).toBe(may);
			expect(turn.isCancelled()).toBe(may);
		});
	}

	test("no turn on the thread: nothing to stop, for anyone", () => {
		expect(cancelRunningTurn("t-none", { actor: actor({ role: "admin" }), keyId: "k1" })).toBe(
			false,
		);
	});
});

describe("registering a turn", () => {
	test("a second registration on a thread that already has one is refused, and the first is untouched", () => {
		const first = running("t-dup", { userId: "u1", keyId: null });
		expect(registerRunningTurn("t-dup", { userId: "u2", keyId: null })).toBeNull();
		expect(isThreadRunning("t-dup")).toBe(true);
		first.finish();
		expect(isThreadRunning("t-dup")).toBe(false);
		const again = running("t-dup", { userId: "u2", keyId: null });
		expect(again.isCancelled()).toBe(false);
	});

	test("finishing a turn that was replaced doesn't unlist its successor", () => {
		const first = running("t-swap", { userId: "u1", keyId: null });
		first.finish();
		running("t-swap", { userId: "u2", keyId: null });
		first.finish();
		expect(isThreadRunning("t-swap")).toBe(true);
	});
});

describe("the cancel route", () => {
	test("team: the asker (cookie) stops it and is told it is stopping, not that it has stopped", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-alice");
		const turn = running("t-1", { userId: alice.id, keyId: null });

		const res = await cancel("t-1", await cookieHeadersFor(alice.id));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, stopping: true });
		expect(turn.isCancelled()).toBe(true);
	});

	test("team: another member and a respond key of another person get 404 and the turn goes on", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a2");
		const bob = await seedLocalUser("cx-b2");
		const bobKey = await seedKey("cx-bob-respond", ["respond"], bob.id);
		const turn = running("t-2", { userId: alice.id, keyId: null });

		for (const headers of [await cookieHeadersFor(bob.id), bearerHeaders(bobKey.key)]) {
			const res = await cancel("t-2", headers);
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: "not_found" });
		}
		expect(turn.isCancelled()).toBe(false);
	});

	test("team: an admin may stop anyone's turn", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a3");
		const admin = await seedLocalUser("cx-admin", "admin");
		const turn = running("t-3", { userId: alice.id, keyId: null });
		expect((await cancel("t-3", await cookieHeadersFor(admin.id))).status).toBe(200);
		expect(turn.isCancelled()).toBe(true);
	});

	test("team: an ownerless manage key stops its own turn and no one else's; an ownerless respond key can't stop a person's", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a4");
		const mine = await seedKey("cx-loose-manage", ["manage"], null);
		const other = await seedKey("cx-loose-other", ["manage"], null);
		const loose = await seedKey("cx-loose-respond", ["respond"], null);
		const own = running("t-4a", { userId: null, keyId: mine.id });
		const theirs = running("t-4b", { userId: alice.id, keyId: null });

		expect((await cancel("t-4a", bearerHeaders(other.key))).status).toBe(404);
		expect(own.isCancelled()).toBe(false);
		expect((await cancel("t-4a", bearerHeaders(mine.key))).status).toBe(200);
		expect(own.isCancelled()).toBe(true);
		expect((await cancel("t-4b", bearerHeaders(mine.key))).status).toBe(404);
		expect((await cancel("t-4b", bearerHeaders(loose.key))).status).toBe(404);
		expect(theirs.isCancelled()).toBe(false);
	});

	describe("by credential: who may stop a member's turn (the F94 matrix)", () => {
		// [caller, may stop alice's turn, may stop its own turn]
		const callers = async () => {
			const alice = await seedLocalUser("cx-m-alice");
			const admin = await seedLocalUser("cx-m-admin", "admin");
			return {
				alice,
				admin,
				headers: {
					adminRespond: bearerHeaders(
						(await seedKey("cx-m-admin-resp", ["respond"], admin.id)).key,
					),
					adminManageKey: bearerHeaders(
						(await seedKey("cx-m-admin-mgr", ["manage"], admin.id)).key,
					),
					adminCookie: await cookieHeadersFor(admin.id),
					aliceRespond: bearerHeaders(
						(await seedKey("cx-m-alice-resp", ["respond"], alice.id)).key,
					),
					aliceCookie: await cookieHeadersFor(alice.id),
				},
			};
		};

		test("team: an admin's respond key can't stop a member's turn (404, turn goes on); a manage admin can", async () => {
			await setStoredMode("team");
			const { alice, headers } = await callers();
			const turn = running("t-m1", { userId: alice.id, keyId: null });
			const refused = await cancel("t-m1", headers.adminRespond);
			expect(refused.status).toBe(404);
			expect(await refused.json()).toMatchObject({ error: "not_found" });
			expect(turn.isCancelled()).toBe(false);
			const viaKey = running("t-m1-key", { userId: alice.id, keyId: null });
			const viaCookie = running("t-m1-cookie", { userId: alice.id, keyId: null });
			expect((await cancel("t-m1-key", headers.adminManageKey)).status).toBe(200);
			expect((await cancel("t-m1-cookie", headers.adminCookie)).status).toBe(200);
			expect([viaKey.isCancelled(), viaCookie.isCancelled()]).toEqual([true, true]);
		});

		test("team: an admin's respond key stops the turn it asked itself", async () => {
			await setStoredMode("team");
			const { admin, headers } = await callers();
			const turn = running("t-m2", { userId: admin.id, keyId: null });
			expect((await cancel("t-m2", headers.adminRespond)).status).toBe(200);
			expect(turn.isCancelled()).toBe(true);
		});

		test("team: an owner's respond key stops its owner's turn, and the refusal is the same 404 as no turn", async () => {
			await setStoredMode("team");
			const { alice, headers } = await callers();
			const bob = await seedLocalUser("cx-m-bob");
			const bobsTurn = running("t-m3b", { userId: bob.id, keyId: null });
			running("t-m3a", { userId: alice.id, keyId: null });
			const foreign = await cancel("t-m3b", headers.aliceRespond);
			const none = await cancel("t-m3-nothing", headers.aliceRespond);
			expect([foreign.status, await foreign.json()]).toEqual([none.status, await none.json()]);
			expect(bobsTurn.isCancelled()).toBe(false);
			expect((await cancel("t-m3a", headers.aliceRespond)).status).toBe(200);
		});

		test("solo: a respond key can't stop another person's turn; a manage key still can; its own it can", async () => {
			await setStoredMode("solo");
			const { alice, headers } = await callers();
			const other = await seedLocalUser("cx-m-other");
			const solo = bearerHeaders((await seedKey("cx-m-solo-resp", ["respond"], other.id)).key);
			const soloLoose = await seedKey("cx-m-solo-loose", ["respond"], null);
			const turn = running("t-m4", { userId: alice.id, keyId: null });
			expect((await cancel("t-m4", solo)).status).toBe(404);
			expect((await cancel("t-m4", bearerHeaders(soloLoose.key))).status).toBe(404);
			expect(turn.isCancelled()).toBe(false);
			// the manage credential keeps the one-person rule
			expect((await cancel("t-m4", headers.adminManageKey)).status).toBe(200);
			expect(turn.isCancelled()).toBe(true);
			const mine = running("t-m4b", { userId: other.id, keyId: null });
			expect((await cancel("t-m4b", solo)).status).toBe(200);
			expect(mine.isCancelled()).toBe(true);
			const loose = running("t-m4c", { userId: null, keyId: soloLoose.id });
			expect((await cancel("t-m4c", bearerHeaders(soloLoose.key))).status).toBe(200);
			expect(loose.isCancelled()).toBe(true);
		});
	});

	test("an observe key and an ingest key never reach the route: 403, whatever is running", async () => {
		const observe = await seedKey("cx-observe", ["observe"], null);
		const ingest = await seedKey("cx-ingest", ["ingest"], null);
		const turn = running("t-5", { userId: null, keyId: observe.id });
		for (const key of [observe.key, ingest.key]) {
			const res = await cancel("t-5", bearerHeaders(key));
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
		}
		expect(turn.isCancelled()).toBe(false);
	});

	test("a thread with no turn is 404, and the answer is the same as for someone else's turn", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a6");
		const bob = await seedLocalUser("cx-b6");
		running("t-6", { userId: alice.id, keyId: null });
		const bobs = await cookieHeadersFor(bob.id);
		const foreign = await cancel("t-6", bobs);
		const none = await cancel("t-nothing-here", bobs);
		expect([foreign.status, await foreign.json()]).toEqual([none.status, await none.json()]);
	});

	test("after the turn has finished a cancel finds nothing: 404", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a7");
		const turn = running("t-7", { userId: alice.id, keyId: null });
		turn.finish();
		expect((await cancel("t-7", await cookieHeadersFor(alice.id))).status).toBe(404);
	});

	test("a second cancel while the first is taking effect is still answered 200 stopping", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("cx-a8");
		running("t-8", { userId: alice.id, keyId: null });
		const headers = await cookieHeadersFor(alice.id);
		expect((await cancel("t-8", headers)).status).toBe(200);
		expect((await cancel("t-8", headers)).status).toBe(200);
	});
});
