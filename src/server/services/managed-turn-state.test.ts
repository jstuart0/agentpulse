/**
 * AGEN-91 phase 2: the server reads a managed Codex session's turns. Real events, state and
 * register routes over the real app and a real database; nothing in the repo is mocked.
 *
 * What is pinned here, and the bug each part catches:
 *  - a Codex turn flips `isWorking` and the timestamps the operational badge reads (before this,
 *    a managed Codex session was never "working");
 *  - the update rides the receipt transaction, so a replay changes nothing and a failure rolls
 *    rows and receipt back together;
 *  - repeated identical prompts and agent messages are stored when a delivery id says they are
 *    different deliveries, and not otherwise;
 *  - a supervisor restart degrades the host's Codex sessions, and an outbox replay cannot undo it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import "../db/__test_db.js";
import { DELIVERY_ID_HEADER, REPLAY_HEADER } from "../../shared/hook-headers.js";
import { deleteAllSupervisors } from "./__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const schema = await import("../db/schema/index.js");
const {
	controlActions,
	events,
	launchRequests,
	managedDeliveryReceipts,
	managedSessions,
	sessions,
} = schema;
const harness = await import("../test-utils/codex-approvals-harness.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { sessionBus } = await import("./notifier.js");
const { mapSessionDto } = await import("./session-dto.js");
const { boundaryOf, computeTurnKey } = await import("./ai/turn-identity.js");
const { updateStaleSessions } = await import("./session-tracker.js");
const { promptDeliverability } = await import("./ai/prompt-deliverability.js");
const managedState = await import("./managed-session-state.js");
const { HOST_RESTARTED_SYNC_ERROR } = await import("./managed-sync-errors.js");
const audit = await import("./ai/dispatch-audit-service.js");

const originalDisableAuth = config.disableAuth;
let manageKey: string;

type Host = { id: string; token: string };

const SUBMITTED_PAYLOAD = { source: "agentpulse_workspace", codexRuntime: true };
const submitted = (
	content = "run the tests",
	rawPayload: Record<string, unknown> = SUBMITTED_PAYLOAD,
) => ({
	eventType: "HeadlessPromptSubmitted",
	category: "prompt",
	content,
	rawPayload,
});
const turnEnd = (
	eventType: "HeadlessPromptCompleted" | "HeadlessPromptFailed" = "HeadlessPromptCompleted",
) => ({
	eventType,
	category: "system_event",
	content:
		eventType === "HeadlessPromptCompleted" ? "Codex finished the turn." : "Codex turn failed.",
	rawPayload: {
		codexTurnId: "turn-1",
		status: eventType === "HeadlessPromptCompleted" ? "completed" : "failed",
		codexRuntime: true,
	},
});
const sessionStart = (marker = true) => ({
	eventType: "ManagedSessionStart",
	category: "system_event",
	content: "Managed Codex session started.",
	rawPayload: marker ? { threadId: "thr-1", codexRuntime: true } : { threadId: "thr-1" },
});
const stopped = () => ({
	eventType: "ManagedSessionStopped",
	category: "system_event",
	content: "Managed session stopped by operator.",
});
const agentMessage = (text = "Should I continue?") => ({
	eventType: "ManagedAgentMessage",
	category: "assistant_message",
	content: text,
	rawPayload: { notification: { method: "item/completed" } },
});
const warning = (text = "Codex asked for something unsupported.") => ({
	eventType: "ManagedWarning",
	category: "system_event",
	content: text,
});

function register(extra: Record<string, unknown>, token?: string) {
	return app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-AgentPulse-Supervisor-Token": token } : {}),
		},
		body: JSON.stringify({
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: { codex: { available: true, command: "codex", resolvedPath: "/bin/codex" } },
			},
			trustedRoots: ["/tmp"],
			...extra,
		}),
	});
}

async function enroll(name: string): Promise<Host> {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await register({ hostName: name, enrollmentToken });
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

const agentHeaders = (host: Host, extra: Record<string, string> = {}) => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": host.token,
	...extra,
});

let hostA: Host;
let hostB: Host;
const sessionsUsed: string[] = [];
let counter = 0;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("p2-turn-state-manage", ["manage"])).key;
	hostA = await enroll("p2-host-a");
	hostB = await enroll("p2-host-b");
});

afterEach(async () => {
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
});

afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	await deleteAllSupervisors();
});

/** A managed Codex session owned by `host`: session, claimed launch (codex), managed row. */
async function codexSession(host: Host, over: { managedState?: string } = {}) {
	const sessionId = `p2-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
	await getDb()
		.update(launchRequests)
		.set({ agentType: "codex_cli" })
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	if (over.managedState) {
		await getDb()
			.update(managedSessions)
			.set({ managedState: over.managedState })
			.where(eq(managedSessions.sessionId, sessionId));
	}
	return sessionId;
}

/** The same shape for a Claude session: its hooks own working state, not this route. */
async function claudeSession(host: Host) {
	const sessionId = `p2c-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
	await getDb()
		.update(sessions)
		.set({ agentType: "claude_code" })
		.where(eq(sessions.sessionId, sessionId));
	return sessionId;
}

