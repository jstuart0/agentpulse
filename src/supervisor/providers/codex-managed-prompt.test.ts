/**
 * AGEN-91: a follow-up prompt starts a new turn on a managed Codex session's live thread.
 *
 * The launch goes through the real path against the fake `codex app-server` child (real spawn, real
 * framing, real `RpcClient`, real approval tracker). The report callbacks are the test's recorders, so the
 * order of what the supervisor reports and what it writes on the wire is asserted directly.
 *
 * Never waits on a fixed sleep for an outcome: state is polled with a deadline. The `turn/start` timeout is
 * injected short; nothing here depends on elapsed time freeing a runtime, because nothing does.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import {
	appendFileSync,
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
import {
	type Replacement,
	normaliseFollowUp,
	readOrUpdateFixture,
} from "../../shared/__fixtures__/followup-normalise.js";
import type {
	LaunchRequest,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
} from "../../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "../control-actions.js";
import { createReportGate } from "../services/report-gate.js";
import { SupervisorRequestError } from "../services/report-resilience.js";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import {
	_setSessionStartingForTest,
	launchManagedCodexRequest,
	promptManagedCodexSession,
	stopManagedCodexSession,
} from "./codex-managed.js";
import { CodexPromptWithheld } from "./codex-shared.js";

setDefaultTimeout(30_000);

const COPY = {
	busy: "Codex hasn't ended its current turn. Send this again when it ends.",
	uncertain:
		"The last prompt may still be running. Send this again after it ends, or stop the session.",
	timeout:
		"Codex didn't answer in time. The prompt may have started, so check the timeline. Prompts stay blocked until this turn ends or the session is stopped.",
	noRuntime:
		"This session's Codex process isn't running on its host any more. Start a new session for this work.",
	tooLong: "This prompt is too long to send to Codex.",
	notRecorded: "AgentPulse couldn't record this prompt, so it wasn't sent.",
	completed: "Codex finished the turn.",
	failed: "Codex turn failed.",
	interrupted: "Codex turn was interrupted.",
	unknownResult: "Codex turn ended with an unknown result.",
	closed: "The connection to Codex closed during this turn.",
	rejected: "Codex refused this prompt.",
	stopped: "This prompt wasn't sent because the session stopped.",
	notSentBusy: "This prompt wasn't sent because Codex was still busy.",
};

type Seq =
	| { kind: "state"; body: ManagedSessionStateInput }
	| { kind: "event"; event: ManagedSessionEventInput };
type Outcome = "sent" | "queued" | "excluded" | "blocked";

type Hooks = {
	onEvents?: (events: ManagedSessionEventInput[]) => Promise<unknown> | undefined;
	onState?: (body: ManagedSessionStateInput) => Promise<void> | undefined;
};

type World = {
	id: string;
	home: string;
	logPath: string;
	controlPath: string;
	pid: number;
	seq: Seq[];
	hooks: Hooks;
	callbacks: Parameters<typeof launchManagedCodexRequest>[1];
	launchResult: Awaited<ReturnType<typeof launchManagedCodexRequest>>;
};

const ENV_KEYS = [
	"HOME",
	"AGENTPULSE_CODEX_COMMAND",
	"AGENTPULSE_SERVER_URL",
	"AGENTPULSE_SUPERVISOR_DRY_RUN",
	"FAKE_CODEX_LOG",
	"FAKE_CODEX_CONTROL",
	"FAKE_CODEX_VERSION",
	"FAKE_CODEX_REQUESTS",
	"FAKE_CODEX_REQUESTS_ON_TURN",
	"FAKE_CODEX_TURN_START_ERROR",
	"FAKE_CODEX_TURN_START_SILENT",
	"FAKE_CODEX_TURN_COMPLETE_BEFORE_REPLY",
	"FAKE_CODEX_REALISTIC",
	"FAKE_CODEX_IGNORE_INTERRUPT",
];
const saved: Record<string, string | undefined> = {};
const worlds: World[] = [];
const homes: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(async () => {
	for (const world of worlds.splice(0)) {
		try {
			await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		} catch {
			// Already gone: the test stopped it, or the launch failed.
		}
	}
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(what: string, read: () => T | undefined | false, ms = 8_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

function launchRequest(id: string, over: Partial<LaunchRequest> = {}): LaunchRequest {
	return {
		id: "launch-1",
		launchCorrelationId: id,
		agentType: "codex_cli",
		cwd: "/tmp",
		baseInstructions: "",
		taskPrompt: "go",
		model: "m",
		approvalPolicy: null,
		sandboxMode: null,
		requestedLaunchMode: "managed_codex",
		env: {},
		launchSpec: {},
		status: "claimed",
		...over,
	} as unknown as LaunchRequest;
}

function prepare(knobs: Record<string, string> = {}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-codex-prompt-")));
	homes.push(home);
	const logPath = join(home, "fake.log");
	const controlPath = join(home, "control.jsonl");
	writeFileSync(controlPath, "");
	process.env.HOME = home;
	process.env.AGENTPULSE_CODEX_COMMAND = installFakeCodex(home);
	process.env.AGENTPULSE_SERVER_URL = "http://localhost:3000";
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.FAKE_CODEX_VERSION = "0.163.0";
	process.env.FAKE_CODEX_LOG = logPath;
	process.env.FAKE_CODEX_CONTROL = controlPath;
	for (const key of ENV_KEYS) if (key.startsWith("FAKE_CODEX_TURN_")) delete process.env[key];
	for (const [key, value] of Object.entries(knobs)) process.env[key] = value;
	return { home, logPath, controlPath };
}

function makeCallbacks(seq: Seq[], hooks: Hooks) {
	return {
		reportState: async (body: ManagedSessionStateInput) => {
			await hooks.onState?.(body);
			seq.push({ kind: "state", body });
			return { session: { displayName: "n" }, managedSession: {}, outcome: "sent" as const };
		},
		reportEvents: async (events: ManagedSessionEventInput[]) => {
			const outcome = hooks.onEvents ? await hooks.onEvents(events) : "sent";
			for (const event of events) seq.push({ kind: "event", event });
			return outcome;
		},
	} as unknown as Parameters<typeof launchManagedCodexRequest>[1];
}

/** Launches through the real path. `endLaunchTurn` (default) completes the launch's turn so the thread is idle. */
async function launch(
	opts: {
		knobs?: Record<string, string>;
		hooks?: Hooks;
		endLaunchTurn?: boolean;
		request?:
			| Partial<LaunchRequest>
			| ((ctx: { home: string; id: string }) => Partial<LaunchRequest>);
		/** Replaces the recording callbacks, e.g. with the real report gate. */
		callbacks?: (ctx: { home: string; id: string }) => Parameters<
			typeof launchManagedCodexRequest
		>[1];
	} = {},
): Promise<World> {
	const { home, logPath, controlPath } = prepare(opts.knobs);
	const id = crypto.randomUUID();
	const seq: Seq[] = [];
	const hooks: Hooks = opts.hooks ?? {};
	const callbacks = opts.callbacks ? opts.callbacks({ home, id }) : makeCallbacks(seq, hooks);
	const request = typeof opts.request === "function" ? opts.request({ home, id }) : opts.request;
	const launchResult = await launchManagedCodexRequest(launchRequest(id, request), callbacks);
	const world: World = {
		id,
		home,
		logPath,
		controlPath,
		pid: launchResult.pid,
		seq,
		hooks,
		callbacks,
		launchResult,
	};
	worlds.push(world);
	if (opts.endLaunchTurn !== false) {
		const before = idleReports(world).length;
		endTurn(world, "turn-1");
		await waitFor("the launch turn's idle report", () => idleReports(world).length > before);
	}
	return world;
}

