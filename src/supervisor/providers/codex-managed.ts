import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	CODEX_SANDBOX_RESPONSE_TYPE,
	LaunchPrivilegeError,
	type ReportedByAgent,
	type ResolvedLaunchPrivileges,
	privilegeMetadata,
	requireLaunchPrivileges,
	sanitizeReportedByAgent,
} from "../../shared/launch-privileges.js";
import { MAX_EVENT_CONTENT_CHARS } from "../../shared/managed-report-limits.js";
import type {
	LaunchRequest,
	ManagedSession,
	ManagedSessionStateInput,
} from "../../shared/types.js";
import { disposeRuntimesAndExit } from "../services/fatal-exit.js";
import type { ReportOutcome } from "../services/report-gate.js";
import { reportInSessionSafely } from "../services/report-resilience.js";
import { uuidV7Millis } from "../services/session-resume.js";
import { canonicalSpawnCwd } from "../services/spawn-cwd.js";
import { type ApprovalLaunch, sharedCodexApprovals } from "./codex-approvals.js";
import {
	type Verdict,
	bindVerdictToUserAgent,
	codexProtocolVerdict,
	resolveCodex,
} from "./codex-protocol.js";
import {
	type CodexAppServer,
	type JsonRpcNotification,
	type RpcClient,
	RpcTimeoutError,
	initializeCodexClient,
	startCodexAppServer,
} from "./codex-rpc.js";
import {
	CodexPromptWithheld,
	CodexResumeError,
	type FollowUp,
	type LaunchCallbacks,
	type ManagedCodexRuntime,
	buildPrompt,
	extractText,
} from "./codex-shared.js";

const runtimes = new Map<string, ManagedCodexRuntime>();

/** The two ids a managed runtime reports under: the launch row and the session it creates. */
type ManagedRuntimeIds = Pick<LaunchRequest, "id" | "launchCorrelationId">;

/** Sessions a launch or a resume is still starting on this host: a prompt for one is not a prompt for a dead process. */
const startingSessions = new Set<string>();

/** Test seam: mark or unmark a session as starting. */
export function _setSessionStartingForTest(sessionId: string, starting: boolean): void {
	if (starting) startingSessions.add(sessionId);
	else startingSessions.delete(sessionId);
}

/**
 * A prompt reached this host for a session it holds no runtime for (the double failure: a state report was
 * lost after a resume, so the server believes it is running). One report, before the prompt is refused:
 * degraded and idle, so the server offers Resume. Never throws; the prompt is refused either way.
 */
async function reportNoRuntime(sessionId: string, callbacks: LaunchCallbacks): Promise<void> {
	try {
		await callbacks.reportState({
			sessionId,
			managedState: "degraded",
			status: "idle",
			providerSyncState: "failed",
			providerSyncError: "This session's Codex process is not running on its host.",
		});
	} catch (error) {
		console.error(
			`[codex-managed] couldn't report a session with no runtime (session=${sessionId}): ${forHostLog(error)}`,
		);
	}
}

/** True when this supervisor holds a live Codex runtime for the session (a Claude action for one is a mismatch). */
export function hasManagedCodexRuntime(sessionId: string): boolean {
	return runtimes.has(sessionId);
}

/** How many managed Codex agents this supervisor is running; the keep-alive rule reads it. */
export function managedCodexRuntimeCount(): number {
	return runtimes.size;
}

/**
 * F31/D7: best-effort cleanup before a fatal (401 credential-rejected) exit
 * — dispose every managed Codex runtime this process still holds (closes
 * the app-server's stdin, then its process group if it lingers) before the
 * process itself exits. Resolves once every child is gone or its escalation
 * has run out; the caller bounds how long it waits.
 */
export async function disposeAllManagedCodexRuntimes(): Promise<void> {
	await Promise.all(
		[...runtimes.values()].map(async (runtime) => {
			try {
				await runtime.dispose();
			} catch (err) {
				console.error("[codex-managed] runtime dispose failed during fatal shutdown:", err);
			}
		}),
	);
}

/** How long a follow-up's `turn/start` gets to answer before the turn is treated as possibly started. */
export const CODEX_TURN_START_TIMEOUT_MS = 15_000;
/** How much of a turn's own error text the host log keeps. */
const HOST_LOG_ERROR_CHARS = 300;

/**
 * Every sentence a follow-up can put in front of a person. Fixed words: the timeline row feeds the watcher's
 * evidence and Telegram, and fixed words can't be read as instructions. Codex's own error text goes to the
 * host log only.
 */
const PROMPT_COPY = {
	// No runtime at all on this host. Its words change (to offer Resume) in the phase that adds the button.
	noRuntime:
		"This session's Codex process isn't running on its host any more. Start a new session for this work.",
	// A runtime that is stopping, closing or gone mid-call: not a dead process, so no Resume to offer.
	stopping:
		"This session's Codex process isn't running on its host any more. Start a new session for this work.",
	busy: "Codex hasn't ended its current turn. Send this again when it ends.",
	uncertain:
		"The last prompt may still be running. Send this again after it ends, or stop the session.",
	timeout:
		"Codex didn't answer in time. The prompt may have started, so check the timeline. Prompts stay blocked until this turn ends or the session is stopped.",
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
} as const;

type TurnEnd = { failed: boolean; content: string; status: string; turnId?: string | null };

/** The one place a turn's status becomes words. Anything unrecognised is a failure with no claim about what happened. */
function endForStatus(status: unknown): Pick<TurnEnd, "failed" | "content" | "status"> {
	const shown = typeof status === "string" && status.length <= 64 ? status : "unknown";
	switch (status) {
		case "completed":
			return { failed: false, content: PROMPT_COPY.completed, status: shown };
		case "failed":
			return { failed: true, content: PROMPT_COPY.failed, status: shown };
		case "interrupted":
			return { failed: true, content: PROMPT_COPY.interrupted, status: shown };
		default:
			return { failed: true, content: PROMPT_COPY.unknownResult, status: shown };
	}
}

/** Reads and clears the running follow-up. Whoever gets it writes its one end event. */
function takeFollowUp(runtime: ManagedCodexRuntime): FollowUp | null {
	const followUp = runtime.followUp;
	runtime.followUp = null;
	return followUp;
}

function emitFollowUpEnd(
	followUp: FollowUp,
	callbacks: LaunchCallbacks,
	end: TurnEnd,
): Promise<unknown> {
	const turnId = end.turnId ?? followUp.turnId;
	return callbacks.reportEvents([
		{
			eventType: end.failed ? "HeadlessPromptFailed" : "HeadlessPromptCompleted",
			category: "system_event",
			content: end.content,
			rawPayload: {
				...(turnId ? { codexTurnId: turnId } : {}),
				status: end.status,
				codexRuntime: true,
			},
		},
	]);
}

