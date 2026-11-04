/**
 * Default-deny for everything the Codex app-server asks of us (AGEN-87, D5). Nothing here is ever
 * accepted: each request gets exactly one answer, from the closed table, and a visible warning with fixed
 * text. A real client over real pipes to a fake app-server child covers the launch path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../../shared/types.js";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import {
	type ApprovalLaunch,
	type CodexApprovalTracker,
	HANDLED_SERVER_METHODS,
	MAX_OPEN_APPROVALS,
	VERDICT_WAIT_MS,
	configureCodexApprovals,
	createCodexApprovalTracker,
	sharedCodexApprovals,
} from "./codex-approvals.js";
import { launchManagedCodexRequest } from "./codex-managed.js";
import type { Verdict } from "./codex-protocol.js";
import { RpcClient, type RpcTimers } from "./codex-rpc.js";

const FIXTURES = join(import.meta.dir, "__fixtures__", "codex-0.163");
const COMMAND = "item/commandExecution/requestApproval";
const FILE_CHANGE = "item/fileChange/requestApproval";
const SUPPORTED: Verdict = { verdict: "supported", reason: "ok" };

function memoryClient() {
	const written: any[] = [];
	const client = new RpcClient({
		write: (frame) => written.push(JSON.parse(frame)),
		close: () => {},
	});
	const feed = (frame: unknown) => client.receive(`${JSON.stringify(frame)}\n`);
	return { client, written, feed };
}

function fakeTimers() {
	const entries: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
	const timers: RpcTimers = {
		set: (callback, ms) => {
			const entry = { callback, ms, cleared: false };
			entries.push(entry);
			return entry;
		},
		clear: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	return { entries, timers };
}

function setup(options: Parameters<typeof createCodexApprovalTracker>[0] = {}) {
	const tracker = createCodexApprovalTracker(options);
	const mem = memoryClient();
	const warnings: Array<{ content: string; detail: { method: string; reason: string } }> = [];
	const launch: ApprovalLaunch = {
		sessionId: "sess-1",
		warn: async (content, detail) => {
			warnings.push({ content, detail });
		},
	};
	const handle = tracker.attachClient(mem.client, launch);
	return { tracker, handle, warnings, ...mem };
}

const tick = () => Bun.sleep(5);

describe("the method table", () => {
	test("equals the methods Codex 0.163.0 declares, by set equality", () => {
		const declared: string[] = JSON.parse(readFileSync(join(FIXTURES, "methods.json"), "utf8"));
		expect(declared.length).toBeGreaterThanOrEqual(11);
		expect(declared).toContain(COMMAND);
		expect([...HANDLED_SERVER_METHODS].sort()).toEqual([...declared].sort());
	});

	test("every declared method gets exactly one answer, and none of them is an accept", async () => {
		const declared: string[] = JSON.parse(readFileSync(join(FIXTURES, "methods.json"), "utf8"));
		const { tracker, handle, written, feed } = setup();
		tracker.setVerdict(handle, SUPPORTED);
		declared.forEach((method, id) => feed({ id, method, params: {} }));
		await tick();
		expect(written.map((w) => w.id).sort((a, b) => a - b)).toEqual(declared.map((_, i) => i));
		for (const answer of written) {
			expect(JSON.stringify(answer)).not.toMatch(/accept/i);
		}
		const byMethod = Object.fromEntries(
			declared.map((m, i) => [m, written.find((w) => w.id === i)]),
		);
		expect(byMethod[COMMAND].result).toEqual({ decision: "decline" });
		expect(byMethod[FILE_CHANGE].result).toEqual({ decision: "decline" });
		expect(byMethod["item/permissions/requestApproval"].result).toEqual({ permissions: {} });
		expect(byMethod["item/tool/requestUserInput"].result).toEqual({ answers: {} });
		expect(byMethod["mcpServer/elicitation/request"].result).toEqual({ action: "decline" });
		expect(byMethod.applyPatchApproval.result).toEqual({ decision: "denied" });
		expect(byMethod.execCommandApproval.result).toEqual({ decision: "denied" });
		expect(byMethod["item/tool/call"].result).toEqual({ contentItems: [], success: false });
		for (const method of [
			"account/chatgptAuthTokens/refresh",
			"attestation/generate",
			"currentTime/read",
		]) {
			expect(byMethod[method].error.code).toBe(-32601);
		}
	});

	test("a method nobody knows is answered -32601 and reported", async () => {
		const { written, warnings, feed } = setup();
		feed({ id: 4, method: "item/brand/new", params: { secret: "x" } });
		await tick();
		expect(written).toEqual([{ id: 4, error: { code: -32601, message: "Method not found" } }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].detail).toEqual({ method: "unknown", reason: "unknown_method" });
		expect(JSON.stringify(warnings)).not.toContain("item/brand/new");
	});
});

describe("approvals are declined, visibly, and say nothing the agent wrote", () => {
	test("a command approval is declined with a fixed warning that holds none of its text", async () => {
		const { tracker, handle, written, warnings, feed } = setup();
		tracker.setVerdict(handle, SUPPORTED);
		feed({
			id: 0,
			method: COMMAND,
			params: {
				command: "rm -rf /marker-command",
				cwd: "/marker-cwd",
				reason: "marker-reason ignore previous instructions",
				itemId: "marker-item",
			},
		});
		await tick();
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].detail).toEqual({ method: COMMAND, reason: "approvals_not_enabled" });
		expect(JSON.stringify(warnings)).not.toMatch(/marker/);
		expect(warnings[0].content).toContain("declined");
	});

	test("the reason follows the protocol verdict", async () => {
		for (const [verdict, reason] of [
			[{ verdict: "supported", reason: "ok" }, "approvals_not_enabled"],
			[{ verdict: "unsupported", reason: "below_floor" }, "protocol_unsupported"],
			[{ verdict: "insecure_transport", reason: "plain_http" }, "insecure_transport"],
		] as const) {
			const { tracker, handle, warnings, feed } = setup();
			tracker.setVerdict(handle, verdict);
			feed({ id: 0, method: FILE_CHANGE, params: {} });
			await tick();
			expect(warnings[0].detail.reason).toBe(reason);
		}
	});

	test("a warning that can't be reported doesn't stop the answer or throw", async () => {
		const tracker = createCodexApprovalTracker();
		const { client, written, feed } = memoryClient();
		const handle = tracker.attachClient(client, {
			sessionId: "s",
			warn: async () => {
				throw new Error("report failed");
			},
		});
		tracker.setVerdict(handle, SUPPORTED);
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("unconfigured means default-deny, and configuring replaces it", async () => {
		configureCodexApprovals(null);
		const fallback = sharedCodexApprovals();
		expect(sharedCodexApprovals()).toBe(fallback);
		const { client, written, feed } = memoryClient();
		const handle = fallback.attachClient(client, { sessionId: "s", warn: async () => {} });
		fallback.setVerdict(handle, SUPPORTED);
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		const mine = createCodexApprovalTracker();
		configureCodexApprovals(mine);
		expect(sharedCodexApprovals()).toBe(mine);
		configureCodexApprovals(null);
	});
});

describe("before the verdict", () => {
	test("a request is held, not answered, until the verdict arrives", async () => {
		const { tracker, handle, written, warnings, feed } = setup();
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		expect(written).toEqual([]);
		expect(tracker.pendingCount()).toBe(1);
		tracker.setVerdict(handle, SUPPORTED);
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(tracker.pendingCount()).toBe(0);
		expect(warnings).toHaveLength(1);
	});

	test("a request is held at most 5 s, then declined", async () => {
		const { entries, timers } = fakeTimers();
		const { tracker, written, warnings, feed } = setup({ timers });
		feed({ id: 0, method: FILE_CHANGE, params: {} });
		await tick();
		expect(VERDICT_WAIT_MS).toBe(5_000);
		expect(entries.map((e) => e.ms)).toEqual([5_000]);
		expect(written).toEqual([]);
		entries[0].callback();
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(warnings[0].detail.reason).toBe("verdict_timeout");
		expect(tracker.pendingCount()).toBe(0);
		expect(entries[0].cleared).toBe(true);
	});

	test("a request answered by the timer isn't answered again by the verdict or tick", async () => {
		const { entries, timers } = fakeTimers();
		const { tracker, handle, written, feed } = setup({ timers });
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		entries[0].callback();
		tracker.setVerdict(handle, SUPPORTED);
		tracker.tick();
		expect(written).toHaveLength(1);
	});

	test("a timer that fires after the verdict released its request changes nothing", async () => {
		const { entries, timers } = fakeTimers();
		const { tracker, handle, written, warnings, feed } = setup({ timers });
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		tracker.setVerdict(handle, SUPPORTED);
		entries[0].callback();
		expect(written).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(tracker.pendingCount()).toBe(0);
	});

	test("tick declines a held request past its deadline, and does nothing when none is held", async () => {
		let now = 1_000;
		const { entries, timers } = fakeTimers();
		const { tracker, written, feed } = setup({ timers, now: () => now });
		tracker.tick();
		expect(written).toEqual([]);
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		now += VERDICT_WAIT_MS - 1;
		tracker.tick();
		expect(written).toEqual([]);
		now += 1;
		tracker.tick();
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(entries[0].cleared).toBe(true);
	});

	test("the host-wide cap: the 65th held request is declined at once", async () => {
		const { tracker, written, warnings, feed } = setup();
		expect(MAX_OPEN_APPROVALS).toBe(64);
		for (let id = 0; id < 65; id++) feed({ id, method: COMMAND, params: {} });
		await tick();
		expect(tracker.pendingCount()).toBe(64);
		expect(written).toEqual([{ id: 64, result: { decision: "decline" } }]);
		expect(warnings[0].detail.reason).toBe("over_capacity");
	});

	test("the cap is shared by every runtime on the host", async () => {
		const tracker = createCodexApprovalTracker({ maxOpen: 2 });
		const a = memoryClient();
		const b = memoryClient();
		tracker.attachClient(a.client, { sessionId: "a", warn: async () => {} });
		tracker.attachClient(b.client, { sessionId: "b", warn: async () => {} });
		a.feed({ id: 0, method: COMMAND, params: {} });
		a.feed({ id: 1, method: COMMAND, params: {} });
		b.feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		expect(b.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.written).toEqual([]);
	});
});

describe("fence, close and dispose", () => {
	test("fence declines what is held for that session only, and later approvals too", async () => {
		const tracker = createCodexApprovalTracker();
		const one = memoryClient();
		const two = memoryClient();
		const w1: string[] = [];
		const h1 = tracker.attachClient(one.client, {
			sessionId: "one",
			warn: async (_c, d) => void w1.push(d.reason),
		});
		tracker.attachClient(two.client, { sessionId: "two", warn: async () => {} });
		one.feed({ id: 0, method: COMMAND, params: {} });
		two.feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		tracker.fence("one");
		expect(one.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(two.written).toEqual([]);
		expect(tracker.pendingCount()).toBe(1);
		tracker.setVerdict(h1, SUPPORTED);
		one.feed({ id: 1, method: FILE_CHANGE, params: {} });
		await tick();
		expect(one.written.at(-1)).toEqual({ id: 1, result: { decision: "decline" } });
		expect(w1).toEqual(["fenced", "fenced"]);
	});

	test("closing the client cleans up through onClose, and a double close is harmless", async () => {
		const { entries, timers } = fakeTimers();
		const { tracker, handle, client, written, feed } = setup({ timers });
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		expect(tracker.pendingCount()).toBe(1);
		client.transportClosed(new Error("gone"));
		client.transportClosed(new Error("again"));
		expect(tracker.pendingCount()).toBe(0);
		expect(entries.every((e) => e.cleared)).toBe(true);
		expect(written).toEqual([]);
		expect(() => tracker.setVerdict(handle, SUPPORTED)).not.toThrow();
		expect(() => tracker.dispose(handle)).not.toThrow();
		expect(() => tracker.dispose(handle)).not.toThrow();
		expect(() => tracker.fence("sess-1")).not.toThrow();
	});

	test("dispose declines what is held on a client that is still open, then forgets it", async () => {
		const { tracker, handle, written, warnings, feed } = setup();
		feed({ id: 0, method: COMMAND, params: {} });
		await tick();
		tracker.dispose(handle);
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(warnings).toEqual([]);
		expect(tracker.pendingCount()).toBe(0);
		// Nothing is attached any more, so the client's own default answers: a request never hangs.
		feed({ id: 1, method: COMMAND, params: {} });
		await tick();
		expect(written[1]).toEqual({ id: 1, error: { code: -32601, message: "Method not found" } });
		expect(written).toHaveLength(2);
	});

	test("each attach is a new epoch", () => {
		const tracker = createCodexApprovalTracker();
		const a = tracker.attachClient(memoryClient().client, { sessionId: "s", warn: async () => {} });
		const b = tracker.attachClient(memoryClient().client, { sessionId: "s", warn: async () => {} });
		expect(b.epoch).not.toBe(a.epoch);
		expect(a.epoch).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});

describe("through a real launch", () => {
	let home: string;
	let fakeCodex: string;
	let logPath: string;
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		"HOME",
		"AGENTPULSE_CODEX_COMMAND",
		"AGENTPULSE_SUPERVISOR_DRY_RUN",
		"FAKE_CODEX_LOG",
		"FAKE_CODEX_REQUESTS",
		"FAKE_CODEX_FORCE_SANDBOX",
	];

	beforeAll(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		home = mkdtempSync(join(tmpdir(), "ap-approvals-"));
		fakeCodex = installFakeCodex(home);
		logPath = join(home, "fake.log");
		process.env.HOME = home;
		process.env.AGENTPULSE_CODEX_COMMAND = fakeCodex;
		process.env.FAKE_CODEX_LOG = logPath;
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	});
	afterAll(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(home, { recursive: true, force: true });
	});
	beforeEach(() => {
		rmSync(logPath, { force: true });
		process.env.FAKE_CODEX_REQUESTS = "";
		process.env.FAKE_CODEX_FORCE_SANDBOX = "";
		configureCodexApprovals(null);
	});
	afterEach(() => configureCodexApprovals(null));

	const events: any[] = [];
	const callbacks = {
		reportState: async () => ({ session: { displayName: "fake-session" }, managedSession: {} }),
		reportEvents: async (batch: any[]) => {
			events.push(...batch);
		},
	} as never;
	const codexLaunch = () =>
		({
			id: `launch-${crypto.randomUUID()}`,
			launchCorrelationId: crypto.randomUUID(),
			agentType: "codex_cli",
			cwd: home,
			baseInstructions: "",
			taskPrompt: "do the thing",
			model: "gpt-test",
			approvalPolicy: null,
			sandboxMode: null,
			requestedLaunchMode: "managed_codex",
			env: {},
			launchSpec: {},
			status: "claimed",
		}) as unknown as LaunchRequest;

	async function waitFor(predicate: () => boolean, ms = 8_000) {
		const deadline = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error("condition not met");
			await Bun.sleep(10);
		}
	}

	test("every request the child sends is answered once, nothing is accepted, and each is reported", async () => {
		events.length = 0;
		const declared: string[] = JSON.parse(readFileSync(join(FIXTURES, "methods.json"), "utf8"));
		process.env.FAKE_CODEX_REQUESTS = JSON.stringify(
			declared.map((method) => ({
				method,
				params: { command: "touch /marker-command", cwd: "/marker-cwd", reason: "marker-reason" },
			})),
		);
		const result = await launchManagedCodexRequest(codexLaunch(), callbacks);
		try {
			await waitFor(() => readFakeLog(logPath).filter((e) => e.answer).length >= declared.length);
			await Bun.sleep(100);
			const answers = readFakeLog(logPath).filter((e) => e.answer);
			expect(answers.map((e) => e.answer.id).sort((a, b) => a - b)).toEqual(
				declared.map((_, i) => i),
			);
			for (const entry of answers) expect(JSON.stringify(entry.answer)).not.toMatch(/accept/i);
			await waitFor(
				() => events.filter((e) => e.eventType === "ManagedWarning").length >= declared.length,
			);
			const warnings = events.filter((e) => e.eventType === "ManagedWarning");
			expect(warnings.length).toBeGreaterThanOrEqual(declared.length);
			expect(JSON.stringify(warnings)).not.toMatch(/marker/);
		} finally {
			await result.runtime.dispose();
		}
	});

	test("a verdict that isn't supported: one warning, the verdict in the snapshot, no request to any server", async () => {
		events.length = 0;
		const states: any[] = [];
		const recording = {
			reportState: async (input: unknown) => {
				states.push(input);
				return { session: { displayName: "fake-session" }, managedSession: {} };
			},
			reportEvents: async (batch: any[]) => {
				events.push(...batch);
			},
		} as never;
		const result = await launchManagedCodexRequest(codexLaunch(), recording);
		try {
			// The fake reports 0.0.0, under the floor.
			expect(states[0].providerCapabilitySnapshot.agentpulseApprovals).toBe("unsupported");
			const protocol = events.filter((e) => e.rawPayload?.method === "protocol");
			expect(protocol).toHaveLength(1);
			expect(protocol[0].eventType).toBe("ManagedWarning");
			expect(protocol[0].rawPayload.reason).toBe("below_floor");
		} finally {
			await result.runtime.dispose();
		}
	});

	test("a launch that fails after attachClient is cleaned up through the client's close", async () => {
		const real = createCodexApprovalTracker();
		let attachedBeforeInitialize = false;
		let attachedClient: RpcClient | undefined;
		const spy: CodexApprovalTracker = {
			...real,
			attachClient: (client, launch) => {
				attachedClient = client;
				attachedBeforeInitialize = !readFakeLog(logPath).some((e) => e.method);
				return real.attachClient(client, launch);
			},
		};
		configureCodexApprovals(spy);
		process.env.FAKE_CODEX_FORCE_SANDBOX = "read-only";
		await expect(
			launchManagedCodexRequest({ ...codexLaunch(), sandboxMode: "workspace-write" }, callbacks),
		).rejects.toThrow();
		expect(attachedBeforeInitialize).toBe(true);
		expect(attachedClient?.isClosed).toBe(true);
		expect(real.pendingCount()).toBe(0);
	});

	test("stopping a session with a request pending leaves it declined, and the child gone", async () => {
		process.env.FAKE_CODEX_REQUESTS = JSON.stringify([{ method: COMMAND, params: {} }]);
		const launch = codexLaunch();
		const { stopManagedCodexSession } = await import("./codex-managed.js");
		const result = await launchManagedCodexRequest(launch, callbacks);
		await waitFor(() => readFakeLog(logPath).some((e) => e.answer));
		await stopManagedCodexSession(launch.launchCorrelationId);
		expect(readFakeLog(logPath).filter((e) => e.answer)).toHaveLength(1);
		expect(readFakeLog(logPath).some((e) => e.method === "turn/interrupt")).toBe(true);
		expect(() => process.kill(result.pid, 0)).toThrow();
	});
});

// ---- answering from the server (AGEN-87, plan 5.3) ----

import { readdirSync } from "node:fs";
import {
	CODEX_APPROVAL_TTL_MS,
	CODEX_FILE_DIFF_WAIT_MS,
	CODEX_RESOLVED_WAIT_MS,
	CODEX_SLOW_SYNC_RESPONSE_MS,
	CODEX_TRACKER_DEADLINE_MS,
	type CodexApprovalReportRequest,
	type ParsedApprovalSyncResponse,
	type TrackerOutcome,
} from "../../shared/codex-approvals.js";
import { SupervisorNetworkError, SupervisorRequestError } from "../services/report-resilience.js";
import type { ApprovalGatePort } from "./codex-approvals.js";

type SyncEntries = Parameters<ApprovalGatePort["syncApprovals"]>[0];

function clockPair() {
	const state = { wall: 1_800_000_000_000, mono: 5_000 };
	return {
		state,
		now: () => state.wall,
		monotonic: () => state.mono,
		advance: (ms: number) => {
			state.wall += ms;
			state.mono += ms;
		},
	};
}

/** A gate port that records what it is asked and answers from the test's script. */
function stubGate() {
	const script = {
		verdict: "send" as "send" | "excluded" | "blocked",
		excluded: new Set<string>(),
		offline: false,
		// The same request gets the same id again, as on the server.
		report: async (
			sessionId: string,
			body: CodexApprovalReportRequest,
		): Promise<{ approvalId: string }> => {
			const key = `${sessionId}|${body.runtimeEpoch}|${body.rpcId}`;
			const known = script.ids.get(key);
			if (known) return { approvalId: known };
			const approvalId = `ap-${++script.counter}`;
			script.ids.set(key, approvalId);
			return { approvalId };
		},
		sync: async (_entries: SyncEntries): Promise<Partial<ParsedApprovalSyncResponse>> => ({}),
		counter: 0,
		ids: new Map<string, string>(),
	};
	const reports: Array<{ sessionId: string; body: CodexApprovalReportRequest }> = [];
	const syncs: SyncEntries[] = [];
	const gate: ApprovalGatePort = {
		verdict: () => script.verdict,
		excludesPath: (path) => script.excluded.has(path),
		isOffline: () => script.offline,
		reportApproval: async (sessionId, body) => {
			// The real gate sends nothing for a session a rule covers.
			if (script.verdict !== "send") {
				return { outcome: script.verdict === "excluded" ? "excluded" : "blocked" };
			}
			reports.push({ sessionId, body });
			const { approvalId } = await script.report(sessionId, body);
			return {
				outcome: "sent",
				response: { v: 1, approvalId, revision: body.revision, expiresInMs: 1 },
			};
		},
		syncApprovals: async (entries) => {
			// The real gate leaves out a session a rule covers, and sends nothing when nothing is left.
			if (script.verdict !== "send") return { outcome: "empty" };
			syncs.push(JSON.parse(JSON.stringify(entries)));
			const partial = await script.sync(entries);
			return {
				outcome: "sent",
				response: {
					v: 1,
					answers: [],
					closed: [],
					ack: [],
					...partial,
				} as ParsedApprovalSyncResponse,
			};
		},
	};
	return { gate, script, reports, syncs };
}