let settleSeq = 0;
/**
 * Waits until the supervisor has handled everything Codex sent before this call: a sentinel agent message
 * goes down the same ordered pipe, and its event can only appear after the notifications ahead of it.
 */
async function settle(world: World) {
	const text = `settle-${++settleSeq}`;
	control(world, {
		send: {
			method: "item/completed",
			params: { threadId: "thr-1", item: { type: "agentMessage", id: text, text } },
		},
	});
	await waitFor(`the ${text} sentinel`, () =>
		events(world).some((event) => event.content === text),
	);
}

/** For after the process is gone: nothing can be sent down the pipe, so let the pending continuations run. */
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const control = (world: World, command: unknown) =>
	appendFileSync(world.controlPath, `${JSON.stringify(command)}\n`);

function endTurn(
	world: World,
	turnId: string,
	status = "completed",
	extra: Record<string, unknown> = {},
) {
	control(world, {
		send: {
			method: "turn/completed",
			params: { threadId: "thr-1", turn: { id: turnId, status, ...extra } },
		},
	});
}

const turnStarts = (world: World) =>
	readFakeLog(world.logPath).filter((entry) => entry.method === "turn/start");
const events = (world: World) =>
	world.seq.flatMap((entry) => (entry.kind === "event" ? [entry.event] : []));
const eventsOf = (world: World, ...types: string[]) =>
	events(world).filter((event) => types.includes(event.eventType));
const idleReports = (world: World) =>
	world.seq.filter((entry) => entry.kind === "state" && entry.body.status === "idle");
const prompt = (
	world: World,
	text: string,
	options?: Parameters<typeof promptManagedCodexSession>[2],
) => promptManagedCodexSession({ sessionId: world.id, prompt: text }, world.callbacks, options);

async function expectRejects(promise: Promise<unknown>, message: string) {
	const error = await promise.then(
		() => null,
		(thrown) => thrown as Error,
	);
	expect(error, `expected a rejection with "${message}"`).not.toBeNull();
	expect((error as Error).message).toBe(message);
	return error as Error;
}

/** Records the timers of a second or more that are set and not yet fired or cleared. */
function trackLongTimers() {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const live = new Set<unknown>();
	globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const handle = realSet(() => {
			live.delete(handle);
			fn(...args);
		}, ms);
		if (typeof ms === "number" && ms >= 1000) live.add(handle);
		return handle;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
		live.delete(handle);
		realClear(handle);
	}) as typeof clearTimeout;
	return {
		live,
		restore: () => {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		},
	};
}

const FOLLOW_UP_END = ["HeadlessPromptCompleted", "HeadlessPromptFailed"];

