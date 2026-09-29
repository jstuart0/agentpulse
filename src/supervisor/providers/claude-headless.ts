import type { LaunchRequest } from "../../shared/types.js";
import { loadSupervisorConfig } from "../config.js";
import { reportInSessionSafely } from "../services/report-resilience.js";
import type {
	ClaudePromptAction,
	HeadlessProgressUpdate,
	LaunchCallbacks,
	LaunchMetadata,
} from "./claude-shared.js";
import {
	activityToManagedEvent,
	appendAssistantDelta,
	appendTail,
	buildActionEnv,
	buildActionPrompt,
	buildLaunchBaseArgs,
	buildLaunchEnv,
	buildPrompt,
	buildResumeBaseArgs,
	pushActivity,
	readTextStream,
	sanitizeCliText,
	summarizeStreamLine,
} from "./claude-shared.js";

type HeadlessLaunchMetadata = LaunchMetadata & {
	executionState: "running" | "completed" | "failed";
	output: {
		assistantPreview: string;
		stderrPreview: string;
		activity: Array<{
			kind: "assistant" | "status" | "tool" | "error";
			text: string;
			timestamp: string;
		}>;
		rawEventCount: number;
	};
};

type HeadlessLaunchResult = {
	pid: number;
	metadata: HeadlessLaunchMetadata & { dryRun?: boolean };
	monitor: Promise<void>;
};

// D9/F41: every claude child this process has spawned and not yet reaped,
// keyed by a unique per-launch token (not sessionId — promptClaudeHeadlessSession
// can run a second prompt against the same session after the first
// completes, and a fresh registration must not collide with a stale one).
// disposeAllHeadlessRuntimes() is the fatal-401 cleanup path's onFatal
// (mirrors codex-managed.ts's disposeAllManagedCodexRuntimes): before this
// campaign's D7 added a process.exit(1) path, there was no exit path that
// could orphan a still-running child; D9 closes that regression.
const activeRuntimes = new Map<string, ReturnType<typeof Bun.spawn>>();

/**
 * SIGTERM, then SIGKILL after `graceMs` if the child hasn't exited by then.
 * `graceMs` is a parameter (not a fixed sleep) so tests can drive the
 * SIGKILL branch quickly instead of waiting out a production-sized grace.
 */
async function killProcessWithGrace(
	proc: ReturnType<typeof Bun.spawn>,
	graceMs: number,
): Promise<void> {
	try {
		proc.kill("SIGTERM");
	} catch (err) {
		console.error("[claude-headless] SIGTERM failed during fatal shutdown:", err);
	}
	const exited = await Promise.race([
		proc.exited.then(() => true),
		Bun.sleep(graceMs).then(() => false),
	]);
	if (exited) return;
	try {
		proc.kill("SIGKILL");
	} catch (err) {
		console.error("[claude-headless] SIGKILL failed during fatal shutdown:", err);
	}
}

/**
 * Terminate every headless claude child this process still holds. Used as
 * the onFatal callback for a 401 credential rejection (D7/D9) — before
 * process.exit(1), every spawned child gets SIGTERM, then SIGKILL after
 * `graceMs` for any that don't exit in time. Default grace (2s) is a
 * production value; tests pass a short override.
 */
export async function disposeAllHeadlessRuntimes(graceMs = 2_000): Promise<void> {
	const procs = [...activeRuntimes.values()];
	activeRuntimes.clear();
	await Promise.all(procs.map((proc) => killProcessWithGrace(proc, graceMs)));
}

function createHeadlessMetadata(
	args: string[],
	resolvedExecutable: string,
): HeadlessLaunchMetadata {
	return {
		mode: "headless",
		command: args,
		resolvedExecutable,
		startedAt: new Date().toISOString(),
		executionState: "running",
		output: {
			assistantPreview: "",
			stderrPreview: "",
			activity: [],
			rawEventCount: 0,
		},
	};
}

