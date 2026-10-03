/**
 * Owner-or-admin rules, per actor kind and mode.
 *
 * Solo: every assertion is a no-op. Team: a session's owner or an admin may
 * delete, archive, rename or pin it (an unowned session stays open to any
 * member); a key or host is for its owner or an admin (an unowned one is for an
 * admin). An actor with no user id (a Telegram chat, autonomous AI, a service
 * key that isn't kept as an admin) is a member with no identity: refused on
 * anything owned, and on an unowned session too (open to signed-in members, not
 * to someone the instance doesn't know). A host credential is refused on
 * everything.
 *
 * The same rules hold where the operation is reached without a route: the AI
 * action-request executors run them with the approving human as the actor.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, aiActionRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const {
	AdminRequiredError,
	NotOwnerError,
	assertAdmin,
	assertCanArchiveSession,
	assertCanDeleteSession,
	assertCanManageHost,
	assertCanPinSession,
	assertCanRenameSession,
	assertCanRevokeKey,
	assertCanViewKey,
	mayClearAttention,
} = await import("./authorization.js");
const { createActionRequest, getActionRequest, resolveActionRequest } = await import(
	"./ai/action-requests-service.js"
);

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(aiActionRequests);
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

// ── The pure rule for clearing WAITING / ERROR ────────────────────────────────

describe("mayClearAttention", () => {
	const base = { sessionOwnerUserId: "u1", callerUserId: "u1" };

	test("an unowned session accepts any caller", () => {
		expect(mayClearAttention({ sessionOwnerUserId: null, callerUserId: "u2" })).toBe(true);
		expect(mayClearAttention({ sessionOwnerUserId: null, callerUserId: null })).toBe(true);
	});

	test("an owned session accepts its owner and nobody else", () => {
		expect(mayClearAttention(base)).toBe(true);
		expect(mayClearAttention({ sessionOwnerUserId: "u1", callerUserId: "u2" })).toBe(false);
		expect(mayClearAttention({ sessionOwnerUserId: "u1", callerUserId: null })).toBe(false);
	});

	test("auth disabled accepts anyone", () => {
		expect(
			mayClearAttention({ sessionOwnerUserId: "u1", callerUserId: null, authDisabled: true }),
		).toBe(true);
	});

	test("an admin override accepts a non-owner", () => {
		expect(
			mayClearAttention({ sessionOwnerUserId: "u1", callerUserId: "u2", adminOverride: true }),
		).toBe(true);
		expect(
			mayClearAttention({ sessionOwnerUserId: "u1", callerUserId: null, adminOverride: true }),
		).toBe(true);
	});
});

// ── Actors and resources ──────────────────────────────────────────────────────

interface Fixture {
	admin: Actor;
	owner: Actor;
	otherMember: Actor;
	adminKey: Actor;
	serviceKey: Actor;
	telegram: Actor;
	ai: Actor;
	hostCredential: Actor;
	ownerId: string;
}

async function fixture(mode: "solo" | "team"): Promise<Fixture> {
	if (mode === "team") await setStoredMode("team");
	const admin = await seedLocalUser("az-admin", "admin");
	const owner = await seedLocalUser("az-owner");
	const other = await seedLocalUser("az-other");
	return {
		ownerId: owner.id,
		admin: { userId: admin.id, label: "user", role: "admin", mode },
		owner: { userId: owner.id, label: "user", role: "member", mode },
		otherMember: { userId: other.id, label: "user", role: "member", mode },
		adminKey: { userId: null, label: "api_key", role: "admin", mode },
		serviceKey: { userId: null, label: "api_key", role: "member", mode },
		telegram: { userId: null, label: "telegram" },
		ai: { userId: null, label: "ai" },
		hostCredential: { userId: null, label: "supervisor", role: "none", mode },
	};
}

async function seedSession(sessionId: string, ownerUserId: string | null) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "completed", ownerUserId });
}

async function seedHost(ownerUserId: string | null) {
	const id = crypto.randomUUID();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `az-host-${id.slice(0, 6)}`,
			platform: "linux",
			arch: "x64",
			version: "0",
			ownerUserId,
		});
	return id;
}

async function refused(fn: () => Promise<void> | void, error: new (...args: never[]) => Error) {
	let thrown: unknown = null;
	try {
		await fn();
	} catch (err) {
		thrown = err;
	}
	return thrown instanceof error;
}

const SESSION_ASSERTS = [
	["delete", assertCanDeleteSession],
	["archive", assertCanArchiveSession],
	["rename", assertCanRenameSession],
	["pin", assertCanPinSession],
] as const;

describe("session assertions", () => {
	for (const [name, assertFn] of SESSION_ASSERTS) {
		test(`${name}: solo is a no-op for every actor`, async () => {
			const f = await fixture("solo");
			await seedSession("az-solo", f.ownerId);
			for (const actor of [f.otherMember, f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
				expect(await refused(() => assertFn(actor, "az-solo"), NotOwnerError)).toBe(false);
			}
		});

		test(`${name}: team refuses everyone but the owner and an admin on an owned session`, async () => {
			const f = await fixture("team");
			await seedSession("az-owned", f.ownerId);
			for (const actor of [f.admin, f.owner, f.adminKey]) {
				expect(await refused(() => assertFn(actor, "az-owned"), NotOwnerError)).toBe(false);
			}
			for (const actor of [f.otherMember, f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
				expect(await refused(() => assertFn(actor, "az-owned"), NotOwnerError)).toBe(true);
			}
		});

		test(`${name}: team leaves an unowned session open to a signed-in member and an admin, not to an actor with no identity or a host credential`, async () => {
			const f = await fixture("team");
			await seedSession("az-unowned", null);
			for (const actor of [f.otherMember, f.admin, f.adminKey]) {
				expect(await refused(() => assertFn(actor, "az-unowned"), NotOwnerError)).toBe(false);
			}
			for (const actor of [f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
				expect(await refused(() => assertFn(actor, "az-unowned"), NotOwnerError)).toBe(true);
			}
		});

		test(`${name}: a session that doesn't exist passes (the caller decides what a missing row means)`, async () => {
			const f = await fixture("team");
			expect(await refused(() => assertFn(f.otherMember, "az-missing"), NotOwnerError)).toBe(false);
		});

		test(`${name}: with no mode on the actor, the stored mode decides`, async () => {
			const f = await fixture("team");
			await seedSession("az-lookup", f.ownerId);
			const noMode: Actor = { userId: f.otherMember.userId, label: "user", role: "member" };
			expect(await refused(() => assertFn(noMode, "az-lookup"), NotOwnerError)).toBe(true);
		});
	}
});

describe("key assertions", () => {
	for (const [name, assertFn] of [
		["revoke", assertCanRevokeKey],
		["view", assertCanViewKey],
	] as const) {
		test(`${name}: solo is a no-op`, async () => {
			const f = await fixture("solo");
			const { id } = await seedKey("az-key", ["manage"], f.ownerId);
			expect(await refused(() => assertFn(f.otherMember, id), NotOwnerError)).toBe(false);
		});

		test(`${name}: team lets the owner and an admin in, and nobody else`, async () => {
			const f = await fixture("team");
			const { id } = await seedKey("az-key-owned", ["manage"], f.ownerId);
			for (const actor of [f.owner, f.admin, f.adminKey]) {
				expect(await refused(() => assertFn(actor, id), NotOwnerError)).toBe(false);
			}
			for (const actor of [f.otherMember, f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
				expect(await refused(() => assertFn(actor, id), NotOwnerError)).toBe(true);
			}
		});

		test(`${name}: team makes a service key (no owner) an admin's`, async () => {
			const f = await fixture("team");
			const { id } = await seedKey("az-key-service", ["manage"]);
			expect(await refused(() => assertFn(f.admin, id), NotOwnerError)).toBe(false);
			expect(await refused(() => assertFn(f.adminKey, id), NotOwnerError)).toBe(false);
			expect(await refused(() => assertFn(f.owner, id), NotOwnerError)).toBe(true);
			expect(await refused(() => assertFn(f.serviceKey, id), NotOwnerError)).toBe(true);
		});
	}

	test("a key that doesn't exist passes", async () => {
		const f = await fixture("team");
		expect(
			await refused(() => assertCanRevokeKey(f.otherMember, "no-such-key"), NotOwnerError),
		).toBe(false);
		const rows = await getDb().select().from(apiKeys).where(eq(apiKeys.id, "no-such-key"));
		expect(rows).toEqual([]);
	});
});

describe("host assertion", () => {
	test("solo is a no-op", async () => {
		const f = await fixture("solo");
		const hostId = await seedHost(f.ownerId);
		expect(await refused(() => assertCanManageHost(f.otherMember, hostId), NotOwnerError)).toBe(
			false,
		);
	});

	test("team lets the host's owner and an admin rotate or revoke it, and nobody else", async () => {
		const f = await fixture("team");
		const hostId = await seedHost(f.ownerId);
		for (const actor of [f.owner, f.admin, f.adminKey]) {
			expect(await refused(() => assertCanManageHost(actor, hostId), NotOwnerError)).toBe(false);
		}
		for (const actor of [f.otherMember, f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
			expect(await refused(() => assertCanManageHost(actor, hostId), NotOwnerError)).toBe(true);
		}
	});

	test("team makes an unowned host an admin's", async () => {
		const f = await fixture("team");
		const hostId = await seedHost(null);
		expect(await refused(() => assertCanManageHost(f.admin, hostId), NotOwnerError)).toBe(false);
		expect(await refused(() => assertCanManageHost(f.owner, hostId), NotOwnerError)).toBe(true);
	});
});

describe("assertAdmin", () => {
	test("passes an admin (user or key) and refuses a member, a service key that isn't kept, and a host credential", async () => {
		const f = await fixture("team");
		expect(await refused(() => assertAdmin(f.admin), AdminRequiredError)).toBe(false);
		expect(await refused(() => assertAdmin(f.adminKey), AdminRequiredError)).toBe(false);
		for (const actor of [f.owner, f.serviceKey, f.telegram, f.ai, f.hostCredential]) {
			expect(await refused(() => assertAdmin(actor), AdminRequiredError)).toBe(true);
		}
	});

	test("is strict in solo as well: it guards operations that are new, where solo has nothing to preserve", async () => {
		const f = await fixture("solo");
		expect(await refused(() => assertAdmin(f.owner), AdminRequiredError)).toBe(true);
		expect(await refused(() => assertAdmin(f.admin), AdminRequiredError)).toBe(false);
	});
});

// ── The two delete executors, and archive, run for the approving human ───────

describe("AI action requests carry the approving human", () => {
	async function request(kind: "session_delete" | "session_archive", sessionId: string) {
		return createActionRequest({
			kind,
			question: "?",
			payload: { sessionId, sessionDisplayName: sessionId },
			origin: "web",
		});
	}

	async function approve(id: string, actor: Actor) {
		return resolveActionRequest({ id, decision: "applied", resolvedBy: "tester", actor });
	}

	async function sessionExists(sessionId: string) {
		const rows = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		return rows.length > 0;
	}

	test("team: a member approver can't delete another user's session; the request stays open and the session stays", async () => {
		const f = await fixture("team");
		await seedSession("az-ai-del", f.ownerId);
		const req = await request("session_delete", "az-ai-del");
		const result = await approve(req.id, f.otherMember);
		expect(result).toEqual({ ok: false, reason: "not_owner" });
		// Checked before the request is claimed: it stays open for the owner or an admin.
		expect((await getActionRequest(req.id))?.status).toBe("awaiting_reply");
		expect(await sessionExists("az-ai-del")).toBe(true);

		expect((await approve(req.id, f.owner)).ok).toBe(true);
		expect(await sessionExists("az-ai-del")).toBe(false);
	});

	test("team: the owner, an admin and an admin key can", async () => {
		const f = await fixture("team");
		for (const [label, actor] of [
			["owner", f.owner],
			["admin", f.admin],
			["adminKey", f.adminKey],
		] as const) {
			const id = `az-ai-del-${label}`;
			await seedSession(id, f.ownerId);
			const req = await request("session_delete", id);
			expect((await approve(req.id, actor)).ok).toBe(true);
			expect(await sessionExists(id)).toBe(false);
		}
	});

	test("team: a Telegram approver's session delete is refused; solo allows it", async () => {
		const team = await fixture("team");
		await seedSession("az-tg-team", team.ownerId);
		const req = await request("session_delete", "az-tg-team");
		expect(await approve(req.id, team.telegram)).toEqual({ ok: false, reason: "not_owner" });
		expect((await getActionRequest(req.id))?.status).toBe("awaiting_reply");
		expect(await sessionExists("az-tg-team")).toBe(true);

		await setStoredMode("solo");
		const again = await request("session_delete", "az-tg-team");
		expect((await approve(again.id, team.telegram)).ok).toBe(true);
		expect(await sessionExists("az-tg-team")).toBe(false);
	});

	test("team: autonomous AI execution (the AI's own actor, no approver) is refused on an owned session, for delete and archive", async () => {
		const f = await fixture("team");
		await seedSession("az-auto", f.ownerId);
		const { AI_EXECUTOR_ACTOR } = await import("./ai/action-requests-service.js");
		for (const kind of ["session_delete", "session_archive"] as const) {
			const req = await request(kind, "az-auto");
			expect((await approve(req.id, AI_EXECUTOR_ACTOR)).ok).toBe(false);
			expect((await getActionRequest(req.id))?.status).toBe("awaiting_reply");
		}
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "az-auto"));
		expect(row?.isArchived).toBe(false);
	});

	test("team: archive follows the same rule", async () => {
		const f = await fixture("team");
		await seedSession("az-ai-arch", f.ownerId);
		const refusedReq = await request("session_archive", "az-ai-arch");
		expect((await approve(refusedReq.id, f.otherMember)).ok).toBe(false);
		expect((await getActionRequest(refusedReq.id))?.status).toBe("awaiting_reply");
		const okReq = await request("session_archive", "az-ai-arch");
		expect((await approve(okReq.id, f.owner)).ok).toBe(true);
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "az-ai-arch"));
		expect(row?.isArchived).toBe(true);
	});

	test("team: an unowned session is open to a member approver", async () => {
		const f = await fixture("team");
		await seedSession("az-ai-unowned", null);
		const req = await request("session_delete", "az-ai-unowned");
		expect((await approve(req.id, f.otherMember)).ok).toBe(true);
	});

	test("team: an unowned session is refused to an approver with no identity (a chat, the AI's own actor)", async () => {
		const f = await fixture("team");
		await seedSession("az-ai-unowned-none", null);
		const { AI_EXECUTOR_ACTOR } = await import("./ai/action-requests-service.js");
		for (const actor of [f.telegram, AI_EXECUTOR_ACTOR]) {
			const req = await request("session_delete", "az-ai-unowned-none");
			expect(await approve(req.id, actor)).toEqual({ ok: false, reason: "not_owner" });
			expect((await getActionRequest(req.id))?.status).toBe("awaiting_reply");
		}
		expect(await sessionExists("az-ai-unowned-none")).toBe(true);
	});

	test("solo: nothing is refused", async () => {
		const f = await fixture("solo");
		await seedSession("az-ai-solo", f.ownerId);
		const req = await request("session_delete", "az-ai-solo");
		expect((await approve(req.id, f.otherMember)).ok).toBe(true);
	});

	test("bulk: an approver who can't change every session is refused before the request is claimed; one who can, runs it", async () => {
		const f = await fixture("team");
		await seedSession("az-bulk-mine", f.ownerId);
		await seedSession("az-bulk-theirs", f.otherMember.userId);
		const req = await createActionRequest({
			kind: "bulk_session_action",
			question: "?",
			payload: {
				action: "delete",
				sessionIds: ["az-bulk-mine", "az-bulk-theirs"],
				sessionNames: ["mine", "theirs"],
				exclusions: [],
			},
			origin: "web",
		});

		expect(await approve(req.id, f.owner)).toEqual({ ok: false, reason: "not_owner" });
		expect((await getActionRequest(req.id))?.status).toBe("awaiting_reply");
		expect(await sessionExists("az-bulk-mine")).toBe(true);
		expect(await sessionExists("az-bulk-theirs")).toBe(true);

		expect((await approve(req.id, f.admin)).ok).toBe(true);
		expect(await sessionExists("az-bulk-mine")).toBe(false);
		expect(await sessionExists("az-bulk-theirs")).toBe(false);
	});
});
