import { MAX_LLM_CALL_TIMEOUT_SECONDS } from "../../config.js";
import { LlmError } from "./llm/types.js";

/**
 * The one fetch path for every LLM and embeddings call.
 *
 * It hides three things callers must not get wrong:
 * - Bun's own socket idle timer (300 s by default) is turned off, so the total
 *   deadline we pass is the only time limit on the call;
 * - which limit fired (our deadline, or the caller's abort signal), carried on
 *   `LlmError.deadline`, through the headers, the body and a stream alike;
 * - byte caps on bodies, counted on raw bytes before any decode.
 *
 * `llmFetch` returns the Response for every HTTP status; status handling stays
 * with the caller. It throws `LlmError` only for a transport failure, our
 * deadline, the caller's abort or a cap.
 */

export const MAX_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 4 * 1024;

interface LlmFetchOptions {
	timeoutMs: number;
	/** The caller's own abort signal, combined with the deadline. */
	signal?: AbortSignal;
	/** Prefix for error messages, e.g. "openai_compatible stream". */
	label?: string;
}

interface CallContext {
	deadline: AbortSignal;
	caller?: AbortSignal;
	/** Aborted when we stop reading a body, so the socket closes with the reader. */
	release: AbortController;
	label: string;
}

/** Bun's `fetch` takes `timeout`, which `bun-types` does not declare. */
type BunRequestInit = RequestInit & { timeout?: false };

const contexts = new WeakMap<Response, CallContext>();

/** Only the error's name or code goes into a message; the original stays on `cause`. */
function errorName(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string") return code;
	return err instanceof Error ? err.name : "unknown";
}

function abortToLlmError(err: unknown, ctx: CallContext | undefined, phase: string): LlmError {
	if (err instanceof LlmError) return err;
	const label = ctx?.label ?? "llm";
	if (ctx?.deadline.aborted) {
		return new LlmError("transient_timeout", `${label} ${phase} timed out`, undefined, err, true);
	}
	if (ctx?.caller?.aborted) {
		return new LlmError("unknown", `${label} ${phase} aborted`, undefined, err);
	}
	return new LlmError("unknown", `${label} ${phase} failed (${errorName(err)})`, undefined, err);
}

export async function llmFetch(
	url: string,
	init: RequestInit,
	options: LlmFetchOptions,
): Promise<Response> {
	const label = options.label ?? "llm";
	const { timeoutMs } = options;
	if (
		typeof timeoutMs !== "number" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > MAX_LLM_CALL_TIMEOUT_SECONDS * 1000
	) {
		throw new LlmError("unknown", `${label} request has an invalid timeout`);
	}
	const deadline = AbortSignal.timeout(timeoutMs);
	const release = new AbortController();
	const ctx: CallContext = { deadline, caller: options.signal, release, label };
	const signal = AbortSignal.any(
		options.signal ? [deadline, release.signal, options.signal] : [deadline, release.signal],
	);
	try {
		const response = await fetch(url, { ...init, signal, timeout: false } as BunRequestInit);
		contexts.set(response, ctx);
		return response;
	} catch (err) {
		throw abortToLlmError(err, ctx, "request");
	}
}

/**
 * Yields raw chunks, rejecting once their running total passes `maxBytes`.
 * The chunk that crosses the cap has already been received (one transport
 * chunk, typically tens of KiB) and is dropped, not decoded or appended.
 */
export async function* readStreamCapped(
	response: Response,
	maxBytes: number = MAX_SUCCESS_BODY_BYTES,
): AsyncGenerator<Uint8Array> {
	if (!response.body) return;
	const ctx = contexts.get(response);
	const reader = response.body.getReader();
	let total = 0;
	try {
		while (true) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (err) {
				throw abortToLlmError(err, ctx, "response body");
			}
			if (chunk.done) return;
			total += chunk.value.byteLength;
			if (total > maxBytes) {
				throw new LlmError(
					"unknown",
					`${ctx?.label ?? "llm"} response too large (over ${maxBytes} bytes)`,
				);
			}
			yield chunk.value;
		}
	} finally {
		ctx?.release.abort();
		await reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			// already released
		}
	}
}

export async function readTextCapped(
	response: Response,
	maxBytes: number = MAX_SUCCESS_BODY_BYTES,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of readStreamCapped(response, maxBytes)) {
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
}

export async function readJsonCapped(
	response: Response,
	maxBytes: number = MAX_SUCCESS_BODY_BYTES,
): Promise<unknown> {
	// A body that is not JSON throws the SyntaxError, as `response.json()` did.
	return JSON.parse(await readTextCapped(response, maxBytes));
}

/**
 * The first 4 KiB of an error body. Never throws: an error body that fails,
 * stalls past the deadline or runs over is simply cut, because the status has
 * already told us what the provider said.
 */
export async function readErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	try {
		while (total < MAX_ERROR_BODY_BYTES) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const room = MAX_ERROR_BODY_BYTES - total;
			const part = chunk.value.byteLength > room ? chunk.value.subarray(0, room) : chunk.value;
			total += part.byteLength;
			text += decoder.decode(part, { stream: true });
		}
	} catch {
		// keep what arrived
	} finally {
		contexts.get(response)?.release.abort();
		await reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			// already released
		}
	}
	return text + decoder.decode();
}