const cmdParams = (id: number, over: Record<string, unknown> = {}) => ({
	kind: "command",
	threadId: "thr-1",
	turnId: "turn-1",
	itemId: `item-${id}`,
	startedAtMs: 1,
	environmentId: "local",
	reason: null,
	command: "npm test",
	cwd: "/work/project",
	availableDecisions: ["accept", "cancel"],
	...over,
});

type Armed = ReturnType<typeof armed>;
/** A tracker with a stub gate, the server's feature on and a supported verdict, ready for requests. */
function armed(
	options: { verdict?: "supported" | "unsupported"; features?: string[] | null } = {},
) {
	const clock = clockPair();
	const stub = stubGate();
	const timers = fakeTimers();
	const tracker = createCodexApprovalTracker({
		gate: stub.gate,
		now: clock.now,
		monotonic: clock.monotonic,
		timers: timers.timers,
	});
	tracker.setServerFeatures(
		options.features === null ? undefined : (options.features ?? ["codex_approvals"]),
	);
	const mem = memoryClient();
	const warnings: Array<{ content: string; detail: { method: string; reason: string } }> = [];
	const handle = tracker.attachClient(mem.client, {
		sessionId: "sess-1",
		cwd: "/work/project",
		warn: async (content, detail) => {
			warnings.push({ content, detail });
		},
	});
	tracker.setVerdict(
		handle,
		options.verdict === "unsupported"
			? { verdict: "unsupported", reason: "below_floor" }
			: SUPPORTED,
	);
	return { tracker, handle, clock, timers, warnings, ...stub, ...mem };
}

