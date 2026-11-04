import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveCodex } from "./codex-protocol.js";

/** JSON-RPC ids are numbers or strings; the server's and ours are separate id spaces. */
export type JsonRpcId = number | string;

export type JsonRpcNotification = {
	method: string;
	params?: unknown;
};

/** A request the app-server sends us. It has both an `id` and a `method`. */
export type JsonRpcServerRequest = {
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

type RpcWaiter = {
	method: string;
	predicate?: (notification: JsonRpcNotification) => boolean;
	resolve: (notification: JsonRpcNotification) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** What the client needs of whatever carries its frames. `write` never throws. */
export type RpcLink = {
	/** Sends one frame (the client adds no newline; the link does). */
	write(frame: string): void;
	/** Ends our side of the stream. */
	close(): void;
};

export type RpcTimers = {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

const DEFAULT_TIMERS: RpcTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One JSONL frame larger than this closes the client with an error. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** How long a silent app-server may take to answer `initialize`. */
export const CODEX_INITIALIZE_TIMEOUT_MS = 15_000;
/** JSON-RPC "method not found". */
export const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INTERNAL_ERROR = -32603;

const idKey = (id: JsonRpcId) => JSON.stringify(id);
const isRpcId = (value: unknown): value is JsonRpcId =>
	typeof value === "number" || typeof value === "string";

/**
 * A JSON-RPC client over a JSONL stream. The owner feeds it bytes (`receive`) and tells it when
 * the stream ended (`transportClosed`); it never touches a process or a socket itself.
 */
export class RpcClient {
	private nextId = 1;
	private pending = new Map<
		JsonRpcId,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	private notifications: JsonRpcNotification[] = [];
	private waiters: RpcWaiter[] = [];
	private listeners = new Set<(notification: JsonRpcNotification) => void>();
	private closeListeners = new Set<(error?: Error) => void>();
	private serverRequestHandler: ((call: JsonRpcServerRequest) => void | Promise<void>) | null =
		null;
	/** Server requests received and not yet answered, by `idKey`. */
	private openServerRequests = new Set<string>();
	private closed = false;
	private decoder = new StringDecoder("utf8");
	private pieces: string[] = [];
	private pieceBytes = 0;
	private readonly maxFrameBytes: number;
	private readonly timers: RpcTimers;

	constructor(
		private readonly link: RpcLink,
		options: { maxFrameBytes?: number; timers?: RpcTimers } = {},
	) {
		this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
		this.timers = options.timers ?? DEFAULT_TIMERS;
	}

	get isClosed() {
		return this.closed;
	}

	/** Bytes (or text) from the app-server's stdout, in any chunking. */
	receive(chunk: Uint8Array | string) {
		if (this.closed) return;
		const text =
			typeof chunk === "string"
				? chunk
				: this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		let rest = text;
		while (rest.length > 0 && !this.closed) {
			const newline = rest.indexOf("\n");
			if (newline === -1) {
				this.pieces.push(rest);
				this.pieceBytes += Buffer.byteLength(rest);
				if (this.pieceBytes > this.maxFrameBytes) this.overflow();
				return;
			}
			const head = rest.slice(0, newline);
			rest = rest.slice(newline + 1);
			const line = this.pieces.length > 0 ? this.pieces.join("") + head : head;
			this.pieces = [];
			this.pieceBytes = 0;
			if (Buffer.byteLength(line) > this.maxFrameBytes) {
				this.overflow();
				return;
			}
			this.handleLine(line);
		}
	}

	/**
	 * The stream is over (stdout ended, the child exited, or it never started). Whatever partial line is
	 * buffered is dropped. Fires the close listeners once, however many times this is called.
	 */
	transportClosed(error?: Error) {
		if (this.closed) return;
		this.closed = true;
		this.pieces = [];
		this.pieceBytes = 0;
		const reason = error ?? new Error("Codex app-server closed");
		for (const [, pending] of this.pending) pending.reject(reason);
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(reason);
		}
		this.waiters = [];
		this.openServerRequests.clear();
		for (const listener of this.closeListeners) {
			try {
				listener(reason);
			} catch (err) {
				console.error("[codex-rpc] close listener threw:", err);
			}
		}
	}

	async request<T>(
		method: string,
		params?: unknown,
		options: { timeoutMs?: number } = {},
	): Promise<T> {
		if (this.closed) throw new Error("Codex app-server connection is closed");
		const id = this.nextId++;
		return await new Promise<T>((resolve, reject) => {
			let timer: unknown;
			const clearTimer = () => {
				if (timer !== undefined) this.timers.clear(timer);
			};
			this.pending.set(id, {
				resolve: (value) => {
					clearTimer();
					resolve(value);
				},
				reject: (error) => {
					clearTimer();
					reject(error);
				},
			});
			if (options.timeoutMs !== undefined) {
				timer = this.timers.set(() => {
					if (!this.pending.delete(id)) return;
					reject(new Error(`Timed out waiting for ${method} after ${options.timeoutMs} ms`));
				}, options.timeoutMs);
			}
			this.link.write(JSON.stringify({ id, method, params }));
		});
	}

	/**
	 * Registers the one handler for server requests. A request with no handler is answered
	 * `-32601`; a handler that throws leaves an unanswered request answered `-32603`.
	 */
	onServerRequest(handler: (call: JsonRpcServerRequest) => void | Promise<void>) {
		this.serverRequestHandler = handler;
		return () => {
			if (this.serverRequestHandler === handler) this.serverRequestHandler = null;
		};
	}

	/** Answers a server request. False when it was already answered or the client is closed. */
	respond(id: JsonRpcId, result: unknown): boolean {
		if (!this.openServerRequests.delete(idKey(id))) return false;
		this.link.write(JSON.stringify({ id, result }));
		return true;
	}

	respondError(id: JsonRpcId, code: number, message: string): boolean {
		if (!this.openServerRequests.delete(idKey(id))) return false;
		this.link.write(JSON.stringify({ id, error: { code, message } }));
		return true;
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

	/** Ends our side: the app-server sees end of file on stdin. Close listeners fire once. */
	close() {
		if (this.closed) return;
		try {
			this.link.close();
		} catch {}
		this.transportClosed(new Error("Codex app-server connection closed"));
	}

	private overflow() {
		console.error(`[codex-rpc] a frame passed ${this.maxFrameBytes} bytes; closing the connection`);
		this.transportClosed(new Error("Codex app-server sent a frame over the size limit"));
		try {
			this.link.close();
		} catch {}
	}

	private handleLine(line: string) {
		if (line.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			console.warn("[codex-rpc] ignoring a malformed frame");
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			console.warn("[codex-rpc] ignoring a frame that is not an object");
			return;
		}
		this.handleMessage(message as Record<string, unknown>);
	}

	private handleMessage(message: Record<string, unknown>) {
		const { id, method } = message;
		if (typeof method === "string" && "id" in message) {
			// A request from the server. Its ids are its own: it must never be read as a response.
			if (!isRpcId(id)) {
				console.warn("[codex-rpc] ignoring a request with an unusable id");
				return;
			}
			this.dispatchServerRequest({ id, method, params: message.params });
			return;
		}
		if (typeof method !== "string" && "id" in message) {
			this.handleResponse(message as unknown as JsonRpcResponse);
			return;
		}
		if (typeof method !== "string") return;

		const notification = message as unknown as JsonRpcNotification;
		this.notifications.push(notification);
		// F25: listeners are frequently async (they report state/events back to
		// the server) and are dispatched fire-and-forget here — nothing else in
		// this class awaits or catches their returned promise. A rejection
		// (e.g. a 403 session_not_owned from a mid-session report, or any other
		// non-2xx) would otherwise surface as an unhandled promise rejection
		// and crash the whole supervisor process, which is exactly the
		// crash-loop class this campaign fixes, reintroduced through the new
		// 403. Each listener call is isolated in its own microtask so one
		// listener's rejection can never escape this loop or block delivery to
		// the next listener/notification.
		for (const listener of this.listeners) {
			Promise.resolve()
				.then(() => listener(notification))
				.catch((err) => {
					console.error("[codex-rpc] notification listener threw:", err);
				});
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.method !== notification.method) continue;
			if (waiter.predicate && !waiter.predicate(notification)) continue;
			clearTimeout(waiter.timer);
			this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
			waiter.resolve(notification);
		}
	}

	private handleResponse(message: JsonRpcResponse) {
		// Our ids are numbers: a string id never matches, so "1" cannot answer request 1.
		const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
		if (!pending) return;
		this.pending.delete(message.id as number);
		if (message.error) {
			pending.reject(new Error(`${message.error.message} (${message.error.code})`));
			return;
		}
		pending.resolve(message.result);
	}

	private dispatchServerRequest(call: JsonRpcServerRequest) {
		this.openServerRequests.add(idKey(call.id));
		const handler = this.serverRequestHandler;
		if (!handler) {
			this.respondError(call.id, RPC_METHOD_NOT_FOUND, "Method not found");
			return;
		}
		Promise.resolve()
			.then(() => handler(call))
			.catch((err) => {
				console.error("[codex-rpc] server request handler threw:", err);
				this.respondError(call.id, RPC_INTERNAL_ERROR, "Internal error");
			});
	}
}

/** `initialize` with the limit a silent app-server gets. */
export async function initializeCodexClient<T>(client: RpcClient, params: unknown): Promise<T> {
	return await client.request<T>("initialize", params, { timeoutMs: CODEX_INITIALIZE_TIMEOUT_MS });
}

// ---- the child process ----

export type ShutdownTimings = {
	/** After stdin closes, how long the child gets to leave on its own. */
	stdinCloseMs: number;
	/** After SIGTERM to its group. */
	termMs: number;
	/** After SIGKILL, before shutdown gives up waiting. */
	killMs: number;
};

export const DEFAULT_SHUTDOWN_TIMINGS: ShutdownTimings = {
	stdinCloseMs: 3_000,
	termMs: 2_000,
	killMs: 1_000,
};

const GONE_POLL_MS = 25;

export type CodexAppServer = {
	client: RpcClient;
	pid: number;
	/** Closes stdin, then escalates to the child's process group. Idempotent. */
	shutdown(): Promise<void>;
};

export type StartCodexAppServerOptions = {
	/** The program to run. Default: the resolved `codex`. */
	executable?: string;
	/** Default: `["app-server"]`. No listener flag is passed: the child talks over stdin and stdout only. */
	args?: string[];
	env?: NodeJS.ProcessEnv;
	timings?: Partial<ShutdownTimings>;
	maxFrameBytes?: number;
	timers?: RpcTimers;
	/** Where the one local line about an unexpected exit goes. */
	log?: (line: string) => void;
};

const isPosix = () => process.platform !== "win32";

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// EPERM means the group exists and is not ours to signal; only ESRCH means it is empty.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
	try {
		if (isPosix() && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// Already gone.
	}
}

/**
 * Starts `codex app-server` on stdio (no listening socket exists, so nothing else can talk to it) and
 * returns the client plus the one way to stop it. A missing executable, or a child that dies at once,
 * rejects here; a child that starts and says nothing is bounded by `initializeCodexClient`.
 */
export async function startCodexAppServer(
	options: StartCodexAppServerOptions = {},
): Promise<CodexAppServer> {
	const executable = options.executable ?? (await resolveCodex()).binary.path;
	const timings = { ...DEFAULT_SHUTDOWN_TIMINGS, ...options.timings };
	const log = options.log ?? ((line: string) => console.warn(line));
	const posix = isPosix();

	const child = spawn(executable, options.args ?? ["app-server"], {
		stdio: ["pipe", "pipe", "pipe"],
		// Own process group on POSIX, so an escalation reaches the wrapper's children too.
		detached: posix,
		env: options.env ?? process.env,
	});
	child.stdin.on("error", () => {});
	child.stdout.on("error", () => {});
	child.stderr.on("error", () => {});

	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (error) =>
			reject(new Error(`Failed to start Codex app-server (${executable}): ${error.message}`)),
		);
	});
	// Past the spawn, an error is the same as the child going away.
	child.on("error", () => {});

	let stdinOpen = true;
	const link: RpcLink = {
		write(frame) {
			if (!stdinOpen || child.stdin.destroyed || child.stdin.writableEnded) return;
			try {
				child.stdin.write(`${frame}\n`);
			} catch {
				// A pipe that closed under us is the child going away.
			}
		},
		close() {
			if (!stdinOpen) return;
			stdinOpen = false;
			try {
				child.stdin.end();
			} catch {}
		},
	};
	const client = new RpcClient(link, {
		maxFrameBytes: options.maxFrameBytes,
		timers: options.timers,
	});

	// Drained so the pipe never blocks the child. Its text is never kept or logged: it can echo
	// credentials or session content, and no sanitiser can tell which.
	let stderrBytes = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
	});
	child.stdout.on("data", (chunk: Buffer) => client.receive(chunk));

	let exited = false;
	let requested = false;
	const finish = (error?: Error) => client.transportClosed(error);
	child.stdout.once("end", () => finish());
	child.once("exit", (code, signal) => {
		exited = true;
		if (!requested) {
			log(
				`[codex-rpc] app-server exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}, stderr=${stderrBytes} bytes, not logged; run Codex by hand to see its output)`,
			);
		}
		finish(
			new Error(`Codex app-server exited (code=${code ?? "none"}, signal=${signal ?? "none"})`),
		);
	});

	const gone = () => exited && (!posix || !child.pid || !groupAlive(child.pid));
	async function waitGone(ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (!gone()) {
			if (Date.now() >= deadline) return false;
			await Bun.sleep(GONE_POLL_MS);
		}
		return true;
	}

	let shutdownPromise: Promise<void> | undefined;
	let running = false;
	async function runShutdown() {
		// Stdin first: a well-behaved child leaves on end of file and is never signalled.
		link.close();
		client.close();
		if (await waitGone(timings.stdinCloseMs)) return;
		signalGroup(child, "SIGTERM");
		if (await waitGone(timings.termMs)) return;
		signalGroup(child, "SIGKILL");
		if (!(await waitGone(timings.killMs))) {
			log("[codex-rpc] app-server did not exit after SIGKILL");
		}
	}
	const run = () => {
		if (!running) {
			running = true;
			shutdownPromise = runShutdown();
		}
		return shutdownPromise;
	};
	const shutdown = async () => {
		requested = true;
		await run();
	};
	// Whatever ends the connection (a frame over the limit, a broken pipe) also ends the child.
	client.onClose(() => {
		void run();
	});

	return { client, pid: child.pid ?? 0, shutdown };
}
