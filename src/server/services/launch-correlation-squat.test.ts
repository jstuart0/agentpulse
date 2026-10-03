/**
 * Launch-correlation squatting (fix/launch-correlation-squat).
 *
 * A manage-scoped caller (REST `POST /api/v1/launches` or MCP `launch_agent`)
 * could previously set `launchSpec.launchCorrelationId` to an existing or
 * guessed-future session id. On that session's next `SessionStart`, the
 * session would silently attach to the attacker's launch instead of its
 * real one, handing the attacker's supervisor ownership of record.
 *
 * Covers:
 *   1. createValidatedLaunchRequest always mints its own correlation id.
 *   2. The hook-path correlation resolver refuses to attach a pending
 *      launch to a session that predates it, or that's already managed
 *      under a different launch — while still attaching a brand-new
 *      session to its own awaiting launch (the normal flow).
 *   3. queuePromptAction/queueStopAction/retryLaunchForSession assert
 *      ownership consistency, not just correlationId string equality.
 *   4. launch_correlation_id stays globally unique at the DB layer.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const TEST_ACTOR: Actor = { userId: null, label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiActionRequests, controlActions, launchRequests, managedSessions, sessions, supervisors } =
	await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { createValidatedLaunchRequest } = await import("./launch-validator.js");
const { associateObservedSession } = await import("./launch-dispatch.js");
const { claimNextControlAction, queuePromptAction, queueStopAction, retryLaunchForSession } =
	await import("./control-actions.js");
const { createActionRequest, resolveActionRequest } = await import(
	"./ai/action-requests-service.js"
);

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
	await getDb().delete(aiActionRequests).execute();
});

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

async function seedConnectedSupervisor(id: string): Promise<void> {
	const now = new Date().toISOString();
	const future = new Date(Date.now() + 60_000).toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: id,
			platform: "darwin",
			arch: "arm64",
			version: "0.1.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["interactive_terminal", "headless"],
				os: "macos",
				terminalSupport: ["iTerm.app"],
				executables: {
					claude: { available: true, version: "1.0", path: "/usr/bin/claude" },
					codex: { available: true, version: "1.0", path: "/usr/bin/codex" },
				},
				features: [],
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: future,
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

async function seedSessionRow(sessionId: string, startedAt?: string): Promise<void> {
	const now = startedAt ?? new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
		})
		.onConflictDoNothing()
		.execute();
}

async function seedPendingLaunch(
	correlationId: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const id = crypto.randomUUID();
	// createdAt/updatedAt are stamped explicitly (ISO, matching
	// createValidatedLaunchRequest's own nowIso()) so each test can pin an
	// exact, deterministic chronology relative to its session row.
	// resolveObservedSessionCorrelation compares these via parseDbTimestamp
	// (db-time.ts), which normalizes SQLite-bare, ISO, and Postgres-offset
	// forms to epoch ms, so mixing formats between this helper and
	// seedSessionRow below is no longer a correctness hazard — see the
	// "chronology guard: DB-default timestamps" describe block for coverage
	// of the raw-default (unstamped column) case specifically.
	const now = new Date().toISOString();
	await getDb()
		.insert(launchRequests)
		.values({
			id,
			launchCorrelationId: correlationId,
			agentType: "claude_code",
			cwd: "/tmp/squat",
			requestedLaunchMode: "interactive_terminal",
			status: "validated",
			createdAt: now,
			updatedAt: now,
			...overrides,
		})
		.execute();
	return id;
}

/**
 * Seeds a sessions row with NO startedAt supplied, so the active dialect's
 * raw column default fires: SQLite's bare `datetime('now')`
 * ("YYYY-MM-DD HH:MM:SS", no zone) or Postgres's CURRENT_TIMESTAMP cast to
 * text. Deliberately bypasses seedSessionRow's own ISO stamping — these
 * tests exist specifically to prove parseDbTimestamp (not a raw string
 * comparison) handles whatever the real, unstamped default produces.
 */