interface PostOptions {
	deliveryId?: string | null;
	replay?: boolean;
}

/** Events with a fresh delivery id unless the test says otherwise (null means none). */
async function postEvents(
	host: Host,
	sessionId: string,
	batch: unknown[],
	opts: PostOptions = {},
): Promise<Response> {
	const headers: Record<string, string> = {};
	const deliveryId = opts.deliveryId === undefined ? crypto.randomUUID() : opts.deliveryId;
	if (deliveryId) headers[DELIVERY_ID_HEADER] = deliveryId;
	if (opts.replay) headers[REPLAY_HEADER] = "1";
	return app.request(`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/events`, {
		method: "POST",
		headers: agentHeaders(host, headers),
		body: JSON.stringify({ events: batch }),
	});
}

async function ok(res: Response) {
	expect(res.status).toBe(200);
	return res;
}

async function postState(
	host: Host,
	sessionId: string,
	body: Record<string, unknown>,
	opts: { replay?: boolean } = {},
) {
	return app.request(`/api/v1/supervisors/${host.id}/managed-session-state`, {
		method: "POST",
		headers: agentHeaders(host, opts.replay ? { [REPLAY_HEADER]: "1" } : {}),
		body: JSON.stringify({ sessionId, ...body }),
	});
}

const rowOf = async (sessionId: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId)))[0]!;
const managedOf = async (sessionId: string) =>
	(
		await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, sessionId))
	)[0]!;
const storedEvents = (sessionId: string) =>
	getDb().select().from(events).where(eq(events.sessionId, sessionId)).orderBy(events.id);
const receipts = (sessionId: string) =>
	getDb()
		.select()
		.from(managedDeliveryReceipts)
		.where(eq(managedDeliveryReceipts.sessionId, sessionId));
const operational = async (sessionId: string) =>
	mapSessionDto(await rowOf(sessionId), { managedSession: null }).operationalStatus;