async function settle() {
	await Bun.sleep(5);
}

/** Feeds a command request and waits for its report; returns the approval id the stub gave it. */
async function openRequest(a: Armed, id = 0, over: Record<string, unknown> = {}) {
	a.feed({ id, method: COMMAND, params: cmdParams(id, over) });
	await settle();
	return a.reports.length;
}

const answerOf = (approvalId: string, decision: string, revision = 1) => ({
	approvalId,
	decision,
	revision,
});

describe("the slow sync response rule (3 s)", () => {
	async function acceptAfter(delay: (a: Armed) => void) {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => {
			delay(a);
			return { answers: [answerOf("ap-1", "accept")] };
		};
		await a.tracker.tick();
		return a;
	}

	test("slow sync response: a round trip of exactly 3,000 ms delivers the accept", async () => {
		expect(CODEX_SLOW_SYNC_RESPONSE_MS).toBe(3_000);
		const a = await acceptAfter((x) => x.clock.advance(3_000));
		expect(a.written).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("slow sync response: 3,001 ms declines it, and the decline is reported as declined_slow_response", async () => {
		const a = await acceptAfter((x) => x.clock.advance(3_001));
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.resolved).toEqual([
			{
				sessionId: "sess-1",
				approvalId: "ap-1",
				outcome: "declined_slow_response",
				sentDecision: "decline",
			},
		]);
	});

	test("slow sync response: a wall clock that jumps while the monotonic one stands still still declines", async () => {
		const a = await acceptAfter((x) => {
			x.clock.state.wall += 5_000;
		});
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("slow sync response: a monotonic clock that jumps while the wall clock stands still still declines", async () => {
		const a = await acceptAfter((x) => {
			x.clock.state.mono += 5_000;
		});
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("slow sync response: a decline in a slow response is still delivered", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => {
			a.clock.advance(9_000);
			return { answers: [answerOf("ap-1", "decline")] };
		};
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});
});

describe("revision compare", () => {
	test("an accept at the revision that was held is delivered", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("a patch that lands after the sync answer and before the write gives decline and declined_revision_changed", async () => {
		const a = armed();
		a.feed({
			method: "item/started",
			params: {
				threadId: "thr-1",
				item: {
					type: "fileChange",
					id: "fc-1",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "one\n" }],
				},
			},
		});
		a.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "thr-1",
				turnId: "turn-1",
				itemId: "fc-1",
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		});
		await settle();
		expect(a.reports[0].body.revision).toBe(1);
		a.script.sync = async () => {
			// The patch arrives while the answer is in flight.
			a.feed({
				method: "item/fileChange/patchUpdated",
				params: {
					threadId: "thr-1",
					itemId: "fc-1",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "two\n" }],
				},
			});
			await settle();
			return { answers: [answerOf("ap-1", "accept", 1)] };
		};
		await a.tracker.tick();

		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.resolved.map((r) => r.outcome)).toContain("declined_revision_changed");
	});

	test("a changed patch bumps the revision synchronously, and the new revision is re-reported", async () => {
		const a = armed();
		const frames = (diff: string) => ({
			method: "item/fileChange/patchUpdated",
			params: {
				threadId: "t",
				itemId: "fc-2",
				changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff }],
			},
		});
		a.feed({
			method: "item/started",
			params: {
				threadId: "t",
				item: {
					type: "fileChange",
					id: "fc-2",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "a\n" }],
				},
			},
		});
		a.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "fc-2",
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		});
		await settle();
		a.feed(frames("b\n"));
		await settle();
		a.feed(frames("b\n"));
		await settle();
		expect(a.reports.map((r) => r.body.revision)).toEqual([1, 2]);
		expect(a.reports[1].body.changes?.[0].diff).toBe("b\n");
	});
});

