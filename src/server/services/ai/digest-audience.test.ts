/**
 * The digest is built for one audience at a time: the rows its viewer may not read are dropped before
 * anything is counted, and the cache is kept per audience (N12). Two members and an admin on the same day
 * get three different digests, and an ownerless key's phone, which has no person behind it, gets none.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import { clearInstanceSettings, seedLocalUser } from "../../test-utils/team-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions, watcherProposals } = await import("../../db/schema/index.js");
const { buildDigest, countDigestSessions, getDailyDigest, invalidateDigestCache, EVERYONE } =
	await import("./digest-service.js");
const { digestAudienceOf } = await import("../push/push-trigger-ports.js");
type EligibleDevice = import("../push/push-targets.js").EligibleDevice;

beforeAll(() => initializeDatabase(), 60_000);
beforeEach(async () => {
	await getDb().delete(watcherProposals).execute();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	await resetIdentityState();
	await clearInstanceSettings();
	invalidateDigestCache();
}, 60_000);

const NOW = new Date("2026-10-20T12:00:00Z");

async function mkSession(sessionId: string, ownerUserId: string | null, cwd: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "completed",
			lastActivityAt: "2026-10-20T11:00:00.000Z",
			cwd,
			ownerUserId,
		})
		.execute();
}

const device = (id: string, userId: string, ownerlessKeyId: string | null = null) => ({
	id,
	userId,
	ownerlessKeyId,
	platform: "ios",
	relayDeviceId: id,
	sendTokenCiphertext: "t",
	kid: "k",
	publicKey: "AAAA",
	clientServerRef: "r",
	prefs: {},
});

async function world(): Promise<Record<"alice" | "bob" | "admin" | "loose", EligibleDevice>> {
	const alice = await seedLocalUser("da-alice");
	const bob = await seedLocalUser("da-bob");
	const admin = await seedLocalUser("da-admin", "admin");
	await mkSession("s-alice", alice.id, "/w/alice-repo");
	await mkSession("s-bob", bob.id, "/w/bob-repo");
	await mkSession("s-open", null, "/w/shared-repo");
	return {
		alice: { device: device("d-alice", alice.id), role: "member" },
		bob: { device: device("d-bob", bob.id), role: "member" },
		admin: { device: device("d-admin", admin.id), role: "admin" },
		loose: { device: device("d-loose", "key:k9", "k9"), role: null },
	};
}

const ids = (d: Awaited<ReturnType<typeof buildDigest>>) =>
	d.repos.flatMap((r) => r.sessions.map((s) => s.sessionId)).sort();

describe("digest audience", () => {
	test("each viewer's digest holds only what they may read, from the first build", async () => {
		const w = await world();
		const build = (entry: EligibleDevice) =>
			buildDigest({ audience: digestAudienceOf(entry, "team"), now: NOW });
		expect(ids(await build(w.alice))).toEqual(["s-alice", "s-open"]);
		expect(ids(await build(w.bob))).toEqual(["s-bob", "s-open"]);
		expect(ids(await build(w.admin))).toEqual(["s-alice", "s-bob", "s-open"]);
		expect(ids(await build(w.loose))).toEqual([]);
		expect(ids(await buildDigest({ now: NOW }))).toEqual(["s-alice", "s-bob", "s-open"]);
	});

	test("counts and repo names are taken after filtering, not blanked afterwards", async () => {
		const w = await world();
		const alice = await buildDigest({ audience: digestAudienceOf(w.alice, "team"), now: NOW });
		expect(alice.totals.sessions).toBe(2);
		expect(alice.totals.completedToday).toBe(2);
		expect(alice.totals.repos).toBe(2);
		expect(JSON.stringify(alice)).not.toContain("bob-repo");
		expect(JSON.stringify(alice)).not.toContain("s-bob");
	});

	test("the cache keeps them apart: the second read of each is its own, from the cache", async () => {
		const w = await world();
		const read = (entry: EligibleDevice) =>
			getDailyDigest({ audience: digestAudienceOf(entry, "team"), now: NOW });
		const first = [
			await read(w.alice),
			await read(w.bob),
			await read(w.admin),
			await read(w.loose),
		];
		const second = [
			await read(w.alice),
			await read(w.bob),
			await read(w.admin),
			await read(w.loose),
		];
		expect(second).toEqual(first);
		for (let i = 0; i < 4; i++) expect(second[i]).toBe(first[i] as never);
		expect(first.map((d) => d.totals.sessions)).toEqual([2, 2, 3, 0]);
		expect(ids(first[0] as never)).toEqual(["s-alice", "s-open"]);
		expect(ids(first[1] as never)).toEqual(["s-bob", "s-open"]);
	});

	test("an audience key isn't shared across people: a cached admin digest is never served to a member", async () => {
		const w = await world();
		await getDailyDigest({ audience: digestAudienceOf(w.admin, "team"), now: NOW });
		const member = await getDailyDigest({ audience: digestAudienceOf(w.alice, "team"), now: NOW });
		expect(ids(member)).toEqual(["s-alice", "s-open"]);
	});

	test("without an audience the digest is everyone's, as the web has always read it", async () => {
		await world();
		expect(ids(await getDailyDigest({ now: NOW }))).toEqual(["s-alice", "s-bob", "s-open"]);
		expect(EVERYONE.key).toBe("all");
	});

	test("solo: every device reads everything, ownerless keys included", async () => {
		const w = await world();
		for (const entry of [w.alice, w.loose]) {
			expect(
				ids(await getDailyDigest({ audience: digestAudienceOf(entry, "solo"), now: NOW })),
			).toEqual(["s-alice", "s-bob", "s-open"]);
		}
	});

	test("the count-only check agrees with the digest's own session total for every audience and mode", async () => {
		const w = await world();
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-old",
				agentType: "claude_code",
				status: "completed",
				lastActivityAt: "2026-10-10T11:00:00.000Z",
				ownerUserId: null,
			})
			.execute();
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-archived",
				agentType: "claude_code",
				status: "completed",
				lastActivityAt: "2026-10-20T11:00:00.000Z",
				isArchived: true,
				ownerUserId: null,
			})
			.execute();
		for (const mode of ["team", "solo"] as const) {
			for (const entry of [w.alice, w.bob, w.admin, w.loose]) {
				const audience = digestAudienceOf(entry, mode);
				const built = await buildDigest({ audience, now: NOW });
				const counted = await countDigestSessions({ audience, now: NOW });
				expect({ mode, id: entry.device.id, counted }).toEqual({
					mode,
					id: entry.device.id,
					counted: built.totals.sessions,
				});
			}
		}
		expect(await countDigestSessions({ now: NOW })).toBe(3);
		expect(
			await countDigestSessions({ audience: digestAudienceOf(w.alice, "team"), now: NOW }),
		).toBe(2);
		expect(
			await countDigestSessions({ audience: digestAudienceOf(w.loose, "team"), now: NOW }),
		).toBe(0);
	});
});
