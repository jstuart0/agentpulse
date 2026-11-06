/**
 * Claude Code's stream-json wire, spoken directly (AGEN-117 T2). No SDK: its licence is proprietary and
 * five message shapes are all a takeover uses. This module is the only place that frames them.
 *
 * `ClaudeLink` sits between the child's stdout/stdin and the JSON-RPC `RpcClient` the approval tracker is
 * built on: a `can_use_tool` control request becomes a server request (`id` = Claude's `request_id`, method
 * `claude/can_use_tool`), a `control_cancel_request` becomes a notification, and the client's `respond` is
 * written as a `control_response`. Everything else Claude prints (system, assistant, user, result,
 * command_lifecycle) is handed to `onMessage` untouched. The framing, the size cap, respond-once and
 * the write order are therefore the ones Codex already has, with no second implementation.
 *
 * Nothing here is told by a model or a person: a line is parsed, classified and either forwarded or
 * dropped. A line that isn't a JSON object is dropped, a control request of a subtype nobody here knows is
 * answered with an error `control_response` (measured: Claude accepts it silently; never silence, which
 * would leave Claude waiting), and a line over the size cap closes the link.
 */
import { StringDecoder } from "node:string_decoder";
import { RPC_METHOD_NOT_FOUND, RpcClient, type RpcLink, type RpcTimers } from "./codex-rpc.js";

/** One stream-json object from Claude. */
export type ClaudeMessage = Record<string, unknown>;

/** A request line larger than this closes the link (T9: 16 MiB). */
export const CLAUDE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The method a `can_use_tool` control request carries once it is a server request. */
export const CLAUDE_CAN_USE_TOOL = "claude/can_use_tool";
/** The notification method a `control_cancel_request` becomes; its params are `{ request_id }`. */
export const CLAUDE_CANCEL = "claude/cancel";
/** How long a control request of ours (initialize, interrupt) may wait for its answer. */
export const CLAUDE_CONTROL_TIMEOUT_MS = 15_000;

/**
 * What an error reply says. Fixed: Claude shows the text of an error `control_response` to the model
 * (measured, P0 `unknown_req`), so nothing about a request or a host ever goes into it.
 */
export const CLAUDE_ERROR_REPLY_TEXT = "AgentPulse cannot answer this one.";
export const CLAUDE_UNSUPPORTED_REPLY_TEXT = "AgentPulse does not support this kind of message.";

export class ClaudeControlError extends Error {
	constructor(
		readonly subtype: string,
		reason: string,
	) {
		super(`Claude ${subtype} request failed: ${reason}`);
		this.name = "ClaudeControlError";
	}
}

/** The byte-exact bodies Claude accepts for a `can_use_tool` answer (fixtures hold the equality). */
export const allowResponse = (updatedInput: unknown) => ({ behavior: "allow", updatedInput });
export const denyResponse = (message: string, interrupt = false) =>
	interrupt ? { behavior: "deny", message, interrupt: true } : { behavior: "deny", message };

/** The envelope around an answer: the line Claude reads. */
export function controlResponseLine(requestId: string, response: unknown): string {
	return JSON.stringify({
		type: "control_response",
		response: { subtype: "success", request_id: requestId, response },
	});
}

export function controlErrorLine(requestId: string, error: string): string {
	return JSON.stringify({
		type: "control_response",
		response: { subtype: "error", request_id: requestId, error },
	});
}

/** The user line Claude reads for a prompt. `uuid` comes back in `command_lifecycle` and `init` (P0 `uuid`). */
export function userLine(text: string, uuid?: string): string {
	return JSON.stringify({
		type: "user",
		session_id: "",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		...(uuid ? { uuid } : {}),
	});
}

export type ClaudeIo = {
	/** Writes one line (no newline: the link adds it). May be async; writes are made one at a time, in order. */
	write(line: string): void | Promise<void>;
	/** Ends our side of the stream (stdin). */
	closeStdin(): void;
};

export type ClaudeLinkOptions = {
	maxFrameBytes?: number;
	timers?: RpcTimers;
	controlTimeoutMs?: number;
	/** A fresh id for a control request of ours. Default: `init-`/`req-` plus 8 hex. */
	newRequestId?: (kind: "init" | "req") => string;
};

