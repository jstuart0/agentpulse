/**
 * Ask threads belong to whoever asked them.
 *
 * Team mode: read, list and archive reach a thread only for the person who asked it (by
 * user, or by key for a key with no owner user) or an admin. Everyone else gets the same
 * 404 as a thread that doesn't exist, so the answer says nothing about which ids exist. A
 * thread with no owner (one that predates owners, or a Telegram chat's) is an admin's
 * alone. The phone's respond key reads its own person's thread. Solo mode is one person:
 * every thread is theirs, ownerless ones included, exactly as before.
 *
 * Threads are written straight to the table, so this runs on Postgres as well as SQLite.
 * Cancel has its own matrix in ask-cancel-authz.test.ts.
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
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { eq } = await import("drizzle-orm");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { aiActionRequests, askMessages, askThreads } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { upsertSetting } = await import("../services/settings-service.js");
const { setLabsFlag } = await import("../services/labs-service.js");
const { invalidateAiFlagsCache } = await import("../services/ai/feature.js");
const { countOpenProposals } = await import("../services/ask/ask-service.js");

beforeAll(() => initializeDatabase(), 60_000);
beforeEach(async () => {
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	invalidateAiFlagsCache();
	await setLabsFlag("askAssistant", true);
}, 60_000);
afterEach(async () => {
	await getDb().delete(aiActionRequests);
	await getDb().delete(askMessages);
	await getDb().delete(askThreads);
	await resetIdentityState();
	await clearInstanceSettings();
	await setLabsFlag("askAssistant", false);
	await upsertSetting("ai.enabled", false, { allowProtected: true });
	invalidateAiFlagsCache();
}, 60_000);

type ThreadName = "alice" | "bob" | "loose" | "none" | "telegram";

interface World {
	threads: Record<ThreadName, string>;
	callers: Record<string, Headers>;
}

async function insertThread(values: Record<string, unknown>): Promise<string> {
	const [row] = await getDb()
		.insert(askThreads)
		.values({ origin: "web", ...values } as never)
		.returning();
	const id = (row as { id: string }).id;
	await getDb()
		.insert(askMessages)
		.values({ threadId: id, role: "user", content: `question in ${id}` });
	return id;
}

async function world(): Promise<World> {
	const alice = await seedLocalUser("ao-alice");
	const bob = await seedLocalUser("ao-bob");
	const admin = await seedLocalUser("ao-admin", "admin");
	const aliceKey = await seedKey("ao-alice-manage", ["manage"], alice.id);
	const aliceRespond = await seedKey("ao-alice-respond", ["respond"], alice.id);
	const bobKey = await seedKey("ao-bob-manage", ["manage"], bob.id);
	const adminKey = await seedKey("ao-admin-manage", ["manage"], admin.id);
	const loose = await seedKey("ao-loose-manage", ["manage"], null);
	const otherLoose = await seedKey("ao-other-loose", ["manage"], null);
	const threads = {
		alice: await insertThread({ title: "alice's", ownerUserId: alice.id }),
		bob: await insertThread({ title: "bob's", ownerUserId: bob.id }),
		loose: await insertThread({ title: "loose key's", ownerKeyId: loose.id }),
		none: await insertThread({ title: "ownerless" }),
		telegram: await insertThread({ title: "telegram chat", origin: "telegram" }),
	};
	await setStoredMode("team");
	return {
		threads,
		callers: {
			alice: await cookieHeadersFor(alice.id),
			aliceKey: bearerHeaders(aliceKey.key),
			aliceRespond: bearerHeaders(aliceRespond.key),
			bob: await cookieHeadersFor(bob.id),
			bobKey: bearerHeaders(bobKey.key),
			admin: await cookieHeadersFor(admin.id),
			adminKey: bearerHeaders(adminKey.key),
			loose: bearerHeaders(loose.key),
			otherLoose: bearerHeaders(otherLoose.key),
		},
	};
}

const read = (id: string, headers: Headers) =>
	app.request(`/api/v1/ai/ask/threads/${id}`, { headers });
const list = (headers: Headers) => app.request("/api/v1/ai/ask/threads", { headers });
const archive = (id: string, headers: Headers) =>
	app.request(`/api/v1/ai/ask/threads/${id}`, { method: "DELETE", headers });

const ALL: ThreadName[] = ["alice", "bob", "loose", "none", "telegram"];
// [caller, the threads it may reach in team mode]
const TEAM_MATRIX: Array<[string, ThreadName[]]> = [
	["alice", ["alice"]],
	["aliceKey", ["alice"]],
	["bob", ["bob"]],
	["bobKey", ["bob"]],
	["admin", ALL],
	["adminKey", ALL],
	["loose", ["loose"]],
	["otherLoose", []],
];

describe("team mode: read (GET /ai/ask/threads/:id)", () => {
	for (const [caller, may] of TEAM_MATRIX) {
		test(`${caller} reads ${may.length === 0 ? "nothing" : may.join(", ")}, and 404s on the rest`, async () => {
			const w = await world();
			const headers = w.callers[caller] as Headers;
			const missing = await read("no-such-thread", headers);
			for (const name of ALL) {
				const res = await read(w.threads[name], headers);
				if (may.includes(name)) {
					expect({ caller, name, status: res.status }).toEqual({ caller, name, status: 200 });
					const body = (await res.json()) as {
						thread: Record<string, unknown>;
						messages: unknown[];
					};
					expect(body.thread.id).toBe(w.threads[name]);
					expect(body.messages).toHaveLength(1);
				} else {
					// Same status and same body as an id that never existed: nothing to tell them apart by.
					expect({ caller, name, status: res.status }).toEqual({ caller, name, status: 404 });
					expect(await res.json()).toEqual(await missing.clone().json());
				}
			}
		});
	}

	test("a key id recorded on a thread that has a user owner gives that key nothing", async () => {
		const w = await world();
		const bob = await seedLocalUser("ao-bob-mixed");
		const loose = await seedKey("ao-loose-mixed", ["manage"], null);
		const id = await insertThread({ ownerUserId: bob.id, ownerKeyId: loose.id });
		expect((await read(id, bearerHeaders(loose.key))).status).toBe(404);
		expect((await read(id, await cookieHeadersFor(bob.id))).status).toBe(200);
		expect(w.threads.alice).toBeTruthy();
	});

	test("the phone's respond key reads its own person's thread, and not another person's", async () => {
		const w = await world();
		const own = await read(w.threads.alice, w.callers.aliceRespond as Headers);
		expect(own.status).toBe(200);
		for (const name of ["bob", "loose", "none", "telegram"] as const) {
			const res = await read(w.threads[name], w.callers.aliceRespond as Headers);
			expect({ name, status: res.status }).toEqual({ name, status: 404 });
		}
	});

	test("a respond key can read a thread but not list them or archive one", async () => {
		const w = await world();
		const headers = w.callers.aliceRespond as Headers;
		expect((await list(headers)).status).toBe(403);
		const res = await archive(w.threads.alice, headers);
		expect(res.status).toBe(403);
		const [row] = await getDb().select().from(askThreads).where(eq(askThreads.id, w.threads.alice));
		expect(row?.archivedAt).toBeNull();
	});

	test("the thread in the answer names no owner", async () => {
		const w = await world();
		const body = (await (await read(w.threads.alice, w.callers.alice as Headers)).json()) as {
			thread: Record<string, unknown>;
		};
		expect(Object.keys(body.thread).sort()).toEqual([
			"archivedAt",
			"createdAt",
			"id",
			"origin",
			"telegramChatId",
			"title",
			"updatedAt",
		]);
	});
});

describe("team mode: list (GET /ai/ask/threads)", () => {
	for (const [caller, may] of TEAM_MATRIX) {
		test(`${caller} lists ${may.length === 0 ? "nothing" : may.join(", ")}`, async () => {
			const w = await world();
			const res = await list(w.callers[caller] as Headers);
			expect(res.status).toBe(200);
			const { threads } = (await res.json()) as { threads: Array<{ id: string }> };
			expect(threads.map((t) => t.id).sort()).toEqual(may.map((name) => w.threads[name]).sort());
		});
	}
});

describe("team mode: archive (DELETE /ai/ask/threads/:id)", () => {
	for (const [caller, may] of TEAM_MATRIX) {
		test(`${caller} archives ${may.length === 0 ? "nothing" : may.join(", ")}, and the rest stay`, async () => {
			const w = await world();
			const headers = w.callers[caller] as Headers;
			const missing = await archive("no-such-thread", headers);
			for (const name of ALL) {
				const res = await archive(w.threads[name], headers);
				const [row] = await getDb()
					.select()
					.from(askThreads)
					.where(eq(askThreads.id, w.threads[name]));
				if (may.includes(name)) {
					expect({ caller, name, status: res.status }).toEqual({ caller, name, status: 200 });
					expect(row?.archivedAt).not.toBeNull();
				} else {
					expect({ caller, name, status: res.status }).toEqual({ caller, name, status: 404 });
					expect(await res.json()).toEqual(await missing.clone().json());
					expect(row?.archivedAt).toBeNull();
				}
			}
		});
	}

	test("an archived thread leaves the owner's list but stays unreadable to others", async () => {
		const w = await world();
		expect((await archive(w.threads.alice, w.callers.alice as Headers)).status).toBe(200);
		const { threads } = (await (await list(w.callers.alice as Headers)).json()) as {
			threads: unknown[];
		};
		expect(threads).toEqual([]);
		expect((await archive(w.threads.alice, w.callers.alice as Headers)).status).toBe(404);
	});
});

describe("solo mode: one person, every thread is theirs", () => {
	test("any manage key reads, lists and archives every thread, ownerless ones included", async () => {
		const w = await world();
		await setStoredMode("solo");
		const key = bearerHeaders((await seedKey("ao-solo", ["manage"], null)).key);
		const { threads } = (await (await list(key)).json()) as { threads: Array<{ id: string }> };
		expect(threads.map((t) => t.id).sort()).toEqual(Object.values(w.threads).sort());
		for (const name of ALL) {
			expect((await read(w.threads[name], key)).status).toBe(200);
		}
		for (const name of ALL) {
			expect((await archive(w.threads[name], key)).status).toBe(200);
		}
	});
});

describe("a thread that predates owners", () => {
	test("is unchanged in solo and admin-only in team, whoever asked it", async () => {
		const w = await world();
		const member = w.callers.alice as Headers;
		const admin = w.callers.admin as Headers;
		expect((await read(w.threads.none, member)).status).toBe(404);
		expect((await read(w.threads.none, admin)).status).toBe(200);
		await setStoredMode("solo");
		expect((await read(w.threads.none, member)).status).toBe(200);
	});
});

describe("the open proposals an ask_reply push counts", () => {
	test("counts the thread's requests still waiting on a person, and no other thread's", async () => {
		const w = await world();
		const request = (threadId: string | null, status: string) => ({
			kind: "launch",
			status,
			question: "launch it?",
			payload: {},
			origin: "ask",
			askThreadId: threadId,
		});
		await getDb()
			.insert(aiActionRequests)
			.values([
				request(w.threads.alice, "awaiting_reply"),
				request(w.threads.alice, "awaiting_reply"),
				request(w.threads.alice, "approved"),
				request(w.threads.alice, "declined"),
				request(w.threads.bob, "awaiting_reply"),
				request(null, "awaiting_reply"),
			] as never);
		expect(await countOpenProposals(w.threads.alice)).toBe(2);
		expect(await countOpenProposals(w.threads.bob)).toBe(1);
		expect(await countOpenProposals(w.threads.loose)).toBe(0);
		expect(await countOpenProposals("no-such-thread")).toBe(0);
	});
});

describe("a respond key reads only a thread it asked, whatever its role or the mode", () => {
	const names = ["alice", "bob", "loose", "none", "telegram"] as const;

	test("an admin's respond key reads its admin's own thread and nothing else, ownerless threads included", async () => {
		const w = await world();
		const admin = await seedLocalUser("ao-admin-respond", "admin");
		const adminRespond = bearerHeaders((await seedKey("ao-admin-resp", ["respond"], admin.id)).key);
		const mine = await insertThread({ title: "the admin's", ownerUserId: admin.id });
		expect((await read(mine, adminRespond)).status).toBe(200);
		for (const name of names) {
			expect({ name, status: (await read(w.threads[name], adminRespond)).status }).toEqual({
				name,
				status: 404,
			});
		}
		// the same admin, on a manage credential, still reads everything
		for (const name of names) {
			expect((await read(w.threads[name], await cookieHeadersFor(admin.id))).status).toBe(200);
		}
	});

	test("an owner's respond key reads its owner's threads and no one else's", async () => {
		const w = await world();
		expect((await read(w.threads.alice, w.callers.aliceRespond as Headers)).status).toBe(200);
		for (const name of ["bob", "loose", "none", "telegram"] as const) {
			expect((await read(w.threads[name], w.callers.aliceRespond as Headers)).status).toBe(404);
		}
	});

	test("solo: a respond key reads what its person (or it) asked, not the other threads a manage key would", async () => {
		const w = await world();
		await setStoredMode("solo");
		const alice = await seedLocalUser("ao-solo-alice");
		const owned = await insertThread({ ownerUserId: alice.id });
		const loose = await seedKey("ao-solo-loose-respond", ["respond"], null);
		const byKey = await insertThread({ ownerKeyId: loose.id });
		const aliceRespond = bearerHeaders(
			(await seedKey("ao-solo-alice-resp", ["respond"], alice.id)).key,
		);

		expect((await read(owned, aliceRespond)).status).toBe(200);
		expect((await read(byKey, bearerHeaders(loose.key))).status).toBe(200);
		for (const name of names) {
			expect((await read(w.threads[name], aliceRespond)).status).toBe(404);
			expect((await read(w.threads[name], bearerHeaders(loose.key))).status).toBe(404);
		}
		expect((await read(byKey, aliceRespond)).status).toBe(404);
		// a manage key in solo keeps the usual rule: every thread is the one person's
		const manage = bearerHeaders((await seedKey("ao-solo-manage", ["manage"], null)).key);
		for (const name of names) expect((await read(w.threads[name], manage)).status).toBe(200);
	});

	test("a manage admin credential keeps the usual rule", async () => {
		const w = await world();
		for (const caller of ["admin", "adminKey"]) {
			for (const name of names) {
				expect((await read(w.threads[name], w.callers[caller] as Headers)).status).toBe(200);
			}
		}
	});
});