/** The columns the turn rules own. */
async function turnColumns(sessionId: string) {
	const r = await rowOf(sessionId);
	return {
		isWorking: r.isWorking,
		currentTurnStartedAt: r.currentTurnStartedAt,
		lastAgentTurnCompletedAt: r.lastAgentTurnCompletedAt,
		lastUserAcknowledgedAt: r.lastUserAcknowledgedAt,
		status: r.status,
		endedAt: r.endedAt,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ── 1. turn boundaries ──────────────────────────────────────────────────────────────

describe("a Codex turn moves working state", () => {
	test("Submitted sets working, the acknowledgement and the turn start; Completed and Failed end it and the badge reads waiting", async () => {
		for (const end of ["HeadlessPromptCompleted", "HeadlessPromptFailed"] as const) {
			const sessionId = await codexSession(hostA);
			await getDb()
				.update(sessions)
				.set({
					status: "idle",
					endedAt: "2026-01-01T00:00:00.000Z",
					lastActivityAt: "2026-01-01T00:00:00.000Z",
				})
				.where(eq(sessions.sessionId, sessionId));
			await ok(await postEvents(hostA, sessionId, [submitted()]));

			const working = await rowOf(sessionId);
			expect(working.isWorking).toBe(true);
			expect(working.lastUserAcknowledgedAt).not.toBeNull();
			expect(working.currentTurnStartedAt).not.toBeNull();
			expect(working.status).toBe("active");
			expect(working.endedAt).toBeNull();
			expect(working.lastActivityAt > "2026-01-02").toBe(true);
			expect(await operational(sessionId)).toBe("working");

			await tick();
			await ok(await postEvents(hostA, sessionId, [turnEnd(end)]));
			const done = await rowOf(sessionId);
			expect(done.isWorking).toBe(false);
			expect(done.currentTurnStartedAt).toBeNull();
			expect(done.lastAgentTurnCompletedAt).not.toBeNull();
			expect(done.lastActivityAt >= working.lastActivityAt).toBe(true);
			expect(await operational(sessionId)).toBe("waiting");
		}
	});

	test("order within a batch decides: [Submitted, Completed] ends idle of work, [Completed, Submitted] ends working", async () => {
		const first = await codexSession(hostA);
		await ok(await postEvents(hostA, first, [submitted(), turnEnd()]));
		expect((await rowOf(first)).isWorking).toBe(false);

		const second = await codexSession(hostA);
		await ok(await postEvents(hostA, second, [turnEnd(), submitted()]));
		expect((await rowOf(second)).isWorking).toBe(true);
	});

	test("a stale row is not swept right after a Submitted (positive control: it is swept without one)", async () => {
		const stale = new Date(Date.now() - 10 * 60_000).toISOString();
		const control = await codexSession(hostA, { managedState: "degraded" });
		const worked = await codexSession(hostA, { managedState: "degraded" });
		for (const id of [control, worked]) {
			await getDb()
				.update(sessions)
				.set({ status: "active", lastActivityAt: stale, isWorking: false })
				.where(eq(sessions.sessionId, id));
		}
		await ok(await postEvents(hostA, worked, [submitted()]));

		await updateStaleSessions();

		expect((await rowOf(control)).status).toBe("idle");
		expect((await rowOf(worked)).status).toBe("active");
		expect((await rowOf(worked)).isWorking).toBe(true);
	});

	test("a Codex ManagedSessionStart with the marker is working with no acknowledgement and no watcher wake", async () => {
		const sessionId = await codexSession(hostA);
		const seen: Array<{ eventType: string; category: string | null }> = [];
		const listener = (m: {
			sessionId: string;
			event: { eventType: string; category: string | null };
		}) => {
			if (m.sessionId === sessionId) seen.push(m.event);
		};
		sessionBus.on("session_event", listener as never);
		try {
			await ok(await postEvents(hostA, sessionId, [sessionStart(true)]));
			await ok(await postEvents(hostA, sessionId, [submitted("go")]));
		} finally {
			sessionBus.off("session_event", listener as never);
		}
		const start = seen.find((e) => e.eventType === "ManagedSessionStart");
		expect(start).toBeDefined();
		expect(boundaryOf(start!)).toBeNull();
		// Positive control: the prompt in the same run is a boundary, so the capture sees wakeable events.
		expect(boundaryOf(seen.find((e) => e.eventType === "HeadlessPromptSubmitted")!)).toBe(
			"turn_start",
		);

		const fresh = await codexSession(hostA);
		await ok(await postEvents(hostA, fresh, [sessionStart(true)]));
		const columns = await turnColumns(fresh);
		expect(columns.isWorking).toBe(true);
		expect(columns.currentTurnStartedAt).not.toBeNull();
		expect(columns.lastUserAcknowledgedAt).toBeNull();
	});

	test("a start without the marker (dry run, old supervisor) changes nothing; the marker on a Claude row changes nothing", async () => {
		const dry = await codexSession(hostA);
		await ok(await postEvents(hostA, dry, [sessionStart(false)]));
		expect((await rowOf(dry)).isWorking).toBe(false);

		const claude = await claudeSession(hostA);
		await ok(await postEvents(hostA, claude, [sessionStart(true), submitted()]));
		const row = await rowOf(claude);
		expect(row.isWorking).toBe(false);
		expect(row.lastUserAcknowledgedAt).toBeNull();
	});

	test("a Submitted with no marker (an old supervisor, or Claude) does not set working", async () => {
		const sessionId = await codexSession(hostA);
		await ok(
			await postEvents(hostA, sessionId, [submitted("go", { source: "agentpulse_workspace" })]),
		);
		expect((await rowOf(sessionId)).isWorking).toBe(false);
	});

	test("ManagedSessionStopped clears; a late Submitted and a late Start do not set; a late Completed clears", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [submitted()]));
		await ok(await postEvents(hostA, sessionId, [stopped()]));
		const afterStop = await rowOf(sessionId);
		expect(afterStop.isWorking).toBe(false);
		expect(afterStop.currentTurnStartedAt).toBeNull();

		await ok(await postEvents(hostA, sessionId, [submitted()], { replay: true }));
		await ok(await postEvents(hostA, sessionId, [sessionStart(true)], { replay: true }));
		expect((await rowOf(sessionId)).isWorking).toBe(false);

		await ok(await postEvents(hostA, sessionId, [submitted()]));
		expect((await rowOf(sessionId)).isWorking).toBe(true);
		await ok(await postEvents(hostA, sessionId, [turnEnd()], { replay: true }));
		expect((await rowOf(sessionId)).isWorking).toBe(false);

		const both = await codexSession(hostA);
		await ok(await postEvents(hostA, both, [submitted(), turnEnd()], { replay: true }));
		expect((await rowOf(both)).isWorking).toBe(false);
	});

	test("a batch of more than 500 events whose last is a Submitted ends working", async () => {
		const sessionId = await codexSession(hostA);
		const filler = Array.from({ length: 520 }, (_, i) => warning(`filler ${i}`));
		await ok(await postEvents(hostA, sessionId, [...filler, submitted()]));
		expect((await rowOf(sessionId)).isWorking).toBe(true);
	});

	test("an unknown session id is a no-op and another agent's row is left alone", async () => {
		await managedState.applyManagedTurnBoundaries(getDb(), "no-such-session", [submitted()], {
			late: false,
		});
		const sessionId = await codexSession(hostA);
		await getDb()
			.update(sessions)
			.set({ agentType: "copilot_cli" })
			.where(eq(sessions.sessionId, sessionId));
		await ok(await postEvents(hostA, sessionId, [submitted()]));
		expect((await rowOf(sessionId)).isWorking).toBe(false);
	});
});