/**
 * Reports the session idle, unless something has moved on since the turn this report is about: a stop began
 * (it reports `stopped` itself, and an idle report would overwrite that) or a newer turn started (its flag
 * would be cleared by the older turn's report). The generation, not `turnStarting`, is the test: a launch
 * turn that completes before its reply's continuation still has `turnStarting` set, and this report is the
 * only thing that clears its working state.
 */
async function reportIdle(
	runtime: ManagedCodexRuntime,
	callbacks: LaunchCallbacks,
	generation: number,
	over: Partial<ManagedSessionStateInput> = {},
): Promise<void> {
	if (runtime.stopping || runtime.intentionalClose || runtime.turnGeneration !== generation) return;
	await reportInSessionSafely(
		"codex-managed",
		runtime.sessionId,
		"idle",
		() =>
			callbacks.reportState({
				sessionId: runtime.sessionId,
				launchRequestId: runtime.launchRequestId,
				managedState: "managed",
				status: "idle",
				...over,
			}),
		disposeRuntimesAndExit,
	);
}

/** Text for the host log: no control characters, bounded. */
function forHostLog(value: unknown): string {
	const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += char;
		if (out.length >= HOST_LOG_ERROR_CHARS) break;
	}
	return out.slice(0, HOST_LOG_ERROR_CHARS);
}

const isRequestTimeout = (error: unknown) => error instanceof RpcTimeoutError;

async function emitEndSafely(
	runtime: ManagedCodexRuntime,
	followUp: FollowUp,
	callbacks: LaunchCallbacks,
	end: TurnEnd,
) {
	await reportInSessionSafely(
		"codex-managed",
		runtime.sessionId,
		"turn-end",
		() => emitFollowUpEnd(followUp, callbacks, end),
		disposeRuntimesAndExit,
	);
}

/** How long `turn/interrupt` gets before a stop gives up on it and disposes the runtime anyway. */
export const INTERRUPT_TIMEOUT_MS = 5_000;
/** How long a launch waits for the protocol verdict before it goes on without it. */
const VERDICT_BOOTSTRAP_WAIT_MS = 3_000;

// Log-once per distinct unexpected protocolVersion value so a persistently
// misbehaving app-server doesn't spam logs across every managed launch.
// Module-level and independent of other log-once sets in the codebase (see
// pricing.ts's warnedFallbackModels / event-normalizer.ts's unknown-event set).
const warnedProtocolVersions = new Set<string>();

/** Test hook: forget which values were already warned about. */
export function _resetWarnedProtocolVersionsForTest(): void {
	warnedProtocolVersions.clear();
}

/**
 * Coerce the app-server's `initialize` response into a stored protocol
 * version string. `initResult.protocolVersion` is untyped wire data — when
 * it's missing or not a string, warns once per distinct bad value and falls
 * back to "app-server" (existing behavior). Never throws; the managed
 * launch must proceed regardless of what the app-server reports.
 */
export function resolveProviderProtocolVersion(
	initResult: Record<string, unknown> | null | undefined,
): string {
	const raw = initResult?.protocolVersion;
	if (typeof raw === "string") return raw;

	const key = raw === undefined ? "undefined" : JSON.stringify(raw);
	if (!warnedProtocolVersions.has(key)) {
		warnedProtocolVersions.add(key);
		console.warn(
			`[codex-managed] initialize returned unexpected providerProtocolVersion (${key}); falling back to "app-server".`,
		);
	}
	return "app-server";
}

type ThreadStartResult = {
	thread: { id: string; cwd: string; status: unknown; source: string };
	approvalPolicy?: unknown;
	sandbox?: { type?: unknown } | null;
};

/**
 * The app-server answers thread/start with the policy and sandbox the thread really
 * got. A requested value that doesn't come back identical (a managed requirements file
 * narrowed it, an older server ignored the field) fails the launch rather than running
 * with something other than what was confirmed.
 */
export interface CodexReportedPrivileges {
	approvalPolicy: unknown;
	sandbox: unknown;
	/** workspaceWrite / readOnly extras the app-server reported, so a widened sandbox is visible. */
	networkAccess: boolean | null;
	writableRoots: string[];
	/** True when what Codex reported is broad: no sandbox, approval `never`, or network access on. */
	permissive: boolean;
}

function widenedSandbox(sandbox: ThreadStartResult["sandbox"]): string | null {
	const extras = sandbox as { networkAccess?: unknown; writableRoots?: unknown } | null | undefined;
	if (extras?.networkAccess === true) return "network access is on";
	if (Array.isArray(extras?.writableRoots) && extras.writableRoots.length > 0) {
		return `extra writable roots (${extras.writableRoots.join(", ")})`;
	}
	return null;
}

export function assertCodexThreadPrivileges(
	started: Pick<ThreadStartResult, "approvalPolicy" | "sandbox">,
	privileges: ResolvedLaunchPrivileges,
): CodexReportedPrivileges {
	const wanted = privileges.codexThread ?? {};
	const reportedSandbox = started.sandbox?.type ?? null;
	const widened = widenedSandbox(started.sandbox);
	if (wanted.approvalPolicy !== undefined && started.approvalPolicy !== wanted.approvalPolicy) {
		throw new LaunchPrivilegeError([
			`Codex started the thread with approval policy ${JSON.stringify(started.approvalPolicy ?? null)} instead of '${wanted.approvalPolicy}'.`,
		]);
	}
	if (wanted.sandbox !== undefined) {
		if (reportedSandbox !== CODEX_SANDBOX_RESPONSE_TYPE[wanted.sandbox]) {
			throw new LaunchPrivilegeError([
				`Codex started the thread with sandbox ${JSON.stringify(reportedSandbox)} instead of '${wanted.sandbox}'.`,
			]);
		}
		if (widened && wanted.sandbox !== "danger-full-access") {
			throw new LaunchPrivilegeError([
				`Codex started the thread with sandbox '${wanted.sandbox}' but ${widened}, which is wider than requested.`,
			]);
		}
	}
	const extras = started.sandbox as { networkAccess?: unknown; writableRoots?: unknown } | null;
	return {
		...(sanitizeReportedByAgent({
			approvalPolicy: started.approvalPolicy,
			sandbox: reportedSandbox,
			networkAccess: extras?.networkAccess,
			writableRoots: extras?.writableRoots,
		}) as ReportedByAgent),
		permissive:
			reportedSandbox === "dangerFullAccess" ||
			started.approvalPolicy === "never" ||
			widened !== null,
	} as CodexReportedPrivileges;
}

