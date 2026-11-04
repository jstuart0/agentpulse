/**
 * Codex approvals, phase 4: the person routes (AGEN-87, plan 4.1 to 4.3).
 *
 * Every step of the POST's check order has a test, and each step is shown to hide
 * the facts of the steps after it. Real SQLite by default and real Postgres under
 * AGENTPULSE_TEST_BACKEND=postgres.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import type { CodexApprovalDetail, CodexApprovalList } from "../../shared/codex-approvals.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { codexApprovals, supervisors } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { recordApprovalRequest, closeApprovalsForSession } = await import(
	"../services/codex-approvals.js"
);
const { sessionBus } = await import("../services/notifier.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { resolveSsoUser } = await import("../services/user-identity.js");
const { issueSession, SESSION_COOKIE_NAME } = await import("../services/local-auth-service.js");

const ORIGIN = "http://localhost:3000";
const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

let counter = 0;
async function seedSession(ownerUserId: string | null) {
	counter++;
	const sessionId = `p4-session-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = `p4-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	hostsUsed.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, ownerUserId });
	return { sessionId, supervisorId };
}

async function openApproval(
	ctx: { sessionId: string; supervisorId: string },
	overrides: Parameters<typeof harness.commandReport>[0] = {},
) {
	const { response } = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport({
			itemId: crypto.randomUUID(),
			rpcId: crypto.randomUUID(),
			...overrides,
		}),
	);
	const [row] = await getDb()
		.select()
		.from(codexApprovals)
		.where(eq(codexApprovals.id, response.approvalId));
	if (!row) throw new Error("approval row missing");
	return { id: response.approvalId, hash: row.presentationHash, row };
}

async function rowOf(id: string) {
	const [row] = await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id));
	return row;
}

function withHeaders(base: Headers, extra: Record<string, string> = {}): Headers {
	const merged = new Headers(base);
	for (const [key, value] of Object.entries(extra)) merged.set(key, value);
	return merged;
}

const base = (sessionId: string) => `/api/v1/sessions/${sessionId}/approvals`;

function decide(
	sessionId: string,
	approvalId: string,
	headers: Headers,
	body: unknown,
	options: { contentType?: string | null; raw?: string } = {},
) {
	const merged = new Headers(headers);
	const contentType = options.contentType === undefined ? "application/json" : options.contentType;
	if (contentType !== null) merged.set("Content-Type", contentType);
	return app.request(`${base(sessionId)}/${approvalId}/decision`, {
		method: "POST",
		headers: merged,
		body: options.raw ?? JSON.stringify(body),
	});
}

const accept = (hash?: string) => ({ decision: "accept", presentationHash: hash });
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

/** A person's browser request: their cookie and the page's own Origin. */
async function browser(userId: string) {
	return withHeaders(await cookieHeadersFor(userId), { Origin: ORIGIN });
}