describe("an accepted follow-up", () => {
	test("sends exactly {threadId, input}, verbatim text, and returns the turn it started", async () => {
		const world = await launch();
		const framesBefore = readFakeLog(world.logPath).length;
		const text = "-rf foo\nbar  /not-a-command";
		const result = await prompt(world, text);
		expect(result.metadata).toEqual({ mode: "managed_codex", threadId: "thr-1", turnId: "turn-2" });

		const [, second] = turnStarts(world);
		expect(second?.params).toEqual({ threadId: "thr-1", input: [{ type: "text", text }] });
		expect(Object.keys(second?.params ?? {}).sort()).toEqual(["input", "threadId"]);
		expect(second?.params.input).toHaveLength(1);
		expect(Object.keys(second?.params.input[0]).sort()).toEqual(["text", "type"]);
		// Drift guard: between the call and its settle the only request on the wire is turn/start.
		const methods = readFakeLog(world.logPath)
			.slice(framesBefore)
			.flatMap((entry) => (typeof entry.method === "string" ? [entry.method] : []));
		expect(methods).toEqual(["turn/start"]);
	});

	test("a 1,000,000-character text arrives byte-equal; one more character is refused with no frame and no event", async () => {
		const world = await launch();
		const big = "x".repeat(1_000_000);
		await prompt(world, big);
		expect(turnStarts(world)[1]?.params.input[0].text).toBe(big);
		endTurn(world, "turn-2");
		await waitFor("the end event", () => eventsOf(world, ...FOLLOW_UP_END).length > 0);

		const startsBefore = turnStarts(world).length;
		const eventsBefore = events(world).length;
		await expectRejects(prompt(world, "x".repeat(1_000_001)), COPY.tooLong);
		expect(turnStarts(world)).toHaveLength(startsBefore);
		expect(events(world)).toHaveLength(eventsBefore);
	});

	test("reports the prompt before the turn/start frame is written, with no turn id on it", async () => {
		const world = await launch();
		let startsWhenReported = -1;
		world.hooks.onEvents = async (batch) => {
			if (batch[0]?.eventType === "HeadlessPromptSubmitted") {
				startsWhenReported = turnStarts(world).length;
			}
			return "sent";
		};
		await prompt(world, "do the thing");
		// Only the launch's own turn/start existed when the prompt was reported.
		expect(startsWhenReported).toBe(1);
		const [submitted] = eventsOf(world, "HeadlessPromptSubmitted");
		expect(submitted).toMatchObject({
			eventType: "HeadlessPromptSubmitted",
			category: "prompt",
			content: "do the thing",
			rawPayload: { source: "agentpulse_workspace", codexRuntime: true },
		});
		expect(JSON.stringify(submitted?.rawPayload)).not.toContain("codexTurnId");
		expect(JSON.stringify(submitted?.rawPayload)).not.toContain("turn_id");
	});

	test("the events it emits equal the committed fixture the server's tests replay", async () => {
		const world = await launch();
		const from = events(world).length;
		await prompt(world, "run the tests");
		control(world, {
			send: {
				method: "item/completed",
				params: {
					threadId: "thr-1",
					turnId: "turn-2",
					item: { type: "agentMessage", id: "item-1", text: "All tests passed." },
				},
			},
		});
		await waitFor("the agent message", () => eventsOf(world, "ManagedAgentMessage").length > 0);
		endTurn(world, "turn-2");
		await waitFor("the end event", () => eventsOf(world, ...FOLLOW_UP_END).length > 0);

		const replacements: Replacement[] = [
			[world.id, "<session>"],
			["thr-1", "<thread>"],
			["turn-2", "<turn>"],
		];
		const actual = normaliseFollowUp(events(world).slice(from), replacements);
		expect(actual).toEqual(
			readOrUpdateFixture(
				new URL("../../shared/__fixtures__/codex-followup-events.json", import.meta.url),
				actual,
			),
		);
		expect(actual.map((event) => event.eventType)).toEqual([
			"HeadlessPromptSubmitted",
			"ManagedAgentMessage",
			"HeadlessPromptCompleted",
		]);
	});
});