describe("closed decision table", () => {
	test("closed decision table: a word outside the table, and every decision that outlives one approval, becomes a decline", async () => {
		for (const word of [
			"acceptForSession",
			"acceptWithExecpolicyAmendment",
			"applyNetworkPolicyAmendment",
			"nonsense",
			"",
		]) {
			const a = armed();
			await openRequest(a);
			a.script.sync = async () => ({
				answers: [{ approvalId: "ap-1", decision: word, revision: 1 }],
			});
			await a.tracker.tick();
			expect(a.written, word).toEqual([{ id: 0, result: { decision: "decline" } }]);
		}
	});

	test("closed decision table: the session-wide decision names appear in one refusal table in the source and nowhere else", () => {
		const providers = readdirSync(import.meta.dir).filter(
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
		);
		const holders = providers.filter((file) =>
			/acceptForSession|acceptWithExecpolicyAmendment/.test(
				readFileSync(join(import.meta.dir, file), "utf8"),
			),
		);
		expect(holders).toEqual(["codex-approvals.ts"]);
	});
});

describe("the one accept", () => {
	test("exactly one expression in the supervisor can write accept to Codex, and it is inside deliverAccept", () => {
		const supervisorDir = join(import.meta.dir, "..");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "__fixtures__") walk(full);
				} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
			}
		};
		walk(supervisorDir);
		expect(files.length).toBeGreaterThan(20);
		expect(files.map((f) => f.slice(supervisorDir.length))).toContain(
			"/providers/codex-approvals.ts",
		);
		const writers: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			for (const _ of text.matchAll(/decision:\s*["'`]accept["'`]/g))
				writers.push(file.slice(supervisorDir.length));
			for (const _ of text.matchAll(/decision["']?\s*:\s*[a-z][A-Za-z]*\s*as\b/g))
				writers.push(`${file}: cast`);
		}
		expect(writers).toEqual(["/providers/codex-approvals.ts"]);
		const text = readFileSync(join(import.meta.dir, "codex-approvals.ts"), "utf8");
		const at = text.indexOf('{ decision: "accept" }');
		expect(at).toBeGreaterThan(0);
		const start = text.lastIndexOf("function deliverAccept", at);
		const end = text.indexOf("\n\t// ----", at);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(at);
		// ... and nothing between the function's opening and that write awaits.
		expect(text.slice(start, at)).not.toMatch(/\bawait\b/);
	});

	test("an accept that isn't for the exact held request is never written: unknown, repeated, mismatched, fenced, disposed", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({
			answers: [answerOf("not-an-id", "accept"), answerOf("ap-1", "accept", 9)],
		});
		await a.tracker.tick();
		// The second is a revision mismatch: a decline, and that is all Codex hears.
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);

		const fenced = armed();
		await openRequest(fenced);
		fenced.tracker.fence("sess-1");
		fenced.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await fenced.tracker.tick();
		expect(fenced.written).toEqual([{ id: 0, result: { decision: "decline" } }]);

		const gone = armed();
		await openRequest(gone);
		gone.tracker.dispose(gone.handle);
		gone.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await gone.tracker.tick();
		expect(gone.written.filter((w) => JSON.stringify(w).includes("accept"))).toEqual([]);
	});

	test("an accept naming an id other than the one this request was last reported under is never written", async () => {
		const a = armed();
		let calls = 0;
		a.script.report = async () => ({ approvalId: `ap-changed-${++calls}` });
		a.feed({
			method: "item/started",
			params: {
				threadId: "t",
				item: {
					type: "fileChange",
					id: "fc-1",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "one\n" }],
				},
			},
		});
		a.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "fc-1",
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		});
		await settle();
		// A patch re-reports the request, and the server (which never should) answers with another id.
		a.feed({
			method: "item/fileChange/patchUpdated",
			params: {
				threadId: "t",
				itemId: "fc-1",
				changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "two\n" }],
			},
		});
		await settle();
		expect(a.reports.map((r) => r.body.revision)).toEqual([1, 2]);

		// Both ids the host has been given are answered with an accept at the held revision.
		a.script.sync = async () => ({
			answers: [answerOf("ap-changed-1", "accept", 2), answerOf("ap-changed-2", "accept", 2)],
		});
		await a.tracker.tick();

		// The stale id no longer names this request: it is declined, and nothing accepts it.
		expect(a.written.map((w) => w.result.decision)).toEqual(["decline"]);

		const b = armed();
		let again = 0;
		b.script.report = async () => ({ approvalId: `ap-changed-${++again}` });
		b.feed({
			method: "item/started",
			params: {
				threadId: "t",
				item: {
					type: "fileChange",
					id: "fc-2",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "one\n" }],
				},
			},
		});
		b.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "fc-2",
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		});
		await settle();
		b.feed({
			method: "item/fileChange/patchUpdated",
			params: {
				threadId: "t",
				itemId: "fc-2",
				changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "two\n" }],
			},
		});
		await settle();
		b.script.sync = async () => ({ answers: [answerOf("ap-changed-1", "accept", 2)] });
		await b.tracker.tick();
		expect(JSON.stringify(b.written)).not.toContain("accept");
	});

	test("every path that ends a request also ends the chance of an accept for it: features off, fence, dispose, unsupported verdict, closed client", async () => {
		const ends: Array<[string, (a: Armed) => void]> = [
			["features off", (a) => a.tracker.setServerFeatures(undefined)],
			["fence", (a) => a.tracker.fence("sess-1")],
			["dispose", (a) => a.tracker.dispose(a.handle)],
			[
				"verdict unsupported",
				(a) => a.tracker.setVerdict(a.handle, { verdict: "unsupported", reason: "x" }),
			],
			["client closed", (a) => a.client.transportClosed(new Error("gone"))],
		];
		for (const [name, end] of ends) {
			const a = armed();
			await openRequest(a);
			end(a);
			// The server's feature comes back (a heartbeat says so) and then it issues the accept: a request
			// that was ended stays ended.
			a.tracker.setServerFeatures(["codex_approvals"]);
			a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
			a.script.offline = false;
			await a.tracker.tick();
			expect(JSON.stringify(a.written), name).not.toContain("accept");
		}
	});

	test("repeat answers are idempotent: the same accept three times is one write, and a later decline for it is ignored", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		await a.tracker.tick();
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("two runtimes with the same rpc id are two requests: an answer for one never reaches the other", async () => {
		const tracker = armed();
		const other = memoryClient();
		const second = tracker.tracker.attachClient(other.client, {
			sessionId: "sess-2",
			cwd: "/work/project",
			warn: async () => {},
		});
		tracker.tracker.setVerdict(second, SUPPORTED);
		other.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
		await openRequest(tracker);
		await settle();
		expect(tracker.reports.map((r) => r.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
		expect(new Set(tracker.reports.map((r) => r.body.runtimeEpoch)).size).toBe(2);

		tracker.script.sync = async () => ({ answers: [answerOf("ap-2", "accept")] });
		await tracker.tracker.tick();
		const writes = [tracker.written, other.written].map((w) => w.length);
		expect(writes.reduce((a, b) => a + b, 0)).toBe(1);
	});
});

describe("outcome protocol", () => {
	const outcomesSent = (a: Armed) => a.syncs.flatMap((s) => s.resolved.map((r) => r.outcome));

	test("outcome protocol: a response is reported respond_sent, and resolved after it is reported resolved_after_response", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.resolved).toEqual([
			{ sessionId: "sess-1", approvalId: "ap-1", outcome: "respond_sent", sentDecision: "accept" },
			{
				sessionId: "sess-1",
				approvalId: "ap-1",
				outcome: "resolved_after_response",
				sentDecision: "accept",
			},
		]);
	});

	test("outcome protocol: each outcome is re-sent until acknowledged, then forgotten; a terminal ack forgets the request", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();
		a.script.sync = async () => ({});
		await a.tracker.tick();
		await a.tracker.tick();
		expect(outcomesSent(a).filter((o) => o === "resolved_after_response")).toHaveLength(2);

		a.script.sync = async () => ({
			ack: [
				{ approvalId: "ap-1", outcome: "respond_sent" as TrackerOutcome },
				{ approvalId: "ap-1", outcome: "resolved_after_response" as TrackerOutcome },
			],
		});
		await a.tracker.tick();
		const calls = a.syncs.length;
		await a.tracker.tick();
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(calls);
		expect(a.tracker.pendingCount()).toBe(0);
	});

	test("outcome protocol: no resolved within 10 s of a sent response is resolved_timeout", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		const timer = a.timers.entries.find((e) => e.ms === CODEX_RESOLVED_WAIT_MS && !e.cleared);
		expect(timer).toBeDefined();
		timer?.callback();
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(outcomesSent(a)).toContain("resolved_timeout");
	});

	test("outcome protocol: resolved with no response of ours is resolved_before_response, and nothing is written", async () => {
		const a = armed();
		await openRequest(a);
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		expect(outcomesSent(a)).toContain("resolved_before_response");
	});

	test("outcome protocol: a runtime that closes reports runtime_gone, or runtime_gone_after_response once something was sent", async () => {
		const unanswered = armed();
		await openRequest(unanswered);
		unanswered.client.transportClosed(new Error("gone"));
		unanswered.script.sync = async () => ({});
		await unanswered.tracker.tick();
		expect(unanswered.syncs.at(-1)?.resolved.map((r) => r.outcome)).toEqual(["runtime_gone"]);

		const answered = armed();
		await openRequest(answered);
		answered.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await answered.tracker.tick();
		answered.client.transportClosed(new Error("gone"));
		answered.script.sync = async () => ({});
		await answered.tracker.tick();
		expect(answered.syncs.at(-1)?.resolved.map((r) => r.outcome)).toEqual([
			"respond_sent",
			"runtime_gone_after_response",
		]);
	});

	test("outcome protocol: the live list names what is held and leaves out what is finished", async () => {
		const a = armed();
		await openRequest(a, 0);
		await openRequest(a, 1);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs[0].live.map((l) => l.approvalId).sort()).toEqual(["ap-1", "ap-2"]);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.live.map((l) => l.approvalId)).toEqual(["ap-2"]);
	});

	test("the server saying a row is closed declines the request and reports nothing more about it", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ closed: ["ap-1"] });
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		const calls = a.syncs.length;
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(calls);
	});
});