/** Whether the first title push should happen: not when the bootstrap state was only queued. */
export function shouldPushBootstrapTitle(outcome: string | undefined): boolean {
	return outcome !== "queued";
}

/** The one way a managed Codex session's thread title is pushed and recorded: pending, `thread/name/set`, then synced. */
function makeSyncTitle(
	launch: ManagedRuntimeIds,
	client: RpcClient,
	threadId: string,
	callbacks: LaunchCallbacks,
): (title: string) => Promise<void> {
	return async function syncTitle(title: string) {
		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			providerSessionId: threadId,
			providerThreadId: threadId,
			managedState: "managed",
			desiredThreadTitle: title,
			providerSyncState: "pending",
			providerSyncError: null,
		});

		await client.request("thread/name/set", { threadId, name: title });
		await client.waitForNotification(
			"thread/name/updated",
			(notification) => {
				const params = notification.params as { threadId?: string; threadName?: string };
				return params.threadId === threadId && params.threadName === title;
			},
			5_000,
		);

		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			providerSessionId: threadId,
			providerThreadId: threadId,
			managedState: "managed",
			desiredThreadTitle: title,
			providerThreadTitle: title,
			providerSyncState: "synced",
			providerSyncError: null,
			lastProviderSyncAt: new Date().toISOString(),
		});
	};
}

/** Everything a managed Codex runtime needs besides the thread itself, shared by a launch and a resume. */
interface BuildRuntimeArgs {
	launch: ManagedRuntimeIds;
	client: RpcClient;
	server: CodexAppServer;
	tracker: ReturnType<typeof sharedCodexApprovals>;
	approvals: ReturnType<ReturnType<typeof sharedCodexApprovals>["attachClient"]>;
	threadId: string;
	initResult: Record<string, unknown>;
	currentThreadTitle: string;
	/** True from construction until the first `turn/start` settles; a resume has none to wait for. */
	turnStarting: boolean;
	syncTitle: (title: string) => Promise<void>;
	callbacks: LaunchCallbacks;
}

/** Builds the runtime, wires its notifications and close handling, and registers it. */
function buildManagedRuntime(args: BuildRuntimeArgs): ManagedCodexRuntime {
	const { launch, client, server, tracker, approvals, threadId, initResult, callbacks } = args;
	const runtime: ManagedCodexRuntime = {
		sessionId: launch.launchCorrelationId,
		launchRequestId: launch.id,
		threadId,
		client,
		currentThreadTitle: args.currentThreadTitle,
		protocolVersion: resolveProviderProtocolVersion(initResult),
		activeTurnId: null,
		turnStarting: args.turnStarting,
		turnUncertain: false,
		turnGeneration: 0,
		stopping: false,
		followUp: null,
		lastCompletedTurnId: null,
		intentionalClose: false,
		syncTitle: async (title: string) => {
			await args.syncTitle(title);
			runtime.currentThreadTitle = title;
		},
		dispose: async () => {
			runtime.intentionalClose = true;
			runtimes.delete(launch.launchCorrelationId);
			tracker.dispose(approvals);
			await server.shutdown();
		},
	};

	client.onNotification(async (notification) => {
		// F25/D6: in-session reporting (reportState/reportEvents) can now
		// reject with a 403 session_not_owned, a 401 (credential revoked or
		// rotated, F31/D7), or any other non-2xx, mid-session. Logged and
		// isolated so a rejection here can never become an unhandled
		// rejection or skip later notification branches — except a 401,
		// which is fatal only once the credential tripwire confirms it (see
		// reportInSessionSafely).
		await reportInSessionSafely(
			"codex-managed",
			launch.launchCorrelationId,
			"notification",
			() => handleManagedCodexNotification(notification, launch, runtime, threadId, callbacks),
			disposeRuntimesAndExit,
		);
	});

	client.onClose(async (error) => {
		if (runtime.intentionalClose) {
			runtimes.delete(launch.launchCorrelationId);
			return;
		}
		// A follow-up in flight ends with this close: take it now, before anything awaits, so a rejected
		// turn/start sees it gone and writes nothing of its own.
		const followUp = takeFollowUp(runtime);
		const generation = runtime.turnGeneration;
		// F25/D6: same in-session-reporting hazard as the notification
		// handler above — the control channel is already gone, so there's
		// nothing more useful to do than log (or, for a 401, exit) and
		// finish tearing the runtime down.
		await reportIdle(runtime, callbacks, generation, {
			managedState: "degraded",
			providerSyncState: "failed",
			providerSyncError: error?.message ?? "Codex control channel closed",
		});
		if (followUp) {
			await emitEndSafely(runtime, followUp, callbacks, {
				failed: true,
				content: PROMPT_COPY.closed,
				status: "closed",
			});
		}
		runtimes.delete(launch.launchCorrelationId);
	});

	runtimes.set(launch.launchCorrelationId, runtime);
	return runtime;
}

export async function launchManagedCodexRequest(launch: LaunchRequest, callbacks: LaunchCallbacks) {
	startingSessions.add(launch.launchCorrelationId);
	try {
		return await startManagedCodexLaunch(launch, callbacks);
	} finally {
		startingSessions.delete(launch.launchCorrelationId);
	}
}

