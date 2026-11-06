/**
 * AGEN-117 P3 at the route level, over the real app and database:
 *  - a hook post for a takeover fork is answered 200, stores nothing, broadcasts nothing, and moves
 *    /health's forkHookDropped; the same post for a launched session is stored (negative control);
 *  - a Claude-marked turn report through the managed-events route moves a fork's working state and nothing
 *    else's;
 *  - a prompt to a fork under the person's own settings is refused human_required for an API key, and passes
 *    for DISABLE_AUTH's caller; under restricted a key passes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { DELIVERY_ID_HEADER } from "../../shared/hook-headers.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { events, launchRequests, managedSessions, sessions, controlActions } = await import(
	"../db/schema/index.js"
);
const harness = await import("../test-utils/codex-approvals-harness.js");
const { sessionBus } = await import("../services/notifier.js");
const { getInFlightCount } = await import("./ingest-counters.js");

const originalDisableAuth = config.disableAuth;
let manageKey: string;
let host: { id: string; token: string };
const used: string[] = [];
let counter = 0;

async function until(check: () => boolean, ms = 8_000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

beforeAll(async () => {
	await initializeDatabase();
	(await import("./health.js")).markDbReady();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("fork-routes-manage", ["manage"])).key;
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name: "fork-routes-host" }),
	});
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			hostName: "fork-routes-host",
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: ["/tmp"],
		}),
	});
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	host = { id: body.supervisor.id, token: body.supervisorCredential };
});

afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = false;
	await harness.cleanApprovalFixtures(used.splice(0));
});

afterAll(async () => {
	(await import("./health.js"))._resetDbReadyForTest(false);
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(used.splice(0));
	await deleteAllSupervisors();
});

async function claudeSession(kind: "fork" | "launched", branch?: string) {
	const sessionId = `fr-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	used.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
	await getDb()
		.update(launchRequests)
		.set({
			agentType: "claude_code",
			requestedLaunchMode: "headless",
			metadata: kind === "fork" ? { boundObservedSession: true } : {},
		})
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	await getDb()
		.update(sessions)
		.set({
			agentType: "claude_code",
			metadata:
				kind === "fork"
					? { forkedFromSessionId: "src-1", ...(branch ? { forkPermissionBranch: branch } : {}) }
					: {},
		})
		.where(eq(sessions.sessionId, sessionId));
	return sessionId;
}

const health = async () => {
	(config as Record<string, unknown>).disableAuth = true;
	const res = await app.request("/api/v1/health");
	return (await res.json()) as { forkHookDropped: number };
};

const postHook = (sessionId: string, name: string, extra: Record<string, unknown> = {}) =>
	app.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Agent-Type": "claude_code" },
		body: JSON.stringify({
			session_id: sessionId,
			hook_event_name: name,
			tool_name: "Bash",
			...extra,
		}),
	});

describe("a hook post for a takeover fork", () => {
	test("is answered 200, stores nothing, broadcasts nothing, and moves forkHookDropped on /health", async () => {
		const sessionId = await claudeSession("fork");
		const before = (await health()).forkHookDropped;
		const seen: string[] = [];
		const listener = (m: { sessionId?: string }) => {
			if (m?.sessionId === sessionId) seen.push("event");
		};
		const updated = (s: { sessionId?: string }) => {
			if (s?.sessionId === sessionId) seen.push("updated");
		};
		sessionBus.on("session_event", listener as never);
		sessionBus.on("session_updated", updated as never);
		try {
			(config as Record<string, unknown>).disableAuth = true;
			const res = await postHook(sessionId, "PreToolUse", {
				tool_input: { command: "echo SENTINEL-route-9c1" },
				tool_use_id: "toolu_route",
			});
			expect(res.status).toBe(200);
			await until(() => getInFlightCount() === 0);
			await until(() => true);
		} finally {
			sessionBus.off("session_event", listener as never);
			sessionBus.off("session_updated", updated as never);
		}
		expect((await health()).forkHookDropped - before).toBe(1);
		expect(await getDb().select().from(events).where(eq(events.sessionId, sessionId))).toEqual([]);
		expect(seen).toEqual([]);
	});

	test("negative control: the same post for a launched session is stored and /health does not move", async () => {
		const sessionId = await claudeSession("launched");
		const before = (await health()).forkHookDropped;
		(config as Record<string, unknown>).disableAuth = true;
		expect((await postHook(sessionId, "PreToolUse", { tool_use_id: "toolu_ctl" })).status).toBe(
			200,
		);
		await until(() => getInFlightCount() === 0);
		await until(() => true);
		expect((await health()).forkHookDropped).toBe(before);
		const stored = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
		expect(stored.length).toBeGreaterThan(0);
	});
});

describe("a Claude turn marker through the managed-events route", () => {
	const post = (sessionId: string, batch: unknown[]) =>
		app.request(`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": host.token,
				[DELIVERY_ID_HEADER]: crypto.randomUUID(),
			},
			body: JSON.stringify({ events: batch }),
		});
	const working = async (id: string) =>
		(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0]?.isWorking;
	const submitted = (marker: Record<string, unknown>) => ({
		eventType: "HeadlessPromptSubmitted",
		category: "prompt",
		content: "go",
		rawPayload: { source: "agentpulse_workspace", ...marker },
	});

	test("moves a fork's working state, and not a launched Claude's, with the same events", async () => {
		const fork = await claudeSession("fork");
		const launched = await claudeSession("launched");
		expect((await post(fork, [submitted({ claudeStreamRuntime: true })])).status).toBe(200);
		expect((await post(launched, [submitted({ claudeStreamRuntime: true })])).status).toBe(200);
		expect(await working(fork)).toBe(true);
		expect(await working(launched)).toBe(false);
		const end = {
			eventType: "HeadlessPromptCompleted",
			category: "system_event",
			content: "Claude finished this turn.",
			rawPayload: { status: "completed", claudeStreamRuntime: true },
		};
		expect((await post(fork, [end])).status).toBe(200);
		expect(await working(fork)).toBe(false);
	});
});

describe("a prompt to a continued session that runs under the person's own settings", () => {
	const send = (sessionId: string, key?: string) =>
		app.request(`/api/v1/sessions/${sessionId}/prompt`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({ prompt: "carry on" }),
		});

	test("an API key gets human_required with nothing queued; DISABLE_AUTH's caller passes", async () => {
		const sessionId = await claudeSession("fork", "ask");
		const refused = await send(sessionId, manageKey);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: "human_required" });
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId)),
		).toEqual([]);
		(config as Record<string, unknown>).disableAuth = true;
		expect((await send(sessionId)).status).toBe(202);
	});

	test("under restricted an API key passes; a slash line is refused 400 prompt_unsafe with a reason", async () => {
		const sessionId = await claudeSession("fork", "restricted");
		const slash = await app.request(`/api/v1/sessions/${sessionId}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
			body: JSON.stringify({ prompt: "/model opus" }),
		});
		expect(slash.status).toBe(400);
		expect(await slash.json()).toMatchObject({ error: "prompt_unsafe", reason: "slash_command" });
		expect((await send(sessionId, manageKey)).status).toBe(202);
	});

	test("the fixture managed row is the fork's own (positive control for the seed)", async () => {
		const sessionId = await claudeSession("fork", "ask");
		const [row] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(row?.managedState).toBe("managed");
	});
});