describe("refusals before anything is sent", () => {
	test("while the launch turn runs", async () => {
		const world = await launch({ endLaunchTurn: false });
		await expectRejects(prompt(world, "hi"), COPY.busy);
		expect(turnStarts(world)).toHaveLength(1);
		expect(eventsOf(world, "HeadlessPromptSubmitted")).toHaveLength(0);
	});

	test("in the launch's own turn/start window, before it settles (turnStarting from construction)", async () => {
		const { logPath } = prepare({ FAKE_CODEX_TURN_START_SILENT: "1" });
		const id = crypto.randomUUID();
		const seq: Seq[] = [];
		const callbacks = makeCallbacks(seq, {});
		const launching = launchManagedCodexRequest(launchRequest(id), callbacks);
		launching.catch(() => {});
		await waitFor("the launch's turn/start", () =>
			readFakeLog(logPath).some((entry) => entry.method === "turn/start"),
		);
		await expectRejects(
			promptManagedCodexSession({ sessionId: id, prompt: "hi" }, callbacks),
			COPY.busy,
		);
		expect(readFakeLog(logPath).filter((entry) => entry.method === "turn/start")).toHaveLength(1);
		await stopManagedCodexSession(id, { interruptTimeoutMs: 100 });
		await launching.then(
			() => {},
			() => {},
		);
	});

	test("two prompts at once on an idle runtime send exactly one frame", async () => {
		const world = await launch();
		const results = await Promise.allSettled([prompt(world, "one"), prompt(world, "two")]);
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect((rejected.reason as Error).message).toBe(COPY.busy);
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("during a follow-up", async () => {
		const world = await launch();
		await prompt(world, "one");
		await expectRejects(prompt(world, "two"), COPY.busy);
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("a turn/completed from another thread, or for another turn, doesn't free the runtime", async () => {
		const world = await launch();
		await prompt(world, "one");
		control(world, {
			send: {
				method: "turn/completed",
				params: { threadId: "someone-elses-thread", turn: { id: "turn-2", status: "completed" } },
			},
		});
		endTurn(world, "turn-9");
		await settle(world);
		await expectRejects(prompt(world, "two"), COPY.busy);
		expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(0);

		endTurn(world, "turn-2");
		await waitFor("the end event", () => eventsOf(world, ...FOLLOW_UP_END).length === 1);
		await prompt(world, "two");
		expect(turnStarts(world)).toHaveLength(3);
	});

	test("after the runtime is stopped: the process is gone, nothing is sent, nothing is spawned", async () => {
		const world = await launch();
		await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		const framesBefore = readFakeLog(world.logPath).length;
		await expectRejects(prompt(world, "hi"), COPY.noRuntime);
		expect(readFakeLog(world.logPath)).toHaveLength(framesBefore);
		expect(() => process.kill(world.pid, 0)).toThrow();
	});

	test("a session that was never launched here", async () => {
		await expectRejects(
			promptManagedCodexSession(
				{ sessionId: crypto.randomUUID(), prompt: "hi" },
				makeCallbacks([], {}),
			),
			COPY.noRuntime,
		);
	});
});

describe("how a turn ends", () => {
	const cases: Array<[string, string, string, string]> = [
		["completed", "HeadlessPromptCompleted", COPY.completed, "completed"],
		["failed", "HeadlessPromptFailed", COPY.failed, "failed"],
		["interrupted", "HeadlessPromptFailed", COPY.interrupted, "interrupted"],
		["something-new", "HeadlessPromptFailed", COPY.unknownResult, "something-new"],
	];
	for (const [status, eventType, words, payloadStatus] of cases) {
		test(`${status} -> exactly one ${eventType} saying "${words}", then one idle report`, async () => {
			const world = await launch();
			await prompt(world, "go");
			const idleBefore = idleReports(world).length;
			endTurn(world, "turn-2", status);
			await waitFor("the idle report", () => idleReports(world).length > idleBefore);

			const ends = eventsOf(world, ...FOLLOW_UP_END);
			expect(ends).toHaveLength(1);
			expect(ends[0]).toMatchObject({
				eventType,
				content: words,
				rawPayload: { codexTurnId: "turn-2", status: payloadStatus, codexRuntime: true },
			});
			expect(JSON.stringify(ends[0])).not.toContain("turn_id");
			// The end event comes before the report that says the session is idle.
			const endAt = world.seq.findIndex(
				(entry) => entry.kind === "event" && entry.event === ends[0],
			);
			const idleAt = world.seq.indexOf(idleReports(world).at(-1) as Seq);
			expect(endAt).toBeLessThan(idleAt);
		});
	}

	test("a turn's error text never reaches an event; the host log gets 300 characters of it, no control characters", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const world = await launch();
			await prompt(world, "go");
			const message = `quota-exceeded\u0007\u001b[31m${"z".repeat(600)}`;
			endTurn(world, "turn-2", "failed", { error: { message } });
			await waitFor("the end event", () => eventsOf(world, ...FOLLOW_UP_END).length === 1);
			expect(JSON.stringify(events(world))).not.toContain("quota-exceeded");

			const logged = errorSpy.mock.calls
				.map((call) => call.map(String).join(" "))
				.find((line) => line.includes("quota-exceeded"));
			expect(logged, "the host log has the reason").toBeDefined();
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone
			expect(logged).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
			expect(logged).not.toContain("z".repeat(301));
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("a failing end event is logged and the idle report is still sent", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const world = await launch();
			await prompt(world, "go");
			const idleBefore = idleReports(world).length;
			world.hooks.onEvents = async (batch) => {
				if (FOLLOW_UP_END.includes(batch[0]?.eventType ?? ""))
					throw new Error("server unreachable");
				return "sent";
			};
			endTurn(world, "turn-2");
			await waitFor("the idle report", () => idleReports(world).length > idleBefore);
			expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(0);
			world.hooks.onEvents = undefined;
			await prompt(world, "next");
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("a turn/completed whose status is inProgress ends nothing: no clears, no event, no idle report, one log line", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const world = await launch();
			await prompt(world, "go");
			const idleBefore = idleReports(world).length;
			endTurn(world, "turn-2", "inProgress");
			await settle(world);
			expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(0);
			expect(idleReports(world).length).toBe(idleBefore);
			// Still busy: the turn is still running as far as we know.
			await expectRejects(prompt(world, "again"), COPY.busy);
			const logged = errorSpy.mock.calls
				.map((call) => call.map(String).join(" "))
				.filter((line) => line.includes("turn/completed") && line.includes("inProgress"));
			expect(logged).toHaveLength(1);

			// The real end afterwards still ends the turn once (positive control).
			endTurn(world, "turn-2", "completed");
			await waitFor("the idle report", () => idleReports(world).length > idleBefore);
			expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("a repeated turn/completed for a turn that already ended changes nothing", async () => {
		const world = await launch();
		await prompt(world, "go");
		const idleBefore = idleReports(world).length;
		endTurn(world, "turn-2");
		await waitFor("the idle report", () => idleReports(world).length === idleBefore + 1);
		endTurn(world, "turn-2");
		await settle(world);
		expect(idleReports(world).length).toBe(idleBefore + 1);
		expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(1);
	});

	test("a request raised during a follow-up leaves the runtime busy", async () => {
		const world = await launch({
			knobs: {
				FAKE_CODEX_REQUESTS_ON_TURN: "2",
				FAKE_CODEX_REQUESTS: JSON.stringify([
					{ method: "item/commandExecution/requestApproval", params: { command: "touch x" } },
				]),
			},
		});
		await prompt(world, "go");
		await waitFor("the approval request to be answered", () =>
			readFakeLog(world.logPath).some((entry) => entry.answer),
		);
		await expectRejects(prompt(world, "again"), COPY.busy);
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("the launch turn's completion emits no boundary event but still reports idle", async () => {
		const world = await launch({ endLaunchTurn: false });
		endTurn(world, "turn-1");
		await waitFor("the idle report", () => idleReports(world).length === 1);
		expect(eventsOf(world, "HeadlessPromptSubmitted", ...FOLLOW_UP_END)).toHaveLength(0);
		expect(idleReports(world)[0]).toMatchObject({ body: { managedState: "managed" } });
	});

	test("a turn that completes before its reply: one end event, one idle report, and the runtime isn't stuck busy", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_COMPLETE_BEFORE_REPLY: "2" } });
		const idleBefore = idleReports(world).length;
		await prompt(world, "quick");
		await waitFor("the idle report", () => idleReports(world).length > idleBefore);
		await settle(world);
		expect(eventsOf(world, ...FOLLOW_UP_END)).toHaveLength(1);
		expect(idleReports(world).length - idleBefore).toBe(1);
		await prompt(world, "next");
		expect(turnStarts(world)).toHaveLength(3);
	});

	test("the launch turn completing before its reply sends its idle report and leaves the runtime usable", async () => {
		const world = await launch({
			knobs: { FAKE_CODEX_TURN_COMPLETE_BEFORE_REPLY: "1" },
			endLaunchTurn: false,
		});
		await waitFor("the launch turn's idle report", () => idleReports(world).length >= 1);
		await prompt(world, "after");
		expect(turnStarts(world)).toHaveLength(2);
	});
});

describe("when Codex says no, or says nothing", () => {
	test("a JSON-RPC error: one Failed, the flags are undone and the next prompt is accepted", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_ERROR: "2" } });
		await expectRejects(prompt(world, "refused"), COPY.rejected);
		const failed = eventsOf(world, "HeadlessPromptFailed");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.content).toBe(COPY.rejected);
		await prompt(world, "again");
		expect(turnStarts(world)).toHaveLength(3);
	});

	test("an accepted-but-silent turn: the timeout copy, no Failed, and nothing releases it by time", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
		await expectRejects(prompt(world, "silent", { turnStartTimeoutMs: 60 }), COPY.timeout);
		expect(eventsOf(world, "HeadlessPromptFailed")).toHaveLength(0);

		// Ten minutes later by every clock the code could read: still blocked, still nothing sent.
		setSystemTime(new Date(Date.now() + 10 * 60_000));
		try {
			await expectRejects(prompt(world, "retry"), COPY.uncertain);
		} finally {
			setSystemTime();
		}
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("no timer is left behind by the uncertain state once the session stops", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
		const timers = trackLongTimers();
		try {
			await expectRejects(prompt(world, "silent", { turnStartTimeoutMs: 60 }), COPY.timeout);
			await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
			expect([...timers.live], "timers of a second or more still pending").toEqual([]);
		} finally {
			timers.restore();
		}
	});

	test("a reply with no usable turn id is the same as a timeout", async () => {
		for (const result of [{}, { turn: {} }, { turn: { id: "" } }, { turn: { id: 7 } }]) {
			const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
			const pending = prompt(world, "odd");
			const second = await waitFor("the second turn/start", () => turnStarts(world)[1]);
			control(world, { send: { id: second.id, result } });
			await expectRejects(pending, COPY.timeout);
			await expectRejects(prompt(world, "retry"), COPY.uncertain);
			await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		}
	});

	test("way out 1: a late turn/started then turn/completed gives one end event and frees the runtime", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
		await expectRejects(prompt(world, "silent", { turnStartTimeoutMs: 60 }), COPY.timeout);
		control(world, {
			send: { method: "turn/started", params: { threadId: "thr-1", turn: { id: "turn-2" } } },
		});
		await settle(world);
		// Started clears "uncertain", but the turn is now known and running.
		await expectRejects(prompt(world, "retry"), COPY.busy);
		endTurn(world, "turn-2");
		await waitFor("the end event", () => eventsOf(world, ...FOLLOW_UP_END).length === 1);
		expect(eventsOf(world, ...FOLLOW_UP_END)[0]?.eventType).toBe("HeadlessPromptCompleted");
		await prompt(world, "free");
		expect(turnStarts(world)).toHaveLength(3);
	});

	test("way out 2: the channel closing gives Failed with the closed words", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
		await expectRejects(prompt(world, "silent", { turnStartTimeoutMs: 60 }), COPY.timeout);
		control(world, { exit: 1 });
		await waitFor("Failed", () => eventsOf(world, "HeadlessPromptFailed").length === 1);
		expect(eventsOf(world, "HeadlessPromptFailed")[0]?.content).toBe(COPY.closed);
	});

	test("way out 3: Stop, through the real handler, end to end", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_TURN_START_SILENT: "2" } });
		await expectRejects(prompt(world, "silent", { turnStartTimeoutMs: 60 }), COPY.timeout);
		const idleBefore = idleReports(world).length;

		const posted: Array<{ path: string; body: any }> = [];
		const gate = createReportGate({
			request: async (path: string, options?: RequestInit) => {
				posted.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
				return { session: { displayName: "n" }, managedSession: {}, events: [] };
			},
			supervisorId: "sup-1",
			home: world.home,
			now: () => 0,
			log: () => {},
		} as never);
		mkdirSync(join(world.home, ".agentpulse"), { recursive: true, mode: 0o700 });
		chmodSync(join(world.home, ".agentpulse"), 0o700);
		const handle = createControlActionHandler({
			gate,
			trustedRoots: [world.home],
			providers: {
				stopManagedCodexSession,
				promptManagedCodexSession,
				hasManagedCodexRuntime: () => false,
			} as unknown as ControlProviders,
			executeCleanupWorkArea: (async () => ({})) as never,
			log: () => {},
		});
		await handle({
			id: "stop-1",
			sessionId: world.id,
			launchRequestId: null,
			actionType: "stop",
			requestedBy: null,
			status: "claimed",
			error: null,
			metadata: null,
		} as never);

		const status = posted.find((p) => p.path.endsWith("/control-actions/stop-1/status"));
		expect(status?.body).toEqual({ status: "succeeded" });
		expect(
			posted.some(
				(p) => p.path.includes("managed-session-state") && p.body.managedState === "stopped",
			),
		).toBe(true);
		await waitFor("the process to exit", () => {
			try {
				process.kill(world.pid, 0);
				return false;
			} catch {
				return true;
			}
		});
		await flush();
		expect(idleReports(world)).toHaveLength(idleBefore);
		expect(eventsOf(world, "HeadlessPromptFailed")).toHaveLength(0);
		await expectRejects(prompt(world, "after"), COPY.noRuntime);
		// No turn was known to be active, so there was nothing to interrupt.
		expect(readFakeLog(world.logPath).some((entry) => entry.method === "turn/interrupt")).toBe(
			false,
		);
	});
});