async function startManagedCodexLaunch(launch: LaunchRequest, callbacks: LaunchCallbacks) {
	const privileges = requireLaunchPrivileges(
		"codex_cli",
		launch.approvalPolicy,
		launch.sandboxMode,
	);
	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		const threadId = crypto.randomUUID();
		const desiredState = await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "codex_cli",
			cwd: launch.cwd,
			model: launch.model ?? null,
			managedState: "managed",
			providerThreadId: threadId,
			correlationSource: "session_id",
			providerSyncState: "synced",
			providerThreadTitle: `dry-run-${launch.launchCorrelationId.slice(0, 8)}`,
			lastProviderSyncAt: new Date().toISOString(),
			providerProtocolVersion: "dry-run",
		});
		await callbacks.reportEvents([
			{
				eventType: "ManagedSessionStart",
				category: "system_event",
				content: "Managed Codex dry-run session started.",
				rawPayload: { threadId },
			},
		]);
		return {
			pid: 0,
			metadata: { mode: "dry-run", threadId, privileges: privilegeMetadata(privileges) },
			runtime: {
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				threadId,
				client: null,
				currentThreadTitle: desiredState.session.displayName,
				protocolVersion: "dry-run",
				activeTurnId: null,
				turnStarting: false,
				turnUncertain: false,
				turnGeneration: 0,
				stopping: false,
				followUp: null,
				lastCompletedTurnId: null,
				intentionalClose: false,
				syncTitle: async () => {},
				dispose: async () => {},
			} satisfies ManagedCodexRuntime,
		};
	}

	const { binary, serverUrl } = await resolveCodex();
	// Started before the spawn so a cold schema run overlaps it; it never rejects.
	const verdictPromise = codexProtocolVerdict(binary, serverUrl);
	const server = await startCodexAppServer({ executable: binary.path });
	const { client } = server;
	const tracker = sharedCodexApprovals();
	const reportApprovalWarning: ApprovalLaunch["warn"] = (content, detail) =>
		reportInSessionSafely(
			"codex-managed",
			launch.launchCorrelationId,
			"approval-warning",
			() =>
				callbacks.reportEvents([
					{
						eventType: "ManagedWarning",
						category: "system_event",
						content,
						rawPayload: { source: "approval_tracker", ...detail },
					},
				]),
			disposeRuntimesAndExit,
		);
	// Before `initialize`, so every way the launch can fail from here on is covered by the client's close.
	const approvals = tracker.attachClient(client, {
		sessionId: launch.launchCorrelationId,
		cwd: launch.cwd,
		warn: reportApprovalWarning,
	});
	let runtimeRef: ManagedCodexRuntime | undefined;
	let startEventSent = false;

	try {
		const initResult = await initializeCodexClient<Record<string, unknown>>(client, {
			clientInfo: {
				name: "agentpulse-supervisor",
				title: "AgentPulse Supervisor",
				version: "0.1.0",
			},
			capabilities: {
				experimentalApi: true,
			},
		});

		const boundVerdict: Promise<Verdict> = verdictPromise.then((verdict) =>
			bindVerdictToUserAgent(verdict, binary, serverUrl, initResult.userAgent),
		);
		const earlyVerdict = await Promise.race([
			boundVerdict,
			Bun.sleep(VERDICT_BOOTSTRAP_WAIT_MS).then(() => null),
		]);
		const noteVerdict = (verdict: Verdict) => {
			tracker.setVerdict(approvals, verdict);
			if (verdict.verdict === "supported") return;
			void reportApprovalWarning(
				"AgentPulse can't answer this Codex version's approval requests, so they are declined automatically.",
				{ method: "protocol", reason: verdict.reason },
			);
		};

		const started = await client.request<ThreadStartResult>("thread/start", {
			cwd: launch.cwd,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
			sessionStartSource: "startup",
			...privileges.codexThread,
		});
		const threadId = started.thread.id;
		const reportedByAgent = assertCodexThreadPrivileges(started, privileges);
		// Recovery's proof of which thread this supervisor started for the launch, written before the first
		// report so no report can name a thread the record doesn't. A record that can't be written never fails a launch.
		try {
			callbacks.recordThread?.(launch.id, threadId);
		} catch (error) {
			console.error(
				`[codex-managed] couldn't record the thread (launch=${launch.id}): ${forHostLog(error)}`,
			);
		}

		const bootstrap = await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "codex_cli",
			cwd: launch.cwd,
			model: launch.model ?? null,
			status: "active",
			managedState: "managed",
			providerSessionId: threadId,
			providerThreadId: threadId,
			correlationSource: "session_id",
			providerProtocolVersion: resolveProviderProtocolVersion(initResult),
			providerCapabilitySnapshot: {
				...initResult,
				...(earlyVerdict ? { agentpulseApprovals: earlyVerdict.verdict } : {}),
			},
			providerSyncState: "pending",
		});
		if (earlyVerdict) noteVerdict(earlyVerdict);
		else {
			// Not ready at bootstrap: the tracker declines in the meantime, and a follow-up report carries it.
			void boundVerdict.then(async (verdict) => {
				if (client.isClosed) return;
				noteVerdict(verdict);
				await reportInSessionSafely(
					"codex-managed",
					launch.launchCorrelationId,
					"approvals-verdict",
					() =>
						callbacks.reportState({
							sessionId: launch.launchCorrelationId,
							launchRequestId: launch.id,
							managedState: "managed",
							providerCapabilitySnapshot: { ...initResult, agentpulseApprovals: verdict.verdict },
						}),
					disposeRuntimesAndExit,
				);
			});
		}

		const syncTitle = makeSyncTitle(launch, client, threadId, callbacks);

		// A queued bootstrap has no server name to go by: pushing the short id as the thread's title would
		// stick. The title is left for reconcileManagedCodexTitles, once the server has the session.
		if (shouldPushBootstrapTitle(bootstrap.outcome)) {
			await syncTitle(bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8));
		}

		const runtime = buildManagedRuntime({
			launch,
			client,
			server,
			tracker,
			approvals,
			threadId,
			initResult,
			currentThreadTitle: shouldPushBootstrapTitle(bootstrap.outcome)
				? bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8)
				: "",
			// The launch's own turn/start is still to come: nothing may start a turn before it settles.
			turnStarting: true,
			syncTitle,
			callbacks,
		});
		runtimeRef = runtime;

		await callbacks.reportEvents([
			{
				eventType: "ManagedSessionStart",
				category: "system_event",
				content: "Managed Codex session started.",
				// The marker is what lets the server read this as the start of a real turn (a dry run has none).
				rawPayload: { threadId, codexRuntime: true },
			},
		]);
		startEventSent = true;

		const prompt = buildPrompt(launch);
		const turn = await client.request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [{ type: "text", text: prompt }],
			cwd: launch.cwd,
			model: launch.model ?? undefined,
		});
		// A turn that already ended (its completion came before this reply) must not be left marked active.
		if (runtime.lastCompletedTurnId !== turn.turn.id) runtime.activeTurnId = turn.turn.id;
		runtime.turnStarting = false;

		return {
			pid: server.pid,
			metadata: {
				mode: "managed_codex",
				threadId,
				privileges: {
					...privilegeMetadata(privileges),
					reportedByAgent,
					permissive: reportedByAgent.permissive,
				},
			},
			runtime,
		};
	} catch (error) {
		// A launch that failed after its start event left the server believing a turn is running.
		if (startEventSent) {
			await reportInSessionSafely(
				"codex-managed",
				launch.launchCorrelationId,
				"launch-failed",
				() =>
					callbacks.reportState({
						sessionId: launch.launchCorrelationId,
						launchRequestId: launch.id,
						managedState: "degraded",
						providerSyncState: "failed",
						providerSyncError: error instanceof Error ? error.message : "Codex launch failed",
						status: "idle",
					}),
				disposeRuntimesAndExit,
			);
		}
		// Whatever failed, the child goes through the same shutdown as every other path.
		if (runtimeRef) runtimeRef.intentionalClose = true;
		runtimes.delete(launch.launchCorrelationId);
		tracker.dispose(approvals);
		await server.shutdown();
		throw error;
	}
}