// ── 2. the idle rule on state reports ───────────────────────────────────────────────

describe("the idle rule", () => {
	test("an idle report clears working and stamps the completion once; a repeat after Completed moves nothing", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [sessionStart(true)]));
		expect((await rowOf(sessionId)).isWorking).toBe(true);

		await ok(await postState(hostA, sessionId, { managedState: "managed", status: "idle" }));
		const cleared = await rowOf(sessionId);
		expect(cleared.isWorking).toBe(false);
		expect(cleared.currentTurnStartedAt).toBeNull();
		expect(cleared.lastAgentTurnCompletedAt).not.toBeNull();
		expect(await operational(sessionId)).toBe("waiting");

		await tick();
		await ok(await postState(hostA, sessionId, { managedState: "managed", status: "idle" }));
		const again = await rowOf(sessionId);
		expect(again.lastAgentTurnCompletedAt).toBe(cleared.lastAgentTurnCompletedAt);
		expect(again.isWorking).toBe(false);
	});

	test("an idle report after a Completed stamps nothing, because the session was no longer working", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [submitted()]));
		await tick();
		await ok(await postEvents(hostA, sessionId, [turnEnd()]));
		const completed = (await rowOf(sessionId)).lastAgentTurnCompletedAt;
		await tick();
		await ok(await postState(hostA, sessionId, { managedState: "managed", status: "idle" }));
		expect((await rowOf(sessionId)).lastAgentTurnCompletedAt).toBe(completed);
	});

	test("a Claude row is unchanged by an idle report", async () => {
		const sessionId = await claudeSession(hostA);
		await getDb()
			.update(sessions)
			.set({ isWorking: true, currentTurnStartedAt: "2026-01-01T00:00:00.000Z" })
			.where(eq(sessions.sessionId, sessionId));
		await ok(
			await postState(hostA, sessionId, {
				agentType: "claude_code",
				managedState: "managed",
				status: "idle",
			}),
		);
		const row = await rowOf(sessionId);
		expect(row.isWorking).toBe(true);
		expect(row.lastAgentTurnCompletedAt).toBeNull();
	});

	test("a status-less degraded report mid-turn does not clear; degraded with status idle does", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [submitted()]));
		await ok(
			await postState(hostA, sessionId, {
				managedState: "degraded",
				providerSyncState: "failed",
				providerSyncError: "rename failed",
			}),
		);
		expect((await rowOf(sessionId)).isWorking).toBe(true);

		await ok(await postState(hostA, sessionId, { managedState: "degraded", status: "idle" }));
		expect((await rowOf(sessionId)).isWorking).toBe(false);
	});
});

// ── 3. the receipt transaction ──────────────────────────────────────────────────────