// Exported for the F25 in-session-reporting-resilience test
// (claude-headless.test.ts) — it's the shared streaming primitive both
// launchClaudeHeadlessRequest and promptClaudeHeadlessSession build on, and
// the natural seam for driving a fake proc through it without spawning a
// real `claude` CLI process.
export async function streamHeadlessClaude(opts: {
	sessionId: string;
	launchRequestId?: string;
	cwd: string;
	model?: string | null;
	configCapabilities: Record<string, unknown>;
	proc: ReturnType<typeof Bun.spawn>;
	metadata: HeadlessLaunchMetadata;
	reportProgress: (update: HeadlessProgressUpdate) => Promise<void>;
	callbacks?: LaunchCallbacks;
	startEvent: {
		eventType: string;
		category: "system_event" | "prompt";
		content: string;
		rawPayload: Record<string, unknown>;
	};
	completionEvent: {
		success: string;
		failurePrefix: string;
		failurePayload?: Record<string, unknown>;
	};
}) {
	const {
		sessionId,
		launchRequestId,
		cwd,
		model,
		configCapabilities,
		proc,
		metadata,
		reportProgress,
		callbacks,
	} = opts;
	let lastReportAt = 0;
	let emittedActivityCount = 0;

	// D9/F41: register this child so a fatal 401 (below) can kill it instead
	// of orphaning it when the process exits.
	const runtimeKey = crypto.randomUUID();
	activeRuntimes.set(runtimeKey, proc);

	// F25/D6/F31/D9: in-session reporting (reportState/reportEvents) now
	// carries an ownership guard and can reject mid-stream (403
	// session_not_owned, a 401 if the credential was revoked or rotated, or
	// any other non-2xx). flushProgress fires from the stdout/stderr line
	// handlers below, which feed `monitor` (returned fire-and-forget as
	// `void result.monitor` for the initial launch — see
	// src/supervisor/index.ts). An uncaught rejection here would propagate
	// through stdoutTask/stderrTask into monitor and surface as an
	// unhandled promise rejection, crashing the supervisor process — the
	// same crash-loop class this campaign fixes, reintroduced through the
	// new 403. reportProgress (the launch-status endpoint) is untouched by
	// the ownership guard, so it keeps its existing behavior. A 401 is
	// fatal: disposeAllHeadlessRuntimes() kills every held child (this one
	// included) before reportInSessionSafely's default process.exit(1);
	// everything else logs and continues.
	function reportInSession(op: string, fn: () => Promise<unknown>): Promise<void> {
		return reportInSessionSafely("claude-headless", sessionId, op, fn, async () => {
			await disposeAllHeadlessRuntimes();
			process.exit(1);
		});
	}

	const flushProgress = async (force = false) => {
		const now = Date.now();
		if (!force && now - lastReportAt < 750) return;
		lastReportAt = now;
		if (callbacks && metadata.output.activity.length > emittedActivityCount) {
			const newActivity = metadata.output.activity.slice(emittedActivityCount);
			emittedActivityCount = metadata.output.activity.length;
			await reportInSession("reportEvents", () =>
				callbacks.reportEvents(newActivity.map(activityToManagedEvent)),
			);
		}
		if (callbacks) {
			await reportInSession("reportState", () =>
				callbacks.reportState({
					sessionId,
					launchRequestId,
					agentType: "claude_code",
					cwd,
					model: model ?? null,
					status: "active",
					managedState: "headless",
					providerSessionId: sessionId,
					correlationSource: "launch_correlation_id",
					providerCapabilitySnapshot: configCapabilities,
					metadata: {
						launchMode: "headless",
						pid: proc.pid ?? null,
						executionState: metadata.executionState,
					},
				}),
			);
		}
		await reportProgress({
			status: "running",
			pid: proc.pid,
			providerLaunchMetadata: metadata,
		});
	};

	if (callbacks) {
		await callbacks.reportState({
			sessionId,
			launchRequestId,
			agentType: "claude_code",
			cwd,
			model: model ?? null,
			status: "active",
			managedState: "headless",
			providerSessionId: sessionId,
			correlationSource: "launch_correlation_id",
			providerCapabilitySnapshot: configCapabilities,
			metadata: {
				launchMode: "headless",
				pid: proc.pid ?? null,
				executionState: "running",
			},
		});
		await callbacks.reportEvents([opts.startEvent]);
	}

	const stdoutTask = readTextStream(proc.stdout as ReadableStream<Uint8Array>, async (line) => {
		const summarized = summarizeStreamLine(line);
		if (!summarized) return;
		metadata.output.rawEventCount += 1;
		if (summarized.assistantDelta) {
			metadata.output.assistantPreview = appendAssistantDelta(
				metadata.output.assistantPreview,
				summarized.assistantDelta,
			);
		}
		if (summarized.activity) {
			metadata.output.activity = pushActivity(metadata.output.activity, summarized.activity);
		}
		await flushProgress();
	});

	const stderrTask = readTextStream(proc.stderr as ReadableStream<Uint8Array>, async (line) => {
		const cleaned = sanitizeCliText(line);
		if (!cleaned) return;
		metadata.output.stderrPreview = appendTail(metadata.output.stderrPreview, `${cleaned}\n`);
		metadata.output.activity = pushActivity(metadata.output.activity, {
			kind: "error",
			text: cleaned,
			timestamp: new Date().toISOString(),
		});
		await flushProgress();
	});

	const monitor = (async () => {
		const [exitCode] = await Promise.all([proc.exited, stdoutTask, stderrTask]);
		// The child has exited on its own — no longer eligible for the fatal
		// cleanup path to kill.
		activeRuntimes.delete(runtimeKey);
		metadata.executionState = exitCode === 0 ? "completed" : "failed";
		metadata.completedAt = new Date().toISOString();
		metadata.exitCode = exitCode;
		metadata.durationMs =
			new Date(metadata.completedAt as string).getTime() - new Date(metadata.startedAt).getTime();

		if (callbacks) {
			if (metadata.output.activity.length > emittedActivityCount) {
				const newActivity = metadata.output.activity.slice(emittedActivityCount);
				emittedActivityCount = metadata.output.activity.length;
				await reportInSession("reportEvents", () =>
					callbacks.reportEvents(newActivity.map(activityToManagedEvent)),
				);
			}
			await reportInSession("reportState", () =>
				callbacks.reportState({
					sessionId,
					launchRequestId,
					agentType: "claude_code",
					cwd,
					model: model ?? null,
					status: exitCode === 0 ? "completed" : "failed",
					managedState: exitCode === 0 ? "completed" : "failed",
					providerSessionId: sessionId,
					correlationSource: "launch_correlation_id",
					providerCapabilitySnapshot: configCapabilities,
					metadata: {
						launchMode: "headless",
						pid: proc.pid ?? null,
						executionState: metadata.executionState,
						exitCode,
					},
				}),
			);
			await reportInSession("reportEvents", () =>
				callbacks.reportEvents([
					{
						eventType:
							exitCode === 0
								? `${opts.completionEvent.success}`
								: opts.completionEvent.failurePrefix,
						category: "system_event",
						content:
							exitCode === 0
								? opts.completionEvent.success === "HeadlessTaskCompleted"
									? "Headless Claude task completed."
									: "Headless follow-up task completed."
								: metadata.output.stderrPreview || `Claude exited with code ${exitCode}`,
						rawPayload:
							exitCode === 0
								? opts.startEvent.rawPayload
								: { ...(opts.completionEvent.failurePayload ?? {}), exitCode },
					},
				]),
			);
		}

		await reportProgress({
			status: exitCode === 0 ? "completed" : "failed",
			pid: proc.pid,
			error:
				exitCode === 0
					? null
					: metadata.output.stderrPreview || `Claude exited with code ${exitCode}`,
			providerLaunchMetadata: metadata,
		});
	})();

	return { pid: proc.pid, metadata, monitor } satisfies HeadlessLaunchResult;
}

