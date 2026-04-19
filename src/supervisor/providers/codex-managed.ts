import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type {
	LaunchRequest,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedSession,
	Session,
} from "../../shared/types.js";

type JsonRpcId = number;

type JsonRpcNotification = {
	method: string;
	params?: unknown;
};

type JsonRpcResponse = {
	id: JsonRpcId;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
};

type RpcWaiter = {
	method: string;
	predicate?: (notification: JsonRpcNotification) => boolean;
	resolve: (notification: JsonRpcNotification) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

class RpcClient {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private notifications: JsonRpcNotification[] = [];
	private waiters: RpcWaiter[] = [];
	private listeners = new Set<(notification: JsonRpcNotification) => void>();
	private closeListeners = new Set<(error?: Error) => void>();

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (event) => this.handleMessage(String(event.data));
		ws.onerror = () => this.rejectAll(new Error("Codex app-server websocket error"));
		ws.onclose = () => this.rejectAll(new Error("Codex app-server websocket closed"));
	}

	static async connect(url: string, timeoutMs = 5_000): Promise<RpcClient> {
		return await new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error(`Timed out connecting to ${url}`));
			}, timeoutMs);

			ws.onopen = () => {
				clearTimeout(timer);
				resolve(new RpcClient(ws));
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`Failed connecting to ${url}`));
			};
		});
	}

	async request<T>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		return await new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async waitForNotification(
		method: string,
		predicate?: (notification: JsonRpcNotification) => boolean,
		timeoutMs = 5_000,
	): Promise<JsonRpcNotification> {
		const buffered = this.notifications.find((notification) => {
			return notification.method === method && (!predicate || predicate(notification));
		});
		if (buffered) return buffered;

		return await new Promise<JsonRpcNotification>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
				reject(new Error(`Timed out waiting for ${method}`));
			}, timeoutMs);
			this.waiters.push({ method, predicate, resolve, reject, timer });
		});
	}

	onNotification(listener: (notification: JsonRpcNotification) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void) {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close() {
		this.ws.close();
	}

	private handleMessage(raw: string) {
		const message = JSON.parse(raw) as JsonRpcNotification | JsonRpcResponse;
		if ("id" in message) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`${message.error.message} (${message.error.code})`));
				return;
			}
			pending.resolve(message.result);
			return;
		}

		this.notifications.push(message);
		for (const listener of this.listeners) listener(message);
		for (const waiter of [...this.waiters]) {
			if (waiter.method !== message.method) continue;
			if (waiter.predicate && !waiter.predicate(message)) continue;
			clearTimeout(waiter.timer);
			this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
			waiter.resolve(message);
		}
	}

	private rejectAll(error: Error) {
		for (const [, pending] of this.pending) pending.reject(error);
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters = [];
		for (const listener of this.closeListeners) listener(error);
	}
}

type ManagedCodexRuntime = {
	sessionId: string;
	threadId: string;
	url: string;
	client: RpcClient | null;
	serverProcess: ChildProcess | null;
	currentThreadTitle: string | null;
	protocolVersion: string | null;
	syncTitle: (title: string) => Promise<void>;
	dispose: () => void;
};

const runtimes = new Map<string, ManagedCodexRuntime>();

async function findFreePort() {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate a local port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

function spawnServer(url: string): ChildProcess {
	return spawn("codex", ["app-server", "--listen", url], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

async function waitForServer(url: string, attempts = 30, delayMs = 250): Promise<RpcClient> {
	let lastError: Error | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await RpcClient.connect(url, delayMs);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			await Bun.sleep(delayMs);
		}
	}
	throw lastError ?? new Error(`Failed connecting to ${url}`);
}

function buildPrompt(launch: LaunchRequest) {
	const sections = [];
	if (launch.baseInstructions.trim()) {
		sections.push(`Instructions:\n${launch.baseInstructions.trim()}`);
	}
	if (launch.taskPrompt.trim()) {
		sections.push(`Task:\n${launch.taskPrompt.trim()}`);
	}
	return sections.join("\n\n").trim() || "Continue working on this project.";
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	if (Array.isArray(value)) return value.map((item) => extractText(item)).filter(Boolean).join("");
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.delta === "string") return record.delta;
	if (record.content) return extractText(record.content);
	if (record.item) return extractText(record.item);
	if (record.review) return typeof record.review === "string" ? record.review : "";
	return "";
}

type LaunchCallbacks = {
	reportState: (input: ManagedSessionStateInput) => Promise<{ session: Session; managedSession: ManagedSession }>;
	reportEvents: (events: ManagedSessionEventInput[]) => Promise<void>;
};

export async function launchManagedCodexRequest(
	launch: LaunchRequest,
	callbacks: LaunchCallbacks,
) {
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
				syncTitle: async () => {},
				dispose: () => {},
			} satisfies ManagedCodexRuntime,
		};
	}

	const port = await findFreePort();
	const url = `ws://127.0.0.1:${port}`;
	const serverProcess = spawnServer(url);
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

	const started = await client.request<{ thread: { id: string; cwd: string; status: unknown; source: string } }>(
		"thread/start",
		{
			cwd: launch.cwd,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
			sessionStartSource: "startup",
		},
	);
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
		syncTitle: async (title: string) => {
			await syncTitle(title);
			runtime.currentThreadTitle = title;
		},
		dispose: () => {
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
			await callbacks.reportState({
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				managedState: "managed",
				status: "idle",
			});
		}
	});

	client.onClose(async (error) => {
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
	await client.request("turn/start", {
		threadId,
		input: [{ type: "text", text: prompt }],
		cwd: launch.cwd,
		model: launch.model ?? undefined,
	});

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