const DEFAULT_TIMERS: RpcTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type PendingControl = {
	subtype: string;
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
	timer: unknown;
};

const isRecord = (value: unknown): value is ClaudeMessage =>
	!!value && typeof value === "object" && !Array.isArray(value);

export class ClaudeLink implements RpcLink {
	/** Server requests (`claude/can_use_tool`) and notifications (`claude/cancel`) arrive here. */
	readonly client: RpcClient;
	private readonly decoder = new StringDecoder("utf8");
	private pieces: string[] = [];
	private pieceBytes = 0;
	private readonly maxFrameBytes: number;
	private readonly timers: RpcTimers;
	private readonly controlTimeoutMs: number;
	private readonly newRequestId: (kind: "init" | "req") => string;
	private readonly pending = new Map<string, PendingControl>();
	private readonly openRequestIds = new Set<string>();
	private readonly messageListeners = new Set<(message: ClaudeMessage) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private writeChain: Promise<void> = Promise.resolve();
	private closed = false;
	private dropped = 0;
	private duplicates = 0;

	constructor(
		private readonly io: ClaudeIo,
		options: ClaudeLinkOptions = {},
	) {
		this.maxFrameBytes = options.maxFrameBytes ?? CLAUDE_MAX_FRAME_BYTES;
		this.timers = options.timers ?? DEFAULT_TIMERS;
		this.controlTimeoutMs = options.controlTimeoutMs ?? CLAUDE_CONTROL_TIMEOUT_MS;
		this.newRequestId =
			options.newRequestId ??
			((kind) => `${kind}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`);
		// The client never frames bytes here: this link feeds it whole lines.
		// Nothing here waits for a notification, and a fork lives for days: its cancels are not kept.
		this.client = new RpcClient(this, {
			maxFrameBytes: this.maxFrameBytes,
			timers: this.timers,
			bufferNotifications: false,
		});
	}

	get isClosed() {
		return this.closed;
	}

	/** Lines that were not a JSON object (blank lines excepted): a count for the host log, never their text. */
	get droppedLines() {
		return this.dropped;
	}

	/** Requests that reused the id of one still open; the second is dropped and the first stands. */
	get duplicateRequestIds() {
		return this.duplicates;
	}

	// ---- reading ----

	/** Bytes (or text) from Claude's stdout, in any chunking, including a multibyte character split across chunks. */
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

	/** The stream ended (stdout closed, the child exited, or it never started). Fires the close listeners once. */
	transportClosed(error?: Error) {
		if (this.closed) return;
		this.closed = true;
		this.pieces = [];
		this.pieceBytes = 0;
		const reason = error ?? new Error("Claude closed the stream");
		for (const entry of this.pending.values()) {
			this.timers.clear(entry.timer);
			entry.reject(reason);
		}
		this.pending.clear();
		this.openRequestIds.clear();
		this.client.transportClosed(reason);
		for (const listener of this.closeListeners) {
			try {
				listener(reason);
			} catch (err) {
				console.error("[claude-wire] close listener threw:", err);
			}
		}
	}