describe("the channel closing", () => {
	test("with a follow-up running: degraded + idle, then Failed with the closed words", async () => {
		const world = await launch();
		await prompt(world, "go");
		const from = world.seq.length;
		control(world, { exit: 1 });
		await waitFor("Failed", () => eventsOf(world, "HeadlessPromptFailed").length === 1);
		const after = world.seq.slice(from);
		const degradedAt = after.findIndex(
			(entry) =>
				entry.kind === "state" &&
				entry.body.managedState === "degraded" &&
				entry.body.status === "idle",
		);
		const failedAt = after.findIndex(
			(entry) => entry.kind === "event" && entry.event.eventType === "HeadlessPromptFailed",
		);
		expect(degradedAt).toBeGreaterThanOrEqual(0);
		expect(failedAt).toBeGreaterThan(degradedAt);
		expect(eventsOf(world, "HeadlessPromptFailed")[0]).toMatchObject({
			content: COPY.closed,
			rawPayload: { codexRuntime: true },
		});
	});

	test("with no follow-up: degraded + idle and no event", async () => {
		const world = await launch();
		control(world, { exit: 1 });
		await waitFor("the degraded report", () =>
			world.seq.some((e) => e.kind === "state" && e.body.managedState === "degraded"),
		);
		const degraded = world.seq.find(
			(e) => e.kind === "state" && e.body.managedState === "degraded",
		) as Extract<Seq, { kind: "state" }>;
		expect(degraded.body.status).toBe("idle");
		await flush();
		expect(eventsOf(world, "HeadlessPromptFailed", "HeadlessPromptCompleted")).toHaveLength(0);
	});

	test("a planned stop reports no degraded state and no event", async () => {
		const world = await launch();
		await prompt(world, "go");
		await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		await flush();
		expect(
			world.seq.filter((e) => e.kind === "state" && e.body.managedState === "degraded"),
		).toHaveLength(0);
		expect(eventsOf(world, "HeadlessPromptFailed")).toHaveLength(0);
	});
});

