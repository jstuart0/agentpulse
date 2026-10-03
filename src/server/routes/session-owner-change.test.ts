/**
 * PATCH /sessions/:sessionId/owner: an admin (a signed-in admin, an admin-owned
 * key, or a kept service key; never a member) sets or clears a session's owner.
 * The audit line (who, from, to) is the only record, the broadcast carries the
 * new owner, and a later event from another key doesn't move it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { sessionBus } = await import("../services/notifier.js");
const { processHookEvent } = await import("../services/event-processor.js");

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

async function seedSession(
	sessionId: string,
	ownerUserId: string | null,
	ingestKeyId: string | null = null,
) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", ownerUserId, ingestKeyId });
}
async function ownerOf(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row?.ownerUserId ?? null;
}
async function errorCode(res: Response): Promise<string | undefined> {
	return ((await res.json().catch(() => ({}))) as { error?: string }).error;
}
const patch = (sessionId: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1/sessions/${sessionId}/owner`, jsonRequest("PATCH", body, headers));

function auditLines(lines: string[]) {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((line) => line?.kind === "session_owner_changed");
}

describe("PATCH /sessions/:sessionId/owner", () => {
	test("an admin changes the owner; the audit line carries from, to and by", async () => {
		const admin = await seedLocalUser("so-admin", "admin");
		const first = await seedLocalUser("so-first");
		const second = await seedLocalUser("so-second");
		await seedSession("so-1", first.id);

		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		let res: Response;
		try {
			res = await patch("so-1", { ownerUserId: second.id }, await cookieHeadersFor(admin.id));
		} finally {
			spy.mockRestore();
		}
		expect(res.status).toBe(200);
		const body = (await res.json()) as { session: { ownerUserId: string; ownerKind: string } };
		expect(body.session.ownerUserId).toBe(second.id);
		expect(body.session.ownerKind).toBe("user");
		expect(await ownerOf("so-1")).toBe(second.id);

		const [line] = auditLines(lines);
		expect(line).toMatchObject({ sessionId: "so-1", from: first.id, to: second.id, by: admin.id });
	});

	test("null clears the owner; a session reported by a key then reads as a service session", async () => {
		const admin = await seedLocalUser("so-clear-admin", "admin");
		const owner = await seedLocalUser("so-clear-owner");
		const service = await seedKey("so-clear-key", ["ingest"]);
		await seedSession("so-clear", owner.id, service.id);
		const res = await patch("so-clear", { ownerUserId: null }, await cookieHeadersFor(admin.id));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { session: { ownerKind: string } }).session.ownerKind).toBe(
			"service",
		);
		expect(await ownerOf("so-clear")).toBeNull();
	});

	test("an admin-owned key and a kept service key may; an unkept service key and a member may not", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("so-key-admin", "admin");
		const member = await seedLocalUser("so-key-member");
		const adminKey = await seedKey("so-adminkey", ["manage"], admin.id);
		const listed = await seedKey("so-listed", ["manage"]);
		const unlisted = await seedKey("so-unlisted", ["manage"]);
		await setAdminServiceKeyList([listed.id]);
		await seedSession("so-who", null);

		expect(
			(await patch("so-who", { ownerUserId: member.id }, bearerHeaders(adminKey.key))).status,
		).toBe(200);
		expect(
			(await patch("so-who", { ownerUserId: admin.id }, bearerHeaders(listed.key))).status,
		).toBe(200);
		const refused = await patch("so-who", { ownerUserId: member.id }, bearerHeaders(unlisted.key));
		expect(refused.status).toBe(403);
		const asMember = await patch(
			"so-who",
			{ ownerUserId: member.id },
			await cookieHeadersFor(member.id),
		);
		expect(asMember.status).toBe(403);
		expect(await ownerOf("so-who")).toBe(admin.id);
	});

	test("an unknown session is 404, an unknown or disabled target is 404 or 409, a bad body is 400", async () => {
		const admin = await seedLocalUser("so-err-admin", "admin");
		const gone = await seedLocalUser("so-err-gone");
		await disableUserDirectly(gone.id);
		await seedSession("so-err", null);
		const headers = await cookieHeadersFor(admin.id);
		expect((await patch("no-such-session", { ownerUserId: admin.id }, headers)).status).toBe(404);
		const unknown = await patch("so-err", { ownerUserId: "nope" }, headers);
		expect(unknown.status).toBe(404);
		expect(await errorCode(unknown)).toBe("user_not_found");
		const disabled = await patch("so-err", { ownerUserId: gone.id }, headers);
		expect(disabled.status).toBe(409);
		expect(await errorCode(disabled)).toBe("user_disabled");
		expect((await patch("so-err", {}, headers)).status).toBe(400);
		expect((await patch("so-err", { ownerUserId: 5 }, headers)).status).toBe(400);
		expect(await ownerOf("so-err")).toBeNull();
	});

	test("a foreign Origin is refused", async () => {
		const admin = await seedLocalUser("so-origin", "admin");
		await seedSession("so-origin-s", null);
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", "https://evil.example.test");
		const res = await patch("so-origin-s", { ownerUserId: admin.id }, headers);
		expect(res.status).toBe(403);
		expect(await errorCode(res)).toBe("bad_origin");
	});

	test("the broadcast carries the new owner", async () => {
		const admin = await seedLocalUser("so-bus-admin", "admin");
		const target = await seedLocalUser("so-bus-target");
		await seedSession("so-bus", null);
		const seen: Array<{ sessionId: string; ownerUserId: string | null }> = [];
		const listener = (session: { sessionId: string; ownerUserId?: string | null }) => {
			seen.push({ sessionId: session.sessionId, ownerUserId: session.ownerUserId ?? null });
		};
		sessionBus.on("session_updated", listener);
		try {
			await patch("so-bus", { ownerUserId: target.id }, await cookieHeadersFor(admin.id));
		} finally {
			sessionBus.off("session_updated", listener);
		}
		expect(seen.find((s) => s.sessionId === "so-bus")?.ownerUserId).toBe(target.id);
	});

	test("a later event from another owner's key does not move it", async () => {
		const admin = await seedLocalUser("so-move-admin", "admin");
		const assigned = await seedLocalUser("so-move-assigned");
		const stranger = await seedLocalUser("so-move-stranger");
		const strangerKey = await seedKey("so-stranger-key", ["ingest"], stranger.id);
		await seedSession("so-move", null);
		await patch("so-move", { ownerUserId: assigned.id }, await cookieHeadersFor(admin.id));

		await processHookEvent(
			{ session_id: "so-move", hook_event_name: "PostToolUse" },
			"claude_code",
			{
				keyId: strangerKey.id,
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: stranger.id, ingestKeyId: strangerKey.id },
			},
		);
		expect(await ownerOf("so-move")).toBe(assigned.id);
	});
});
