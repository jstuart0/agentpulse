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
		expect(b.epoch).toBeGreaterThan(a.epoch);
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