describe("the update is inside the receipt transaction", () => {
	test("a receipt replay changes no column, even after a manual flip in between", async () => {
		const sessionId = await codexSession(hostA);
		const deliveryId = crypto.randomUUID();
		await ok(await postEvents(hostA, sessionId, [submitted()], { deliveryId }));
		await ok(await postEvents(hostA, sessionId, [turnEnd()]));
		const before = await turnColumns(sessionId);
		await getDb()
			.update(sessions)
			.set({ isWorking: false })
			.where(eq(sessions.sessionId, sessionId));

		const replay = await postEvents(hostA, sessionId, [submitted()], { deliveryId });
		expect(replay.status).toBe(200);

		const after = await turnColumns(sessionId);
		expect(after.isWorking).toBe(false);
		expect(after).toEqual({ ...before, isWorking: false });
		expect(await storedEvents(sessionId)).toHaveLength(2);
	});

	test("a failure inside the update rolls back the rows and the receipt, and the retry applies the rule", async () => {
		const sessionId = await codexSession(hostA);
		const deliveryId = crypto.randomUUID();
		const batch = [submitted()];
		let thrown: unknown;
		try {
			await managedState.appendManagedSessionDelivery(
				hostA.id,
				sessionId,
				batch as never,
				{ deliveryId, bodyDigest: "digest" },
				{
					afterRows: async (tx) => {
						await managedState.applyManagedTurnBoundaries(tx, sessionId, batch, { late: false });
						throw new Error("injected");
					},
				},
			);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toBe("injected");
		expect(await storedEvents(sessionId)).toHaveLength(0);
		expect(await receipts(sessionId)).toHaveLength(0);
		expect((await rowOf(sessionId)).isWorking).toBe(false);

		await ok(await postEvents(hostA, sessionId, batch, { deliveryId }));
		expect(await storedEvents(sessionId)).toHaveLength(1);
		expect((await rowOf(sessionId)).isWorking).toBe(true);
	});

	test("a batch the content window dropped still applies the rule, with and without a delivery id", async () => {
		const without = await codexSession(hostA);
		await getDb().insert(events).values({
			sessionId: without,
			eventType: "HeadlessPromptSubmitted",
			category: "prompt",
			source: "managed_control",
			content: "same text",
			rawPayload: {},
		});
		await ok(await postEvents(hostA, without, [submitted("same text")], { deliveryId: null }));
		expect(
			(await storedEvents(without)).filter((e) => e.eventType === "HeadlessPromptSubmitted"),
		).toHaveLength(1);
		expect((await rowOf(without)).isWorking).toBe(true);

		// With a delivery id the prompt is kept, so a start row is the one the window drops.
		const withId = await codexSession(hostA);
		await getDb().insert(events).values({
			sessionId: withId,
			eventType: "ManagedSessionStart",
			category: "system_event",
			source: "launch_system",
			content: "Managed Codex session started.",
			rawPayload: {},
		});
		await ok(await postEvents(hostA, withId, [sessionStart(true)]));
		expect(
			(await storedEvents(withId)).filter((e) => e.eventType === "ManagedSessionStart"),
		).toHaveLength(1);
		expect(await receipts(withId)).toHaveLength(1);
		expect((await rowOf(withId)).isWorking).toBe(true);
	});
});

// ── 4. statement budget ─────────────────────────────────────────────────────────────

/**
 * Statements the events route issues for a one-event batch with a delivery id, measured at 34124dc6
 * (before this phase). A boundary-free batch must still cost exactly this.
 */
const FREE_BATCH_STATEMENTS = 8;

describe("statement budget, by count", () => {
	async function statementsFor(host: Host, sessionId: string, batch: unknown[]) {
		let status = 0;
		const calls = await countDbCalls(async () => {
			status = (await postEvents(host, sessionId, batch)).status;
		});
		expect(status).toBe(200);
		return calls;
	}

	test("boundary-free +0, Codex boundary +1, Claude +0, an idle report +0", async () => {
		const codex = await codexSession(hostA);
		const claude = await claudeSession(hostA);
		// warm caches (auth, plans) so the measured calls are steady
		await statementsFor(hostA, codex, [warning("warm-1")]);
		await statementsFor(hostA, claude, [warning("warm-2")]);

		const free = await statementsFor(hostA, codex, [warning("free")]);
		const boundary = await statementsFor(hostA, codex, [submitted("budget")]);
		const claudeBoundary = await statementsFor(hostA, claude, [
			submitted("budget", { source: "agentpulse_workspace" }),
		]);
		const claudeMarked = await statementsFor(hostA, claude, [turnEnd()]);
		const lateBoundary = await countDbCalls(async () => {
			await postEvents(hostA, codex, [submitted("late one")], { replay: true });
		});

		expect(boundary).toBe(free + 1);
		expect(claudeBoundary).toBe(free);
		expect(claudeMarked).toBe(free + 1); // a marker on Claude's row still issues the guarded update: the guard is the row's agent type
		expect(lateBoundary).toBe(free);
		expect(free).toBe(FREE_BATCH_STATEMENTS);

		const idleNow = await countDbCalls(async () => {
			await postState(hostA, codex, { managedState: "managed", status: "idle" });
		});
		const activeNow = await countDbCalls(async () => {
			await postState(hostA, codex, { managedState: "managed", status: "active" });
		});
		expect(idleNow).toBe(activeNow);
	});
});

// ── 5. repeated prompts and messages ────────────────────────────────────────────────

describe("repeats under a delivery id", () => {
	test("two identical prompts with different delivery ids store two rows; the same id stores one", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [submitted("continue")]));
		await ok(await postEvents(hostA, sessionId, [submitted("continue")]));
		const same = crypto.randomUUID();
		await ok(await postEvents(hostA, sessionId, [submitted("continue")], { deliveryId: same }));
		await ok(await postEvents(hostA, sessionId, [submitted("continue")], { deliveryId: same }));
		expect(
			(await storedEvents(sessionId)).filter((e) => e.eventType === "HeadlessPromptSubmitted"),
		).toHaveLength(3);
	});

	test("a repeated ManagedAgentMessage stores two rows and the newest is the one the human gate reads; a repeated ManagedWarning is still dropped", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [agentMessage()]));
		await ok(await postEvents(hostA, sessionId, [agentMessage()]));
		await ok(await postEvents(hostA, sessionId, [warning()]));
		await ok(await postEvents(hostA, sessionId, [warning()]));
		const rows = await storedEvents(sessionId);
		const messages = rows.filter((e) => e.eventType === "ManagedAgentMessage");
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)?.content).toBe("Should I continue?");
		expect(rows.filter((e) => e.eventType === "ManagedWarning")).toHaveLength(1);
	});

	test("with no delivery id any repeat is still dropped, prompts and messages included", async () => {
		const sessionId = await codexSession(hostA);
		for (let i = 0; i < 2; i++) {
			await ok(
				await postEvents(hostA, sessionId, [submitted("continue"), agentMessage("hi")], {
					deliveryId: null,
				}),
			);
		}
		const rows = await storedEvents(sessionId);
		expect(rows.filter((e) => e.eventType === "HeadlessPromptSubmitted")).toHaveLength(1);
		expect(rows.filter((e) => e.eventType === "ManagedAgentMessage")).toHaveLength(1);
	});

	test("D6 pinned for Claude: a repeated identical managed prompt and completion row now store twice", async () => {
		const sessionId = await claudeSession(hostA);
		const prompt = submitted("repeat me", { source: "agentpulse_workspace" });
		const completion = {
			eventType: "HeadlessPromptCompleted",
			category: "system_event",
			content: "Claude finished.",
		};
		await ok(await postEvents(hostA, sessionId, [prompt, completion]));
		await ok(await postEvents(hostA, sessionId, [prompt, completion]));
		const rows = await storedEvents(sessionId);
		expect(rows.filter((e) => e.eventType === "HeadlessPromptSubmitted")).toHaveLength(2);
		expect(rows.filter((e) => e.eventType === "HeadlessPromptCompleted")).toHaveLength(2);
	});

	test("computeTurnKey differs for two identical stored prompts and is never t:", async () => {
		const sessionId = await codexSession(hostA);
		await ok(await postEvents(hostA, sessionId, [submitted("continue"), turnEnd()]));
		await ok(await postEvents(hostA, sessionId, [submitted("continue"), turnEnd()]));
		const rows = await storedEvents(sessionId);
		const ends = rows.filter((e) => e.eventType === "HeadlessPromptCompleted");
		expect(ends).toHaveLength(2);
		const keys = [];
		for (const end of ends) {
			keys.push(
				await computeTurnKey(getDb(), { sessionId, agentType: "codex_cli" }, { id: end.id }),
			);
		}
		expect(new Set(keys).size).toBe(2);
		for (const key of keys) expect(key).toMatch(/^p:\d+$/);
	});
});

