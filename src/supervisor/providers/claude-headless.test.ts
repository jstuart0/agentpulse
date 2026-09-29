/**
 * F25/F32 (2026-09-29-deliver-supervisor-auth-routing): in-session reporting
 * (reportState/reportEvents) inside streamHeadlessClaude's flushProgress /
 * monitor must not let a rejected report (e.g. a mid-session
 * 403 session_not_owned) escape as an unhandled promise rejection or stop
 * later reporting from being attempted. Asserts no unhandledRejection the
 * same way codex-rpc.test.ts does (F32).
 *
 * Drives streamHeadlessClaude directly with a fake `proc` (no real `claude`
 * CLI spawn needed) — the exported seam this campaign added for exactly
 * this test.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { SupervisorRequestError } from "../services/report-resilience.js";
import { streamHeadlessClaude } from "./claude-headless.js";

function fakeProc(stdoutLines: string[], exitCode = 0) {
	const encoder = new TextEncoder();
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of stdoutLines) controller.enqueue(encoder.encode(`${line}\n`));
			controller.close();
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	return {
		pid: 4242,
		stdout,
		stderr,
		exited: Promise.resolve(exitCode),
		// biome-ignore lint/suspicious/noExplicitAny: fake proc only needs the fields streamHeadlessClaude reads
	} as any;
}

function fakeMetadata() {
	return {
		mode: "headless" as const,
		command: [],
		resolvedExecutable: "claude",
		startedAt: new Date().toISOString(),
		executionState: "running" as const,
		output: { assistantPreview: "", stderrPreview: "", activity: [], rawEventCount: 0 },
	};
}

describe("streamHeadlessClaude in-session reporting resilience (F25/F32)", () => {
	test("a reportState rejection (403-shaped) during streaming doesn't crash monitor, and later reports still fire", async () => {
		const unhandledReasons: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		const reportStateCalls: unknown[] = [];
		let reportStateCallCount = 0;

		const proc = fakeProc([JSON.stringify({ type: "tool_use", tool_name: "bash", text: "ls" })]);

		try {
			const result = await streamHeadlessClaude({
				sessionId: "f25-headless-sess",
				launchRequestId: "launch-1",
				cwd: "/tmp",
				model: null,
				configCapabilities: {},
				proc,
				metadata: fakeMetadata(),
				reportProgress: async () => {},
				callbacks: {
					reportState: async (body) => {
						reportStateCallCount++;
						reportStateCalls.push(body);
						// Call 1 is the launch-time bootstrap report — it must keep
						// succeeding (that path isn't the one under test; see D6/F25's
						// "launch-time path keeps its existing failed-status handling").
						// Call 2 is the first in-session (mid-stream) report, which we
						// fail here to prove it doesn't crash the process.
						if (reportStateCallCount === 2) {
							throw new Error("Supervisor request failed: 403 Forbidden");
						}
						return { session: {} as never, managedSession: {} as never };
					},
					reportEvents: async () => {},
				},
				startEvent: {
					eventType: "HeadlessTaskStarted",
					category: "system_event",
					content: "started",
					rawPayload: {},
				},
				completionEvent: {
					success: "HeadlessTaskCompleted",
					failurePrefix: "HeadlessTaskFailed",
				},
			});

			// Must resolve, not reject — the mid-stream reportState failure must
			// not propagate through stdoutTask -> monitor.
			await result.monitor;

			// bootstrap (1, succeeds) + mid-stream flush (2, rejects) + final
			// completion report (3, must still be attempted) — reporting kept
			// going past the in-session failure.
			expect(reportStateCallCount).toBeGreaterThanOrEqual(3);
			expect(unhandledReasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	// F31/D7: a 401 in-session (credential revoked or rotated) is fatal —
	// streamHeadlessClaude's flushProgress routes through
	// reportInSessionSafely with no onFatal override, so the default
	// (process.exit(1)) applies here.
	test("a reportState 401 during streaming exits the process instead of continuing", async () => {
		const unhandledReasons: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		const exitSpy = spyOn(process, "exit").mockImplementation(
			(() => undefined) as unknown as typeof process.exit,
		);

		let reportStateCallCount = 0;
		const proc = fakeProc([JSON.stringify({ type: "tool_use", tool_name: "bash", text: "ls" })]);

		try {
			const result = await streamHeadlessClaude({
				sessionId: "f31-headless-sess",
				launchRequestId: "launch-1",
				cwd: "/tmp",
				model: null,
				configCapabilities: {},
				proc,
				metadata: fakeMetadata(),
				reportProgress: async () => {},
				callbacks: {
					reportState: async () => {
						reportStateCallCount++;
						// Call 1 (bootstrap) succeeds; call 2 (in-session) is the
						// credential rejection under test.
						if (reportStateCallCount === 2) {
							throw new SupervisorRequestError(401, "Unauthorized");
						}
						return { session: {} as never, managedSession: {} as never };
					},
					reportEvents: async () => {},
				},
				startEvent: {
					eventType: "HeadlessTaskStarted",
					category: "system_event",
					content: "started",
					rawPayload: {},
				},
				completionEvent: {
					success: "HeadlessTaskCompleted",
					failurePrefix: "HeadlessTaskFailed",
				},
			});

			await result.monitor;

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(unhandledReasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			exitSpy.mockRestore();
		}
	});
});