async function seedSessionRowRawDefault(sessionId: string): Promise<void> {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: new Date().toISOString(),
			metadata: {},
		})
		.onConflictDoNothing()
		.execute();
}

/** Same as seedSessionRowRawDefault, but for launch_requests.createdAt/updatedAt. */
async function seedPendingLaunchRawDefault(
	correlationId: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const id = crypto.randomUUID();
	await getDb()
		.insert(launchRequests)
		.values({
			id,
			launchCorrelationId: correlationId,
			agentType: "claude_code",
			cwd: "/tmp/squat",
			requestedLaunchMode: "interactive_terminal",
			status: "validated",
			...overrides,
		})
		.execute();
	return id;
}

async function minimalLaunchInput(correlationId: string, requestedSupervisorId: string) {
	return {
		requestedSupervisorId,
		template: {
			name: "squat-template",
			agentType: "claude_code" as const,
			cwd: "/tmp/squat",
		},
		launchSpec: {
			version: 1 as const,
			launchCorrelationId: correlationId,
			managedMode: "unmanaged_preview" as const,
			agentType: "claude_code" as const,
			cwd: "/tmp/squat",
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
			baseInstructions: "",
			taskPrompt: "",
			env: {},
			providerConfig: {
				command: "claude",
				cliArgs: [],
				instructionsFile: "CLAUDE.md" as const,
			},
		},
	};
}