/**
 * Starts a new turn on a managed Codex session's live thread (AGEN-91). The wire shape is exactly
 * `{threadId, input}`: the thread's approval policy, sandbox, directory and model were set and verified when
 * it started and are sticky, so a follow-up carries no override that could widen them.
 *
 * It refuses, with fixed words and nothing sent, whenever it can't be sure a turn isn't running: Codex may
 * steer an active turn rather than fail a second `turn/start`, so "busy" is judged here, in the one process
 * that holds the thread. At most one `turn/start` is in flight per runtime.
 *
 * Order: refuse or claim the runtime (synchronously), report the prompt (so agent messages can't land ahead
 * of it), check nothing changed meanwhile, then `turn/start`. Whoever takes `followUp` writes the turn's one
 * end event.
 */
export async function promptManagedCodexSession(
	input: { sessionId: string; prompt: string },
	callbacks: LaunchCallbacks,
	options: { turnStartTimeoutMs?: number } = {},
): Promise<{ metadata: Record<string, unknown> }> {
	const { sessionId, prompt } = input;
	const runtime = runtimes.get(sessionId);
	const client = runtime?.client;
	if (!runtime) {
		// This host holds nothing for a session the server believes is running: tell it, so the person is
		// offered Resume (a launch or resume for the id still starting is not a dead process).
		if (!startingSessions.has(sessionId)) await reportNoRuntime(sessionId, callbacks);
		throw new Error(PROMPT_COPY.noRuntime);
	}
	if (!client || client.isClosed || runtime.intentionalClose || runtime.stopping) {
		throw new Error(PROMPT_COPY.stopping);
	}
	if (runtime.turnUncertain) throw new Error(PROMPT_COPY.uncertain);
	if (runtime.activeTurnId || runtime.turnStarting) throw new Error(PROMPT_COPY.busy);
	if (prompt.length > MAX_EVENT_CONTENT_CHARS) throw new Error(PROMPT_COPY.tooLong);

	// No await between the checks above and these writes: two prompts can't both pass.
	const followUp: FollowUp = { turnId: null };
	runtime.turnStarting = true;
	runtime.followUp = followUp;
	runtime.turnGeneration += 1;
	const generation = runtime.turnGeneration;
	const stillMine = () => runtime.followUp === followUp;
	const undo = () => {
		runtime.turnStarting = false;
		if (stillMine()) runtime.followUp = null;
	};
	const writeEnd = (end: TurnEnd) => emitEndSafely(runtime, followUp, callbacks, end);

	let outcome: ReportOutcome | undefined;
	try {
		outcome = await callbacks.reportEvents([
			{
				eventType: "HeadlessPromptSubmitted",
				category: "prompt",
				content: prompt,
				rawPayload: { source: "agentpulse_workspace", codexRuntime: true },
			},
		]);
	} catch (error) {
		// The server may or may not have the event, so nothing was sent and the working flag it may have set is cleared.
		undo();
		console.error(
			`[codex-managed] couldn't record a follow-up prompt (session=${sessionId}): ${forHostLog(error)}`,
		);
		await reportIdle(runtime, callbacks, generation);
		throw new Error(PROMPT_COPY.notRecorded);
	}
	// Only a recorded prompt goes on: anything else (including an outcome this code has never heard of) is withheld.
	if (outcome !== "sent" && outcome !== "queued") {
		undo();
		throw new CodexPromptWithheld();
	}

	if (
		runtimes.get(sessionId) !== runtime ||
		client.isClosed ||
		runtime.stopping ||
		runtime.intentionalClose
	) {
		const taken = stillMine();
		undo();
		if (taken) await writeEnd({ failed: true, content: PROMPT_COPY.stopped, status: "not_sent" });
		throw new Error(PROMPT_COPY.stopping);
	}
	// Codex spoke up while the prompt was being recorded (a turn started or went uncertain): sending now could steer it.
	if (runtime.activeTurnId || runtime.turnUncertain) {
		const taken = stillMine();
		undo();
		if (taken)
			await writeEnd({ failed: true, content: PROMPT_COPY.notSentBusy, status: "not_sent" });
		throw new Error(PROMPT_COPY.busy);
	}

	const markUncertain = (): never => {
		// The turn may exist and a second turn/start could steer it: nothing more is sent until Codex says
		// so (turn/started or turn/completed), the channel closes, or the session is stopped.
		runtime.turnUncertain = true;
		runtime.turnStarting = false;
		throw new Error(PROMPT_COPY.timeout);
	};

	let started: { turn?: { id?: unknown } } | undefined;
	try {
		started = await client.request<{ turn?: { id?: unknown } }>(
			"turn/start",
			{ threadId: runtime.threadId, input: [{ type: "text", text: prompt }] },
			{ timeoutMs: options.turnStartTimeoutMs ?? CODEX_TURN_START_TIMEOUT_MS },
		);
	} catch (error) {
		if (isRequestTimeout(error)) return markUncertain();
		console.error(`[codex-managed] turn/start failed (session=${sessionId}): ${forHostLog(error)}`);
		const taken = stillMine();
		undo();
		if (client.isClosed) {
			// An unplanned close took the follow-up and wrote its end; a planned one leaves it to us.
			if (taken) await writeEnd({ failed: true, content: PROMPT_COPY.stopped, status: "not_sent" });
			throw new Error(PROMPT_COPY.stopping);
		}
		if (taken) await writeEnd({ failed: true, content: PROMPT_COPY.rejected, status: "rejected" });
		throw new Error(PROMPT_COPY.rejected);
	}

	const turnId = started?.turn?.id;
	if (typeof turnId !== "string" || !turnId) return markUncertain();

	if (stillMine()) followUp.turnId = turnId;
	// The turn may already have ended (its completion came before this reply).
	if (runtime.lastCompletedTurnId !== turnId) runtime.activeTurnId = turnId;
	runtime.turnStarting = false;
	return { metadata: { mode: "managed_codex", threadId: runtime.threadId, turnId } };
}

/**
 * F25: extracted from the inline `client.onNotification` callback so the
 * caller can wrap the whole dispatch in one try/catch. Each branch may call
 * `callbacks.reportState`/`reportEvents`, which now carry an ownership guard
 * (session_not_owned) and can reject mid-session.
 */
