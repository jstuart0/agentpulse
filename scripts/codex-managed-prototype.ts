#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process";

type JsonRpcId = number;

type JsonRpcRequest = {
	id: JsonRpcId;
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

type JsonRpcNotification = {
	method: string;
	params?: unknown;
};

type ThreadReadResult = {
	thread: {
		id: string;
		name: string | null;
		cwd: string;
		status: string;
		source: string;
	};
};

class RpcClient {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private notifications: JsonRpcNotification[] = [];
	private waiters: Array<{
		method: string;
		predicate?: (notification: JsonRpcNotification) => boolean;
		resolve: (notification: JsonRpcNotification) => void;
		reject: (error: Error) => void;
		timer: Timer;
	}> = [];

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (event) => this.handleMessage(String(event.data));
		ws.onerror = () => this.rejectAll(new Error("WebSocket error"));
		ws.onclose = () => this.rejectAll(new Error("WebSocket closed"));
	}

	static async connect(url: string, timeoutMs = 5000): Promise<RpcClient> {
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
		const payload: JsonRpcRequest = { id, method, params };

		return await new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify(payload));
		});
	}

	async waitForNotification(
		method: string,
		predicate?: (notification: JsonRpcNotification) => boolean,
		timeoutMs = 5000,
	): Promise<JsonRpcNotification> {
		const buffered = this.notifications.find((notification) => {
			return notification.method === method && (!predicate || predicate(notification));
		});
		if (buffered) return buffered;

		return await new Promise<JsonRpcNotification>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
				reject(new Error(`Timed out waiting for notification ${method}`));
			}, timeoutMs);

			this.waiters.push({ method, predicate, resolve, reject, timer });
		});
	}

	close() {
		this.ws.close();
	}

	private handleMessage(raw: string) {
		const message = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;

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
	}
}

function parseArgs(argv: string[]) {
	const [command, ...rest] = argv;
	const args: Record<string, string | boolean> = {};

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = rest[i + 1];
		if (!next || next.startsWith("--")) {
			args[key] = true;
			continue;
		}
		args[key] = next;
		i++;
	}

	return { command, args };
}

function usage() {
	console.log(`Usage:
  bun scripts/codex-managed-prototype.ts demo --url ws://127.0.0.1:8765 --cwd <dir> --name <thread-name> [--spawn-server]
  bun scripts/codex-managed-prototype.ts set-name --url ws://127.0.0.1:8765 --thread-id <id> --name <thread-name>

Notes:
  - This is a Phase 1 prototype for managed Codex mode.
  - It talks to Codex app-server over WebSocket and sends thread/name/set.
  - Use --spawn-server only for local loopback testing.
`);
}

function spawnServer(url: string): ChildProcess {
	return spawn("codex", ["app-server", "--listen", url], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

async function waitForServer(url: string, attempts = 20, delayMs = 250): Promise<RpcClient> {
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

async function initialize(client: RpcClient) {
	await client.request("initialize", {
		clientInfo: {
			name: "agentpulse-prototype",
			title: "AgentPulse Managed Codex Prototype",
			version: "0.1.0",
		},
		capabilities: {
			experimentalApi: true,
		},
	});
}

async function startThread(client: RpcClient, cwd: string) {
	const result = await client.request<{
		thread: { id: string; cwd: string; status: string };
	}>("thread/start", {
		cwd,
		experimentalRawEvents: false,
		persistExtendedHistory: false,
		sessionStartSource: "startup",
	});
	return result.thread;
}

async function setThreadName(client: RpcClient, threadId: string, name: string) {
	await client.request("thread/name/set", { threadId, name });
	await client.waitForNotification(
		"thread/name/updated",
		(notification) => {
			const params = notification.params as { threadId?: string; threadName?: string };
			return params.threadId === threadId && params.threadName === name;
		},
		5000,
	);
}

async function readThread(client: RpcClient, threadId: string) {
	return await client.request<ThreadReadResult>("thread/read", {
		threadId,
		includeTurns: false,
	});
}

async function run() {
	const { command, args } = parseArgs(process.argv.slice(2));
	if (!command || command === "--help" || command === "help") {
		usage();
		process.exit(0);
	}

	const url = String(args.url || "ws://127.0.0.1:8765");
	const name = typeof args.name === "string" ? args.name : "";
	const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
	const threadId = typeof args["thread-id"] === "string" ? args["thread-id"] : "";
	const shouldSpawnServer = args["spawn-server"] === true;

	let server: ChildProcess | null = null;
	if (shouldSpawnServer) {
		server = spawnServer(url);
		server.stdout?.on("data", () => {});
		server.stderr?.on("data", () => {});
	}

	let client: RpcClient | null = null;

	try {
		client = await waitForServer(url);
		await initialize(client);

		if (command === "demo") {
			if (!name) throw new Error("--name is required for demo");
			const thread = await startThread(client, cwd);
			await setThreadName(client, thread.id, name);
			const updated = await readThread(client, thread.id);
			console.log(JSON.stringify({
				ok: true,
				mode: "demo",
				url,
				threadId: updated.thread.id,
				threadName: updated.thread.name,
				cwd: updated.thread.cwd,
				status: updated.thread.status,
				source: updated.thread.source,
				nextStep: `Connect a Codex TUI to ${url} with: codex --remote ${url}`,
			}, null, 2));
			return;
		}

		if (command === "set-name") {
			if (!threadId) throw new Error("--thread-id is required for set-name");
			if (!name) throw new Error("--name is required for set-name");
			await setThreadName(client, threadId, name);
			const updated = await readThread(client, threadId);
			console.log(JSON.stringify({
				ok: true,
				mode: "set-name",
				url,
				threadId: updated.thread.id,
				threadName: updated.thread.name,
				cwd: updated.thread.cwd,
				status: updated.thread.status,
				source: updated.thread.source,
			}, null, 2));
			return;
		}

		throw new Error(`Unknown command: ${command}`);
	} finally {
		client?.close();
		if (server) server.kill("SIGTERM");
	}
}

await run();