describe("createValidatedLaunchRequest always mints its own correlation id", () => {
	test("a caller-supplied launchCorrelationId naming an existing session is ignored, not honored", async () => {
		const supervisorId = `sup-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(supervisorId);
		const victimSessionId = `victim-${crypto.randomUUID()}`;
		await seedSessionRow(victimSessionId, isoAgo(60_000));

		const input = await minimalLaunchInput(victimSessionId, supervisorId);
		const { launchRequest } = await createValidatedLaunchRequest(input, TEST_ACTOR);

		expect(launchRequest.launchCorrelationId).not.toBe(victimSessionId);
		expect(launchRequest.launchCorrelationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});

describe("hook-path correlation resolver refuses to squat an existing session", () => {
	test("a pending launch targeting a previously-unmanaged session's id is NOT attached on SessionStart", async () => {
		const victimSessionId = `victim-${crypto.randomUUID()}`;
		// The victim's session already existed (observed via hooks) well
		// before the attacker's launch was ever created — and was never
		// run through AgentPulse's own launch system, so no launch_requests
		// row exists for it yet.
		await seedSessionRow(victimSessionId, isoAgo(60_000));

		const attackerSupervisorId = `sup-attacker-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(attackerSupervisorId);
		await seedPendingLaunch(victimSessionId, {
			requestedSupervisorId: attackerSupervisorId,
		});

		// Simulate the victim's agent restarting and emitting another
		// SessionStart for the same (already-existing) session id.
		const result = await associateObservedSession({ sessionId: victimSessionId });

		expect(result).toBeNull();
		const managedRows = await getDb().select().from(managedSessions).execute();
		expect(managedRows.find((r) => r.sessionId === victimSessionId)).toBeUndefined();
	});

	test("a brand-new session still attaches to its own awaiting launch (normal flow)", async () => {
		const supervisorId = `sup-real-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(supervisorId);
		const correlationId = crypto.randomUUID();
		const launchId = await seedPendingLaunch(correlationId, {
			claimedBySupervisorId: supervisorId,
			requestedSupervisorId: supervisorId,
		});

		// The launch was created first; the session it spawned reports in
		// afterward, so its startedAt is strictly after the launch's createdAt.
		await seedSessionRow(correlationId, new Date().toISOString());

		const result = await associateObservedSession({ sessionId: correlationId });

		expect(result).not.toBeNull();
		expect(result?.id).toBe(launchId);
		const managedRows = await getDb().select().from(managedSessions).execute();
		const managed = managedRows.find((r) => r.sessionId === correlationId);
		expect(managed?.supervisorId).toBe(supervisorId);
	});

	test("a session already managed under a different launch is not re-attached", async () => {
		const sessionId = `sess-${crypto.randomUUID()}`;
		await seedPendingLaunch(sessionId);
		await seedSessionRow(sessionId, isoAgo(5_000));

		// Stamp a managed row pointing at a launch other than the one this
		// correlation id resolves to (e.g. a prior supervisor-authenticated
		// managed-session-state report with its own launchRequestId value).
		const now = new Date().toISOString();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: "some-other-launch-id",
				supervisorId: "sup-prior",
				managedState: "managed",
				createdAt: now,
				updatedAt: now,
			})
			.execute();

		const result = await associateObservedSession({ sessionId });
		expect(result).toBeNull();

		const managedRows = await getDb().select().from(managedSessions).execute();
		const row = managedRows.find((r) => r.sessionId === sessionId);
		expect(row?.launchRequestId).toBe("some-other-launch-id");
	});
});

describe("chronology guard: DB-default timestamps (AGEN-65 round 2)", () => {
	// The chronology comparison in resolveObservedSessionCorrelation parses
	// both sides with parseDbTimestamp (db-time.ts), not a raw string `<`.
	// These tests seed at least one side through the REAL column default
	// (the column is simply omitted) rather than an app-stamped ISO value,
	// to prove the comparison is correct against whatever the active
	// dialect's own default produces — not just against values this
	// codebase happens to always stamp itself today.

	test("(a) session startedAt via DB default, OLDER than an ISO launch -> refused", async () => {
		const sessionId = `chrono-a-${crypto.randomUUID()}`;
		// Session's raw-default startedAt lands at ~now; the launch is
		// stamped comfortably in the future, so the session is older.
		await seedSessionRowRawDefault(sessionId);
		await seedPendingLaunch(sessionId, { createdAt: isoAgo(-30_000), updatedAt: isoAgo(-30_000) });

		const result = await associateObservedSession({ sessionId });
		expect(result).toBeNull();
	});

	test("(b) session startedAt via DB default, NEWER than an ISO launch -> attaches", async () => {
		const sessionId = `chrono-b-${crypto.randomUUID()}`;
		const launchId = await seedPendingLaunch(sessionId, {
			createdAt: isoAgo(30_000),
			updatedAt: isoAgo(30_000),
		});
		// Session's raw-default startedAt lands at ~now, comfortably after
		// the launch stamped 30s in the past.
		await seedSessionRowRawDefault(sessionId);

		const result = await associateObservedSession({ sessionId });
		expect(result?.id).toBe(launchId);
	});

	test("(c) launch createdAt via DB default, ISO session OLDER -> refused", async () => {
		const sessionId = `chrono-c-${crypto.randomUUID()}`;
		await seedSessionRow(sessionId, isoAgo(30_000));
		// Launch's raw-default createdAt lands at ~now, after the session.
		await seedPendingLaunchRawDefault(sessionId);

		const result = await associateObservedSession({ sessionId });
		expect(result).toBeNull();
	});

	test("(d) same-second boundary: equal instants still attach (>=, not >)", async () => {
		const sessionId = `chrono-d-${crypto.randomUUID()}`;
		const instant = "2026-06-15T12:00:00.000Z";
		await seedPendingLaunch(sessionId, { createdAt: instant, updatedAt: instant });
		await seedSessionRow(sessionId, instant);

		const result = await associateObservedSession({ sessionId });
		expect(result).not.toBeNull();
	});

	test("(d) local-time trap: a bare zone-less session timestamp is read as UTC, not local, under a non-UTC TZ", async () => {
		const savedTz = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const sessionId = `chrono-tz-${crypto.randomUUID()}`;
			// Bare (zone-less) value, exactly 1 second BEFORE the launch. A
			// naive `Date.parse` under America/New_York (UTC-4/-5) would read
			// this as LOCAL noon and add hours of positive offset, making it
			// look *newer* than the launch instead of 1s older -- flipping a
			// real squat attempt into an allowed attach. parseDbTimestamp
			// must read it as UTC regardless of process TZ, so the session
			// stays correctly "older" and gets refused.
			await getDb()
				.insert(sessions)
				.values({
					sessionId,
					displayName: sessionId,
					agentType: "claude_code",
					status: "active",
					startedAt: "2026-06-15 11:59:59",
					lastActivityAt: new Date().toISOString(),
					metadata: {},
				})
				.execute();
			await seedPendingLaunch(sessionId, {
				createdAt: "2026-06-15T12:00:00.000Z",
				updatedAt: "2026-06-15T12:00:00.000Z",
			});

			const result = await associateObservedSession({ sessionId });
			expect(result).toBeNull();
		} finally {
			process.env.TZ = savedTz;
		}
	});

	test("(e) an unparseable session startedAt is refused, not treated as 'not older'", async () => {
		const sessionId = `chrono-e-${crypto.randomUUID()}`;
		await getDb()
			.insert(sessions)
			.values({
				sessionId,
				displayName: sessionId,
				agentType: "claude_code",
				status: "active",
				startedAt: "not-a-timestamp",
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();
		await seedPendingLaunch(sessionId);

		const result = await associateObservedSession({ sessionId });
		expect(result).toBeNull();
	});

	test("(e) an unparseable launch createdAt is refused, not treated as 'not newer'", async () => {
		const sessionId = `chrono-e2-${crypto.randomUUID()}`;
		await seedSessionRow(sessionId, isoAgo(5_000));
		await seedPendingLaunch(sessionId, { createdAt: "garbage", updatedAt: "garbage" });

		const result = await associateObservedSession({ sessionId });
		expect(result).toBeNull();
	});
});

describe("launch_correlation_id stays globally unique", () => {
	test("a second launch cannot reuse an already-claimed correlation id", async () => {
		const sessionId = `dup-${crypto.randomUUID()}`;
		await seedPendingLaunch(sessionId);

		await expect(seedPendingLaunch(sessionId)).rejects.toThrow();
	});
});

describe("control-actions ownership-consistency guard (beyond correlationId equality)", () => {
	async function seedUnclaimedDrift(sessionId: string) {
		const requestedSupervisorId = `sup-requested-${crypto.randomUUID()}`;
		const managedSupervisorId = `sup-managed-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(requestedSupervisorId);
		await seedConnectedSupervisor(managedSupervisorId);

		// Legacy fallback shape (control-actions.ts's resolveManagedLaunch):
		// managed.launchRequestId === sessionId, resolved by correlation id.
		// The launch itself is unclaimed (claimedBySupervisorId null), so the
		// old `launch.launchCorrelationId === sessionId` check is satisfied by
		// construction — only an ownership-of-record comparison catches the
		// drift between the launch's requestedSupervisorId and the managed
		// row's own (stale/forged) supervisorId column.
		await seedPendingLaunch(sessionId, { requestedSupervisorId });
		await seedSessionRow(sessionId, isoAgo(5_000));
		const now = new Date().toISOString();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: sessionId,
				supervisorId: managedSupervisorId,
				managedState: "managed",
				createdAt: now,
				updatedAt: now,
			})
			.execute();

		return { requestedSupervisorId, managedSupervisorId };
	}

	test("queuePromptAction refuses when the launch's requested supervisor doesn't match the managed row's owner", async () => {
		const sessionId = `prompt-drift-${crypto.randomUUID()}`;
		await seedUnclaimedDrift(sessionId);

		await expect(queuePromptAction(sessionId, "hello", TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);
	});

	test("queueStopAction refuses when the launch's requested supervisor doesn't match the managed row's owner", async () => {
		const sessionId = `stop-drift-${crypto.randomUUID()}`;
		await seedUnclaimedDrift(sessionId);

		await expect(queueStopAction(sessionId, TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);
	});

	test("retryLaunchForSession refuses when the launch's requested supervisor doesn't match the managed row's owner", async () => {
		const sessionId = `retry-drift-${crypto.randomUUID()}`;
		await seedUnclaimedDrift(sessionId);

		await expect(retryLaunchForSession(sessionId, TEST_ACTOR)).rejects.toThrow(
			"Launch request does not match session.",
		);
	});

	test("queuePromptAction and queueStopAction still succeed for a consistently-owned session", async () => {
		const sessionId = `consistent-${crypto.randomUUID()}`;
		const supervisorId = `sup-consistent-${crypto.randomUUID()}`;
		await seedOwnedLaunch(sessionId, supervisorId, { status: "running" });
		await seedSessionRow(sessionId, isoAgo(5_000));
		const now = new Date().toISOString();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: sessionId,
				supervisorId,
				managedState: "managed",
				createdAt: now,
				updatedAt: now,
			})
			.execute();

		const prompt = await queuePromptAction(sessionId, "hello", TEST_ACTOR);
		expect(prompt.status).toBe("queued");
		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed?.id).toBe(prompt.id);
	});
});