async function handleManagedCodexNotification(
	notification: JsonRpcNotification,
	launch: ManagedRuntimeIds,
	runtime: ManagedCodexRuntime,
	threadId: string,
	callbacks: LaunchCallbacks,
) {
	if (notification.method === "thread/name/updated") {
		const params = notification.params as { threadId?: string; threadName?: string };
		if (params.threadId === threadId && params.threadName) {
			runtime.currentThreadTitle = params.threadName;
			await callbacks.reportState({
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				providerSessionId: threadId,
				providerThreadId: threadId,
				managedState: "managed",
				desiredThreadTitle: params.threadName,
				providerThreadTitle: params.threadName,
				providerSyncState: "synced",
				lastProviderSyncAt: new Date().toISOString(),
			});
		}
		return;
	}

	if (notification.method === "item/completed") {
		const params = notification.params as Record<string, unknown>;
		const item = (params.item ?? null) as Record<string, unknown> | null;
		const itemType = typeof item?.type === "string" ? item.type : "";
		const text = extractText(item);
		if ((itemType === "agentMessage" || itemType === "exitedReviewMode") && text.trim()) {
			await callbacks.reportEvents([
				{
					eventType: "ManagedAgentMessage",
					category: "assistant_message",
					content: text.trim(),
					rawPayload: { notification },
				},
			]);
		}
		return;
	}

	if (notification.method === "warning") {
		const params = notification.params as { message?: string };
		if (params.message) {
			await callbacks.reportEvents([
				{
					eventType: "ManagedWarning",
					category: "system_event",
					content: params.message,
					rawPayload: { notification },
				},
			]);
		}
		return;
	}

	if (notification.method === "turn/started") {
		const params = notification.params as
			| { threadId?: unknown; turn?: { id?: unknown } }
			| undefined;
		const turnId = params?.turn?.id;
		if (params?.threadId !== threadId || typeof turnId !== "string" || !turnId) return;
		if (turnId === runtime.lastCompletedTurnId) return;
		// Codex has said the turn exists: no longer uncertain, and now known to be running.
		runtime.turnUncertain = false;
		if (!runtime.activeTurnId) runtime.activeTurnId = turnId;
		if (runtime.followUp && !runtime.followUp.turnId) runtime.followUp.turnId = turnId;
		return;
	}

	if (notification.method === "turn/completed") {
		const params = notification.params as
			| { threadId?: unknown; turn?: { id?: unknown; status?: unknown; error?: unknown } }
			| undefined;
		// Another thread's turn (a subagent's, say) ends nothing of ours.
		if (params?.threadId !== threadId) return;
		const turn = params.turn;
		// The schema allows `inProgress` here. Only a status known to be nonterminal is ignored; a missing or
		// unrecognised one still ends the turn as a failure with no claim about what happened (endForStatus).
		if (turn?.status === "inProgress") {
			console.error(
				`[codex-managed] ignored a turn/completed whose status is inProgress (session=${runtime.sessionId}); the turn is treated as still running`,
			);
			return;
		}
		const turnId = typeof turn?.id === "string" && turn.id ? turn.id : null;
		if (turnId && runtime.activeTurnId && turnId !== runtime.activeTurnId) return;
		// A turn already known to have ended ends nothing now.
		if (turnId && turnId === runtime.lastCompletedTurnId) return;

		// All of this is synchronous: nothing else may observe the runtime between the clears and the take.
		if (turnId) runtime.lastCompletedTurnId = turnId;
		runtime.activeTurnId = null;
		runtime.turnUncertain = false;
		const followUp = takeFollowUp(runtime);
		const generation = runtime.turnGeneration;

		if (followUp) {
			const error = (turn?.error ?? null) as { message?: unknown } | null;
			if (error?.message) {
				console.error(
					`[codex-managed] turn ended with an error (session=${runtime.sessionId}): ${forHostLog(error.message)}`,
				);
			}
			await emitEndSafely(runtime, followUp, callbacks, { ...endForStatus(turn?.status), turnId });
		}
		await reportIdle(runtime, callbacks, generation);
	}
}

export async function stopManagedCodexSession(
	sessionId: string,
	options: { interruptTimeoutMs?: number } = {},
) {
	// Anything still held is declined now, so nothing is let through while the turn is being stopped. This
	// comes before the runtime lookup: a stop for a session whose runtime isn't in the map still fences.
	sharedCodexApprovals().fence(sessionId);

	const runtime = runtimes.get(sessionId);
	if (!runtime) {
		throw new Error("Managed Codex runtime is not available on this supervisor.");
	}
	// Before the interrupt, which can take seconds: nothing new may be sent, and no idle report may overwrite
	// the state the stop is about to write.
	runtime.stopping = true;

	if (runtime.client && runtime.activeTurnId) {
		try {
			await runtime.client.request(
				"turn/interrupt",
				{ threadId: runtime.threadId, turnId: runtime.activeTurnId },
				{ timeoutMs: options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS },
			);
		} catch {
			// Fall through to cleanup even if interrupt fails or never answers.
		}
	}

	await runtime.dispose();
}

export async function reconcileManagedCodexTitles(
	managedSessions: ManagedSession[],
	reportState: LaunchCallbacks["reportState"],
) {
	for (const managedSession of managedSessions) {
		const runtime = runtimes.get(managedSession.sessionId);
		if (!runtime || !managedSession.desiredThreadTitle) continue;
		if (runtime.currentThreadTitle === managedSession.desiredThreadTitle) continue;
		try {
			await runtime.syncTitle(managedSession.desiredThreadTitle);
		} catch (error) {
			await reportState({
				sessionId: managedSession.sessionId,
				launchRequestId: managedSession.launchRequestId,
				providerSessionId: runtime.threadId,
				providerThreadId: runtime.threadId,
				managedState: "degraded",
				desiredThreadTitle: managedSession.desiredThreadTitle,
				providerThreadTitle: runtime.currentThreadTitle,
				providerSyncState: "failed",
				providerSyncError: error instanceof Error ? error.message : "Rename sync failed",
			});
		}
	}
}

// ── resume (AGEN-115) ───────────────────────────────────────────────────────

/** What a takeover's answer must say about the sandbox, key for key: Codex reports a project config's extras here. */
const WORKSPACE_WRITE_SANDBOX = {
	type: "workspaceWrite",
	writableRoots: [] as string[],
	networkAccess: false,
	excludeTmpdirEnvVar: false,
	excludeSlashTmp: false,
};

