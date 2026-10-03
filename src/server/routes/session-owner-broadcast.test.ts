/**
 * The dashboard filters live updates by owner, so every session_created and
 * session_updated payload has to carry ownerUserId and ownerKind, whichever
 * path produced it: a hook event (the raw row) or a dashboard action such as
 * a rename (the already-mapped session). The recorded key id never leaves the
 * server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
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

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { sessionBus } = await import("../services/notifier.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");

beforeAll(async () => {
	await initializeDatabase();
	(await import("./health.js")).markDbReady();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

interface Payload {
	sessionId: string;
	ownerUserId?: string | null;
	ownerKind?: string;
	ingestKeyId?: unknown;
}

/** Resolves with the next session_created / session_updated payload for the session. */
function nextBroadcast(
	sessionId: string,
	type: "session_created" | "session_updated",
): Promise<Payload> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no ${type} for ${sessionId}`)), 3000);
		const onEvent = (payload: unknown) => {
			if ((payload as Payload).sessionId !== sessionId) return;
			clearTimeout(timer);
			sessionBus.off(type, onEvent);
			resolve(payload as Payload);
		};
		sessionBus.on(type, onEvent);
	});
}

async function settled() {
	for (let i = 0; i < 300 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
}

const postHook = (sessionId: string, eventName: string, headers: Headers) =>
	app.request(
		"/api/v1/hooks",
		jsonRequest("POST", { session_id: sessionId, hook_event_name: eventName, cwd: "/w" }, headers),
	);

describe("session broadcasts carry the owner", () => {
	test("a hook from a member's key: created and updated payloads carry that member and kind user", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("bc-member");
		const key = await seedKey("bc-member-key", ["ingest"], member.id);
		const created = nextBroadcast("bc-user", "session_created");
		expect((await postHook("bc-user", "SessionStart", bearerHeaders(key.key))).status).toBe(200);
		expect(await created).toMatchObject({ ownerUserId: member.id, ownerKind: "user" });

		const updated = nextBroadcast("bc-user", "session_updated");
		await postHook("bc-user", "UserPromptSubmit", bearerHeaders(key.key));
		const payload = await updated;
		expect(payload).toMatchObject({ ownerUserId: member.id, ownerKind: "user" });
		expect("ingestKeyId" in payload).toBe(false);
		await settled();
	});

	test("a hook from a service key: kind service, no owner, key id not on the wire", async () => {
		await setStoredMode("team");
		const key = await seedKey("bc-service-key", ["ingest"]);
		const created = nextBroadcast("bc-service", "session_created");
		await postHook("bc-service", "SessionStart", bearerHeaders(key.key));
		const payload = await created;
		expect(payload).toMatchObject({ ownerUserId: null, ownerKind: "service" });
		expect("ingestKeyId" in payload).toBe(false);
		await settled();
	});

	test("a dashboard rename of a service-reported session keeps kind service in its update", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("bc-admin", "admin");
		const key = await seedKey("bc-rename-key", ["ingest"]);
		const created = nextBroadcast("bc-rename", "session_created");
		await postHook("bc-rename", "SessionStart", bearerHeaders(key.key));
		await created;
		await settled();

		const updated = nextBroadcast("bc-rename", "session_updated");
		const res = await app.request(
			"/api/v1/sessions/bc-rename/rename",
			jsonRequest("PUT", { name: "Renamed", source: "user" }, await cookieHeadersFor(admin.id)),
		);
		expect(res.status).toBe(200);
		const payload = await updated;
		expect(payload).toMatchObject({ ownerUserId: null, ownerKind: "service" });
	});

	test("a dashboard rename of an owned session keeps its owner in the update", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("bc-owned");
		const key = await seedKey("bc-owned-key", ["ingest"], member.id);
		const created = nextBroadcast("bc-owned-rename", "session_created");
		await postHook("bc-owned-rename", "SessionStart", bearerHeaders(key.key));
		await created;
		await settled();

		const updated = nextBroadcast("bc-owned-rename", "session_updated");
		await app.request(
			"/api/v1/sessions/bc-owned-rename/rename",
			jsonRequest("PUT", { name: "Mine now", source: "user" }, await cookieHeadersFor(member.id)),
		);
		expect(await updated).toMatchObject({ ownerUserId: member.id, ownerKind: "user" });
	});
});

describe("dashboard actions on a session broadcast it with its owner", () => {
	async function ownedSession(label: string) {
		await setStoredMode("team");
		const member = await seedLocalUser(`${label}-member`);
		const key = await seedKey(`${label}-key`, ["ingest"], member.id);
		const sessionId = `${label}-session`;
		const created = nextBroadcast(sessionId, "session_created");
		await postHook(sessionId, "SessionStart", bearerHeaders(key.key));
		await created;
		await settled();
		return { member, sessionId, headers: await cookieHeadersFor(member.id) };
	}

	const actions: Array<[string, string, unknown]> = [
		["pin", "pin", { pinned: true }],
		["archive", "archive", { archived: true }],
		["notes", "notes", { notes: "remember this" }],
	];

	for (const [label, path, body] of actions) {
		test(`${label} broadcasts a session update that carries the owner and not the key id`, async () => {
			const world = await ownedSession(`bc-${label}`);
			const updated = nextBroadcast(world.sessionId, "session_updated");
			const res = await app.request(
				`/api/v1/sessions/${world.sessionId}/${path}`,
				jsonRequest("PUT", body, world.headers),
			);
			expect(res.status).toBe(200);
			const payload = await updated;
			expect(payload).toMatchObject({ ownerUserId: world.member.id, ownerKind: "user" });
			expect("ingestKeyId" in payload).toBe(false);
		});
	}

	test("a refused pin broadcasts nothing", async () => {
		const world = await ownedSession("bc-refused");
		const stranger = await seedLocalUser("bc-stranger");
		let heard = false;
		const listener = (payload: unknown) => {
			if ((payload as Payload).sessionId === world.sessionId) heard = true;
		};
		sessionBus.on("session_updated", listener);
		try {
			const res = await app.request(
				`/api/v1/sessions/${world.sessionId}/pin`,
				jsonRequest("PUT", { pinned: true }, await cookieHeadersFor(stranger.id)),
			);
			expect(res.status).toBe(403);
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			sessionBus.off("session_updated", listener);
		}
		expect(heard).toBe(false);
	});
});
