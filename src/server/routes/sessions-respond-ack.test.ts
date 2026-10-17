/**
 * What a `respond` key can do to sessions in team mode: acknowledge and
 * un-acknowledge only its own owner's (or unowned) sessions. Another member's
 * session answers 200 "not_owner" and nothing is written. The ownerless key and
 * the admin-owned key are pinned too, since their outcome follows from the rule.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

const SEEN_AT = "2026-10-01T09:30:00.000Z";

async function stamp(sessionId: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ at: sessions.lastUserAcknowledgedAt })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId));
	return row?.at ?? null;
}

async function seed(sessionId: string, ownerUserId: string | null, acknowledged: boolean) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			status: "completed",
			ownerUserId,
			lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: acknowledged ? SEEN_AT : null,
		});
}

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("ack-alice");
	const bob = await seedLocalUser("ack-bob");
	const admin = await seedLocalUser("ack-admin", "admin");
	const aliceKey = await seedKey("ack-alice-key", ["respond"], alice.id);
	const adminKey = await seedKey("ack-admin-key", ["respond"], admin.id);
	const looseKey = await seedKey("ack-loose-key", ["respond"], null);
	return { alice, bob, aliceKey, adminKey, looseKey };
}

const call = (method: "POST" | "DELETE", sessionId: string, key: string) =>
	app.request(`/api/v1/sessions/${sessionId}/acknowledge`, { method, headers: bearerHeaders(key) });

describe("respond key acknowledging in team mode", () => {
	test("another member's session: POST answers not_owner and writes nothing", async () => {
		const t = await team();
		await seed("bobs", t.bob.id, false);

		const res = await call("POST", "bobs", t.aliceKey.key);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "not_owner" });
		expect(await stamp("bobs")).toBeNull();
	});

	test("another member's session: DELETE answers not_owner and leaves the stamp alone", async () => {
		const t = await team();
		await seed("bobs", t.bob.id, true);

		const res = await call("DELETE", "bobs", t.aliceKey.key);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ unacknowledged: false, reason: "not_owner" });
		expect(await stamp("bobs")).toBe(SEEN_AT);
	});

	test("the member's own session: POST stamps it and DELETE clears it", async () => {
		const t = await team();
		await seed("alices", t.alice.id, false);

		expect(await (await call("POST", "alices", t.aliceKey.key)).json()).toEqual({
			acknowledged: true,
		});
		expect(await stamp("alices")).not.toBeNull();

		expect(await (await call("DELETE", "alices", t.aliceKey.key)).json()).toEqual({
			unacknowledged: true,
		});
		expect(await stamp("alices")).toBeNull();
	});

	test("an ownerless respond key: an unowned session is acknowledged, an owned one is not_owner", async () => {
		const t = await team();
		await seed("nobodys", null, false);
		await seed("bobs", t.bob.id, false);

		expect(await (await call("POST", "nobodys", t.looseKey.key)).json()).toEqual({
			acknowledged: true,
		});
		expect(await (await call("POST", "bobs", t.looseKey.key)).json()).toEqual({
			acknowledged: false,
			reason: "not_owner",
		});
		expect(await stamp("bobs")).toBeNull();
	});

	test("an admin-owned respond key resolves to admin and may clear another member's session", async () => {
		const t = await team();
		await seed("bobs", t.bob.id, false);

		expect(await (await call("POST", "bobs", t.adminKey.key)).json()).toEqual({
			acknowledged: true,
		});
	});

	test("an unknown session is a 404 for a respond key as for anyone", async () => {
		const t = await team();
		expect((await call("POST", "no-such-session", t.aliceKey.key)).status).toBe(404);
	});
});
