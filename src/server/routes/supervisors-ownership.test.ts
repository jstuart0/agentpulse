/**
 * Phase 1 (2026-09-29-deliver-supervisor-auth-routing): HTTP-level F94
 * vectors against the real `app`. Test contract items 18-28 (T1-T11).
 *
 * Built on the app.integration.test.ts:17-86 real-app scaffold. Supervisors
 * A and B are enrolled through the real enroll + register HTTP flow.
 *
 * agentHeaders(cred) sends the supervisor token PLUS a "manage"-scoped
 * Bearer key. That combination is what reaches the agent handlers pre-Phase-3
 * (repro case C: the four sibling wildcard routers mounted ahead of the
 * agent router in app.ts require an operator Bearer with "manage" scope to
 * fall through to the real handler). Phase 3 drops the Bearer requirement
 * entirely — see supervisors-ownership.test.ts's Phase 3 edit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { events, launchRequests, managedSessions, sessions } = await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { queuePromptAction } = await import("../services/control-actions.js");

type Credential = { id: string; token: string };

const originalDisableAuth = config.disableAuth;

let manageKey: string;
let supervisorA: Credential;
let supervisorB: Credential;

function agentHeaders(cred: Credential): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"X-AgentPulse-Supervisor-Token": cred.token,
		// Phase 3 removes the Bearer — this combination is what reaches the
		// handler pre-Phase-3 (repro case C).
		Authorization: `Bearer ${manageKey}`,
	};
}

async function enrollAndRegister(hostName: string): Promise<Credential> {
	const enrollRes = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name: hostName }),
	});
	expect(enrollRes.status).toBe(201);
	const { token: enrollmentToken } = (await enrollRes.json()) as { token: string };

	const registerRes = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		// Manage Bearer needed pre-Phase-3 to fall through the sibling wildcard
		// gates (repro case C); see agentHeaders' comment.
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({
			hostName,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
		}),
	});
	expect(registerRes.status).toBe(200);
	const body = (await registerRes.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

async function seedOwnedSession(sessionId: string, supervisorId: string) {
	const { launchId } = await seedOwnedLaunch(sessionId, supervisorId);
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launchId,
			supervisorId,
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return { launchId };
}

async function seedHookObservedSession(sessionId: string) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.execute();
}

async function seedValidatedLaunch(sessionId: string, requestedSupervisorId: string) {
	const [row] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/supervisors-ownership-test",
			requestedSupervisorId,
			status: "validated",
		})
		.returning();
	return row;
}

async function eventCount(sessionId: string): Promise<number> {
	const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	return rows.length;
}

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("phase1-ownership-test-manage", ["manage"])).key;
	supervisorA = await enrollAndRegister(`sup-a-${crypto.randomUUID().slice(0, 8)}`);
	supervisorB = await enrollAndRegister(`sup-b-${crypto.randomUUID().slice(0, 8)}`);
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
});

describe("supervisor ownership guard — HTTP (F94)", () => {
	test("T1: A posts managed-session-state for B's session → 403, unchanged row, B still claims its prompt", async () => {
		const sessionId = `t1-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedOwnedSession(sessionId, supervisorB.id);
		await queuePromptAction(sessionId, "hello from B");

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId, model: "hijacked" }),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "session_not_owned" });

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow?.supervisorId).toBe(supervisorB.id);

		const bClaim = await app.request(
			`/api/v1/supervisors/${supervisorB.id}/control-actions/claim`,
			{ method: "POST", headers: agentHeaders(supervisorB) },
		);
		expect(bClaim.status).toBe(200);
		const bClaimBody = (await bClaim.json()) as { action: { sessionId: string } | null };
		expect(bClaimBody.action?.sessionId).toBe(sessionId);

		const aClaim = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/control-actions/claim`,
			{ method: "POST", headers: agentHeaders(supervisorA) },
		);
		expect(aClaim.status).toBe(200);
		const aClaimBody = (await aClaim.json()) as { action: unknown };
		expect(aClaimBody.action).toBeNull();
	});

	test("T2: A promotes a hook-observed session → 403, no managed row, session unchanged", async () => {
		const sessionId = `t2-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedHookObservedSession(sessionId);
		const [before] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId }),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "session_not_owned" });

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow).toBeUndefined();

		const [after] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(after?.status).toBe(before?.status);
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
	});

	test("T3: A posts an unknown session id → 403, no sessions row created", async () => {
		const sessionId = `t3-sess-${crypto.randomUUID().slice(0, 8)}`;

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId }),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "session_not_owned" });

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row).toBeUndefined();
	});

	test("T4: A's own session with launchRequestId = B's launch → 403, launchRequestId unchanged", async () => {
		const sessionId = `t4-sess-${crypto.randomUUID().slice(0, 8)}`;
		const { launchId } = await seedOwnedSession(sessionId, supervisorA.id);
		const bLaunch = await seedOwnedLaunch(
			`t4-b-sess-${crypto.randomUUID().slice(0, 8)}`,
			supervisorB.id,
		);

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId, launchRequestId: bLaunch.launchId }),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "session_not_owned" });

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow?.launchRequestId).toBe(launchId);
	});

	test("T5: events route — foreign/hook/unknown all 403 with zero rows; owner 200", async () => {
		const bSessionId = `t5-b-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedOwnedSession(bSessionId, supervisorB.id);
		const hookSessionId = `t5-hook-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedHookObservedSession(hookSessionId);
		const unknownSessionId = `t5-unknown-${crypto.randomUUID().slice(0, 8)}`;

		for (const sessionId of [bSessionId, hookSessionId, unknownSessionId]) {
			const res = await app.request(
				`/api/v1/supervisors/${supervisorA.id}/managed-sessions/${sessionId}/events`,
				{
					method: "POST",
					headers: agentHeaders(supervisorA),
					body: JSON.stringify({
						events: [{ eventType: "PostToolUse", category: "tool_use" }],
					}),
				},
			);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "session_not_owned" });
			expect(await eventCount(sessionId)).toBe(0);
		}

		const res = await app.request(
			`/api/v1/supervisors/${supervisorB.id}/managed-sessions/${bSessionId}/events`,
			{
				method: "POST",
				headers: agentHeaders(supervisorB),
				body: JSON.stringify({
					events: [{ eventType: "PostToolUse", category: "tool_use" }],
				}),
			},
		);
		expect(res.status).toBe(200);
		expect(await eventCount(bSessionId)).toBe(1);
	});

	test("T6: correlation override — A posts state for B's awaiting_session launch → 403, no side effects", async () => {
		const sessionId = `t6-sess-${crypto.randomUUID().slice(0, 8)}`;
		const bLaunch = await seedOwnedLaunch(sessionId, supervisorB.id, {
			status: "awaiting_session",
		});

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId, launchRequestId: bLaunch.launchId }),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "session_not_owned" });

		const [launchRow] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, bLaunch.launchId));
		expect(launchRow?.status).toBe("awaiting_session");

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow).toBeUndefined();
	});

	test("T7: legitimate first report — A claims its own launch and reports → 200, owner A, launch running", async () => {
		const sessionId = `t7-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedValidatedLaunch(sessionId, supervisorA.id);

		const claimRes = await app.request(`/api/v1/supervisors/${supervisorA.id}/launches/claim`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
		});
		expect(claimRes.status).toBe(200);
		const claimBody = (await claimRes.json()) as { launchRequest: { id: string } | null };
		const launchId = claimBody.launchRequest?.id;
		expect(launchId).toBeTruthy();

		const stateRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId, launchRequestId: launchId }),
			},
		);
		expect(stateRes.status).toBe(200);

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow?.supervisorId).toBe(supervisorA.id);

		const [launchRow] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchId as string));
		expect(launchRow?.status).toBe("running");
	});

	test("T8: bridge/early-events shapes — state without launchRequestId, events before state → 200", async () => {
		const sessionIdState = `t8-state-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedValidatedLaunch(sessionIdState, supervisorA.id);
		await app.request(`/api/v1/supervisors/${supervisorA.id}/launches/claim`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
		});

		const stateRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId: sessionIdState }),
			},
		);
		expect(stateRes.status).toBe(200);

		const sessionIdEvents = `t8-events-sess-${crypto.randomUUID().slice(0, 8)}`;
		await seedValidatedLaunch(sessionIdEvents, supervisorA.id);
		await app.request(`/api/v1/supervisors/${supervisorA.id}/launches/claim`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
		});
		// events.session_id carries an FK to sessions.session_id, so a raw
		// sessions row must exist first — exactly as it does in production,
		// where a SessionStart hook always creates the row before any tool-use
		// event streams in. No managed_sessions row exists yet, so this still
		// exercises the "events before the first state post" ownership path
		// (owner resolves via the launch claimant, matrix case (a)).
		await seedHookObservedSession(sessionIdEvents);

		const eventsRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-sessions/${sessionIdEvents}/events`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({
					events: [{ eventType: "PostToolUse", category: "tool_use" }],
				}),
			},
		);
		expect(eventsRes.status).toBe(200);
	});

	test("T9: hook-first ordering — SessionStart hook creates the row before A's state post → 200, owner A", async () => {
		const sessionId = `t9-sess-${crypto.randomUUID().slice(0, 8)}`;
		const launch = await seedValidatedLaunch(sessionId, supervisorA.id);
		const claimRes = await app.request(`/api/v1/supervisors/${supervisorA.id}/launches/claim`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
		});
		expect(claimRes.status).toBe(200);

		// Simulate the hook path (event-processor.ts:538-540): a raw sessions
		// row created with no supervisor id, before the supervisor's own state
		// post arrives.
		await seedHookObservedSession(sessionId);

		const stateRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId, launchRequestId: launch.id }),
			},
		);
		expect(stateRes.status).toBe(200);

		const [managedRow] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managedRow?.supervisorId).toBe(supervisorA.id);
	});

	describe("T10: DISABLE_AUTH=true — guard still runs, keyed on route :id, never on anonymous identity", () => {
		beforeAll(() => {
			(config as Record<string, unknown>).disableAuth = true;
		});
		afterAll(() => {
			(config as Record<string, unknown>).disableAuth = false;
		});

		test("supervisor X on its own claimed launch → 200 for state and events", async () => {
			const supervisorX = `sup-x-${crypto.randomUUID().slice(0, 8)}`;
			const sessionId = `t10-own-sess-${crypto.randomUUID().slice(0, 8)}`;
			await seedOwnedLaunch(sessionId, supervisorX);

			const stateRes = await app.request(
				`/api/v1/supervisors/${supervisorX}/managed-session-state`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId }),
				},
			);
			expect(stateRes.status).toBe(200);

			const eventsRes = await app.request(
				`/api/v1/supervisors/${supervisorX}/managed-sessions/${sessionId}/events`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						events: [{ eventType: "PostToolUse", category: "tool_use" }],
					}),
				},
			);
			expect(eventsRes.status).toBe(200);
		});

		test("a launch claimed by Y → 403 session_not_owned, not 401", async () => {
			const supervisorX = `sup-x2-${crypto.randomUUID().slice(0, 8)}`;
			const supervisorY = `sup-y-${crypto.randomUUID().slice(0, 8)}`;
			const sessionId = `t10-foreign-sess-${crypto.randomUUID().slice(0, 8)}`;
			await seedOwnedLaunch(sessionId, supervisorY);

			const res = await app.request(`/api/v1/supervisors/${supervisorX}/managed-session-state`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId }),
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "session_not_owned" });
		});
	});

	// F27 (Medium, tessa): T6 never reaches the D7 code — A posting for its
	// own session (guard passes via the managed-row fallback, matrix case
	// (b)) is the only shape that actually exercises
	// resolveObservedSessionCorrelation's supervisorId check, because the
	// guard has already returned before associateObservedSession runs in
	// every other scenario. Mutation-verified: reverting D7 (restoring
	// `resolvedSupervisorId = supervisorId ?? claimed ?? requested ??
	// "unknown"`) makes this test fail — the unclaimed launch below would
	// get silently attached and transitioned to "running".
	test("F27: D7 still refuses to attach an unclaimed launch to a caller who legitimately owns the session via the managed row", async () => {
		const sessionId = `f27-sess-${crypto.randomUUID().slice(0, 8)}`;
		const now = new Date().toISOString();

		// Matrix case (b): an unclaimed (validated) launch correlated to this
		// session id, plus a managed row owned by A. resolveSessionOwner falls
		// back to the managed row's supervisor_id (the launch has no
		// claimant), so the ownership guard passes for A.
		await getDb().insert(launchRequests).values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/f27-unclaimed-launch",
			status: "validated",
		});
		await getDb().insert(sessions).values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		});
		await getDb().insert(managedSessions).values({
			sessionId,
			launchRequestId: sessionId,
			supervisorId: supervisorA.id,
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		});

		const res = await app.request(`/api/v1/supervisors/${supervisorA.id}/managed-session-state`, {
			method: "POST",
			headers: agentHeaders(supervisorA),
			body: JSON.stringify({ sessionId }),
		});
		// The guard passes — A really does own S via the managed row.
		expect(res.status).toBe(200);

		// D7 must still refuse to correlate the unclaimed launch to A: only
		// its actual claimant may do that.
		const [launchRow] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, sessionId));
		expect(launchRow?.claimedBySupervisorId).toBeNull();
		expect(launchRow?.status).toBe("validated");
	});

	// F28 (Medium, tessa): item T11 (response-body parity, D10) had no
	// standalone test — it was only implicit in T1-T4's individual
	// assertions. This collects the four rejection shapes independently and
	// asserts they're byte-identical to each other and to the documented
	// contract body, so a reason-per-case regression (which would let an
	// enrolled supervisor enumerate foreign/unmanaged/fabricated/forged by
	// watching the error shape change) is caught in one place.
	test("F28: T11 — the 403 body is byte-identical across foreign, unmanaged, fabricated and forged-launch cases", async () => {
		const foreignSessionId = `f28-foreign-${crypto.randomUUID().slice(0, 8)}`;
		await seedOwnedSession(foreignSessionId, supervisorB.id);
		const foreignRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId: foreignSessionId }),
			},
		);

		const unmanagedSessionId = `f28-unmanaged-${crypto.randomUUID().slice(0, 8)}`;
		await seedHookObservedSession(unmanagedSessionId);
		const unmanagedRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId: unmanagedSessionId }),
			},
		);

		const fabricatedSessionId = `f28-fabricated-${crypto.randomUUID().slice(0, 8)}`;
		const fabricatedRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId: fabricatedSessionId }),
			},
		);

		const ownSessionId = `f28-own-${crypto.randomUUID().slice(0, 8)}`;
		await seedOwnedSession(ownSessionId, supervisorA.id);
		const bLaunch = await seedOwnedLaunch(
			`f28-b-launch-${crypto.randomUUID().slice(0, 8)}`,
			supervisorB.id,
		);
		const forgedRes = await app.request(
			`/api/v1/supervisors/${supervisorA.id}/managed-session-state`,
			{
				method: "POST",
				headers: agentHeaders(supervisorA),
				body: JSON.stringify({ sessionId: ownSessionId, launchRequestId: bLaunch.launchId }),
			},
		);

		const responses = [
			{ label: "foreign", res: foreignRes },
			{ label: "unmanaged", res: unmanagedRes },
			{ label: "fabricated", res: fabricatedRes },
			{ label: "forged-launch", res: forgedRes },
		];
		const bodies: Array<{ label: string; status: number; body: unknown }> = [];
		for (const { label, res } of responses) {
			bodies.push({ label, status: res.status, body: await res.json() });
		}

		for (const entry of bodies) {
			expect(entry.status).toBe(403);
			expect(entry.body).toEqual({ error: "session_not_owned" });
		}
		// Byte-identical to each other, not just individually matching the
		// shape — catches a reason field that happens to be absent on one
		// path but present (and merely unequal in value) on another.
		const serialized = bodies.map((entry) => JSON.stringify(entry.body));
		expect(new Set(serialized).size).toBe(1);
	});
});