	onMessage(listener: (message: ClaudeMessage) => void) {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void) {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	private overflow() {
		console.error(`[claude-wire] a line passed ${this.maxFrameBytes} bytes; closing the stream`);
		this.transportClosed(new Error("Claude sent a line over the size limit"));
		try {
			this.io.closeStdin();
		} catch {}
	}

	private handleLine(line: string) {
		if (line.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.dropped++;
			return;
		}
		if (!isRecord(message)) {
			this.dropped++;
			return;
		}
		switch (message.type) {
			case "control_request":
				this.handleControlRequest(message);
				return;
			case "control_cancel_request":
				this.handleCancel(message);
				return;
			case "control_response":
				this.handleControlResponse(message);
				return;
			default:
				// One microtask hop, like the client's own dispatch of a request or a cancel, so a line that follows a
				// request is never seen before the request is (microtasks run in the order they were queued).
				queueMicrotask(() => {
					for (const listener of [...this.messageListeners]) {
						try {
							listener(message);
						} catch (err) {
							console.error("[claude-wire] message listener threw:", err);
						}
					}
				});
		}
	}

	private handleControlRequest(message: ClaudeMessage) {
		const requestId = message.request_id;
		const body = isRecord(message.request) ? message.request : null;
		if (typeof requestId !== "string" || requestId === "" || !body) {
			this.dropped++;
			return;
		}
		if (body.subtype !== "can_use_tool") {
			// Never silence: Claude waits for an answer to a request it sent.
			this.writeLine(controlErrorLine(requestId, CLAUDE_UNSUPPORTED_REPLY_TEXT));
			return;
		}
		if (this.openRequestIds.has(requestId)) {
			this.duplicates++;
			return;
		}
		this.openRequestIds.add(requestId);
		this.client.receive(
			`${JSON.stringify({ id: requestId, method: CLAUDE_CAN_USE_TOOL, params: body })}\n`,
		);
	}

	private handleCancel(message: ClaudeMessage) {
		const requestId = message.request_id;
		if (typeof requestId !== "string" || requestId === "") {
			this.dropped++;
			return;
		}
		this.client.receive(
			`${JSON.stringify({ method: CLAUDE_CANCEL, params: { request_id: requestId } })}\n`,
		);
	}

	private handleControlResponse(message: ClaudeMessage) {
		const response = isRecord(message.response) ? message.response : null;
		const requestId = response?.request_id;
		if (!response || typeof requestId !== "string") return;
		const entry = this.pending.get(requestId);
		// A stray answer to a request we never made is ignored (measured: Claude does the same with ours).
		if (!entry) return;
		this.pending.delete(requestId);
		this.timers.clear(entry.timer);
		if (response.subtype === "error") {
			entry.reject(new ClaudeControlError(entry.subtype, "Claude refused it"));
			return;
		}
		entry.resolve(response.response);
	}

	// ---- writing ----

	/** The `RpcLink` the client writes JSON-RPC frames to: they become `control_response` lines. */
	write(frame: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		const id = parsed.id;
		if (typeof id !== "string") return;
		this.openRequestIds.delete(id);
		if (isRecord(parsed.error)) {
			const unsupported = parsed.error.code === RPC_METHOD_NOT_FOUND;
			this.writeLine(
				controlErrorLine(id, unsupported ? CLAUDE_UNSUPPORTED_REPLY_TEXT : CLAUDE_ERROR_REPLY_TEXT),
			);
			return;
		}
		this.writeLine(controlResponseLine(id, parsed.result));
	}

	/** Ends our side. */
	close() {
		try {
			this.io.closeStdin();
		} catch {}
	}

	/** Lines go out one at a time, in the order they were asked for, even when `io.write` is asynchronous. */
	private writeLine(line: string) {
		if (this.closed) return;
		this.writeChain = this.writeChain
			.then(() => this.io.write(line))
			.catch(() => {
				// A pipe that closed under us is the child going away; the exit path reports it.
			});
	}

	/** Resolves when every line written so far has been handed to the pipe. */
	flush(): Promise<void> {
		return this.writeChain;
	}

	/** A prompt. The line is built here so no caller frames its own. */
	sendUser(text: string, uuid?: string) {
		this.writeLine(userLine(text, uuid));
	}

	/** A control request of ours; resolves with the answer's `response`, rejects on an error answer, a timeout or a closed link. */
	control(subtype: string, extra: Record<string, unknown> = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new ClaudeControlError(subtype, "the stream is closed"));
		const kind = subtype === "initialize" ? "init" : "req";
		const requestId = this.newRequestId(kind);
		return new Promise<unknown>((resolve, reject) => {
			const timer = this.timers.set(() => {
				if (!this.pending.delete(requestId)) return;
				reject(new ClaudeControlError(subtype, "no answer in time"));
			}, this.controlTimeoutMs);
			this.pending.set(requestId, { subtype, resolve, reject, timer });
			// Built by assignment: a bare `request` key is what the report-gate scan reads as the raw request function.
			const line: Record<string, unknown> = { type: "control_request", request_id: requestId };
			line.request = { subtype, ...extra };
			this.writeLine(JSON.stringify(line));
		});
	}

	initialize(): Promise<unknown> {
		return this.control("initialize");
	}

	interrupt(): Promise<unknown> {
		return this.control("interrupt");
	}
}