/** The whole answered sandbox object equals the one measured shape: an extra key, root or flag is a refusal. */
function assertExactWorkspaceWriteSandbox(sandbox: unknown): void {
	const answered = (sandbox ?? {}) as Record<string, unknown>;
	const keys = Object.keys(answered).sort();
	const wanted = Object.keys(WORKSPACE_WRITE_SANDBOX).sort();
	const same =
		keys.length === wanted.length &&
		keys.every((key, i) => key === wanted[i]) &&
		answered.type === WORKSPACE_WRITE_SANDBOX.type &&
		Array.isArray(answered.writableRoots) &&
		answered.writableRoots.length === 0 &&
		answered.networkAccess === false &&
		answered.excludeTmpdirEnvVar === false &&
		answered.excludeSlashTmp === false;
	if (!same)
		throw new CodexResumeError("privileges", "the answered sandbox is not the one asked for");
}

/** Whether anything is at this path, by `lstat` so a symlink (dangling included), a directory or a FIFO counts; never reads or opens it. Any other error fails closed. */
function entryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/**
 * Whether a project `.codex/config.toml` could apply to a thread whose directory is `real`: in it, or in a
 * parent up to the git root, or the trusted root when there is no git root. Measured (codex-resume.real.test.ts):
 * Codex applies such a file at `thread/resume` once the user trusts the directory, and starts its MCP servers
 * there, before anything this host could compare in the answer. So the file's presence is the refusal and
 * trust is not an allow signal (D7). The walk to the git root is cheap and fails closed whether or not
 * Codex layers a parent's file (the real test records which it does).
 */
function projectConfigPresent(real: string, trustedRoots: string[]): boolean {
	const roots = trustedRoots.map((root) => {
		try {
			return realpathSync(root);
		} catch {
			return resolvePath(root);
		}
	});
	for (let dir = real; ; dir = dirname(dir)) {
		if (entryExists(join(dir, ".codex", "config.toml"))) return true;
		if (entryExists(join(dir, ".git"))) return false;
		if (roots.includes(dir) || dirname(dir) === dir) return false;
	}
}

/**
 * Codex's refusal because another process holds the thread. This is the one place a Codex error's wording
 * picks a kind, and it only picks words: either way no resume happened and the process is disposed.
 */
function isActiveWriterRefusal(error: unknown): boolean {
	const text = error instanceof Error ? error.message : "";
	return /active writer/.test(text) && /\(-32600\)\s*$/.test(text);
}

export interface ResumeInput {
	sessionId: string;
	launchRequestId: string;
	threadId: string;
	/** The server's validated guess, already canonical. Never authority: the thread's own directory is read first. */
	candidateCwd: string;
	privileges: ResolvedLaunchPrivileges;
	resumeKind: "takeover" | "recovery";
	resumeActionId: string;
	/** The session's name as the person sees it; the runtime's title, so nothing renames their thread. */
	sessionName: string;
	/**
	 * A recovery of a session this host has no record of: it is believed only if the thread was started by this
	 * supervisor's own client (its `originator`) before the record existed.
	 */
	preUpgrade?: { createdAtMs: number };
}

export interface ResumeCallbacks extends LaunchCallbacks {
	/** The verified-empty fixed directory the app-server runs in. Throws a CodexResumeError("rejected") when it can't be used. */
	neutralCwd(): Promise<string>;
	noteLaunch(launchId: string, sessionId: string, cwd: string): boolean;
	verdict(sessionId: string, cwd: string): string;
	verdictForDirectory(cwd: string): string;
	forgetLaunch(launchId: string, sessionId: string): void;
	reportResumeState(body: ManagedSessionStateInput): Promise<ReportOutcome>;
	recordThread(launchId: string, threadId: string): void;
	trustedRoots: string[];
}

type ThreadAnswer = { thread?: { id?: unknown; cwd?: unknown }; cwd?: unknown };

/**
 * Resumes a Codex thread this host holds a rollout for, under fixed privileges, in a process that nothing
 * else can talk to (D11 steps 6 to 14). Order, and why:
 * 6 the protocol verdict (a takeover on a Codex whose approvals can't be answered is refused, before any
 *   process); 7 spawn in the fixed empty directory with NO approval tracker, and `thread/read` (which opens
 *   nothing in the thread's directory) learns the real directory; 8 judge it (it must exist, be inside the
 *   trusted roots, not be excluded and equal the candidate; a takeover also refuses a project config the user
 *   hasn't trusted); 9 note the launch with the gate; 10 only now attach the tracker; 11 `thread/resume` with
 *   the privileges and NEVER a `cwd` (a `cwd` rewrites the thread's directory for good); 12 check the whole
 *   answer; 13 report, live only; 14 register the runtime, then record the thread.
 * Every failure after the spawn shuts the process down through the one shutdown, and after step 9 forgets the
 * launch. Nothing is reported before the runtime is certain, and the runtime joins the map only after the
 * report was sent.
 */
export async function resumeManagedCodexSession(
	input: ResumeInput,
	callbacks: ResumeCallbacks,
	deps: { timeoutMs?: number } = {},
): Promise<{ pid: number; metadata: Record<string, unknown> }> {
	startingSessions.add(input.sessionId);
	try {
		return await runResume(input, callbacks, deps);
	} finally {
		startingSessions.delete(input.sessionId);
	}
}

