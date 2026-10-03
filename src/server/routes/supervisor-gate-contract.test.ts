/**
 * The supervisor's report gate against the real server routes. Two things the
 * gate promises are only true if the server does its part:
 *
 *  - the one contentless closing report for a newly excluded session moves it out
 *    of the live managed states (live managed sessions are exempt from staleness,
 *    so without it the session would look live for ever) and, with the generic
 *    failure the gate sends for an in-flight control action, clears its control
 *    lock, while storing nothing new: no cwd, title, model, output or metadata
 *    the session did not already have;
 *  - a session that was never reported (excluded from the start) leaves no row.
 *
 * The gate talks to the app through its injected request function, exactly the
 * routes a real supervisor calls. Nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions, events, launchRequests, managedSessions, sessions } = await import(
	"../db/schema/index.js"
);
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { queueStopAction, claimNextControlAction } = await import("../services/control-actions.js");
const { listLiveOwnedManagedSessionIds } = await import("../services/session-ownership.js");
const { createReportGate, LAUNCH_REFUSED_MESSAGE } = await import(
	"../../supervisor/services/report-gate.js"
);

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;
const LIVE_STATES = ["interactive_terminal", "headless", "managed", "pending"];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function registerSupervisor(): Promise<{ id: string; credential: string }> {
	const { token } = await createSupervisorEnrollmentToken(
		`gate-${crypto.randomUUID()}`,
		null,
		null,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "gate-contract-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	return {
		id,
		credential: ((await res.json()) as { supervisorCredential: string }).supervisorCredential,
	};
}

function world() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-gate-contract-")));
	const work = join(home, "work", "secret-project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	let version = 0;
	const writeRules = (lines: string[]) => {
		const file = join(home, ".agentpulse", "exclude");
		writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		version++;
		const at = new Date(Date.now() + version * 1000);
		utimesSync(file, at, at);
	};
	return { home, work, writeRules, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function gateFor(w: ReturnType<typeof world>, supervisor: { id: string; credential: string }) {
	const request = async (path: string, options?: RequestInit) => {
		const res = await app.request(`/api/v1${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
		return res.json();
	};
	return createReportGate({
		request,
		supervisorId: supervisor.id,
		home: w.home,
		now: () => Date.now(),
		log: () => {},
	});
}

const sessionRow = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
const managedRow = async (id: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, id)))[0];
const eventCount = async (id: string) =>
	(await getDb().select().from(events).where(eq(events.sessionId, id))).length;

describe("a newly excluded managed session", () => {
	test("the closing report takes it out of the live states and stores nothing new; the generic failure then clears the control lock", async () => {
		const w = world();
		try {
			const supervisor = await registerSupervisor();
			const gate = gateFor(w, supervisor);
			const sessionId = `gate-${crypto.randomUUID()}`;
			await seedOwnedLaunch(sessionId, supervisor.id);

			gate.noteCwd(sessionId, w.work);
			await gate.reportState({
				sessionId,
				agentType: "claude_code",
				cwd: w.work,
				model: "model-xyz",
				desiredThreadTitle: "a private title",
				status: "active",
				managedState: "headless",
				metadata: { note: "private note" },
			});
			await gate.reportEvents(sessionId, [
				{ eventType: "HeadlessTaskStarted", category: "system_event", content: "started" },
			]);
			expect(await listLiveOwnedManagedSessionIds(LIVE_STATES)).toContain(sessionId);

			// a control action is in flight: the session is locked by it
			const queued = await queueStopAction(sessionId, { userId: null, label: "user" });
			const claimed = await claimNextControlAction(supervisor.id);
			expect(claimed?.id).toBe(queued.id);
			expect((await managedRow(sessionId))?.activeControlActionId).toBe(queued.id);

			const before = await sessionRow(sessionId);
			const eventsBefore = await eventCount(sessionId);
			expect(before?.cwd).toBe(w.work);

			// a rule now covers the directory
			w.writeRules([join(w.home, "work")]);
			await gate.scan();

			const after = await sessionRow(sessionId);
			expect(after?.status).toBe("completed");
			expect((await managedRow(sessionId))?.managedState).toBe("stopped");
			expect(await listLiveOwnedManagedSessionIds(LIVE_STATES)).not.toContain(sessionId);

			// nothing the session did not already have was stored
			expect(after?.cwd).toBe(before?.cwd);
			expect(after?.model).toBe(before?.model);
			expect(after?.displayName).toBe(before?.displayName);
			expect(after?.agentType).toBe(before?.agentType);
			expect(after?.metadata).toEqual(before?.metadata);
			expect(await eventCount(sessionId)).toBe(eventsBefore);

			// the in-flight action ends with the generic failure, which frees the session
			await gate.reportControlStatus(queued.id, sessionId, {
				status: "succeeded",
				metadata: { output: "private output" },
			});
			const action = (
				await getDb().select().from(controlActions).where(eq(controlActions.id, queued.id))
			)[0];
			expect(action?.status).toBe("failed");
			expect(action?.error).toBe(LAUNCH_REFUSED_MESSAGE);
			expect(JSON.stringify(action?.metadata ?? {})).not.toContain("private");
			const managed = await managedRow(sessionId);
			expect(managed?.activeControlActionId).toBeNull();
			expect(managed?.controlLockExpiresAt).toBeNull();
		} finally {
			w.cleanup();
		}
	});
});

describe("a session that was never reported", () => {
	test("excluded from the start: no session row, no managed row, no events, and the launch it came from is untouched", async () => {
		const w = world();
		try {
			const supervisor = await registerSupervisor();
			const gate = gateFor(w, supervisor);
			const sessionId = `gate-${crypto.randomUUID()}`;
			await seedOwnedLaunch(sessionId, supervisor.id);
			w.writeRules([join(w.home, "work")]);

			gate.noteCwd(sessionId, w.work);
			await gate.reportState({
				sessionId,
				cwd: w.work,
				status: "active",
				managedState: "headless",
			});
			await gate.reportEvents(sessionId, [
				{ eventType: "x", category: "system_event", content: "private" },
			]);
			await gate.scan();

			expect(await sessionRow(sessionId)).toBeUndefined();
			expect(await managedRow(sessionId)).toBeUndefined();
			expect(await eventCount(sessionId)).toBe(0);
			const launch = (
				await getDb()
					.select()
					.from(launchRequests)
					.where(eq(launchRequests.launchCorrelationId, sessionId))
			)[0];
			expect(launch?.status).toBe("running");
		} finally {
			w.cleanup();
		}
	});
});
