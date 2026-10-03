/**
 * Nothing in team mode is private: a session update is broadcast to every
 * connected client, not filtered per viewer. A second user's socket receives
 * another user's session update, and the payload carries no key ids.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
const { sessionBus } = await import("../services/notifier.js");
const { handleWsClose, handleWsOpen, initWsBroadcaster } = await import("./handler.js");

beforeAll(async () => {
	await initializeDatabase();
	initWsBroadcaster(sessionBus);
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

function openSocket(userId: string | null) {
	const received: string[] = [];
	const ws = {
		data: { userId, keyId: null },
		send: (message: string) => received.push(message),
		close: () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	handleWsOpen(ws as any);
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	return { received, close: () => handleWsClose(ws as any) };
}

describe("session broadcasts are not filtered per viewer", () => {
	test("a second user's socket receives the owner's session update, with no key ids in it", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("wb-owner");
		const other = await seedLocalUser("wb-other");
		const key = await seedKey("wb-key", ["ingest"], owner.id);
		await getDb().insert(sessions).values({
			sessionId: "wb-1",
			agentType: "claude_code",
			status: "completed",
			ownerUserId: owner.id,
			ingestKeyId: key.id,
			lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
		});
		const ownerSocket = openSocket(owner.id);
		const otherSocket = openSocket(other.id);
		try {
			const res = await app.request(
				"/api/v1/sessions/wb-1/acknowledge",
				jsonRequest("POST", {}, await cookieHeadersFor(owner.id)),
			);
			expect(await res.json()).toEqual({ acknowledged: true });

			for (const socket of [ownerSocket, otherSocket]) {
				const updates = socket.received
					.map(
						(message) =>
							JSON.parse(message) as { type: string; data: { session: Record<string, unknown> } },
					)
					.filter(
						(message) =>
							message.type === "session_updated" && message.data.session.sessionId === "wb-1",
					);
				expect(updates.length).toBe(1);
				expect(updates[0].data.session.ownerUserId).toBe(owner.id);
			}
			const payload = otherSocket.received.join("\n");
			expect(payload).not.toContain(key.id);
			expect(payload).not.toContain("ingestKeyId");
		} finally {
			ownerSocket.close();
			otherSocket.close();
		}
	});
});
