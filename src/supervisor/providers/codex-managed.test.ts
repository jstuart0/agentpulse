import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../../shared/types.js";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import { configureCodexApprovals, createCodexApprovalTracker } from "./codex-approvals.js";
import {
	INTERRUPT_TIMEOUT_MS,
	_resetWarnedProtocolVersionsForTest,
	launchManagedCodexRequest,
	resolveProviderProtocolVersion,
	shouldPushBootstrapTitle,
	stopManagedCodexSession,
} from "./codex-managed.js";

describe("the first title push after a bootstrap report", () => {
	test("a queued bootstrap never pushes the short-id title; every other outcome does", () => {
		expect(shouldPushBootstrapTitle("queued")).toBe(false);
		for (const outcome of ["sent", "excluded", "blocked", undefined]) {
			expect(shouldPushBootstrapTitle(outcome), String(outcome)).toBe(true);
		}
	});

	test("the launch path asks before it syncs the title, and records no title when it didn't", () => {
		const text = readFileSync(new URL("./codex-managed.ts", import.meta.url), "utf-8");
		expect(text).toMatch(
			/if \(shouldPushBootstrapTitle\(bootstrap\.outcome\)\) \{\s*await syncTitle\(/,
		);
		expect(text).toMatch(/currentThreadTitle: shouldPushBootstrapTitle\(bootstrap\.outcome\)/);
	});
});

describe("resolveProviderProtocolVersion", () => {
	// The warn-once memory is module-level; each test needs to start without it.
	beforeEach(() => _resetWarnedProtocolVersionsForTest());

	test("returns the reported protocolVersion when it's a string", () => {
		expect(resolveProviderProtocolVersion({ protocolVersion: "2026.1" })).toBe("2026.1");
	});

	test("falls back to app-server without warning when protocolVersion is a well-formed string", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			resolveProviderProtocolVersion({ protocolVersion: "app-server" });
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("falls back to app-server and warns once when protocolVersion is missing", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveProviderProtocolVersion({});
			expect(result).toBe("app-server");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("falls back to app-server and warns once when protocolVersion is not a string", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveProviderProtocolVersion({ protocolVersion: 42 });
			expect(result).toBe("app-server");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("does not throw and falls back to app-server when initResult is null or undefined", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(resolveProviderProtocolVersion(null)).toBe("app-server");
			expect(resolveProviderProtocolVersion(undefined)).toBe("app-server");
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("logs once per distinct bad value, not once globally", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			resolveProviderProtocolVersion({ protocolVersion: 99 });
			resolveProviderProtocolVersion({ protocolVersion: 99 });
			expect(warnSpy).toHaveBeenCalledTimes(1);

			resolveProviderProtocolVersion({ protocolVersion: 13 });
			expect(warnSpy).toHaveBeenCalledTimes(2);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("is deterministic for the same initResult — pins the persisted providerProtocolVersion and the runtime protocolVersion (both call in launchManagedCodexRequest) to an identical value", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const initResult = { protocolVersion: "2026.3" };
			const persisted = resolveProviderProtocolVersion(initResult);
			const runtime = resolveProviderProtocolVersion(initResult);
			expect(persisted).toBe(runtime);
			expect(persisted).toBe("2026.3");

			const badInitResult = { protocolVersion: 7 };
			const persistedBad = resolveProviderProtocolVersion(badInitResult);
			const runtimeBad = resolveProviderProtocolVersion(badInitResult);
			expect(persistedBad).toBe(runtimeBad);
			expect(persistedBad).toBe("app-server");
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("interrupt timeout", () => {
	let home: string;
	let logPath: string;
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		"HOME",
		"AGENTPULSE_CODEX_COMMAND",
		"AGENTPULSE_SUPERVISOR_DRY_RUN",
		"FAKE_CODEX_LOG",
		"FAKE_CODEX_REQUESTS",
		"FAKE_CODEX_IGNORE_INTERRUPT",
	];
	beforeAll(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		home = mkdtempSync(join(tmpdir(), "ap-codex-stop-"));
		logPath = join(home, "fake.log");
		process.env.HOME = home;
		process.env.AGENTPULSE_CODEX_COMMAND = installFakeCodex(home);
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
		process.env.FAKE_CODEX_LOG = logPath;
	});
	afterAll(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(home, { recursive: true, force: true });
	});

	async function launchWithPendingRequest() {
		rmSync(logPath, { force: true });
		process.env.FAKE_CODEX_IGNORE_INTERRUPT = "1";
		process.env.FAKE_CODEX_REQUESTS = JSON.stringify([
			{
				method: "item/commandExecution/requestApproval",
				params: { command: "touch x", cwd: home },
			},
		]);
		const id = crypto.randomUUID();
		const result = await launchManagedCodexRequest(
			{
				id: "launch-1",
				launchCorrelationId: id,
				agentType: "codex_cli",
				cwd: home,
				baseInstructions: "",
				taskPrompt: "go",
				model: "m",
				approvalPolicy: null,
				sandboxMode: null,
				requestedLaunchMode: "managed_codex",
				env: {},
				launchSpec: {},
				status: "claimed",
			} as unknown as LaunchRequest,
			{
				reportState: async () => ({ session: { displayName: "n" }, managedSession: {} }),
				reportEvents: async () => {},
			} as never,
		);
		const deadline = Date.now() + 8_000;
		while (!readFakeLog(logPath).some((e) => e.answer) && Date.now() < deadline)
			await Bun.sleep(10);
		return { id, result };
	}

	test("a stop whose turn/interrupt is never answered gives up at the limit, disposes, and leaves the request declined", async () => {
		const { id, result } = await launchWithPendingRequest();

		const began = Date.now();
		await stopManagedCodexSession(id, { interruptTimeoutMs: 150 });
		const took = Date.now() - began;

		const log = readFakeLog(logPath);
		expect(log.some((e) => e.method === "turn/interrupt")).toBe(true);
		expect(took).toBeGreaterThanOrEqual(140);
		expect(took).toBeLessThan(4_000);
		expect(log.filter((e) => e.answer)).toEqual([
			{ answer: { id: 0, result: { decision: "decline" } } },
		]);
		expect(log.some((e) => e.stdinEnd)).toBe(true);
		expect(() => process.kill(result.pid, 0)).toThrow();
		await expect(stopManagedCodexSession(id)).rejects.toThrow(/not available/);
	});
	test("the stop fences approvals before it interrupts the turn", async () => {
		const real = createCodexApprovalTracker();
		const order: string[] = [];
		configureCodexApprovals({
			...real,
			fence: (sessionId) => {
				order.push(
					readFakeLog(logPath).some((e) => e.method === "turn/interrupt")
						? "interrupt then fence"
						: "fence",
				);
				real.fence(sessionId);
			},
		});
		try {
			const { id } = await launchWithPendingRequest();
			await stopManagedCodexSession(id, { interruptTimeoutMs: 100 });
			expect(order).toEqual(["fence"]);
		} finally {
			configureCodexApprovals(null);
		}
	});

	test("with no limit given, turn/interrupt gets 5 s", async () => {
		expect(INTERRUPT_TIMEOUT_MS).toBe(5_000);
		const { id } = await launchWithPendingRequest();
		const began = Date.now();
		await stopManagedCodexSession(id);
		const took = Date.now() - began;
		expect(took).toBeGreaterThanOrEqual(4_900);
		expect(took).toBeLessThan(9_000);
	}, 20_000);
});