describe("failure rules", () => {
	const fail = (status: number, code?: string, retryAfterMs?: number) =>
		new SupervisorRequestError(status, "x", code, retryAfterMs);

	async function failing(error: Error) {
		const a = armed();
		a.script.report = async () => {
			throw error;
		};
		a.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
		await settle();
		return a;
	}

	test("failure rules: network, server and back-pressure are retried with a doubling wait", async () => {
		for (const error of [
			new SupervisorNetworkError(),
			fail(500),
			fail(429),
			fail(503, "busy", 2_000),
			fail(401, "Invalid supervisor credential"),
		]) {
			const a = await failing(error);
			expect(a.written, String(error)).toEqual([]);
			expect(a.reports).toHaveLength(1);
			await a.tracker.tick();
			expect(a.reports).toHaveLength(1);
			a.clock.advance(
				1_001 + (error instanceof SupervisorRequestError && error.retryAfterMs ? 1_000 : 0),
			);
			await a.tracker.tick();
			expect(a.reports.length, String(error)).toBe(2);
			a.clock.advance(1_500);
			await a.tracker.tick();
			expect(a.reports.length).toBe(2);
			a.clock.advance(1_000);
			await a.tracker.tick();
			expect(a.reports.length).toBe(3);
		}
	});

	test("failure rules: 409 session_unknown is retried every 5 s until the deadline", async () => {
		const a = await failing(fail(409, "session_unknown"));
		for (let i = 0; i < 3; i++) {
			a.clock.advance(4_999);
			await a.tracker.tick();
			expect(a.reports).toHaveLength(i + 1);
			a.clock.advance(1);
			await a.tracker.tick();
			expect(a.reports).toHaveLength(i + 2);
		}
		a.clock.advance(CODEX_TRACKER_DEADLINE_MS);
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("failure rules: too_many_pending, session_stopping, identity_conflict, session_not_owned decline with a warning", async () => {
		for (const [status, code] of [
			[409, "too_many_pending"],
			[409, "session_stopping"],
			[409, "identity_conflict"],
			[403, "session_not_owned"],
		] as const) {
			const a = await failing(fail(status, code));
			expect(a.written, code).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(
				a.warnings.map((w) => w.detail.reason),
				code,
			).toEqual([code]);
		}
	});

	test("failure rules: an entry error (400 invalid_body, 413) declines with a warning", async () => {
		for (const error of [fail(400, "invalid_body"), fail(413)]) {
			const a = await failing(error);
			expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(a.warnings).toHaveLength(1);
		}
	});

	test("failure rules: a 404 (a server rolled back) declines, warns, and turns approvals off until a heartbeat says otherwise", async () => {
		const a = await failing(fail(404));
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.warnings).toHaveLength(1);

		a.feed({ id: 1, method: COMMAND, params: cmdParams(1) });
		await settle();
		expect(a.written.at(-1)).toEqual({ id: 1, result: { decision: "decline" } });
		const reports = a.reports.length;
		a.tracker.setServerFeatures(["codex_approvals"]);
		a.script.report = async () => ({ approvalId: "ap-ok" });
		a.feed({ id: 2, method: COMMAND, params: cmdParams(2) });
		await settle();
		expect(a.reports.length).toBe(reports + 1);
	});

	test("failure rules: a sync that fails with a refusal declines what is held; one that fails on the network keeps it and backs off", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => {
			throw new SupervisorNetworkError();
		};
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		const calls = a.syncs.length;
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(calls);
		a.clock.advance(1_001);
		a.script.sync = async () => {
			throw fail(404);
		};
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("failure rules: a request past its deadline is declined even if the server is never heard from again", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => {
			throw new SupervisorNetworkError();
		};
		a.clock.advance(CODEX_TRACKER_DEADLINE_MS - 1);
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		a.clock.advance(1);
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("failure rules: with under a minute left a request that was never reported is declined, not reported", async () => {
		const a = armed();
		a.script.report = async () => {
			throw new SupervisorNetworkError();
		};
		a.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
		await settle();
		expect(a.reports).toHaveLength(1);
		a.clock.advance(CODEX_APPROVAL_TTL_MS - 60_000 + 1);
		await a.tracker.tick();
		expect(a.reports).toHaveLength(1);
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("failure rules: a gate that is offline is not asked, but deadlines still run", async () => {
		const a = armed();
		await openRequest(a);
		a.script.offline = true;
		const calls = a.syncs.length;
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(calls);
		a.clock.advance(CODEX_TRACKER_DEADLINE_MS);
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});
});

describe("exclude", () => {
	test("exclude: a session that is excluded or blocked is declined with nothing reported and no request", async () => {
		for (const verdict of ["excluded", "blocked"] as const) {
			const a = armed();
			a.script.verdict = verdict;
			a.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
			await settle();
			expect(a.written, verdict).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(a.reports).toEqual([]);
			expect(a.syncs).toEqual([]);
			expect(a.warnings).toEqual([]);
		}
	});

	test("exclude: the cwd, a file path, a move path and a grant root each exclude, and a relative path is resolved against cwd", async () => {
		const cases: Array<[string, () => Record<string, unknown>, string]> = [
			["cwd", () => cmdParams(0, { cwd: "/secret/place" }), "/secret/place"],
		];
		for (const [name, params, path] of cases) {
			const a = armed();
			a.script.excluded.add(path);
			a.feed({ id: 0, method: COMMAND, params: params() });
			await settle();
			expect(a.written, name).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(a.reports, name).toEqual([]);
		}
		for (const [name, change, path] of [
			["path", { path: "/secret/a.txt", kind: { type: "add" } }, "/secret/a.txt"],
			[
				"move path",
				{ path: "/work/project/a.txt", kind: { type: "update", move_path: "/secret/b.txt" } },
				"/secret/b.txt",
			],
			["relative path", { path: "../secret/c.txt", kind: { type: "add" } }, "/work/secret/c.txt"],
		] as const) {
			const a = armed();
			a.script.excluded.add(path);
			a.feed({
				method: "item/started",
				params: {
					threadId: "t",
					item: { type: "fileChange", id: "fc-x", changes: [{ ...change, diff: "x\n" }] },
				},
			});
			a.feed({
				id: 0,
				method: FILE_CHANGE,
				params: {
					threadId: "t",
					turnId: "u",
					itemId: "fc-x",
					startedAtMs: 1,
					reason: null,
					grantRoot: null,
				},
			});
			await settle();
			expect(a.written, name).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(a.reports, name).toEqual([]);
		}
		const root = armed();
		root.script.excluded.add("/secret/root");
		root.feed({
			method: "item/started",
			params: {
				threadId: "t",
				item: {
					type: "fileChange",
					id: "fc-r",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "x\n" }],
				},
			},
		});
		root.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "fc-r",
				startedAtMs: 1,
				reason: null,
				grantRoot: "/secret/root",
			},
		});
		await settle();
		expect(root.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(root.reports).toEqual([]);
	});

	test("exclude: a retry of a report that failed is not sent once a rule covers its path", async () => {
		const a = armed();
		let attempts = 0;
		a.script.report = async () => {
			attempts++;
			throw new SupervisorNetworkError();
		};
		a.feed({ id: 0, method: COMMAND, params: cmdParams(0, { cwd: "/secret/place" }) });
		await settle();
		expect(attempts).toBe(1);
		a.script.excluded.add("/secret/place");
		a.clock.advance(1_001);
		await a.tracker.tick();
		expect(attempts).toBe(1);
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.warnings).toEqual([]);
	});

	test("exclude: a revision that names an excluded path declines the request and stops listing it", async () => {
		const a = armed();
		a.feed({
			method: "item/started",
			params: {
				threadId: "t",
				item: {
					type: "fileChange",
					id: "fc-9",
					changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "x\n" }],
				},
			},
		});
		a.feed({
			id: 0,
			method: FILE_CHANGE,
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "fc-9",
				startedAtMs: 1,
				reason: null,
				grantRoot: null,
			},
		});
		await settle();
		a.script.excluded.add("/secret/new.txt");
		a.feed({
			method: "item/fileChange/patchUpdated",
			params: {
				threadId: "t",
				itemId: "fc-9",
				changes: [{ path: "/secret/new.txt", kind: { type: "add" }, diff: "x\n" }],
			},
		});
		await settle();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.live ?? []).toEqual([]);
	});

	test("exclude: an answer that arrives after exclusion is ignored and a decline goes", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => {
			a.script.verdict = "excluded";
			return { answers: [answerOf("ap-1", "accept")] };
		};
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.warnings).toEqual([]);
	});

	test("exclude: a pending request is declined at the next beat when a rule appears, with no request about it", async () => {
		const a = armed();
		await openRequest(a);
		a.script.verdict = "excluded";
		const calls = a.syncs.length;
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.syncs).toHaveLength(calls);
	});
});