async function ssoBrowser(userId: string, subject: string) {
	const { token } = await issueSession({
		userId,
		authSource: "forwardauth",
		ssoSubject: subject,
		ssoUsername: subject,
		provider: "authentik",
	});
	return new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}`, Origin: ORIGIN });
}

/** Alice is an SSO identity, so her cookie and her forwardauth session are the same person (as in the HITL matrix). */
async function team() {
	await setStoredMode("team");
	const alice = await resolveSsoUser({
		provider: "authentik",
		subject: "p4-sso-alice",
		source: "uid",
		username: "p4-alice",
	});
	const bob = await seedLocalUser("p4-bob");
	const admin = await seedLocalUser("p4-admin", "admin");
	return { alice, bob, admin };
}

// ── step 1: the Origin ──────────────────────────────────────────────────────

describe("step 1: the Origin", () => {
	test("a foreign Origin is 403 bad_origin for a cookie caller and for a key", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const evil = { Origin: "https://evil.example" };
		const key = await seedKey("p4-manage", ["manage"], t.alice.id);

		for (const headers of [
			withHeaders(await cookieHeadersFor(t.alice.id), evil),
			withHeaders(bearerHeaders(key.key), evil),
		]) {
			const res = await decide(ctx.sessionId, a.id, headers, { decision: "decline" });
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("bad_origin");
		}
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("a cookie caller with no Origin and no Sec-Fetch-Site is refused", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await cookieHeadersFor(t.alice.id);

		const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash));

		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("bad_origin");
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("an SSO (forwardauth) session with no Origin and no Sec-Fetch-Site is refused too", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await ssoBrowser(t.alice.id, "p4-sso-alice");
		headers.delete("Origin");

		const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash));

		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("bad_origin");
	});

	test("Sec-Fetch-Site: same-origin stands in for an Origin; cross-site does not", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const cookie = await cookieHeadersFor(t.alice.id);

		const crossSite = await decide(
			ctx.sessionId,
			a.id,
			withHeaders(cookie, { "Sec-Fetch-Site": "cross-site" }),
			accept(a.hash),
		);
		expect(crossSite.status).toBe(403);
		expect(await errorOf(crossSite)).toBe("bad_origin");

		const sameOrigin = await decide(
			ctx.sessionId,
			a.id,
			withHeaders(cookie, { "Sec-Fetch-Site": "same-origin" }),
			accept(a.hash),
		);
		expect(sameOrigin.status).toBe(200);
	});

	test("an allowed Origin is enough for a cookie caller", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));
		expect(res.status).toBe(200);
	});

	test("an API key with no Origin is judged by authentication: a manage key may decline", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const key = await seedKey("p4-manage", ["manage"], t.alice.id);

		const res = await decide(ctx.sessionId, a.id, bearerHeaders(key.key), { decision: "decline" });

		expect(res.status).toBe(200);
		expect((await rowOf(a.id))?.decision).toBe("decline");
	});

	test("the Origin is judged before the body, the owner and the row", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const evilBob = withHeaders(await cookieHeadersFor(t.bob.id), {
			Origin: "https://evil.example",
		});
		const res = await decide(ctx.sessionId, "no-such-row", evilBob, null, { raw: "{not json" });
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("bad_origin");
	});
});

// ── step 2: content type, size, decision ────────────────────────────────────

describe("step 2: the body", () => {
	test("a wrong or missing content type is 400 invalid_decision", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
			const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash), { contentType });
			expect({ contentType, status: res.status, error: await errorOf(res) }).toEqual({
				contentType,
				status: 400,
				error: "invalid_decision",
			});
		}
		const ok = await decide(
			ctx.sessionId,
			a.id,
			headers,
			{ decision: "decline" },
			{
				contentType: "application/json; charset=utf-8",
			},
		);
		expect(ok.status).toBe(200);
	});

	test("malformed JSON, a non-object and an over-16-KiB body are 400 invalid_decision", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		const bodies: Array<{ label: string; raw: string }> = [
			{ label: "malformed", raw: "{decision:" },
			{ label: "array", raw: "[]" },
			{ label: "null", raw: "null" },
			{ label: "string", raw: '"accept"' },
			{
				label: "oversize",
				raw: JSON.stringify({ decision: "decline", pad: "x".repeat(16 * 1024) }),
			},
		];
		for (const { label, raw } of bodies) {
			const res = await decide(ctx.sessionId, a.id, headers, null, { raw });
			expect({ label, status: res.status, error: await errorOf(res) }).toEqual({
				label,
				status: 400,
				error: "invalid_decision",
			});
		}
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("a decision outside the fixed set is invalid_decision, acceptForSession included", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		for (const decision of [
			"acceptForSession",
			"approve",
			"ACCEPT",
			"",
			1,
			null,
			undefined,
			["accept"],
		]) {
			const res = await decide(ctx.sessionId, a.id, headers, {
				decision,
				presentationHash: a.hash,
			});
			expect({ decision, status: res.status, error: await errorOf(res) }).toEqual({
				decision,
				status: 400,
				error: "invalid_decision",
			});
		}
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("step 2 hides step 3: a non-owner with a bad decision learns invalid_decision, not not_owner", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const res = await decide(ctx.sessionId, a.id, await browser(t.bob.id), {
			decision: "acceptForSession",
		});
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("invalid_decision");
	});
});

// ── step 3: the owner and the person ────────────────────────────────────────

describe("step 3: the owner rule, before the row is read", () => {
	test("a team non-owner gets the same 403 not_owner for a real row, a missing row and a missing session", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.bob.id);

		const real = await decide(ctx.sessionId, a.id, headers, accept(a.hash));
		const missingRow = await decide(ctx.sessionId, "no-such-approval", headers, accept(a.hash));
		const missingSession = await decide("no-such-session", a.id, headers, accept(a.hash));

		const answers = [];
		for (const res of [real, missingRow, missingSession]) {
			answers.push({ status: res.status, body: await res.text() });
		}
		expect(answers[0]).toEqual({ status: 403, body: JSON.stringify({ error: "not_owner" }) });
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("a non-owner's decline is refused the same way", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const res = await decide(ctx.sessionId, a.id, await browser(t.bob.id), { decision: "decline" });
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("not_owner");
	});

	test("an unowned session: a member may decline, only an admin may accept", async () => {
		const t = await team();
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);

		const acceptRes = await decide(ctx.sessionId, a.id, await browser(t.bob.id), accept(a.hash));
		expect(acceptRes.status).toBe(403);
		expect(await errorOf(acceptRes)).toBe("not_owner");

		const declineRes = await decide(ctx.sessionId, a.id, await browser(t.bob.id), {
			decision: "decline",
		});
		expect(declineRes.status).toBe(200);
	});

	test("an admin may answer anyone's approval", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const res = await decide(ctx.sessionId, a.id, await browser(t.admin.id), accept(a.hash));
		expect(res.status).toBe(200);
	});

	test("accept by any API key, even an admin's manage key, is 403 human_required", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const keys = [
			await seedKey("p4-owner-key", ["manage"], t.alice.id),
			await seedKey("p4-admin-key", ["manage"], t.admin.id),
		];
		const kept = await seedKey("p4-kept", ["manage"], null);
		await setAdminServiceKeyList([kept.id]);
		keys.push(kept);

		for (const key of keys) {
			const res = await decide(ctx.sessionId, a.id, bearerHeaders(key.key), accept(a.hash));
			expect({ status: res.status, error: await errorOf(res) }).toEqual({
				status: 403,
				error: "human_required",
			});
		}
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("the owner rule comes before human_required: a stranger's key learns not_owner", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const bobKey = await seedKey("p4-bob-key", ["manage"], t.bob.id);
		const res = await decide(ctx.sessionId, a.id, bearerHeaders(bobKey.key), accept(a.hash));
		expect(await errorOf(res)).toBe("not_owner");
	});

	test("human_required comes before the row: an owner's key accepting a missing row learns nothing about it", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const key = await seedKey("p4-owner-key", ["manage"], t.alice.id);
		const res = await decide(
			ctx.sessionId,
			"no-such-approval",
			bearerHeaders(key.key),
			accept("h"),
		);
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("human_required");
	});

	test("a manage key may decline and cancel", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const b = await openApproval(ctx);
		const key = await seedKey("p4-owner-key", ["manage"], t.alice.id);

		const declined = await decide(ctx.sessionId, a.id, bearerHeaders(key.key), {
			decision: "decline",
		});
		expect(declined.status).toBe(200);
		expect((await rowOf(a.id))?.decision).toBe("decline");

		const canCancel = (await rowOf(b.id))?.canCancel === true;
		const cancelled = await decide(ctx.sessionId, b.id, bearerHeaders(key.key), {
			decision: "cancel",
		});
		expect(cancelled.status).toBe(canCancel ? 200 : 400);
		expect(await errorOf(cancelled)).toBe(canCancel ? undefined : "invalid_decision");
	});

	test("a disabled user is refused before anything is read", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);
		await disableUserDirectly(t.alice.id);

		const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash));

		expect(res.status).toBe(401);
		expect((await rowOf(a.id))?.status).toBe("pending");
	});
});

// ── steps 4 to 7: the row, its state, the hash, the host ────────────────────

describe("step 4: the row", () => {
	test("an unknown id, and an id from another session, are 404 approval_not_found", async () => {
		const t = await team();
		const mine = await seedSession(t.alice.id);
		const other = await seedSession(t.alice.id);
		const theirs = await openApproval(other);
		const headers = await browser(t.alice.id);

		for (const id of ["no-such-approval", theirs.id]) {
			const res = await decide(mine.sessionId, id, headers, accept(theirs.hash));
			expect({ status: res.status, error: await errorOf(res) }).toEqual({
				status: 404,
				error: "approval_not_found",
			});
		}
		expect((await rowOf(theirs.id))?.status).toBe("pending");
	});
});

describe("step 5: the effective state", () => {
	test("an answered row is 409 already_resolved, for the second caller too", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		expect((await decide(ctx.sessionId, a.id, headers, accept(a.hash))).status).toBe(200);
		const again = await decide(ctx.sessionId, a.id, headers, accept(a.hash));
		expect({ status: again.status, error: await errorOf(again) }).toEqual({
			status: 409,
			error: "already_resolved",
		});
		const decline = await decide(ctx.sessionId, a.id, headers, { decision: "decline" });
		expect(await errorOf(decline)).toBe("already_resolved");
	});

	test("an expired row is 409 expired", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		await getDb()
			.update(codexApprovals)
			.set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(codexApprovals.id, a.id));

		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));

		expect({ status: res.status, error: await errorOf(res) }).toEqual({
			status: 409,
			error: "expired",
		});
	});

	test("a row closed by a stopped session is 409 session_stopped", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		await closeApprovalsForSession(ctx.sessionId);

		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));

		expect({ status: res.status, error: await errorOf(res) }).toEqual({
			status: 409,
			error: "session_stopped",
		});
	});

	test("a Stop that is queued but has not closed the row yet still blocks the answer", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		await harness.seedActiveStop(ctx.sessionId);

		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));

		expect({ status: res.status, error: await errorOf(res) }).toEqual({
			status: 409,
			error: "session_stopped",
		});
		expect((await rowOf(a.id))?.status).toBe("pending");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
	});

	test("step 5 hides step 6: a closed row with no hash sent is its state, not presentation_hash_required", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		await closeApprovalsForSession(ctx.sessionId);
		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept());
		expect(await errorOf(res)).toBe("session_stopped");
	});
});

describe("step 6: the hash and approvability (accept only)", () => {
	test("accept with no hash is 400 presentation_hash_required; a wrong hash is 409 presentation_changed", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		for (const hash of [undefined, "", 7]) {
			const res = await decide(ctx.sessionId, a.id, headers, {
				decision: "accept",
				presentationHash: hash,
			});
			expect({ status: res.status, error: await errorOf(res) }).toEqual({
				status: 400,
				error: "presentation_hash_required",
			});
		}
		const wrong = await decide(ctx.sessionId, a.id, headers, accept("0".repeat(64)));
		expect({ status: wrong.status, error: await errorOf(wrong) }).toEqual({
			status: 409,
			error: "presentation_changed",
		});
		expect((await rowOf(a.id))?.status).toBe("pending");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
	});

	test("a row that can't be approved is 409 not_approvable, but a decline still works", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const a = await openApproval(ctx, { command: `echo ${secret}` });
		expect(a.row.approvable).toBe(false);
		const headers = await browser(t.alice.id);

		const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash));
		expect({ status: res.status, error: await errorOf(res) }).toEqual({
			status: 409,
			error: "not_approvable",
		});
		const noHash = await decide(ctx.sessionId, a.id, headers, accept());
		expect(await errorOf(noHash)).toBe("presentation_hash_required");

		const declined = await decide(ctx.sessionId, a.id, headers, { decision: "decline" });
		expect(declined.status).toBe(200);
	});

	test("a decline needs no hash and ignores one", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), {
			decision: "decline",
			presentationHash: "whatever",
		});
		expect(res.status).toBe(200);
	});
});

describe("step 7: the host", () => {
	test("an offline host is 409 host_offline and a gone one 409 host_gone; the row stays pending", async () => {
		const t = await team();
		const offline = await seedSession(t.alice.id);
		const gone = await seedSession(t.alice.id);
		const a = await openApproval(offline);
		const b = await openApproval(gone);
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() })
			.where(eq(supervisors.id, offline.supervisorId));
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, gone.supervisorId));
		const headers = await browser(t.alice.id);

		const off = await decide(offline.sessionId, a.id, headers, accept(a.hash));
		const gn = await decide(gone.sessionId, b.id, headers, accept(b.hash));
		expect({ status: off.status, error: await errorOf(off) }).toEqual({
			status: 409,
			error: "host_offline",
		});
		expect({ status: gn.status, error: await errorOf(gn) }).toEqual({
			status: 409,
			error: "host_gone",
		});
		expect((await rowOf(a.id))?.status).toBe("pending");
		expect((await rowOf(b.id))?.status).toBe("pending");
	});

	test("step 6 hides step 7: an offline host with no hash sent is presentation_hash_required, not host_offline", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() })
			.where(eq(supervisors.id, ctx.supervisorId));
		const noHash = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept());
		expect(await errorOf(noHash)).toBe("presentation_hash_required");
	});
});

// ── step 8: the guarded write ───────────────────────────────────────────────

describe("step 8: the guarded update", () => {
	test("two concurrent accepts: one wins, the other is already_resolved", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);

		const results = await Promise.all([
			decide(ctx.sessionId, a.id, headers, accept(a.hash)),
			decide(ctx.sessionId, a.id, headers, accept(a.hash)),
		]);

		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 409]);
		const loser = results.find((r) => r.status === 409);
		expect(await errorOf(loser as Response)).toBe("already_resolved");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(1);
	});

	test("an accept changes no other row", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const b = await openApproval(ctx);
		const otherSession = await seedSession(t.alice.id);
		const c = await openApproval(otherSession);
		const beforeB = JSON.stringify(await rowOf(b.id));
		const beforeC = JSON.stringify(await rowOf(c.id));

		const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));

		expect(res.status).toBe(200);
		expect(JSON.stringify(await rowOf(b.id))).toBe(beforeB);
		expect(JSON.stringify(await rowOf(c.id))).toBe(beforeC);
		expect((await rowOf(a.id))?.status).toBe("answered");
	});

	test("the audit row names the real actor: a person by user id, a key by key id", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const b = await openApproval(ctx);
		const key = await seedKey("p4-audit-key", ["manage"], t.alice.id);

		expect(
			(await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash))).status,
		).toBe(200);
		expect(
			(await decide(ctx.sessionId, b.id, bearerHeaders(key.key), { decision: "decline" })).status,
		).toBe(200);

		const audit = await harness.auditRows(ctx.sessionId);
		const byApproval = new Map(audit.map((row) => [row.approvalId, row]));
		expect(byApproval.get(a.id)).toMatchObject({
			actorUserId: t.alice.id,
			actorKeyId: null,
			actorLabel: "user",
			decision: "accept",
			outcome: "pending",
			presentationHash: a.hash,
		});
		expect(byApproval.get(b.id)).toMatchObject({
			actorUserId: t.alice.id,
			actorKeyId: key.id,
			actorLabel: "api_key",
			decision: "decline",
		});
	});

	test("after commit: one session_updated, one audit log line, and no agent text in either", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const command = "p4-unique-command --token-flag zzz";
		const reason = "p4-unique-reason because";
		const a = await openApproval(ctx, { command, reason, cwd: "/work/p4-unique-cwd" });
		const updates: unknown[] = [];
		const onUpdate = (session: unknown) => updates.push(session);
		sessionBus.on("session_updated", onUpdate);
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		const err = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			const refused = await decide(ctx.sessionId, a.id, await browser(t.bob.id), accept(a.hash));
			expect(refused.status).toBe(403);
			expect(updates).toHaveLength(0);
			expect(lines.filter((l) => l.includes("codex_approval_answered"))).toHaveLength(0);

			const res = await decide(ctx.sessionId, a.id, await browser(t.alice.id), accept(a.hash));
			expect(res.status).toBe(200);
		} finally {
			sessionBus.off("session_updated", onUpdate);
			log.mockRestore();
			err.mockRestore();
		}

		expect(updates).toHaveLength(1);
		const audit = lines.filter((l) => l.includes("codex_approval_answered"));
		expect(audit).toHaveLength(1);
		const parsed = JSON.parse(audit[0] as string) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			kind: "codex_approval_answered",
			by: t.alice.id,
			decision: "accept",
		});
		for (const secret of [command, reason, "p4-unique-cwd", "p4-unique-command"]) {
			expect(lines.join("\n")).not.toContain(secret);
		}
	});
});

// ── scope: who reaches the routes at all ────────────────────────────────────

describe("scope classification and the host credential", () => {
	const DECISIONS = ["accept", "decline", "cancel"] as const;

	async function reachableRoutes(sessionId: string, approvalId: string) {
		return [
			{ method: "GET", path: base(sessionId) },
			{ method: "GET", path: `${base(sessionId)}/${approvalId}` },
			{ method: "POST", path: `${base(sessionId)}/${approvalId}/decision` },
		];
	}

	function hit(
		route: { method: string; path: string },
		headers: Headers,
		a?: { hash: string },
		decision: "accept" | "decline" | "cancel" = "accept",
	) {
		const merged = new Headers(headers);
		if (route.method === "POST") merged.set("Content-Type", "application/json");
		return app.request(route.path, {
			method: route.method,
			headers: merged,
			body:
				route.method === "POST"
					? JSON.stringify(decision === "accept" ? accept(a?.hash) : { decision })
					: undefined,
		});
	}

	for (const mode of ["solo", "team"] as const) {
		test(`${mode}: observe, ingest and respond keys are 403 insufficient_scope on all three routes, and nothing changes`, async () => {
			const t = await team();
			if (mode === "solo") await clearInstanceSettings();
			const ctx = await seedSession(mode === "team" ? t.alice.id : null);
			const a = await openApproval(ctx);
			const before = JSON.stringify(await rowOf(a.id));
			const keys = {
				observe: await seedKey("p4-observe", ["observe"], null),
				ingest: await seedKey("p4-ingest", ["ingest"], null),
				respond: await seedKey("p4-respond", ["respond"], null),
				ownedRespond: await seedKey("p4-respond-owned", ["respond"], t.alice.id),
				adminRespond: await seedKey("p4-respond-admin", ["respond"], t.admin.id),
			};
			for (const [name, key] of Object.entries(keys)) {
				for (const route of await reachableRoutes(ctx.sessionId, a.id)) {
					for (const decision of DECISIONS) {
						const res = await hit(route, bearerHeaders(key.key), a, decision);
						expect({
							mode,
							name,
							route: `${route.method} ${route.path}`,
							status: res.status,
						}).toEqual({
							mode,
							name,
							route: `${route.method} ${route.path}`,
							status: 403,
						});
						expect(await res.json()).toEqual({ error: "insufficient_scope", required: "manage" });
					}
				}
			}
			expect(JSON.stringify(await rowOf(a.id))).toBe(before);
			expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
		});

		test(`${mode}: a host credential, even the owning host's own, can't reach any route (401)`, async () => {
			const t = await team();
			if (mode === "solo") await clearInstanceSettings();
			const ctx = await seedSession(mode === "team" ? t.alice.id : null);
			const a = await openApproval(ctx);
			const before = JSON.stringify(await rowOf(a.id));
			const credential = await createSupervisorCredential(ctx.supervisorId, "p4-credential");
			const forms = [
				bearerHeaders(credential.token),
				new Headers({ "X-AgentPulse-Supervisor-Token": credential.token }),
			];
			for (const headers of forms) {
				for (const route of await reachableRoutes(ctx.sessionId, a.id)) {
					for (const decision of DECISIONS) {
						const res = await hit(route, withHeaders(headers, { Origin: ORIGIN }), a, decision);
						expect({ mode, route: `${route.method} ${route.path}`, status: res.status }).toEqual({
							mode,
							route: `${route.method} ${route.path}`,
							status: 401,
						});
					}
				}
			}
			expect(JSON.stringify(await rowOf(a.id))).toBe(before);
			expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
		});

		test(`${mode}: no credential at all is 401 on all three routes`, async () => {
			const t = await team();
			if (mode === "solo") await clearInstanceSettings();
			const ctx = await seedSession(mode === "team" ? t.alice.id : null);
			const a = await openApproval(ctx);
			for (const route of await reachableRoutes(ctx.sessionId, a.id)) {
				const res = await hit(route, new Headers(), a);
				expect(res.status).toBe(401);
			}
		});
	}

	test("a manage key reads both GETs; accept is the only thing it can't do", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const key = await seedKey("p4-manage", ["manage"], t.alice.id);
		const list = await app.request(base(ctx.sessionId), { headers: bearerHeaders(key.key) });
		const detail = await app.request(`${base(ctx.sessionId)}/${a.id}`, {
			headers: bearerHeaders(key.key),
		});
		expect(list.status).toBe(200);
		expect(detail.status).toBe(200);
		expect(((await list.json()) as CodexApprovalList).viewer.canAccept).toBe(false);
	});

	test("both mounts answer", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const headers = await browser(t.alice.id);
		for (const prefix of ["/api/v1", "/app-api/v1"]) {
			const res = await app.request(`${prefix}/sessions/${ctx.sessionId}/approvals`, { headers });
			expect(res.status).toBe(200);
		}
	});
});

// ── DISABLE_AUTH ────────────────────────────────────────────────────────────

describe("DISABLE_AUTH", () => {
	const LOOPBACK = { Host: "localhost:3000" };

	test("every caller is the operator, as a person: a loopback curl with JSON and no Origin accepts, and viewer.canAccept is true", async () => {
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);
		(config as Record<string, unknown>).disableAuth = true;

		const list = await app.request(base(ctx.sessionId), { headers: LOOPBACK });
		expect(list.status).toBe(200);
		expect(((await list.json()) as CodexApprovalList).viewer.canAccept).toBe(true);

		const res = await decide(ctx.sessionId, a.id, new Headers(LOOPBACK), accept(a.hash));

		expect(res.status).toBe(200);
		const [audit] = await harness.auditRows(ctx.sessionId);
		expect(audit).toMatchObject({
			actorUserId: null,
			actorKeyId: null,
			actorLabel: "anonymous",
			decision: "accept",
		});
	});

	test("a rebound Host with a matching Origin is refused for accept, decline and cancel, before the body is read", async () => {
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);
		(config as Record<string, unknown>).disableAuth = true;
		const rebound = new Headers({
			Host: "attacker.example:3000",
			Origin: "http://attacker.example:3000",
		});

		for (const body of [accept(a.hash), { decision: "decline" }, { decision: "cancel" }]) {
			const res = await decide(ctx.sessionId, a.id, rebound, body);
			expect({ body, status: res.status, error: await errorOf(res) }).toEqual({
				body,
				status: 403,
				error: "bad_origin",
			});
		}
		const garbage = await decide(ctx.sessionId, a.id, rebound, null, { raw: "{not json" });
		expect(await errorOf(garbage)).toBe("bad_origin");
		const noHost = await decide(
			ctx.sessionId,
			a.id,
			new Headers({ Origin: "http://attacker.example" }),
			{
				decision: "decline",
			},
		);
		expect(await errorOf(noHost)).toBe("bad_origin");
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("a rebound Host with no Origin and Sec-Fetch-Site: same-origin is refused too", async () => {
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);
		(config as Record<string, unknown>).disableAuth = true;
		const res = await decide(
			ctx.sessionId,
			a.id,
			new Headers({ Host: "attacker.example:3000", "Sec-Fetch-Site": "same-origin" }),
			{ decision: "decline" },
		);
		expect([res.status, await errorOf(res)]).toEqual([403, "bad_origin"]);
		expect((await rowOf(a.id))?.status).toBe("pending");
	});

	test("a loopback Host with its own Origin is allowed, for each decision", async () => {
		const ctx = await seedSession(null);
		(config as Record<string, unknown>).disableAuth = true;
		const headers = new Headers({ Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" });
		const a = await openApproval(ctx);
		const b = await openApproval(ctx);
		const c = await openApproval(ctx);
		expect((await decide(ctx.sessionId, a.id, headers, accept(a.hash))).status).toBe(200);
		expect((await decide(ctx.sessionId, b.id, headers, { decision: "decline" })).status).toBe(200);
		expect((await decide(ctx.sessionId, c.id, headers, { decision: "cancel" })).status).toBe(200);
	});

	test("an allowlisted name is allowed", async () => {
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);
		(config as Record<string, unknown>).disableAuth = true;
		const headers = new Headers({ Host: "localhost:3000", Origin: "http://localhost:3000" });
		expect((await decide(ctx.sessionId, a.id, headers, accept(a.hash))).status).toBe(200);
	});

	test("with no Origin: a loopback client sending JSON passes; text/plain, a missing type and a non-loopback Host do not", async () => {
		const ctx = await seedSession(null);
		(config as Record<string, unknown>).disableAuth = true;
		const a = await openApproval(ctx);

		const plain = await decide(ctx.sessionId, a.id, new Headers(LOOPBACK), accept(a.hash), {
			contentType: "text/plain",
		});
		expect([plain.status, await errorOf(plain)]).toEqual([403, "bad_origin"]);
		const untyped = await decide(ctx.sessionId, a.id, new Headers(LOOPBACK), accept(a.hash), {
			contentType: null,
		});
		expect([untyped.status, await errorOf(untyped)]).toEqual([403, "bad_origin"]);
		const sameSite = await decide(
			ctx.sessionId,
			a.id,
			new Headers({ Host: "localhost:3000", "Sec-Fetch-Site": "same-origin" }),
			accept(a.hash),
			{ contentType: "text/plain" },
		);
		expect([sameSite.status, await errorOf(sameSite)]).toEqual([400, "invalid_decision"]);
		const ok = await decide(ctx.sessionId, a.id, new Headers(LOOPBACK), accept(a.hash));
		expect(ok.status).toBe(200);
	});

	test("the same rebound request with auth on is judged normally: the cookie caller whose Origin equals Host passes the Origin step", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = withHeaders(await cookieHeadersFor(t.alice.id), {
			Host: "attacker.example:3000",
			Origin: "http://attacker.example:3000",
		});
		const res = await decide(ctx.sessionId, a.id, headers, accept(a.hash));
		expect(res.status).toBe(200);
	});

	test("a foreign Origin is still refused", async () => {
		const ctx = await seedSession(null);
		const a = await openApproval(ctx);
		(config as Record<string, unknown>).disableAuth = true;
		const res = await decide(
			ctx.sessionId,
			a.id,
			new Headers({ Host: "localhost:3000", Origin: "https://evil.example" }),
			accept(a.hash),
		);
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("bad_origin");
	});
});

describe("Cache-Control: no-store", () => {
	test("on both reads and on the decision answer, refusals included", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.alice.id);
		const answers = [
			await app.request(base(ctx.sessionId), { headers }),
			await app.request(`${base(ctx.sessionId)}/${a.id}`, { headers }),
			await decide(ctx.sessionId, a.id, headers, { decision: "decline" }),
			await decide(ctx.sessionId, a.id, headers, { decision: "decline" }),
			await app.request(base(ctx.sessionId), { headers: await browser(t.bob.id) }),
		];
		expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 409, 403]);
		for (const res of answers) expect(res.headers.get("Cache-Control")).toBe("no-store");
	});
});

// ── viewer.canAccept against the POST ───────────────────────────────────────

describe("viewer.canAccept is what the POST would do", () => {
	type Caller =
		| "cookieAlice"
		| "cookieBob"
		| "cookieAdmin"
		| "ssoAlice"
		| "manageAlice"
		| "manageAdmin"
		| "manageLoose"
		| "manageKept"
		| "disableAuth";
	const CALLERS: Caller[] = [
		"cookieAlice",
		"cookieBob",
		"cookieAdmin",
		"ssoAlice",
		"manageAlice",
		"manageAdmin",
		"manageLoose",
		"manageKept",
		"disableAuth",
	];
	type OwnerState = "alice" | "bob" | "unowned";

	/** The literal specification, written out; nothing here calls a production predicate. */
	function expectedCanAccept(mode: "solo" | "team", caller: Caller, owner: OwnerState): boolean {
		const isKey = caller.startsWith("manage");
		if (caller === "disableAuth") return true;
		if (isKey) return false; // an API key is never a person
		if (mode === "solo") return true;
		if (caller === "cookieAdmin") return true;
		if (owner === "unowned") return false;
		const person = caller === "cookieBob" ? "bob" : "alice";
		return owner === person;
	}

	async function world(mode: "solo" | "team") {
		const t = await team();
		if (mode === "solo") await clearInstanceSettings();
		const kept = await seedKey("p4-kept", ["manage"], null);
		await setAdminServiceKeyList([kept.id]);
		const headers: Record<Exclude<Caller, "disableAuth">, Headers> = {
			cookieAlice: await browser(t.alice.id),
			cookieBob: await browser(t.bob.id),
			cookieAdmin: await browser(t.admin.id),
			ssoAlice: await ssoBrowser(t.alice.id, "p4-sso-alice"),
			manageAlice: bearerHeaders((await seedKey("p4-m-alice", ["manage"], t.alice.id)).key),
			manageAdmin: bearerHeaders((await seedKey("p4-m-admin", ["manage"], t.admin.id)).key),
			manageLoose: bearerHeaders((await seedKey("p4-m-loose", ["manage"], null)).key),
			manageKept: bearerHeaders(kept.key),
		};
		return { t, headers };
	}

	for (const mode of ["solo", "team"] as const) {
		test(`${mode}: the list's flag and the POST agree for every caller and owner state, and match the written table`, async () => {
			const { t, headers } = await world(mode);
			const owners: Record<OwnerState, string | null> = {
				alice: t.alice.id,
				bob: t.bob.id,
				unowned: null,
			};
			let cells = 0;
			let accepted = 0;
			for (const caller of CALLERS) {
				if (caller === "disableAuth" && mode === "team") continue;
				for (const owner of Object.keys(owners) as OwnerState[]) {
					const ctx = await seedSession(owners[owner]);
					const a = await openApproval(ctx);
					(config as Record<string, unknown>).disableAuth = caller === "disableAuth";
					const h =
						caller === "disableAuth" ? new Headers({ Host: "localhost:3000" }) : headers[caller];
					const label = `${mode}/${caller}/${owner}`;

					const list = await app.request(base(ctx.sessionId), { headers: h });
					const post = await decide(ctx.sessionId, a.id, h, accept(a.hash));
					(config as Record<string, unknown>).disableAuth = originalDisableAuth;
					cells++;

					const expected = expectedCanAccept(mode, caller, owner);
					const flag =
						list.status === 200
							? ((await list.json()) as CodexApprovalList).viewer.canAccept
							: false;
					expect({ label, flag }).toEqual({ label, flag: list.status === 200 ? expected : false });
					const postError = post.status === 200 ? null : await errorOf(post);
					expect({ label, accepted: post.status === 200, postError }).toEqual({
						label,
						accepted: expected,
						postError: expected ? null : postError,
					});
					if (post.status === 200) accepted++;
					else expect(["not_owner", "human_required"]).toContain(postError as string);
					if (list.status !== 200)
						expect({ label, post: post.status }).toEqual({ label, post: 403 });
				}
			}
			expect(cells).toBeGreaterThanOrEqual(mode === "solo" ? 27 : 24);
			expect(accepted).toBeGreaterThan(0);
		});
	}
});

