/**
 * When an admin hands a session to a different user, the key recorded as its
 * ingest key stops being authoritative unless that key belongs to the new
 * owner: the previous owner's key can't keep writing to a session that is no
 * longer theirs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { processHookEvent } = await import("../services/event-processor.js");
const { claimUnassignedSessions } = await import("../services/session-owner-admin.js");

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

type KeyRow = { id: string; ownerUserId: string | null };
const ctxFor = (key: KeyRow) => ({
	keyId: key.id,
	deliveryId: null,
	origin: "native" as const,
	attribution: { ownerUserId: key.ownerUserId, ingestKeyId: key.id },
});
const hook = (sessionId: string, toolUseId: string) => ({
	session_id: sessionId,
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_use_id: toolUseId,
});
async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}

async function world() {
	const admin = await seedLocalUser("ho-admin", "admin");
	const alice = await seedLocalUser("ho-alice");
	const bob = await seedLocalUser("ho-bob");
	const keyOf = async (label: string, userId: string): Promise<KeyRow & { id: string }> => ({
		...(await seedKey(label, ["ingest"], userId)),
		ownerUserId: userId,
	});
	return {
		admin,
		alice,
		bob,
		adminCookie: await cookieHeadersFor(admin.id),
		aliceKey: await keyOf("ho-alice-key", alice.id),
		bobKey: await keyOf("ho-bob-key", bob.id),
	};
}

const handOver = (sessionId: string, ownerUserId: string | null, headers: Headers) =>
	app.request(
		`/api/v1/sessions/${sessionId}/owner`,
		jsonRequest("PATCH", { ownerUserId }, headers),
	);

describe("handing a session to a different user", () => {
	test("the previous owner's recorded key is dropped afterwards; the new owner's key works", async () => {
		await setStoredMode("team");
		const w = await world();
		// Created by Alice's key: owned by Alice, her key recorded.
		await processHookEvent(
			{ session_id: "ho-1", hook_event_name: "SessionStart" },
			"claude_code",
			ctxFor(w.aliceKey),
		);
		expect((await row("ho-1"))?.ingestKeyId).toBe(w.aliceKey.id);

		expect((await handOver("ho-1", w.bob.id, w.adminCookie)).status).toBe(200);
		expect((await row("ho-1"))?.ownerUserId).toBe(w.bob.id);
		expect((await row("ho-1"))?.ingestKeyId).toBeNull();

		expect(
			(await processHookEvent(hook("ho-1", "a1"), "claude_code", ctxFor(w.aliceKey))).session,
		).toBeNull();
		expect(
			(await processHookEvent(hook("ho-1", "b1"), "claude_code", ctxFor(w.bobKey))).session,
		).not.toBeNull();
	});

	test("a recorded key that belongs to the new owner stays recorded", async () => {
		await setStoredMode("team");
		const w = await world();
		await getDb().insert(sessions).values({
			sessionId: "ho-2",
			agentType: "claude_code",
			status: "active",
			ownerUserId: w.alice.id,
			ingestKeyId: w.bobKey.id,
		});
		expect((await handOver("ho-2", w.bob.id, w.adminCookie)).status).toBe(200);
		expect((await row("ho-2"))?.ingestKeyId).toBe(w.bobKey.id);
	});

	test("clearing the owner, or setting the same owner again, leaves the recorded key alone", async () => {
		await setStoredMode("team");
		const w = await world();
		await getDb().insert(sessions).values({
			sessionId: "ho-3",
			agentType: "claude_code",
			status: "active",
			ownerUserId: w.alice.id,
			ingestKeyId: w.aliceKey.id,
		});
		expect((await handOver("ho-3", w.alice.id, w.adminCookie)).status).toBe(200);
		expect((await row("ho-3"))?.ingestKeyId).toBe(w.aliceKey.id);
		expect((await handOver("ho-3", null, w.adminCookie)).status).toBe(200);
		expect((await row("ho-3"))?.ingestKeyId).toBe(w.aliceKey.id);
	});
});

describe("setting the owner a session already has", () => {
	test("a service key bound to it stays bound", async () => {
		await setStoredMode("team");
		const w = await world();
		const service = await seedKey("ho-bound-service", ["ingest"]);
		await getDb().insert(sessions).values({
			sessionId: "ho-same",
			agentType: "claude_code",
			status: "active",
			ownerUserId: w.alice.id,
			ingestKeyId: service.id,
		});
		expect((await handOver("ho-same", w.alice.id, w.adminCookie)).status).toBe(200);
		expect((await row("ho-same"))?.ingestKeyId).toBe(service.id);
	});
});

describe("the other two ways an admin gives sessions to a user", () => {
	test("claiming unassigned sessions only takes sessions with no recorded key, so there is none to clear", async () => {
		const w = await world();
		await getDb()
			.insert(sessions)
			.values([
				{ sessionId: "ho-free", agentType: "claude_code", status: "active" },
				{
					sessionId: "ho-keyed",
					agentType: "claude_code",
					status: "active",
					ingestKeyId: w.aliceKey.id,
				},
			]);
		expect(await claimUnassignedSessions(w.bob.id)).toBe(1);
		expect((await row("ho-free"))?.ownerUserId).toBe(w.bob.id);
		expect((await row("ho-keyed"))?.ownerUserId).toBeNull();
		expect((await row("ho-keyed"))?.ingestKeyId).toBe(w.aliceKey.id);
	});

	test("attributing a service key's sessions to a person keeps that key recorded: it is now the person's key", async () => {
		await setStoredMode("team");
		const w = await world();
		const service = await seedKey("ho-service", ["ingest"]);
		await getDb().insert(sessions).values({
			sessionId: "ho-attr",
			agentType: "claude_code",
			status: "active",
			ingestKeyId: service.id,
		});
		const res = await app.request(
			`/api/v1/api-keys/${service.id}`,
			jsonRequest("PATCH", { ownerUserId: w.bob.id, attributeSessions: true }, w.adminCookie),
		);
		expect(res.status).toBe(200);
		expect((await row("ho-attr"))?.ownerUserId).toBe(w.bob.id);
		expect((await row("ho-attr"))?.ingestKeyId).toBe(service.id);
		expect(
			(
				await processHookEvent(hook("ho-attr", "s1"), "claude_code", {
					keyId: service.id,
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: w.bob.id, ingestKeyId: service.id },
				})
			).session,
		).not.toBeNull();
	});
});
