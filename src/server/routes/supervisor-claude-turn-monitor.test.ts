/**
 * AGEN-117 T12 end to end, host code against the server's real routes and database: a fake `claude` runs
 * under the supervisor's real prompt and launch providers, so the exit path that reports how a turn ended
 * (the launch monitor) is the code that runs, not a stub. What each case settles:
 *
 *  - a prompt whose turn a person's Stop ended: the prompt's action stays `failed` "Stopped by a person.",
 *    the stop `succeeded`, the lock free, the session `stopped`;
 *  - a Stop during a launched session's first turn: the launch ends `cancelled` through the launch monitor,
 *    and the session takes a prompt again;
 *  - a final report lost to an outage with the supervisor still running: the retry lands after the server
 *    is back, the launch leaves `running`, and the next prompt goes through.
 *
 * Every real signal goes through the signal guard (D10): only a pid this test started is signalled.
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
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_STOP, CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import {
	CLAUDE_TURN_RUNNING_ERROR,
	CONTROL_TIMEOUT_ERROR,
	HOST_RESTARTED_TURN_ERROR,
	STOPPED_BY_PERSON_ERROR,
} from "../../shared/managed-messages.js";
import type { Actor } from "../auth/actor.js";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { queuePromptAction, queueStopAction, claimNextControlAction } = await import(
	"../services/control-actions.js"
);
const { mapLaunchRequest } = await import("../services/launch-validator.js");
const { createReportGate } = await import("../../supervisor/services/report-gate.js");
const { createControlActionHandler } = await import("../../supervisor/control-actions.js");
const { createLaunchDispatcher } = await import("../../supervisor/launch-dispatch.js");
const { createFinalReporter } = await import("../../supervisor/services/final-report.js");
const { SupervisorNetworkError, SupervisorRequestError } = await import(
	"../../supervisor/services/report-resilience.js"
);
const headless = await import("../../supervisor/providers/claude-headless.js");
const { createSignalGuard, installDescendantKiller } = await import(
	"../../supervisor/test-utils/signal-guard.js"
);

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const FAKE = join(
	import.meta.dir,
	"..",
	"..",
	"supervisor",
	"providers",
	"__fixtures__",
	"fake-claude-tree.ts",
);
const ACTOR: Actor = { userId: null, label: "user" };
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

let guard: ReturnType<typeof createSignalGuard>;
let restoreKiller: () => void;
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"HOME",
	"AGENTPULSE_CLAUDE_COMMAND",
	"AGENTPULSE_SUPERVISOR_DRY_RUN",
	"FAKE_CLAUDE_LOG",
	"FAKE_CLAUDE_CHILD",
	"FAKE_CLAUDE_EXIT_FILE",
	"FAKE_AGENTS_MODE",
];

beforeEach(async () => {
	guard = createSignalGuard();
	restoreKiller = installDescendantKiller(guard);
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});
afterEach(async () => {
	await headless.disposeAllHeadlessRuntimes(100, 3000);
	restoreKiller();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	expect(guard.refused).toEqual([]);
});

async function registerSupervisor(): Promise<{ id: string; credential: string }> {
	const { token } = await createSupervisorEnrollmentToken(
		`turn-${crypto.randomUUID()}`,
		null,
		null,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "turn-monitor-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
			capabilities: { version: 1, features: [CLAUDE_STOP, CLAUDE_TURN_CONTROL] },
		}),
	});
	return {
		id,
		credential: ((await res.json()) as { supervisorCredential: string }).supervisorCredential,
	};
}

function world() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-turn-monitor-")));
	dirs.push(dir);
	const work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(dir, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(dir, ".agentpulse"), 0o700);
	const log = join(dir, "fake.log");
	const wrapper = join(dir, "claude");
	writeFileSync(
		wrapper,
		`#!/bin/sh
if [ "$1" = "agents" ]; then echo '[]'; exit 0; fi
if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi
exec "${process.execPath}" "${FAKE}" "$@"
`,
		{ mode: 0o755 },
	);
	process.env.HOME = dir;
	process.env.AGENTPULSE_CLAUDE_COMMAND = wrapper;
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.FAKE_CLAUDE_LOG = log;
	process.env.FAKE_CLAUDE_CHILD = "none";
	return { dir, work, log };
}

const fakeStarts = (log: string) =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.role === "claude").length
		: 0;

async function until(check: () => boolean | Promise<boolean>, what: string) {
	const deadline = Date.now() + 8_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(15);
	}
}

/** A supervisor: the real gate against the real routes, the real handlers, the real providers. */
function supervisorFor(
	w: ReturnType<typeof world>,
	supervisor: { id: string; credential: string },
) {
	const outage = { on: false };
	const waits: Array<() => void> = [];
	const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
	const ticks: Array<() => void> = [];
	const request = async (path: string, options?: RequestInit) => {
		if (outage.on) throw new SupervisorNetworkError();
		sent.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
		const res = await app.request(`/api/v1${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
				...(options?.headers as Record<string, string> | undefined),
			},
		});
		if (!res.ok) throw new SupervisorRequestError(res.status, res.statusText);
		return res.json();
	};
	const gate = createReportGate({
		request,
		supervisorId: supervisor.id,
		home: w.dir,
		now: () => Date.now(),
		log: () => {},
	});
	const finalReport = createFinalReporter({
		wait: () =>
			new Promise<void>((resolve) => {
				waits.push(resolve);
			}),
		log: () => {},
	});
	const providers = {
		stopManagedCodexSession: async () => {},
		promptManagedCodexSession: async () => {
			throw new Error("not used");
		},
		hasManagedCodexRuntime: () => false,
		promptClaudeInteractiveSession: async () => {
			throw new Error("not used");
		},
		promptClaudeHeadlessSession: async (
			...args: Parameters<typeof headless.promptClaudeHeadlessSession>
		) => {
			const result = await headless.promptClaudeHeadlessSession(...args);
			guard.allow(result.pid);
			return result;
		},
		stopHeadlessClaude: headless.stopHeadlessClaude,
	};
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [w.dir],
		providers: providers as never,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: w.dir })) as never,
		log: () => {},
		serverHas: (feature) => feature === CLAUDE_TURN_CONTROL,
		schedule: (callback) => {
			ticks.push(callback);
			return { stop: () => ticks.splice(ticks.indexOf(callback), 1) && undefined };
		},
		finalReport,
	});
	const dispatch = createLaunchDispatcher({
		gate,
		trustedRoots: [w.dir],
		providers: {
			launchManagedCodex: async () => {
				throw new Error("not used");
			},
			launchClaudeHeadless: async (
				...args: Parameters<typeof headless.launchClaudeHeadlessRequest>
			) => {
				const result = await headless.launchClaudeHeadlessRequest(...args);
				guard.allow(result.pid);
				return result;
			},
			launchClaudeInteractive: async () => {
				throw new Error("not used");
			},
		},
		executePrelaunchActions: (async () => {}) as never,
		finalReport,
		log: () => {},
		warn: () => {},
	});
	return { gate, handle, dispatch, outage, waits, sent, ticks };
}

async function seedRunningSession(
	supervisorId: string,
	sessionId: string,
	w: ReturnType<typeof world>,
) {
	const launch = await seedOwnedLaunch(sessionId, supervisorId, { status: "completed" });
	await getDb()
		.update(launchRequests)
		.set({ cwd: w.work })
		.where(eq(launchRequests.id, launch.launchId));
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
			launchRequestId: launch.launchId,
			supervisorId,
			managedState: "headless",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return launch;
}

const actionOf = async (id: string) =>
	(await getDb().select().from(controlActions).where(eq(controlActions.id, id)))[0];
const managedOf = async (id: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, id)))[0];
const launchOf = async (id: string) =>
	(await getDb().select().from(launchRequests).where(eq(launchRequests.id, id)))[0];

describe("a prompt whose turn a person's Stop ended", () => {
	test("the prompt stays failed 'Stopped by a person.', the stop succeeds, the lock is free, the session reads stopped", async () => {
		const w = world();
		const supervisor = await registerSupervisor();
		const host = supervisorFor(w, supervisor);
		await seedRunningSession(supervisor.id, "monitor-prompt", w);

		const prompt = await queuePromptAction("monitor-prompt", "go", ACTOR);
		const claimedPrompt = await claimNextControlAction(supervisor.id);
		expect(claimedPrompt?.id).toBe(prompt.id);
		await host.handle(claimedPrompt as never);
		await until(() => fakeStarts(w.log) === 1, "the fake claude to start");
		// Accepted: the lock is held for the turn, renewed by the acceptance report.
		expect((await actionOf(prompt.id))?.status).toBe("running");
		expect((await managedOf("monitor-prompt"))?.activeControlActionId).toBe(prompt.id);

		const stop = await queueStopAction("monitor-prompt", ACTOR);
		const pre = await actionOf(prompt.id);
		expect(pre?.status).toBe("failed");
		expect(pre?.error).toBe(STOPPED_BY_PERSON_ERROR);
		const claimedStop = await claimNextControlAction(supervisor.id);
		expect(claimedStop?.id).toBe(stop.id);
		await host.handle(claimedStop as never);

		// The real monitor sees the child leave and reports the turn; the server has already failed it.
		await until(
			async () => (await managedOf("monitor-prompt"))?.managedState === "stopped",
			"stopped",
		);
		await until(
			async () => (await actionOf(stop.id))?.status === "succeeded",
			"the stop to finish",
		);
		await until(() => headless.headlessRuntimeCount() === 0, "the child to be gone");
		// The host's report of the turn's end (failed, in the Stop's words) has reached the server and been ignored.
		await until(
			() =>
				host.sent.some(
					(r) =>
						r.path.endsWith(`/control-actions/${prompt.id}/status`) && r.body.status === "failed",
				),
			"the stopped turn's final report",
		);

		const after = await actionOf(prompt.id);
		expect(after?.status).toBe("failed");
		expect(after?.error).toBe(STOPPED_BY_PERSON_ERROR);
		expect(after?.finishedAt).toBe(pre?.finishedAt as string);
		expect((await managedOf("monitor-prompt"))?.activeControlActionId).toBeNull();
		expect((await queuePromptAction("monitor-prompt", "again", ACTOR)).actionType).toBe("prompt");
	});
});

describe("a Stop during a launched session's first turn", () => {
	test("the launch ends cancelled through the launch monitor, and the session takes a prompt again", async () => {
		const w = world();
		const supervisor = await registerSupervisor();
		const host = supervisorFor(w, supervisor);
		const sessionId = "monitor-first-turn";
		const { launchId } = await seedOwnedLaunch(sessionId, supervisor.id, { status: "claimed" });
		await getDb()
			.update(launchRequests)
			.set({ cwd: w.work, taskPrompt: "start", launchSpec: {} as never })
			.where(eq(launchRequests.id, launchId));
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchId));

		await host.dispatch(mapLaunchRequest(row as never));
		await until(async () => (await launchOf(launchId))?.status === "running", "the launch to run");
		await until(async () => Boolean(await managedOf(sessionId)), "the session's managed row");

		// The first turn is the launch: a prompt waits, a Stop does not.
		await expect(queuePromptAction(sessionId, "too soon", ACTOR)).rejects.toThrow(
			"Another control action is already in progress",
		);
		const stop = await queueStopAction(sessionId, ACTOR);
		const claimed = await claimNextControlAction(supervisor.id);
		expect(claimed?.id).toBe(stop.id);
		await host.handle(claimed as never);

		await until(
			async () => (await launchOf(launchId))?.status === "cancelled",
			"the launch to be cancelled",
		);
		await until(
			async () => (await actionOf(stop.id))?.status === "succeeded",
			"the stop to finish",
		);
		expect((await managedOf(sessionId))?.activeControlActionId).toBeNull();
		expect((await queuePromptAction(sessionId, "now", ACTOR)).actionType).toBe("prompt");
	});
});

describe("a lost final report, the supervisor still running", () => {
	test("the retry lands once the server is back: the launch leaves running and the next prompt succeeds", async () => {
		const w = world();
		const exitFile = join(w.dir, "turn-ends");
		process.env.FAKE_CLAUDE_EXIT_FILE = exitFile;
		const supervisor = await registerSupervisor();
		const host = supervisorFor(w, supervisor);
		const sessionId = "monitor-lost-final";
		const { launchId } = await seedOwnedLaunch(sessionId, supervisor.id, { status: "claimed" });
		await getDb()
			.update(launchRequests)
			.set({ cwd: w.work, taskPrompt: "start", launchSpec: {} as never })
			.where(eq(launchRequests.id, launchId));
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchId));

		await host.dispatch(mapLaunchRequest(row as never));
		await until(async () => (await launchOf(launchId))?.status === "running", "the launch to run");
		// The server becomes unreachable, then the turn ends.
		host.outage.on = true;
		writeFileSync(exitFile, "");
		await until(() => host.waits.length > 0, "the final report to fail and wait");
		expect((await launchOf(launchId))?.status).toBe("running");
		await expect(queuePromptAction(sessionId, "blocked", ACTOR)).rejects.toThrow(
			"Another control action is already in progress",
		);

		// The reconnect: the retry's wait ends and the server answers.
		host.outage.on = false;
		for (const release of host.waits.splice(0)) release();
		await until(
			async () => (await launchOf(launchId))?.status === "completed",
			"the retry to land",
		);
		expect((await queuePromptAction(sessionId, "unblocked", ACTOR)).actionType).toBe("prompt");
	});
});

describe("two failed renewals, the lock lapses, the turn lives on", () => {
	test("the next prompt is refused by the host until the turn's result; the late result replaces the lapse", async () => {
		const w = world();
		const exitFile = join(w.dir, "turn-ends");
		process.env.FAKE_CLAUDE_EXIT_FILE = exitFile;
		const supervisor = await registerSupervisor();
		const host = supervisorFor(w, supervisor);
		await seedRunningSession(supervisor.id, "monitor-lapse", w);

		const first = await queuePromptAction("monitor-lapse", "long turn", ACTOR);
		await host.handle((await claimNextControlAction(supervisor.id)) as never);
		await until(() => fakeStarts(w.log) === 1, "the turn to start");

		// Renewals fail twice (the server is unreachable), and the 90 s lock lapses meanwhile.
		host.outage.on = true;
		for (const tick of [...host.ticks]) tick();
		for (const tick of [...host.ticks]) tick();
		await Bun.sleep(20);
		host.outage.on = false;
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(managedSessions.sessionId, "monitor-lapse"));

		// The server lets a new prompt in (the lapse failed the first); the host knows the turn is still alive.
		const second = await queuePromptAction("monitor-lapse", "too early", ACTOR);
		expect((await actionOf(first.id))?.error).toBe(CONTROL_TIMEOUT_ERROR);
		await host.handle((await claimNextControlAction(supervisor.id)) as never);
		await until(async () => (await actionOf(second.id))?.status === "failed", "the host's refusal");
		expect((await actionOf(second.id))?.error).toBe(CLAUDE_TURN_RUNNING_ERROR);
		expect(fakeStarts(w.log)).toBe(1);

		// The turn's result arrives (the child exits): it replaces the lapse, and the next prompt starts.
		writeFileSync(exitFile, "");
		await until(() => headless.headlessRuntimeCount() === 0, "the turn to end");
		await until(async () => (await actionOf(first.id))?.status === "succeeded", "the late result");
		const third = await queuePromptAction("monitor-lapse", "now", ACTOR);
		await host.handle((await claimNextControlAction(supervisor.id)) as never);
		await until(() => fakeStarts(w.log) === 2, "the third prompt to start");
		expect((await actionOf(third.id))?.status).toBe("running");
	});
});

describe("a control status report must name a status", () => {
	test("none is 400, as an invalid one is, and a real one still reaches the action", async () => {
		const supervisor = await registerSupervisor();
		const post = (body: unknown) =>
			app.request(`/api/v1/supervisors/${supervisor.id}/control-actions/nope/status`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentPulse-Supervisor-Token": supervisor.credential,
				},
				body: JSON.stringify(body),
			});
		expect((await post({})).status).toBe(400);
		expect((await post({ status: "nonsense" })).status).toBe(400);
		expect((await post({ status: "running" })).status).toBe(404);
	});
});

describe("the supervisor registers again (a restart)", () => {
	test("through the route: a headless launch still running and a running Claude prompt are freed, and both sessions take a prompt", async () => {
		const w = world();
		const supervisor = await registerSupervisor();
		const first = await seedOwnedLaunch("restart-first-turn", supervisor.id, { status: "running" });
		await seedRunningSession(supervisor.id, "restart-mid-prompt", w);
		const prompt = await queuePromptAction("restart-mid-prompt", "go", ACTOR);
		expect((await claimNextControlAction(supervisor.id))?.id).toBe(prompt.id);
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "restart-first-turn",
				displayName: "restart-first-turn",
				agentType: "claude_code",
				status: "active",
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: "restart-first-turn",
				launchRequestId: first.launchId,
				supervisorId: supervisor.id,
				managedState: "headless",
			})
			.execute();
		await getDb()
			.update(sessions)
			.set({ isWorking: true, currentTurnStartedAt: new Date().toISOString() })
			.where(eq(sessions.sessionId, "restart-mid-prompt"));
		const otherHost = await seedOwnedLaunch("restart-other-host", "sup-elsewhere", {
			status: "running",
		});
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "restart-other-host",
				displayName: "restart-other-host",
				agentType: "claude_code",
				status: "active",
				isWorking: true,
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: "restart-other-host",
				launchRequestId: otherHost.launchId,
				supervisorId: "sup-elsewhere",
				managedState: "headless",
			})
			.execute();
		await expect(queuePromptAction("restart-first-turn", "a", ACTOR)).rejects.toThrow(
			"Another control action",
		);
		await expect(queuePromptAction("restart-mid-prompt", "a", ACTOR)).rejects.toThrow(
			"Another control action",
		);

		const again = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": supervisor.credential,
			},
			body: JSON.stringify({
				id: supervisor.id,
				hostName: "turn-monitor-host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: { version: 1, features: [CLAUDE_STOP, CLAUDE_TURN_CONTROL] },
			}),
		});
		expect(again.status).toBe(200);

		expect((await launchOf(first.launchId))?.status).toBe("failed");
		expect((await launchOf(first.launchId))?.error).toBe(HOST_RESTARTED_TURN_ERROR);
		expect((await actionOf(prompt.id))?.status).toBe("failed");
		// Bookkeeping only: the sessions aren't called failed, and nothing reads as working any more.
		const sessionOf = async (id: string) =>
			(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
		expect((await sessionOf("restart-first-turn"))?.status).toBe("active");
		expect((await sessionOf("restart-mid-prompt"))?.status).toBe("active");
		expect((await sessionOf("restart-mid-prompt"))?.isWorking).toBe(false);
		expect((await sessionOf("restart-mid-prompt"))?.currentTurnStartedAt).toBeNull();
		// Another host's session (a launch claimed by it) is not touched.
		expect((await launchOf(otherHost.launchId))?.status).toBe("running");
		expect((await sessionOf("restart-other-host"))?.isWorking).toBe(true);
		expect((await queuePromptAction("restart-first-turn", "a", ACTOR)).actionType).toBe("prompt");
		expect((await queuePromptAction("restart-mid-prompt", "a", ACTOR)).actionType).toBe("prompt");
	});
});

describe("registration frees launches and prompts in separate steps", () => {
	test("a failure freeing launches doesn't stop the prompts from being freed, and the registration still answers 200", async () => {
		const w = world();
		const supervisor = await registerSupervisor();
		await seedRunningSession(supervisor.id, "restart-separate", w);
		const prompt = await queuePromptAction("restart-separate", "go", ACTOR);
		await claimNextControlAction(supervisor.id);
		const dispatchModule = await import("../services/launch-dispatch.js");
		const spy = spyOn(
			dispatchModule,
			"failRunningHeadlessLaunchesOfRestartedHost",
		).mockImplementation(async () => {
			throw new Error("injected");
		});
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		try {
			const again = await app.request("/api/v1/supervisors/register", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentPulse-Supervisor-Token": supervisor.credential,
				},
				body: JSON.stringify({
					id: supervisor.id,
					hostName: "turn-monitor-host",
					platform: "linux",
					arch: "x64",
					version: "1.0.0",
					capabilities: { version: 1, features: [CLAUDE_STOP, CLAUDE_TURN_CONTROL] },
				}),
			});
			expect(again.status).toBe(200);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			quiet.mockRestore();
		}
		expect((await actionOf(prompt.id))?.status).toBe("failed");
	});
});