describe("what a healthy host pays", () => {
	test("with nothing held a tick reads no clock and asks the gate nothing", async () => {
		let reads = 0;
		const stub = stubGate();
		const tracker = createCodexApprovalTracker({
			gate: stub.gate,
			now: () => {
				reads++;
				return 1;
			},
			monotonic: () => {
				reads++;
				return 1;
			},
		});
		tracker.setServerFeatures(["codex_approvals"]);
		for (let i = 0; i < 50; i++) await tracker.tick();
		expect(reads).toBe(0);
		expect(stub.syncs).toEqual([]);
		expect(stub.reports).toEqual([]);
	});
});

describe("the server's word and the protocol verdict gate everything", () => {
	test("without the feature, and with an unsupported verdict, a request is declined and nothing is reported", async () => {
		for (const options of [
			{ features: null },
			{ features: [] as string[] },
			{ verdict: "unsupported" as const },
		]) {
			const a = armed(options);
			a.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
			await settle();
			expect(a.written, JSON.stringify(options)).toEqual([
				{ id: 0, result: { decision: "decline" } },
			]);
			expect(a.reports).toEqual([]);
			expect(a.syncs).toEqual([]);
		}
	});

	test("a request that isn't understood (an unknown parameter, no command, no plain accept, stdin, network) is reported decline-only", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ surprise: "x" }, "unknown_param"],
			[{ command: null }, "no_command"],
			[{ cwd: null }, "no_cwd"],
			[{ availableDecisions: ["cancel"] }, "accept_not_offered"],
			[{ availableDecisions: undefined }, "accept_not_offered"],
			[{ kind: "writeStdin" }, "write_stdin"],
			[{ networkApprovalContext: { host: "x" } }, "network"],
			[{ environmentId: "remote" }, "unknown_param"],
		];
		for (const [over, reason] of cases) {
			const a = armed();
			a.feed({ id: 0, method: COMMAND, params: cmdParams(0, over) });
			await settle();
			expect(a.reports[0]?.body.declineOnly, reason).toContain(reason as never);
			// ... and an accept for it is refused here too, whatever the server says.
			a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
			await a.tracker.tick();
			expect(JSON.stringify(a.written), reason).not.toContain("accept");
		}
	});

	test("a request with no usable ids is declined as malformed and never reported", async () => {
		const a = armed();
		a.feed({ id: 0, method: COMMAND, params: { command: "x", cwd: "/x" } });
		await settle();
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.warnings[0].detail.reason).toBe("malformed_request");
		expect(a.reports).toEqual([]);
	});

	test("the report carries a fresh runtime epoch, the JSON of the rpc id, and no field outside the contract", async () => {
		const a = armed();
		a.feed({ id: "7", method: COMMAND, params: cmdParams(7) });
		a.feed({ id: 7, method: COMMAND, params: cmdParams(8) });
		await settle();
		expect(a.reports.map((r) => r.body.rpcId)).toEqual(['"7"', "7"]);
		expect(a.reports[0].body.runtimeEpoch).toBe(a.handle.epoch);
		expect(Object.keys(a.reports[0].body).sort()).toEqual(
			[
				"v",
				"runtimeEpoch",
				"rpcId",
				"requestKind",
				"threadId",
				"turnId",
				"itemId",
				"providerApprovalId",
				"ageMs",
				"revision",
				"command",
				"cwd",
				"reason",
				"grantRoot",
				"truncated",
				"declineOnly",
			].sort(),
		);
	});
});