// ── 6. the shared fixture, through the route ────────────────────────────────────────

describe("the recorded follow-up turn", () => {
	test("the join with the supervisor: the fixture replayed through the real route ends waiting, with every row stored", async () => {
		const fixture = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../shared/__fixtures__/codex-followup-events.json"),
				"utf8",
			),
		) as Array<Record<string, unknown>>;
		const real = JSON.parse(
			JSON.stringify(fixture).replaceAll("<thread>", "thr-1").replaceAll("<turn>", "turn-2"),
		) as unknown[];
		const sessionId = await codexSession(hostA);

		for (const event of real) {
			await ok(await postEvents(hostA, sessionId, [event]));
			await tick();
		}

		const row = await rowOf(sessionId);
		expect(row.isWorking).toBe(false);
		expect(row.lastAgentTurnCompletedAt).not.toBeNull();
		expect(await operational(sessionId)).toBe("waiting");
		expect((await storedEvents(sessionId)).map((e) => e.eventType)).toEqual(
			real.map((e) => (e as { eventType: string }).eventType),
		);
	});
});

// ── 7. registration ─────────────────────────────────────────────────────────────────

async function insertPromptAction(
	sessionId: string,
	status: "queued" | "running",
	type = "prompt",
) {
	const [row] = await getDb()
		.insert(controlActions)
		.values({
			sessionId,
			actionType: type,
			requestedBy: "user",
			status,
			claimedBySupervisorId: status === "running" ? hostA.id : null,
			metadata: { prompt: "hello" },
		})
		.returning();
	return row!;
}