describe("legitimate flows still attach after the fix (AGEN-65 round 2)", () => {
	test("managed Codex launch via the supervisorId branch still attaches (unaffected by the hook-path guards)", async () => {
		const supervisorId = `sup-codex-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(supervisorId);
		const correlationId = crypto.randomUUID();
		const launchId = await seedPendingLaunch(correlationId, {
			agentType: "codex_cli",
			claimedBySupervisorId: supervisorId,
			requestedSupervisorId: supervisorId,
		});
		// upsertManagedSessionState (the real caller on this path) creates the
		// sessions row before ever calling associateObservedSession;
		// managed_sessions.session_id has an FK to sessions.session_id.
		await seedSessionRow(correlationId, new Date().toISOString());

		// The /supervisors/:id/managed-session-state route calls
		// associateObservedSession with the authenticated supervisorId —
		// this branch returns before the no-supervisorId chronology/ownership
		// guards added in rounds 1-2 are ever reached.
		const result = await associateObservedSession({ sessionId: correlationId, supervisorId });

		expect(result?.id).toBe(launchId);
		const managedRows = await getDb().select().from(managedSessions).execute();
		expect(managedRows.find((r) => r.sessionId === correlationId)?.supervisorId).toBe(supervisorId);
	});

	test("an AI-initiated launch (action-requests-service -> createValidatedLaunchRequest -> hook attach) still attaches", async () => {
		const supervisorId = `sup-ai-${crypto.randomUUID()}`;
		await seedConnectedSupervisor(supervisorId);
		const cwdSentinel = `/tmp/ai-launch-${crypto.randomUUID()}`;

		const req = await createActionRequest({
			kind: "launch_request",
			question: "Launch an AI-initiated session?",
			origin: "web",
			payload: {
				kind: "launch_request",
				template: {
					name: "ai-template",
					agentType: "claude_code",
					cwd: cwdSentinel,
				},
				launchSpec: {
					version: 1,
					// Round 1 fix: createValidatedLaunchRequest ignores this and
					// mints its own id regardless, so this value is never the
					// one that actually gets attached — read it back from the
					// created launch_requests row below instead.
					launchCorrelationId: crypto.randomUUID(),
					managedMode: "unmanaged_preview",
					agentType: "claude_code",
					cwd: cwdSentinel,
					model: null,
					approvalPolicy: null,
					sandboxMode: null,
					baseInstructions: "",
					taskPrompt: "",
					env: {},
					providerConfig: { command: "claude", cliArgs: [], instructionsFile: "CLAUDE.md" },
				},
				requestedLaunchMode: "interactive_terminal",
				validatedSupervisorId: supervisorId,
				projectId: null,
				aiInitiated: true,
			},
		});

		const resolved = await resolveActionRequest({
			id: req.id,
			decision: "applied",
			resolvedBy: "test",
			actor: TEST_ACTOR,
		});
		expect(resolved.ok).toBe(true);

		const createdRows = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.cwd, cwdSentinel))
			.execute();
		expect(createdRows.length).toBe(1);
		expect(createdRows[0].status).toBe("validated");
		const actualCorrelationId = createdRows[0].launchCorrelationId;

		// event-processor.ts creates/upserts the sessions row before ever
		// calling associateObservedSession — managed_sessions.session_id has
		// an FK to sessions.session_id, so the row must exist first.
		await seedSessionRow(actualCorrelationId, new Date().toISOString());

		// Simulate the spawned process's first hook event.
		const result = await associateObservedSession({ sessionId: actualCorrelationId });
		expect(result).not.toBeNull();
		const managedRows = await getDb().select().from(managedSessions).execute();
		expect(managedRows.find((r) => r.sessionId === actualCorrelationId)?.supervisorId).toBe(
			supervisorId,
		);
	});

	test("retry: retryLaunchForSession's fresh launch attaches the new session", async () => {
		const originalSessionId = `retry-orig-${crypto.randomUUID()}`;
		const supervisorId = `sup-retry-${crypto.randomUUID()}`;
		await seedOwnedLaunch(originalSessionId, supervisorId, { status: "running" });
		await seedSessionRow(originalSessionId, isoAgo(5_000));
		const now = new Date().toISOString();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: originalSessionId,
				launchRequestId: originalSessionId,
				supervisorId,
				managedState: "managed",
				createdAt: now,
				updatedAt: now,
			})
			.execute();

		const { launchRequest: retried } = await retryLaunchForSession(originalSessionId, TEST_ACTOR);
		const newSessionId = retried.launchCorrelationId;
		expect(newSessionId).not.toBe(originalSessionId);

		// The retried process reports in with the new correlation id as its
		// session id. event-processor.ts creates that sessions row before
		// ever calling associateObservedSession (FK requirement), so seed it
		// here the same way — this is still the normal "brand-new session"
		// path (no pre-existing managed row for newSessionId).
		await seedSessionRow(newSessionId, new Date().toISOString());
		const result = await associateObservedSession({ sessionId: newSessionId });
		expect(result?.id).toBe(retried.id);
		const managedRows = await getDb().select().from(managedSessions).execute();
		expect(managedRows.find((r) => r.sessionId === newSessionId)?.supervisorId).toBe(supervisorId);
	});

	test("resume: a second SessionStart on an already-attached session is a no-op, not a detach/re-attach", async () => {
		const sessionId = `resume-${crypto.randomUUID()}`;
		const supervisorId = `sup-resume-${crypto.randomUUID()}`;
		const launchId = await seedPendingLaunch(sessionId, {
			claimedBySupervisorId: supervisorId,
			requestedSupervisorId: supervisorId,
		});
		await seedSessionRow(sessionId, new Date().toISOString());

		const first = await associateObservedSession({ sessionId });
		expect(first?.id).toBe(launchId);
		const afterFirst = await getDb().select().from(managedSessions).execute();
		const rowAfterFirst = afterFirst.find((r) => r.sessionId === sessionId);
		expect(rowAfterFirst?.launchRequestId).toBe(launchId);
		expect(rowAfterFirst?.supervisorId).toBe(supervisorId);

		// A second SessionStart for the same, already-managed session (e.g.
		// the agent resuming/restarting with the same session id). The first
		// call already transitioned the launch to "running" (markLaunchRunning),
		// which falls outside PENDING_LAUNCH_STATUSES, so
		// findPendingLaunchForObservedSession no longer matches it — the
		// second call is correctly a no-op (null), not a second attach. The
		// part this test exists to pin: it must NOT detach or re-attach the
		// managed row to anything else in the process.
		const second = await associateObservedSession({ sessionId });
		expect(second).toBeNull();
		const afterSecond = await getDb().select().from(managedSessions).execute();
		const rowAfterSecond = afterSecond.find((r) => r.sessionId === sessionId);
		expect(rowAfterSecond?.launchRequestId).toBe(launchId);
		expect(rowAfterSecond?.supervisorId).toBe(supervisorId);
	});
});