async function runResume(
	input: ResumeInput,
	callbacks: ResumeCallbacks,
	deps: { timeoutMs?: number },
): Promise<{ pid: number; metadata: Record<string, unknown> }> {
	const { sessionId, launchRequestId, threadId, privileges } = input;
	const takeover = input.resumeKind === "takeover";
	const timeoutMs = deps.timeoutMs ?? 15_000;

	const { binary, serverUrl } = await resolveCodex();
	const early = await codexProtocolVerdict(binary, serverUrl);
	if (takeover && early.verdict !== "supported") throw new CodexResumeError("unsupported_codex");

	const neutral = await callbacks.neutralCwd();
	// No AGENTPULSE_* name reaches Codex (it needs none, and this process holds the supervisor's own settings);
	// everything else is kept, because a person's provider or proxy variables are theirs.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("AGENTPULSE_")),
	);
	const server = await startCodexAppServer({ executable: binary.path, cwd: neutral, env });
	const { client } = server;
	const tracker = sharedCodexApprovals();
	let approvals: ReturnType<typeof tracker.attachClient> | null = null;
	let noted = false;

	try {
		const initResult = await initializeCodexClient<Record<string, unknown>>(client, {
			clientInfo: {
				name: "agentpulse-supervisor",
				title: "AgentPulse Supervisor",
				version: "0.1.0",
			},
			capabilities: { experimentalApi: true },
		});
		const bound = await bindVerdictToUserAgent(early, binary, serverUrl, initResult.userAgent);
		if (takeover && bound.verdict !== "supported") throw new CodexResumeError("unsupported_codex");

		// 7: what the thread's directory really is. Any failure is "missing", but a timeout is not.
		let read: ThreadAnswer;
		try {
			read = await client.request<ThreadAnswer>(
				"thread/read",
				{ threadId, includeTurns: false },
				{ timeoutMs },
			);
		} catch (error) {
			console.error(
				`[codex-resume] thread/read failed (session=${sessionId}): ${forHostLog(error)}`,
			);
			throw new CodexResumeError(isRequestTimeout(error) ? "timeout" : "missing");
		}
		if (read?.thread?.id !== threadId || typeof read.thread.cwd !== "string") {
			throw new CodexResumeError("missing", "thread/read answered something else");
		}

		if (input.preUpgrade) {
			const originator = (read.thread as { originator?: unknown }).originator;
			const startedAt = uuidV7Millis(threadId);
			if (
				originator !== "agentpulse-supervisor" ||
				startedAt === null ||
				startedAt >= input.preUpgrade.createdAtMs
			) {
				throw new CodexResumeError("thread_unverified", "not provably started by this supervisor");
			}
		}

		// 8: the real directory, judged before anything acts in it.
		let real: string;
		try {
			real = await canonicalSpawnCwd(read.thread.cwd, callbacks.trustedRoots);
		} catch (error) {
			throw new CodexResumeError("cwd_mismatch", forHostLog(error));
		}
		if (callbacks.verdictForDirectory(real) !== "send") {
			throw new CodexResumeError(
				"cwd_mismatch",
				"the real directory is excluded or unreadable by the rules",
			);
		}
		if (real !== input.candidateCwd) {
			throw new CodexResumeError("cwd_mismatch", "the thread's directory is not the candidate");
		}
		if (projectConfigPresent(real, callbacks.trustedRoots)) {
			throw new CodexResumeError("project_config");
		}

		// 9
		if (!callbacks.noteLaunch(launchRequestId, sessionId, real)) {
			throw new CodexResumeError("rejected", "the gate would not note the launch");
		}
		noted = true;
		if (callbacks.verdict(sessionId, real) !== "send") {
			throw new CodexResumeError("rejected", "the gate would not let this session report");
		}

		// 10: the tracker, only now, so nothing could be approved while the directory was still being judged.
		const warn: ApprovalLaunch["warn"] = (content, detail) =>
			reportInSessionSafely(
				"codex-managed",
				sessionId,
				"approval-warning",
				() =>
					callbacks.reportEvents([
						{
							eventType: "ManagedWarning",
							category: "system_event",
							content,
							rawPayload: { source: "approval_tracker", ...detail },
						},
					]),
				disposeRuntimesAndExit,
			);
		approvals = tracker.attachClient(client, { sessionId, cwd: real, warn });
		tracker.setVerdict(approvals, bound);

		// 11
		let resumed: ThreadAnswer & { approvalPolicy?: unknown; sandbox?: { type?: unknown } | null };
		try {
			resumed = await client.request(
				"thread/resume",
				{ threadId, excludeTurns: true, ...privileges.codexThread },
				{ timeoutMs },
			);
		} catch (error) {
			console.error(
				`[codex-resume] thread/resume failed (session=${sessionId}): ${forHostLog(error)}`,
			);
			if (isRequestTimeout(error)) throw new CodexResumeError("timeout");
			throw new CodexResumeError(isActiveWriterRefusal(error) ? "running" : "rejected");
		}

		// 12
		try {
			assertCodexThreadPrivileges(resumed, privileges);
			if (privileges.codexThread?.sandbox === "workspace-write") {
				assertExactWorkspaceWriteSandbox(resumed.sandbox);
			}
		} catch (error) {
			if (error instanceof CodexResumeError) throw error;
			throw new CodexResumeError("privileges", forHostLog(error));
		}
		const answeredCwd = typeof resumed.cwd === "string" ? resumed.cwd : resumed.thread?.cwd;
		let answeredReal: string | null = null;
		try {
			answeredReal =
				typeof answeredCwd === "string"
					? await canonicalSpawnCwd(answeredCwd, callbacks.trustedRoots)
					: null;
		} catch {
			answeredReal = null;
		}
		if (answeredReal !== real)
			throw new CodexResumeError("cwd_mismatch", "the answered directory changed");

		// 13: live only. Anything but "sent" means the server doesn't know this session is running.
		const outcome = await callbacks.reportResumeState({
			sessionId,
			launchRequestId,
			managedState: "managed",
			status: "idle",
			providerSessionId: threadId,
			providerThreadId: threadId,
			correlationSource: "session_id",
			providerProtocolVersion: resolveProviderProtocolVersion(initResult),
			providerCapabilitySnapshot: { ...initResult, agentpulseApprovals: bound.verdict },
			providerSyncState: "synced",
			lastProviderSyncAt: new Date().toISOString(),
			clearProviderSyncError: true,
			resumeActionId: input.resumeActionId,
		});
		if (outcome !== "sent") {
			throw new CodexResumeError("rejected", `the state report was ${outcome}`);
		}

		// 14: the runtime joins now. Its title is the session's own name, so the first reconcile renames nothing.
		buildManagedRuntime({
			launch: { id: launchRequestId, launchCorrelationId: sessionId },
			client,
			server,
			tracker,
			approvals,
			threadId,
			initResult,
			currentThreadTitle: input.sessionName,
			turnStarting: false,
			syncTitle: makeSyncTitle(
				{ id: launchRequestId, launchCorrelationId: sessionId },
				client,
				threadId,
				callbacks,
			),
			callbacks,
		});
		try {
			callbacks.recordThread(launchRequestId, threadId);
		} catch (error) {
			console.error(
				`[codex-resume] couldn't record the thread (session=${sessionId}): ${forHostLog(error)}`,
			);
		}
		return { pid: server.pid, metadata: { mode: "managed_codex", threadId, resumed: true } };
	} catch (error) {
		runtimes.delete(sessionId);
		if (approvals) tracker.dispose(approvals);
		await server.shutdown();
		if (noted) callbacks.forgetLaunch(launchRequestId, sessionId);
		throw error;
	}
}

/** The runtime holding this id as its session id or its thread id, if this host has one: a takeover of it would be a second writer. */
export function managedCodexRuntimeHolds(id: string): boolean {
	for (const runtime of runtimes.values()) {
		if (runtime.sessionId === id || runtime.threadId === id) return true;
	}
	return false;
}