describe("a restarted host's Codex sessions", () => {
	test("registering again degrades A's nonterminal Codex sessions with the constant, leaves terminal ones, other hosts and Claude alone, and clears working", async () => {
		const live = await codexSession(hostA);
		const working = await codexSession(hostA);
		const degradedAlready = await codexSession(hostA, { managedState: "degraded" });
		const terminal = await codexSession(hostA, { managedState: "stopped" });
		const failedTerminal = await codexSession(hostA, { managedState: "failed" });
		const otherHost = await codexSession(hostB);
		const claude = await claudeSession(hostA);
		await ok(await postEvents(hostA, working, [submitted()]));
		await getDb()
			.update(sessions)
			.set({ isWorking: true, currentTurnStartedAt: "2026-01-01T00:00:00.000Z" })
			.where(inArray(sessions.sessionId, [terminal, otherHost, claude]));
		const terminalBefore = await managedOf(terminal);

		const res = await register({ id: hostA.id, hostName: "p2-host-a" }, hostA.token);
		expect(res.status).toBe(200);

		for (const id of [live, working, degradedAlready]) {
			const m = await managedOf(id);
			expect(m.managedState).toBe("degraded");
			expect(m.providerSyncState).toBe("failed");
			expect(m.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
			expect((await rowOf(id)).isWorking).toBe(false);
			expect((await rowOf(id)).currentTurnStartedAt).toBeNull();
		}
		expect(HOST_RESTARTED_SYNC_ERROR).toBe(
			"The host's supervisor restarted, so this session's Codex process is gone.",
		);
		const after = await managedOf(terminal);
		expect(after.managedState).toBe("stopped");
		expect(after.providerSyncError).toBe(terminalBefore.providerSyncError);
		expect((await managedOf(failedTerminal)).managedState).toBe("failed");
		// A terminal session that was still marked working has the flag cleared too.
		expect((await rowOf(terminal)).isWorking).toBe(false);
		expect((await managedOf(otherHost)).managedState).toBe("managed");
		expect((await rowOf(otherHost)).isWorking).toBe(true);
		expect((await managedOf(claude)).managedState).toBe("managed");
		expect((await rowOf(claude)).isWorking).toBe(true);

		const deliverable = await promptDeliverability(live);
		expect(deliverable).toMatchObject({ deliverable: false, reason: "managed_state" });
	});

	test("A's queued and running Codex prompts fail with locks released; its stop and Claude actions, and host B's prompts, are untouched", async () => {
		const a = await codexSession(hostA);
		const a2 = await codexSession(hostA);
		const aClaude = await claudeSession(hostA);
		const b = await codexSession(hostB);
		const queued = await insertPromptAction(a, "queued");
		const running = await insertPromptAction(a2, "running");
		const stop = await insertPromptAction(a, "queued", "stop");
		const claudePrompt = await insertPromptAction(aClaude, "queued");
		const bPrompt = await insertPromptAction(b, "queued");
		// An AI prompt that was queued has an audit row saying it was sent: it never will be.
		const auditId = await audit.insertAuditIntent(getDb(), {
			sessionId: a,
			sessionName: null,
			actorKind: "auto",
			actorUserId: null,
			actorLabel: "ai",
			promptSha256: null,
			promptText: null,
			controlActionId: queued.id,
		});
		await audit.markAuditSent(getDb(), auditId);
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: queued.id,
				controlLockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, a));
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: running.id,
				controlLockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, a2));

		await register({ id: hostA.id, hostName: "p2-host-a" }, hostA.token);

		const byId = async (id: string) =>
			(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0]!;
		for (const id of [queued.id, running.id]) {
			const row = await byId(id);
			expect(row.status).toBe("failed");
			expect(row.error).toBe("The host's supervisor restarted before this prompt was confirmed.");
			expect(row.finishedAt).not.toBeNull();
		}
		const [auditRow] = await getDb()
			.select()
			.from(schema.aiDispatchAudit)
			.where(eq(schema.aiDispatchAudit.id, auditId));
		expect(auditRow).toMatchObject({ outcome: "failed", refusalCode: "expired_unclaimed" });
		expect((await managedOf(a)).activeControlActionId).toBeNull();
		expect((await managedOf(a)).controlLockExpiresAt).toBeNull();
		expect((await managedOf(a2)).activeControlActionId).toBeNull();
		expect((await byId(stop.id)).status).toBe("queued");
		expect((await byId(claudePrompt.id)).status).toBe("queued");
		expect((await byId(bPrompt.id)).status).toBe("queued");
	});

	test("a thrown failure in the degrade does not fail registration, and the approvals close still ran", async () => {
		const sessionId = await codexSession(hostA);
		const spy = spyOn(managedState, "degradeCodexSessionsOfRestartedHost").mockRejectedValue(
			new Error("boom"),
		);
		const closed = spyOn(await import("./codex-approvals.js"), "closeApprovalsForRestartedHost");
		try {
			const res = await register({ id: hostA.id, hostName: "p2-host-a" }, hostA.token);
			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(closed).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			closed.mockRestore();
		}
		expect((await managedOf(sessionId)).managedState).toBe("managed");
	});

	test("the state move and the action failures are one transaction: an injected failure leaves neither", async () => {
		const sessionId = await codexSession(hostA);
		const action = await insertPromptAction(sessionId, "queued");
		let thrown: unknown;
		try {
			await managedState.degradeCodexSessionsOfRestartedHost(hostA.id, {
				afterWrites: async () => {
					throw new Error("injected");
				},
			});
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toBe("injected");
		expect((await managedOf(sessionId)).managedState).toBe("managed");
		expect(
			(await getDb().select().from(controlActions).where(eq(controlActions.id, action.id)))[0]!
				.status,
		).toBe("queued");
	});

	test("a degraded row ages through the sweep, and a hook for the thread id does not reopen it", async () => {
		const sessionId = await codexSession(hostA);
		await register({ id: hostA.id, hostName: "p2-host-a" }, hostA.token);
		await getDb()
			.update(sessions)
			.set({
				status: "active",
				lastActivityAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				isWorking: false,
			})
			.where(eq(sessions.sessionId, sessionId));

		await updateStaleSessions();

		expect((await rowOf(sessionId)).status).toBe("idle");
	});
});