describe("what the report gate says about the prompt event", () => {
	for (const outcome of ["excluded", "blocked"] as const) {
		test(`${outcome}: no frame, CodexPromptWithheld, and the flags are undone`, async () => {
			const world = await launch();
			world.hooks.onEvents = async () => outcome;
			const error = await prompt(world, "secret").then(
				() => null,
				(thrown) => thrown,
			);
			expect(error).toBeInstanceOf(CodexPromptWithheld);
			expect(turnStarts(world)).toHaveLength(1);

			world.hooks.onEvents = undefined;
			await prompt(world, "fine");
			expect(turnStarts(world)).toHaveLength(2);
		});
	}

	for (const outcome of [undefined, "weird"]) {
		test(`an outcome of ${String(outcome)} is not a recorded prompt: withheld, no frame`, async () => {
			const world = await launch();
			world.hooks.onEvents = async () => outcome;
			const error = await prompt(world, "x").then(
				() => null,
				(thrown) => thrown,
			);
			expect(error).toBeInstanceOf(CodexPromptWithheld);
			expect(turnStarts(world)).toHaveLength(1);
		});
	}

	test("a Codex turn starting while the prompt is being recorded: nothing is sent, one Failed, busy", async () => {
		const world = await launch();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		world.hooks.onEvents = async (batch) => {
			if (batch[0]?.eventType === "HeadlessPromptSubmitted") {
				reached = true;
				await held;
			}
			return "sent";
		};
		const pending = prompt(world, "x");
		pending.catch(() => {});
		await waitFor("the report to be in flight", () => reached);
		control(world, {
			send: { method: "turn/started", params: { threadId: "thr-1", turn: { id: "turn-77" } } },
		});
		await settle(world);
		release();
		await expectRejects(pending, COPY.busy);
		expect(turnStarts(world)).toHaveLength(1);
		const failed = eventsOf(world, "HeadlessPromptFailed");
		expect(failed.map((event) => event.content)).toEqual([COPY.notSentBusy]);
	});

	test("the not-recorded undo sends no idle report when a stop began meanwhile", async () => {
		const world = await launch();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		world.hooks.onEvents = async () => {
			reached = true;
			await held;
			throw new Error("unreachable");
		};
		const idleBefore = idleReports(world).length;
		const pending = prompt(world, "x");
		pending.catch(() => {});
		await waitFor("the report to be in flight", () => reached);
		await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		release();
		await expectRejects(pending, COPY.notRecorded);
		await flush();
		expect(idleReports(world).length).toBe(idleBefore);
	});

	test("an unplanned close during a stop's interrupt window reports no degraded state", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_IGNORE_INTERRUPT: "1" } });
		await prompt(world, "go");
		const stopping = stopManagedCodexSession(world.id, { interruptTimeoutMs: 600 });
		await waitFor("the interrupt", () =>
			readFakeLog(world.logPath).some((entry) => entry.method === "turn/interrupt"),
		);
		control(world, { exit: 1 });
		await waitFor("Failed", () => eventsOf(world, "HeadlessPromptFailed").length === 1);
		await stopping;
		expect(
			world.seq.filter((e) => e.kind === "state" && e.body.managedState === "degraded"),
		).toEqual([]);
	});

	test("queued proceeds", async () => {
		const world = await launch();
		world.hooks.onEvents = async () => "queued" as const;
		await prompt(world, "later");
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("a throw: no frame, the not-recorded error (not a withheld), and exactly one idle report", async () => {
		const world = await launch();
		const idleBefore = idleReports(world).length;
		world.hooks.onEvents = async () => {
			throw new Error("413 body too large");
		};
		const error = await expectRejects(prompt(world, "x"), COPY.notRecorded);
		expect(error).not.toBeInstanceOf(CodexPromptWithheld);
		expect(turnStarts(world)).toHaveLength(1);
		expect(idleReports(world).length - idleBefore).toBe(1);

		world.hooks.onEvents = undefined;
		await prompt(world, "after");
		expect(turnStarts(world)).toHaveLength(2);
	});

	test("a throw, and the idle report throws too: still the not-recorded error, nothing propagates", async () => {
		const world = await launch();
		world.hooks.onEvents = async () => {
			throw new Error("unreachable");
		};
		world.hooks.onState = async () => {
			throw new Error("unreachable");
		};
		await expectRejects(prompt(world, "x"), COPY.notRecorded);
		expect(turnStarts(world)).toHaveLength(1);
	});

	test("Stop during that report: no frame, exactly one Failed saying the session stopped", async () => {
		const world = await launch();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		world.hooks.onEvents = async (batch) => {
			if (batch[0]?.eventType !== "HeadlessPromptSubmitted") return "sent";
			reached = true;
			await held;
			return "sent";
		};
		const pending = prompt(world, "x");
		pending.catch(() => {});
		await waitFor("the report to be in flight", () => reached);
		await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		release();
		await expectRejects(pending, COPY.noRuntime);
		expect(turnStarts(world)).toHaveLength(1);
		const failed = eventsOf(world, "HeadlessPromptFailed");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.content).toBe(COPY.stopped);
	});

	test("during a stop's interrupt window: new prompts are refused as gone, and a turn ending then sends no idle report", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_IGNORE_INTERRUPT: "1" } });
		await prompt(world, "go");
		const idleBefore = idleReports(world).length;
		const stopping = stopManagedCodexSession(world.id, { interruptTimeoutMs: 600 });
		await waitFor("the interrupt", () =>
			readFakeLog(world.logPath).some((entry) => entry.method === "turn/interrupt"),
		);
		// Not "busy": the session is going away, and the person should be told so.
		await expectRejects(prompt(world, "too late"), COPY.noRuntime);
		endTurn(world, "turn-2");
		await settle(world);
		await stopping;
		expect(idleReports(world).length).toBe(idleBefore);
	});

	test("Stop while the end event is being reported: no idle report follows", async () => {
		const world = await launch();
		await prompt(world, "go");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		world.hooks.onEvents = async (batch) => {
			if (!FOLLOW_UP_END.includes(batch[0]?.eventType ?? "")) return "sent";
			reached = true;
			await held;
			return "sent";
		};
		const idleBefore = idleReports(world).length;
		endTurn(world, "turn-2");
		await waitFor("the end event to be in flight", () => reached);
		await stopManagedCodexSession(world.id, { interruptTimeoutMs: 100 });
		release();
		await flush();
		expect(idleReports(world).length).toBe(idleBefore);
	});

	test("a new turn begins while the end event is being reported: turn A sends no idle report", async () => {
		const world = await launch();
		await prompt(world, "A");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		world.hooks.onEvents = async (batch) => {
			if (!FOLLOW_UP_END.includes(batch[0]?.eventType ?? "")) return "sent";
			reached = true;
			await held;
			return "sent";
		};
		const idleBefore = idleReports(world).length;
		endTurn(world, "turn-2");
		await waitFor("the end event to be in flight", () => reached);
		world.hooks.onEvents = undefined;
		await prompt(world, "B");
		release();
		await settle(world);
		expect(idleReports(world).length).toBe(idleBefore);
		await expectRejects(prompt(world, "C"), COPY.busy);
	});
});

