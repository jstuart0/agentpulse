import type { LaunchRequest, ManagedSession } from "../../shared/types.js";
import { findFreePort, spawnServer, waitForServer } from "./codex-rpc.js";
import {
	type LaunchCallbacks,
	type ManagedCodexRuntime,
	buildPrompt,
	extractText,
} from "./codex-shared.js";

const runtimes = new Map<string, ManagedCodexRuntime>();

export async function launchManagedCodexRequest(launch: LaunchRequest, callbacks: LaunchCallbacks) {
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
			metadata: { mode: "dry-run", threadId },
			runtime: {
				sessionId: launch.launchCorrelationId,
				threadId,
				url: "dry-run",
				client: null,
				serverProcess: null,
				currentThreadTitle: desiredState.session.displayName,
				protocolVersion: "dry-run",
				activeTurnId: null,
				intentionalClose: false,
				syncTitle: async () => {},
				dispose: () => {},
			} satisfies ManagedCodexRuntime,
		};
	}

	const port = await findFreePort();
	const url = `ws://127.0.0.1:${port}`;
	const serverProcess = await spawnServer(url);
	const client = await waitForServer(url);
	const initResult = await client.request<Record<string, unknown>>("initialize", {
		clientInfo: {
			name: "agentpulse-supervisor",
			title: "AgentPulse Supervisor",
			version: "0.1.0",
		},
		capabilities: {
			experimentalApi: true,
		},
	});

	const started = await client.request<{
		thread: { id: string; cwd: string; status: unknown; source: string };
	}>("thread/start", {
		cwd: launch.cwd,
		experimentalRawEvents: false,
		persistExtendedHistory: true,
		sessionStartSource: "startup",
	});
	const threadId = started.thread.id;

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
		providerProtocolVersion:
			typeof initResult?.protocolVersion === "string" ? initResult.protocolVersion : "app-server",
		providerCapabilitySnapshot: initResult,
		providerSyncState: "pending",
		metadata: {
			managedCodexUrl: url,
		},
	});

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

	await syncTitle(bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8));

	const runtime: ManagedCodexRuntime = {
		sessionId: launch.launchCorrelationId,
		threadId,
		url,
		client,
		serverProcess,
		currentThreadTitle: bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8),
		protocolVersion:
			typeof initResult?.protocolVersion === "string" ? initResult.protocolVersion : "app-server",
		activeTurnId: null,
		intentionalClose: false,
		syncTitle: async (title: string) => {
			await syncTitle(title);
			runtime.currentThreadTitle = title;
		},
		dispose: () => {
			runtime.intentionalClose = true;
			try {
				client.close();
			} catch {}
			try {
				serverProcess.kill();
			} catch {}
			runtimes.delete(launch.launchCorrelationId);
		},
	};

	client.onNotification(async (notification) => {
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
	});

	client.onClose(async (error) => {
		if (runtime.intentionalClose) {
			runtimes.delete(launch.launchCorrelationId);
			return;
		}
		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			managedState: "degraded",
			providerSyncState: "failed",
			providerSyncError: error?.message ?? "Codex control channel closed",
		});
		runtimes.delete(launch.launchCorrelationId);
	});

	runtimes.set(launch.launchCorrelationId, runtime);

	await callbacks.reportEvents([
		{
			eventType: "ManagedSessionStart",
			category: "system_event",
			content: "Managed Codex session started.",
			rawPayload: { url, threadId },
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
		pid: serverProcess.pid ?? 0,
		metadata: {
			mode: "managed_codex",
			threadId,
			url,
		},
		runtime,
	};
}

export async function stopManagedCodexSession(sessionId: string) {
	const runtime = runtimes.get(sessionId);
	if (!runtime) {
		throw new Error("Managed Codex runtime is not available on this supervisor.");
	}

	if (runtime.client && runtime.activeTurnId) {
		try {
			await runtime.client.request("turn/interrupt", {
				threadId: runtime.threadId,
				turnId: runtime.activeTurnId,
			});
		} catch {
			// Fall through to cleanup even if interrupt fails.
		}
	}

	runtime.dispose();
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