// ---- mid-build review of phase 5 ----

const fileChangeRequest = (id: number, threadId: string, itemId: string) => ({
	id,
	method: FILE_CHANGE,
	params: { threadId, turnId: "u", itemId, startedAtMs: 1, reason: null, grantRoot: null },
});
const startedFrame = (threadId: string | undefined, itemId: string, diff: string) => ({
	method: "item/started",
	params: {
		...(threadId === undefined ? {} : { threadId }),
		item: {
			type: "fileChange",
			id: itemId,
			changes: [{ path: "/work/project/a.txt", kind: { type: "add" }, diff }],
		},
	},
});
const patchFrame = (threadId: string | undefined, itemId: string, changes: unknown) => ({
	method: "item/fileChange/patchUpdated",
	params: { ...(threadId === undefined ? {} : { threadId }), itemId, changes },
});
const acceptsWritten = (a: Armed) => a.written.filter((w) => w.result?.decision === "accept");
const fireDiffWaits = (a: Armed) => {
	const due = a.timers.entries.filter((e) => e.ms === CODEX_FILE_DIFF_WAIT_MS && !e.cleared);
	expect(due.length).toBeGreaterThan(0);
	for (const entry of due) entry.callback();
};

describe("a repeated rpc id (M1)", () => {
	test("a second request on an id still open is one decline, ends the first, and is neither held nor reported", async () => {
		const a = armed();
		await openRequest(a);
		expect(a.reports).toHaveLength(1);

		a.feed({ id: 0, method: COMMAND, params: cmdParams(0, { command: "rm -rf /work/project" }) });
		await settle();

		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(a.reports).toHaveLength(1);
		expect(a.tracker.pendingCount()).toBe(0);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["identity_conflict"]);

		// The server's accept for the first request lands afterwards: nothing is written.
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(acceptsWritten(a)).toEqual([]);
		expect(a.written).toHaveLength(1);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.resolved.map((r) => r.outcome)).toEqual(["declined_local"]);
	});

	test("a repeat while the first is still waiting for its verdict leaves one decline too", async () => {
		const a = armed();
		const bare = memoryClient();
		const handle = a.tracker.attachClient(bare.client, {
			sessionId: "sess-2",
			warn: async () => {},
		});
		bare.feed({ id: 4, method: COMMAND, params: cmdParams(4) });
		bare.feed({ id: 4, method: COMMAND, params: cmdParams(4, { command: "other" }) });
		await settle();
		expect(bare.written).toEqual([{ id: 4, result: { decision: "decline" } }]);
		a.tracker.setVerdict(handle, SUPPORTED);
		await settle();
		expect(bare.written).toHaveLength(1);
		expect(a.reports.filter((r) => r.sessionId === "sess-2")).toEqual([]);
	});

	test("a repeat after an accept was written still gets its decline, and the first ends as unknown", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "accept" } }]);

		a.feed({ id: 0, method: COMMAND, params: cmdParams(0, { command: "different" }) });
		await settle();

		expect(a.written.map((w) => w.result.decision)).toEqual(["accept", "decline"]);
		expect(a.reports).toHaveLength(1);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.syncs.at(-1)?.resolved.map((r) => r.outcome)).toContain("resolved_timeout");
	});

	test("an id whose earlier request ended without a decline reaching Codex is still open: the repeat gets its decline", async () => {
		const a = armed();
		let failing = false;
		const failingClient = new RpcClient({
			write: (frame) => {
				if (failing) throw new Error("pipe closed");
				a.written.push(JSON.parse(frame));
			},
			close: () => {},
		});
		const handle = a.tracker.attachClient(failingClient, {
			sessionId: "sess-w",
			warn: async () => {},
		});
		a.tracker.setVerdict(handle, SUPPORTED);
		const feed = (frame: unknown) => failingClient.receive(`${JSON.stringify(frame)}\n`);
		feed({ id: 7, method: COMMAND, params: cmdParams(7) });
		await settle();
		failing = true;
		a.tracker.setServerFeatures(undefined);
		failing = false;
		a.tracker.setServerFeatures(["codex_approvals"]);
		expect(a.written.filter((w) => w.id === 7)).toEqual([]);

		feed({ id: 7, method: COMMAND, params: cmdParams(7, { command: "other" }) });
		await settle();

		expect(a.written.filter((w) => w.id === 7)).toEqual([
			{ id: 7, result: { decision: "decline" } },
		]);
		expect(a.reports.filter((r) => r.sessionId === "sess-w")).toHaveLength(1);
	});

	test("a new request on an id whose earlier request is finished and resolved is held as before; the server's identity_conflict then stands", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();

		a.script.report = async () => {
			throw new SupervisorRequestError(409, "Conflict", "identity_conflict");
		};
		a.feed({ id: 0, method: COMMAND, params: cmdParams(0, { command: "another" }) });
		await settle();

		// Reported (so it was held), refused by the server, and declined for Codex's new request.
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["identity_conflict"]);
		expect(a.written.map((w) => w.result.decision)).toEqual(["decline", "decline"]);
		expect(a.tracker.pendingCount()).toBe(0);
	});

	test("a new request on a finished id whose server row has the same identity is held, and the server's `closed` still ends it", async () => {
		const a = armed();
		await openRequest(a);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		a.feed({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 0 } });
		await settle();

		a.feed({ id: 0, method: COMMAND, params: cmdParams(0) });
		await settle();
		expect(a.reports).toHaveLength(2);
		expect(a.tracker.pendingCount()).toBe(1);
		// The server's row for this key is the old, closed one: it answers `closed`, and the new request is declined.
		a.script.sync = async () => ({ closed: ["ap-1"] });
		await a.tracker.tick();
		expect(a.written.map((w) => w.result.decision)).toEqual(["decline", "decline"]);
		expect(acceptsWritten(a)).toEqual([]);
	});
});