describe("with the real report gate behind the callbacks", () => {
	const gateWorld = () => {
		const posted: Array<{ path: string; body: any }> = [];
		let gate: ReturnType<typeof createReportGate>;
		const workOf = (home: string) => join(home, "work");
		const launching = launch({
			endLaunchTurn: false,
			request: ({ home }) => ({ cwd: workOf(home) }),
			callbacks: ({ home, id }) => {
				mkdirSync(workOf(home), { recursive: true });
				mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
				chmodSync(join(home, ".agentpulse"), 0o700);
				gate = createReportGate({
					request: async (path: string, options?: RequestInit) => {
						const text = options?.body ? String(options.body) : "";
						// The server's own body limit.
						if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
							throw new SupervisorRequestError(413, "Payload Too Large", "payload_too_large");
						}
						posted.push({ path, body: text ? JSON.parse(text) : {} });
						return { session: { displayName: "n" }, managedSession: {}, events: [] };
					},
					supervisorId: "sup-1",
					home,
					now: () => 0,
					log: () => {},
				} as never);
				gate.noteLaunch("launch-1", id, workOf(home));
				return {
					reportState: (body: ManagedSessionStateInput) => gate.reportState(body),
					reportEvents: (batch: ManagedSessionEventInput[]) => gate.reportEvents(id, batch),
				} as never;
			},
		});
		const idleSent = () =>
			posted.filter((p) => p.path.endsWith("/managed-session-state") && p.body.status === "idle");
		return { posted, idleSent, workOf, launching };
	};

	test("a really excluded session: the prompt is withheld, nothing is sent, and its text never leaves", async () => {
		const g = gateWorld();
		const world = await g.launching;
		endTurn(world, "turn-1");
		await waitFor("the launch turn's idle report", () => g.idleSent().length > 0);

		const rules = join(world.home, ".agentpulse", "exclude");
		writeFileSync(rules, `${g.workOf(world.home)}\n`, { mode: 0o600 });
		chmodSync(rules, 0o600);
		utimesSync(rules, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));

		const error = await prompt(world, "EXCLUDED-SECRET").then(
			() => null,
			(thrown) => thrown,
		);
		expect(error).toBeInstanceOf(CodexPromptWithheld);
		expect(turnStarts(world)).toHaveLength(1);
		expect(JSON.stringify(g.posted)).not.toContain("EXCLUDED-SECRET");
	});

	test("an over-limit multibyte prompt gets a real 413: not recorded, nothing sent, one idle report", async () => {
		const g = gateWorld();
		const world = await g.launching;
		endTurn(world, "turn-1");
		await waitFor("the launch turn's idle report", () => g.idleSent().length > 0);
		const idleBefore = g.idleSent().length;

		// Under the 1,000,000-character cap, about 3 MB as UTF-8: over the server's 2 MiB body limit.
		const error = await expectRejects(prompt(world, "字".repeat(1_000_000)), COPY.notRecorded);
		expect(error).not.toBeInstanceOf(CodexPromptWithheld);
		expect(turnStarts(world)).toHaveLength(1);
		expect(g.idleSent().length - idleBefore).toBe(1);
	});
});