export async function launchClaudeHeadlessRequest(
	launch: LaunchRequest,
	reportProgress: (update: HeadlessProgressUpdate) => Promise<void>,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = buildLaunchBaseArgs(launch, executable);
	args.push(
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		buildPrompt(launch),
	);

	const metadata = createHeadlessMetadata(args, executable);

	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		return {
			pid: 0,
			metadata: {
				...metadata,
				dryRun: true,
			},
			monitor: Promise.resolve(),
		} satisfies HeadlessLaunchResult;
	}

	const proc = Bun.spawn({
		cmd: args,
		cwd: launch.cwd,
		env: buildLaunchEnv(launch),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	return streamHeadlessClaude({
		sessionId: launch.launchCorrelationId,
		launchRequestId: launch.id,
		cwd: launch.cwd,
		model: launch.model ?? null,
		configCapabilities: config.capabilities as unknown as Record<string, unknown>,
		proc,
		metadata,
		reportProgress,
		callbacks,
		startEvent: {
			eventType: "HeadlessTaskStarted",
			category: "system_event",
			content: "Headless Claude task started from AgentPulse.",
			rawPayload: { launchMode: "headless", pid: proc.pid ?? null },
		},
		completionEvent: {
			success: "HeadlessTaskCompleted",
			failurePrefix: "HeadlessTaskFailed",
		},
	});
}

export async function promptClaudeHeadlessSession(
	action: ClaudePromptAction,
	reportProgress: (update: HeadlessProgressUpdate) => Promise<void>,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = buildResumeBaseArgs(action, executable);
	args.push(
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		buildActionPrompt(action),
	);

	const metadata = createHeadlessMetadata(args, executable);
	const proc = Bun.spawn({
		cmd: args,
		cwd: action.cwd,
		env: buildActionEnv(action),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	return streamHeadlessClaude({
		sessionId: action.sessionId,
		cwd: action.cwd,
		model: action.model ?? null,
		configCapabilities: config.capabilities as unknown as Record<string, unknown>,
		proc,
		metadata,
		reportProgress,
		callbacks,
		startEvent: {
			eventType: "HeadlessPromptSubmitted",
			category: "prompt",
			content: action.prompt,
			rawPayload: { source: "agentpulse_workspace" },
		},
		completionEvent: {
			success: "HeadlessPromptCompleted",
			failurePrefix: "HeadlessPromptFailed",
			failurePayload: { source: "agentpulse_workspace" },
		},
	});
}
