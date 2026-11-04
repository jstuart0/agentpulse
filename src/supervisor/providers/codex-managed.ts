import {
	CODEX_SANDBOX_RESPONSE_TYPE,
	LaunchPrivilegeError,
	type ReportedByAgent,
	type ResolvedLaunchPrivileges,
	privilegeMetadata,
	requireLaunchPrivileges,
	sanitizeReportedByAgent,
} from "../../shared/launch-privileges.js";
import type { LaunchRequest, ManagedSession } from "../../shared/types.js";
import { disposeRuntimesAndExit } from "../services/fatal-exit.js";
import { reportInSessionSafely } from "../services/report-resilience.js";
import { type ApprovalLaunch, sharedCodexApprovals } from "./codex-approvals.js";
import {
	type Verdict,
	bindVerdictToUserAgent,
	codexProtocolVerdict,
	resolveCodex,
} from "./codex-protocol.js";
import {
	type JsonRpcNotification,
	initializeCodexClient,
	startCodexAppServer,
} from "./codex-rpc.js";
import {
	type LaunchCallbacks,
	type ManagedCodexRuntime,
	buildPrompt,
	extractText,
} from "./codex-shared.js";

const runtimes = new Map<string, ManagedCodexRuntime>();

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

export async function launchManagedCodexRequest(launch: LaunchRequest, callbacks: LaunchCallbacks) {
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
				threadId,
				client: null,
				currentThreadTitle: desiredState.session.displayName,
				protocolVersion: "dry-run",
				activeTurnId: null,
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

		async function syncTitle(title: string) {
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
		}

		// A queued bootstrap has no server name to go by: pushing the short id as the thread's title would
		// stick. The title is left for reconcileManagedCodexTitles, once the server has the session.
		if (shouldPushBootstrapTitle(bootstrap.outcome)) {
			await syncTitle(bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8));
		}

		const runtime: ManagedCodexRuntime = {
			sessionId: launch.launchCorrelationId,
			threadId,
			client,
			currentThreadTitle: shouldPushBootstrapTitle(bootstrap.outcome)
				? bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8)
				: "",
			protocolVersion: resolveProviderProtocolVersion(initResult),
			activeTurnId: null,
			intentionalClose: false,
			syncTitle: async (title: string) => {
				await syncTitle(title);
				runtime.currentThreadTitle = title;
			},
			dispose: async () => {
				runtime.intentionalClose = true;
				runtimes.delete(launch.launchCorrelationId);
				tracker.dispose(approvals);
				await server.shutdown();
			},
		};
		runtimeRef = runtime;

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
			// F25/D6: same in-session-reporting hazard as the notification
			// handler above — the control channel is already gone, so there's
			// nothing more useful to do than log (or, for a 401, exit) and
			// finish tearing the runtime down.
			await reportInSessionSafely(
				"codex-managed",
				launch.launchCorrelationId,
				"degraded-state",
				() =>
					callbacks.reportState({
						sessionId: launch.launchCorrelationId,
						launchRequestId: launch.id,
						managedState: "degraded",
						providerSyncState: "failed",
						providerSyncError: error?.message ?? "Codex control channel closed",
					}),
				disposeRuntimesAndExit,
			);
			runtimes.delete(launch.launchCorrelationId);
		});

		runtimes.set(launch.launchCorrelationId, runtime);

		await callbacks.reportEvents([
			{
				eventType: "ManagedSessionStart",
				category: "system_event",
				content: "Managed Codex session started.",
				rawPayload: { threadId },
			},
		]);

		const prompt = buildPrompt(launch);
		const turn = await client.request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [{ type: "text", text: prompt }],
			cwd: launch.cwd,
			model: launch.model ?? undefined,
		});
		runtime.activeTurnId = turn.turn.id;

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
		// Whatever failed, the child goes through the same shutdown as every other path.
		if (runtimeRef) runtimeRef.intentionalClose = true;
		runtimes.delete(launch.launchCorrelationId);
		tracker.dispose(approvals);
		await server.shutdown();
		throw error;
	}
}

/**
 * F25: extracted from the inline `client.onNotification` callback so the
 * caller can wrap the whole dispatch in one try/catch. Each branch may call
 * `callbacks.reportState`/`reportEvents`, which now carry an ownership guard
 * (session_not_owned) and can reject mid-session.
 */
async function handleManagedCodexNotification(
	notification: JsonRpcNotification,
	launch: LaunchRequest,
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

	if (notification.method === "turn/completed") {
		runtime.activeTurnId = null;
		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			managedState: "managed",
			status: "idle",
		});
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