describe("launching", () => {
	test("the real start event carries codexRuntime; a dry run does not", async () => {
		const world = await launch({ endLaunchTurn: false });
		const [start] = eventsOf(world, "ManagedSessionStart");
		expect(start?.rawPayload).toMatchObject({ threadId: "thr-1", codexRuntime: true });

		prepare();
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		const seq: Seq[] = [];
		await launchManagedCodexRequest(launchRequest(crypto.randomUUID()), makeCallbacks(seq, {}));
		const dryStart = seq.flatMap((e) => (e.kind === "event" ? [e.event] : []))[0];
		expect(dryStart?.eventType).toBe("ManagedSessionStart");
		expect(JSON.stringify(dryStart?.rawPayload)).not.toContain("codexRuntime");
	});

	test("a launch that throws after its start event reports degraded + idle, and a failing report doesn't mask the error", async () => {
		const { home } = prepare({ FAKE_CODEX_TURN_START_ERROR: "1" });
		expect(home).toBeTruthy();
		const seq: Seq[] = [];
		const hooks: Hooks = {};
		const callbacks = makeCallbacks(seq, hooks);
		await expect(
			launchManagedCodexRequest(launchRequest(crypto.randomUUID()), callbacks),
		).rejects.toThrow(/turn refused/);
		const startAt = seq.findIndex(
			(e) => e.kind === "event" && e.event.eventType === "ManagedSessionStart",
		);
		const degradedAt = seq.findIndex(
			(e) => e.kind === "state" && e.body.managedState === "degraded" && e.body.status === "idle",
		);
		expect(startAt).toBeGreaterThanOrEqual(0);
		expect(degradedAt).toBeGreaterThan(startAt);

		// Now the report itself fails: the launch error is still the one that surfaces.
		prepare({ FAKE_CODEX_TURN_START_ERROR: "1" });
		let degradedReportsAttempted = 0;
		const failing = makeCallbacks([], {
			onState: async (body) => {
				if (body.managedState === "degraded") {
					degradedReportsAttempted += 1;
					throw new Error("report failed");
				}
			},
		});
		await expect(
			launchManagedCodexRequest(launchRequest(crypto.randomUUID()), failing),
		).rejects.toThrow(/turn refused/);
		expect(degradedReportsAttempted, "the failing report was really tried").toBeGreaterThan(0);
	});
});

describe("a prompt for a session this host holds no runtime for reports it once (AGEN-115)", () => {
	const degradedReports = (seq: Seq[]) =>
		seq.filter(
			(entry): entry is Extract<Seq, { kind: "state" }> =>
				entry.kind === "state" && entry.body.managedState === "degraded",
		);

	test("the host reports degraded and idle with the connection-lost error, BEFORE the refusal", async () => {
		const seq: Seq[] = [];
		const id = crypto.randomUUID();
		let refusedAfter = -1;
		await promptManagedCodexSession({ sessionId: id, prompt: "hi" }, makeCallbacks(seq, {})).catch(
			() => {
				refusedAfter = seq.length;
			},
		);
		const reports = degradedReports(seq);
		expect(reports).toHaveLength(1);
		expect(reports[0].body).toMatchObject({
			sessionId: id,
			managedState: "degraded",
			status: "idle",
			providerSyncState: "failed",
		});
		expect(typeof reports[0].body.providerSyncError).toBe("string");
		expect(refusedAfter).toBe(1);
	});

	test("nothing is reported while a launch or a resume for the id is still starting", async () => {
		const seq: Seq[] = [];
		const id = crypto.randomUUID();
		_setSessionStartingForTest(id, true);
		try {
			await expectRejects(
				promptManagedCodexSession({ sessionId: id, prompt: "hi" }, makeCallbacks(seq, {})),
				COPY.noRuntime,
			);
		} finally {
			_setSessionStartingForTest(id, false);
		}
		expect(seq).toEqual([]);
	});

	test("a runtime that is stopping is refused as gone with no report, and neither does the Stop itself make one", async () => {
		const world = await launch({ knobs: { FAKE_CODEX_IGNORE_INTERRUPT: "1" } });
		await prompt(world, "go");
		const stopping = stopManagedCodexSession(world.id, { interruptTimeoutMs: 600 });
		await waitFor("the interrupt", () =>
			readFakeLog(world.logPath).some((entry) => entry.method === "turn/interrupt"),
		);
		await expectRejects(prompt(world, "too late"), COPY.noRuntime);
		await stopping;
		expect(degradedReports(world.seq)).toEqual([]);
	});
});