describe("the replay guard, through the real state route", () => {
	async function degrade(sessionId: string) {
		await register({ id: hostA.id, hostName: "p2-host-a" }, hostA.token);
		expect((await managedOf(sessionId)).providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	}

	test("a replayed managed report leaves the row degraded with its error; the same report live moves it to managed", async () => {
		const sessionId = await codexSession(hostA);
		await degrade(sessionId);

		await ok(
			await postState(
				hostA,
				sessionId,
				{ managedState: "managed", status: "active", providerSyncState: "synced" },
				{ replay: true },
			),
		);
		const held = await managedOf(sessionId);
		expect(held.managedState).toBe("degraded");
		expect(held.providerSyncState).toBe("failed");
		expect(held.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);

		await ok(
			await postState(hostA, sessionId, {
				managedState: "managed",
				status: "active",
				providerSyncState: "synced",
			}),
		);
		expect((await managedOf(sessionId)).managedState).toBe("managed");
	});

	test("a replay reporting degraded again for a row degraded by a restart is a no-op, not an error", async () => {
		const sessionId = await codexSession(hostA);
		await degrade(sessionId);
		await ok(
			await postState(
				hostA,
				sessionId,
				{ managedState: "degraded", providerSyncState: "failed", providerSyncError: "other" },
				{ replay: true },
			),
		);
		const row = await managedOf(sessionId);
		expect(row.managedState).toBe("degraded");
		expect(row.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});

	test("a rename-failure degraded row no restart touched is still recovered by a replay", async () => {
		const sessionId = await codexSession(hostA);
		await ok(
			await postState(hostA, sessionId, {
				managedState: "degraded",
				providerSyncState: "failed",
				providerSyncError: "rename failed",
			}),
		);
		await ok(
			await postState(
				hostA,
				sessionId,
				{ managedState: "managed", providerSyncState: "synced" },
				{ replay: true },
			),
		);
		expect((await managedOf(sessionId)).managedState).toBe("managed");
	});

	test("rename failure, then restart, then a replay of managed leaves it degraded with the constant", async () => {
		const sessionId = await codexSession(hostA);
		await ok(
			await postState(hostA, sessionId, {
				managedState: "degraded",
				providerSyncState: "failed",
				providerSyncError: "rename failed",
			}),
		);
		await degrade(sessionId);
		await ok(
			await postState(
				hostA,
				sessionId,
				{ managedState: "managed", providerSyncState: "synced" },
				{ replay: true },
			),
		);
		const row = await managedOf(sessionId);
		expect(row.managedState).toBe("degraded");
		expect(row.providerSyncError).toBe(HOST_RESTARTED_SYNC_ERROR);
	});
});

// A mutation guard for the helpers above: they would pass vacuously if the where clause matched nothing.
describe("test hygiene", () => {
	test("positive control: the seeded Codex session is found by the degrade's owner-of-record read", async () => {
		const sessionId = await codexSession(hostA);
		const ids = await managedState.degradeCodexSessionsOfRestartedHost(hostA.id);
		expect(ids).toContain(sessionId);
		expect(
			await getDb()
				.select()
				.from(launchRequests)
				.where(
					and(
						eq(launchRequests.launchCorrelationId, sessionId),
						eq(launchRequests.agentType, "codex_cli"),
					),
				),
		).toHaveLength(1);
	});
});