describe("diffs are kept by thread and item (M2)", () => {
	test("another thread's diff for the same item id is not this request's diff: it is reported decline-only with no diff", async () => {
		const a = armed();
		a.feed(startedFrame("thr-other", "fc-1", "belongs to another thread\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		fireDiffWaits(a);
		await settle();

		expect(a.reports).toHaveLength(1);
		expect(a.reports[0].body.changes).toEqual([]);
		expect(a.reports[0].body.declineOnly).toContain("no_diff");
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(acceptsWritten(a)).toEqual([]);
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("two threads with the same item id each get their own diff", async () => {
		const a = armed();
		a.feed(startedFrame("thr-1", "fc-1", "mine\n"));
		a.feed(startedFrame("thr-other", "fc-1", "theirs\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		expect(a.reports[0].body.changes?.[0].diff).toBe("mine\n");
	});

	test("a patch from another thread does not move this request's revision", async () => {
		const a = armed();
		a.feed(startedFrame("thr-1", "fc-1", "mine\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		a.feed(patchFrame("thr-other", "fc-1", [{ path: "/x", kind: { type: "add" }, diff: "z\n" }]));
		await settle();
		expect(a.reports).toHaveLength(1);
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
		await a.tracker.tick();
		expect(a.written).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("a started item with no threadId is no diff", async () => {
		const a = armed();
		a.feed(startedFrame(undefined, "fc-1", "no thread named\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		fireDiffWaits(a);
		await settle();
		expect(a.reports[0].body.declineOnly).toContain("no_diff");
	});

	test("an item with no threadId, for an item already held, drops what was held: it can't be told apart from a rewrite", async () => {
		const a = armed();
		a.feed(startedFrame("thr-1", "fc-1", "named\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		a.feed(startedFrame(undefined, "fc-1", "rewritten, thread not named\n"));
		await settle();
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
		await a.tracker.tick();
		expect(acceptsWritten(a)).toEqual([]);
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	test("a patch with no threadId can't be tied to a thread: whatever was held for the item is dropped and an accept is declined", async () => {
		const b = armed();
		b.feed(startedFrame("thr-1", "fc-1", "named\n"));
		b.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		b.feed(
			patchFrame(undefined, "fc-1", [
				{ path: "/work/project/a.txt", kind: { type: "add" }, diff: "x\n" },
			]),
		);
		await settle();
		b.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
		await b.tracker.tick();
		expect(acceptsWritten(b)).toEqual([]);
		expect(b.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});
});

describe("a patch that can't be read in full", () => {
	test("is no patch: an accept at the same revision is declined, and no accept is written", async () => {
		const a = armed();
		a.feed(startedFrame("thr-1", "fc-1", "one\n"));
		a.feed(fileChangeRequest(0, "thr-1", "fc-1"));
		await settle();
		expect(a.reports[0].body.revision).toBe(1);

		a.feed(patchFrame("thr-1", "fc-1", [{ path: "/work/project/a.txt", kind: "add", diff: 5 }]));
		await settle();
		a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
		await a.tracker.tick();

		expect(acceptsWritten(a)).toEqual([]);
		expect(a.written).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});
});

describe("refusal warnings are coalesced (L3)", () => {
	test("one per (session, method, reason) in 30 s, then another; a different method or reason still warns", async () => {
		const a = armed();
		for (let i = 0; i < 6; i++) a.feed({ id: 100 + i, method: "item/tool/call", params: {} });
		await settle();
		expect(a.warnings).toHaveLength(1);
		expect(a.written).toHaveLength(6);

		a.feed({ id: 200, method: "item/tool/requestUserInput", params: {} });
		a.feed({ id: 201, method: "no/such/method", params: {} });
		await settle();
		expect(a.warnings.map((w) => w.detail.method).sort()).toEqual([
			"item/tool/call",
			"item/tool/requestUserInput",
			"unknown",
		]);

		a.clock.advance(29_999);
		a.feed({ id: 300, method: "item/tool/call", params: {} });
		await settle();
		expect(a.warnings).toHaveLength(3);
		a.clock.advance(2);
		a.feed({ id: 301, method: "item/tool/call", params: {} });
		await settle();
		expect(a.warnings).toHaveLength(4);
	});

	test("the same refusal for another session is its own warning", async () => {
		const a = armed();
		const other = memoryClient();
		const seen: string[] = [];
		a.tracker.attachClient(other.client, {
			sessionId: "sess-2",
			warn: async (_content, detail) => void seen.push(detail.reason),
		});
		a.feed({ id: 1, method: "item/tool/call", params: {} });
		other.feed({ id: 1, method: "item/tool/call", params: {} });
		await settle();
		expect(a.warnings).toHaveLength(1);
		expect(seen).toEqual(["out_of_scope"]);
	});
});

describe("stopping a session the supervisor has no runtime for (L1)", () => {
	test("the fence is raised before the runtime lookup fails", async () => {
		const real = createCodexApprovalTracker();
		const fenced: string[] = [];
		configureCodexApprovals({ ...real, fence: (id) => void fenced.push(id) });
		try {
			const { stopManagedCodexSession } = await import("./codex-managed.js");
			await expect(stopManagedCodexSession("never-launched-session")).rejects.toThrow(
				"Managed Codex runtime is not available",
			);
			expect(fenced).toEqual(["never-launched-session"]);
		} finally {
			configureCodexApprovals(null);
		}
	});
});

type RecordedFrame = {
	method: string;
	id: number;
	params: Record<string, unknown> & {
		threadId: string;
		turnId: string;
		itemId: string;
		command?: string;
		cwd?: string;
		item?: { type: string; id: string; changes: RecordedChange[] };
	};
};
type RecordedChange = { path: string; kind: { type: string }; diff: string };

describe("every recorded approval request, through the tracker", () => {
	type Recorded = { dir: string; frame: RecordedFrame };
	const recordedRuns = readdirSync(FIXTURES)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => ({
			name,
			frames: readFileSync(join(FIXTURES, name), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Recorded),
		}));
	const cases = recordedRuns.flatMap(({ name, frames }) =>
		frames.flatMap((entry, index) =>
			entry.dir === "in" &&
			/^item\/(commandExecution|fileChange)\/requestApproval$/.test(entry.frame.method)
				? [{ name, index, request: entry.frame, frames }]
				: [],
		),
	);

	test("the recording holds the requests this test is about", () => {
		expect(cases.filter((c) => c.request.method === COMMAND).length).toBeGreaterThanOrEqual(6);
		expect(cases.filter((c) => c.request.method === FILE_CHANGE).length).toBeGreaterThanOrEqual(4);
	});

	for (const { name, index, request, frames } of cases) {
		test(`${name} frame ${index} (${request.method} id ${request.id}): nothing decline-only, the report says what Codex said, and the server's accept is written`, async () => {
			const a = armed();
			const params = request.params;
			const items = frames
				.slice(0, index)
				.filter(
					(entry) =>
						entry.dir === "in" &&
						entry.frame.method === "item/started" &&
						entry.frame.params.item?.type === "fileChange" &&
						entry.frame.params.item.id === params.itemId,
				);
			for (const entry of items) a.feed(entry.frame);
			a.feed(request);
			await settle();

			expect(a.reports).toHaveLength(1);
			const body = a.reports[0].body;
			expect(body.declineOnly).toEqual([]);
			expect(body.threadId).toBe(params.threadId);
			expect(body.turnId).toBe(params.turnId);
			expect(body.itemId).toBe(params.itemId);
			expect(body.rpcId).toBe(JSON.stringify(request.id));
			expect(body.revision).toBe(1);
			if (request.method === COMMAND) {
				expect(body.requestKind).toBe("command");
				expect((body as { command: string }).command).toBe(params.command as string);
				expect((body as { cwd: string }).cwd).toBe(params.cwd as string);
			} else {
				expect(body.requestKind).toBe("file_change");
				expect(items).toHaveLength(1);
				const recorded = items[0].frame.params.item?.changes ?? [];
				const reported = (body as { changes: Array<{ path: string; kind: string; diff: string }> })
					.changes;
				expect(reported.map((c) => [c.path, c.kind, c.diff])).toEqual(
					recorded.map((c) => [c.path, c.kind.type, c.diff]),
				);
			}

			a.script.sync = async () => ({ answers: [answerOf("ap-1", "accept", 1)] });
			await a.tracker.tick();
			expect(a.written).toEqual([{ id: request.id, result: { decision: "accept" } }]);
		});
	}
});