// ── reads ───────────────────────────────────────────────────────────────────

describe("the reads", () => {
	test("a team non-owner reads neither the list nor the detail (403 not_owner)", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx);
		const headers = await browser(t.bob.id);
		const list = await app.request(base(ctx.sessionId), { headers });
		const detail = await app.request(`${base(ctx.sessionId)}/${a.id}`, { headers });
		expect([list.status, await errorOf(list)]).toEqual([403, "not_owner"]);
		expect([detail.status, await errorOf(detail)]).toEqual([403, "not_owner"]);
	});

	test("an unknown approval is 404 for a reader who can read the session", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const res = await app.request(`${base(ctx.sessionId)}/nope`, {
			headers: await browser(t.alice.id),
		});
		expect([res.status, await errorOf(res)]).toEqual([404, "approval_not_found"]);
	});

	test("the list carries the host and the open row; the detail carries the presentation", async () => {
		const t = await team();
		const ctx = await seedSession(t.alice.id);
		const a = await openApproval(ctx, { command: "npm run build" });
		const headers = await browser(t.alice.id);
		const list = (await (
			await app.request(base(ctx.sessionId), { headers })
		).json()) as CodexApprovalList;
		expect(list.host).toEqual({ state: "live", name: "build-host" });
		expect(list.approvals.map((x) => x.id)).toEqual([a.id]);
		expect(list.viewer).toEqual({ canAccept: true });
		const detail = (await (
			await app.request(`${base(ctx.sessionId)}/${a.id}`, { headers })
		).json()) as CodexApprovalDetail;
		expect(detail.presentation).toMatchObject({ requestKind: "command", command: "npm run build" });
	});
});
