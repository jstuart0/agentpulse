import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { loadSupervisorConfig } from "../config.js";

type JsonRpcId = number;

export type JsonRpcNotification = {
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

export class RpcClient {
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

export async function findFreePort() {
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

export async function spawnServer(url: string): Promise<ChildProcess> {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.codex?.resolvedPath || config.codexCommand || "codex";
	return spawn(executable, ["app-server", "--listen", url], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

export async function waitForServer(url: string, attempts = 30, delayMs = 250): Promise<RpcClient> {
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
