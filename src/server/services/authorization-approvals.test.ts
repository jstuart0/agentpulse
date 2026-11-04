/**
 * Who may answer a Codex approval (AGEN-87, 3.2). Strict, unlike the alias the
 * other session rules share: a session the server can't find gives a non-admin
 * nothing, and an unowned session is not open to everyone for an accept.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { initializeDatabase } = await import("../db/client.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { NotOwnerError, assertCanAnswerApproval, mayAnswerApproval } = await import(
	"./authorization.js"
);
const {
	ApprovalRefusal,
	answerApproval,
	getApprovalDetail,
	listApprovalsForSession,
	recordApprovalRequest,
} = await import("./codex-approvals.js");

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

async function session(ownerUserId: string | null) {
	const sessionId = `auth-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `auth-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, ownerUserId });
	return { sessionId, supervisorId };
}

const member = (userId: string | null) => harness.teamCaller(userId, "member").actor;
const admin = harness.teamCaller("admin-1", "admin").actor;

async function allowed(
	actor: ReturnType<typeof member>,
	sessionId: string,
	decision: "accept" | "decline" | "cancel",
) {
	try {
		await assertCanAnswerApproval(actor, sessionId, decision);
		return true;
	} catch (error) {
		if (error instanceof NotOwnerError) return false;
		throw error;
	}
}

describe("mayAnswerApproval (the pure rule)", () => {
	const solo = {
		userId: null,
		label: "api_key" as const,
		role: "none" as const,
		mode: "solo" as const,
	};

	test("solo: allowed for anyone, including a missing session and an unowned accept", () => {
		expect(mayAnswerApproval(solo, "solo", null, "accept")).toBe(true);
		expect(mayAnswerApproval(solo, "solo", { ownerUserId: null }, "accept")).toBe(true);
		expect(mayAnswerApproval(solo, "solo", { ownerUserId: "u1" }, "accept")).toBe(true);
	});

	test("team: a host credential (role none) is never allowed, not even on an unowned decline", () => {
		const host = {
			userId: null,
			label: "supervisor" as const,
			role: "none" as const,
			mode: "team" as const,
		};
		for (const decision of ["accept", "decline", "cancel"] as const) {
			expect(mayAnswerApproval(host, "team", { ownerUserId: null }, decision)).toBe(false);
			expect(mayAnswerApproval(host, "team", { ownerUserId: "u1" }, decision)).toBe(false);
		}
	});

	test("team: role none is refused even when the credential somehow carries a user id", () => {
		const odd = {
			userId: "u1",
			label: "supervisor" as const,
			role: "none" as const,
			mode: "team" as const,
		};
		for (const decision of ["accept", "decline", "cancel"] as const) {
			expect(mayAnswerApproval(odd, "team", { ownerUserId: "u1" }, decision)).toBe(false);
			expect(mayAnswerApproval(odd, "team", { ownerUserId: null }, decision)).toBe(false);
		}
	});

	test("team: a missing session gives a non-admin nothing and an admin the right to be told it's missing", () => {
		expect(mayAnswerApproval(member("u1"), "team", null, "decline")).toBe(false);
		expect(mayAnswerApproval(member("u1"), "team", null, "accept")).toBe(false);
		expect(mayAnswerApproval(admin, "team", null, "accept")).toBe(true);
	});

	test("team, owned: the owner and an admin; nobody else", () => {
		const owned = { ownerUserId: "owner-1" };
		for (const decision of ["accept", "decline", "cancel"] as const) {
			expect(mayAnswerApproval(member("owner-1"), "team", owned, decision)).toBe(true);
			expect(mayAnswerApproval(admin, "team", owned, decision)).toBe(true);
			expect(mayAnswerApproval(member("someone-else"), "team", owned, decision)).toBe(false);
			expect(mayAnswerApproval(member(null), "team", owned, decision)).toBe(false);
		}
	});

	test("team, unowned: accept is an admin's alone; a decline or cancel is open to an identified member", () => {
		const unowned = { ownerUserId: null };
		expect(mayAnswerApproval(member("u1"), "team", unowned, "accept")).toBe(false);
		expect(mayAnswerApproval(admin, "team", unowned, "accept")).toBe(true);
		expect(mayAnswerApproval(member("u1"), "team", unowned, "decline")).toBe(true);
		expect(mayAnswerApproval(member("u1"), "team", unowned, "cancel")).toBe(true);
		// A member with no identity (a chat, autonomous AI) is refused even a decline.
		expect(mayAnswerApproval(member(null), "team", unowned, "decline")).toBe(false);
	});

	test("an actor with no role at all (a chat or autonomous AI) is a member with no identity", () => {
		const bare = { userId: null, label: "telegram" as const, mode: "team" as const };
		expect(mayAnswerApproval(bare, "team", { ownerUserId: null }, "decline")).toBe(false);
		expect(mayAnswerApproval(bare, "team", { ownerUserId: "u1" }, "decline")).toBe(false);
	});
});

describe("assertCanAnswerApproval (reads the session)", () => {
	test("owned, unowned and missing sessions, through the database", async () => {
		const owned = await session("owner-1");
		const unowned = await session(null);
		expect(await allowed(member("owner-1"), owned.sessionId, "accept")).toBe(true);
		expect(await allowed(member("u2"), owned.sessionId, "decline")).toBe(false);
		expect(await allowed(admin, owned.sessionId, "accept")).toBe(true);
		expect(await allowed(member("u2"), unowned.sessionId, "accept")).toBe(false);
		expect(await allowed(member("u2"), unowned.sessionId, "decline")).toBe(true);
		expect(await allowed(admin, unowned.sessionId, "accept")).toBe(true);
		expect(await allowed(member("u2"), "no-such-session", "decline")).toBe(false);
		expect(await allowed(admin, "no-such-session", "decline")).toBe(true);
	});

	test("solo allows without reading anything", async () => {
		const solo = {
			userId: null,
			label: "api_key" as const,
			role: "none" as const,
			mode: "solo" as const,
		};
		expect(await allowed(solo, "no-such-session", "accept")).toBe(true);
	});
});

describe("the owner check comes before the approval row is read", () => {
	test("a non-owner gets not_owner for a real row, a missing id and a missing session alike", async () => {
		const owned = await session("owner-1");
		const recorded = await recordApprovalRequest(
			owned.supervisorId,
			owned.sessionId,
			harness.commandReport(),
		);
		const stranger = harness.teamCaller("stranger", "member");
		const codeOf = async (sessionId: string, approvalId: string) => {
			try {
				await answerApproval(sessionId, approvalId, { decision: "decline" }, stranger);
			} catch (error) {
				if (error instanceof ApprovalRefusal) return error.code;
				throw error;
			}
			return "ok";
		};
		expect(await codeOf(owned.sessionId, recorded.response.approvalId)).toBe("not_owner");
		expect(await codeOf(owned.sessionId, "missing-approval")).toBe("not_owner");
		expect(await codeOf("missing-session", "missing-approval")).toBe("not_owner");
		// An admin learns the truth.
		const adminCaller = harness.teamCaller("admin-1", "admin");
		await expect(
			answerApproval("missing-session", "missing-approval", { decision: "decline" }, adminCaller),
		).rejects.toMatchObject({ code: "approval_not_found" });
	});

	test("reads are refused not_owner too, and viewer.canAccept is false for a key", async () => {
		const owned = await session("owner-1");
		await recordApprovalRequest(owned.supervisorId, owned.sessionId, harness.commandReport());
		const stranger = harness.teamCaller("stranger", "member");
		await expect(listApprovalsForSession(owned.sessionId, stranger)).rejects.toMatchObject({
			code: "not_owner",
		});
		await expect(getApprovalDetail(owned.sessionId, "x", stranger)).rejects.toMatchObject({
			code: "not_owner",
		});
		const ownerPerson = harness.teamCaller("owner-1", "member");
		expect((await listApprovalsForSession(owned.sessionId, ownerPerson)).viewer.canAccept).toBe(
			true,
		);
		const ownersKey = harness.teamCaller("owner-1", "member", {
			human: false,
			label: "api_key",
			keyId: "k",
		});
		expect((await listApprovalsForSession(owned.sessionId, ownersKey)).viewer.canAccept).toBe(
			false,
		);
		const unownedSession = await session(null);
		const plainMember = harness.teamCaller("m1", "member");
		expect(
			(await listApprovalsForSession(unownedSession.sessionId, plainMember)).viewer.canAccept,
		).toBe(false);
		expect(
			(await listApprovalsForSession(unownedSession.sessionId, harness.teamCaller("a", "admin")))
				.viewer.canAccept,
		).toBe(true);
	});

	test("an accept by an owner's API key is human_required, by the owner as a person it goes through", async () => {
		const owned = await session("owner-1");
		const recorded = await recordApprovalRequest(
			owned.supervisorId,
			owned.sessionId,
			harness.commandReport(),
		);
		const id = recorded.response.approvalId;
		const hash = (
			await getApprovalDetail(owned.sessionId, id, harness.teamCaller("owner-1", "member"))
		).approval.presentationHash;
		const key = harness.teamCaller("owner-1", "member", {
			human: false,
			label: "api_key",
			keyId: "k1",
		});
		await expect(
			answerApproval(owned.sessionId, id, { decision: "accept", presentationHash: hash }, key),
		).rejects.toMatchObject({ code: "human_required" });
		const person = harness.teamCaller("owner-1", "member");
		const done = await answerApproval(
			owned.sessionId,
			id,
			{ decision: "accept", presentationHash: hash },
			person,
		);
		expect(done.approval.decision).toBe("accept");
	});
});
