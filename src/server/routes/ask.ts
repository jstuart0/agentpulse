import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth } from "../auth/middleware.js";
import { getRequestActor, requireOperatorScope } from "../auth/route-scope-policy.js";
import { isAiActive, isAiBuildEnabled } from "../services/ai/feature.js";
import {
	ASK_MAX_SESSION_IDS,
	ASK_MESSAGE_MAX_CHARS,
	AskInvalidSessionIdsError,
	AskRequestError,
	archiveThread,
	getThread,
	listMessages,
	listThreads,
	runAskTurn,
	runAskTurnStream,
	validateAskSessionIds,
} from "../services/ask/ask-service.js";
import {
	ASK_BUSY_MESSAGE,
	AskBusyError,
	AskTurnAbortedError,
} from "../services/ask/ask-turn-limiter.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";

/**
 * Ask chat: global conversational assistant over the user's sessions.
 * Reuses the default LLM provider configured in Settings → AI. All
 * endpoints require the askAssistant labs flag to be enabled so users
 * who haven't opted in don't accidentally spin up LLM calls.
 */
const askRouter = new Hono();

/** A turn's request is one short message and a few ids; 256 KiB is far more than any real one. */
const ASK_BODY_LIMIT_BYTES = 256 * 1024;
const askBodyLimit = bodyLimit({
	maxSize: ASK_BODY_LIMIT_BYTES,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

/** What a client sees when a turn fails for a reason that is not theirs: no paths, no SQL; the detail goes to the log. */
const ASK_FAILED_MESSAGE = "Couldn't answer that right now. Try again in a moment.";

function logAskFailure(err: unknown): void {
	const detail = err instanceof Error ? err.message : String(err);
	console.error(
		JSON.stringify({ kind: "ask_turn_failed", level: "error", error: detail.slice(0, 300) }),
	);
}

/** Parses the request body. Only malformed JSON is the caller's mistake; any other failure, such as the body limit cutting off an oversized read, must propagate. */
async function readAskBody(c: Context): Promise<{
	threadId?: string | null;
	message?: string;
	sessionIds?: string[];
} | null> {
	return c.req.json().catch((err: unknown) => {
		if (!(err instanceof SyntaxError)) throw err;
		return null;
	});
}
// Router-level guards so any future route on this router is covered regardless
// of its path (path-prefixed use() only fires on matching paths, which would
// silently miss a hypothetical non-/ai/ask route added later).
askRouter.use("*", requireAuth());
// Manage-only: /ai/ask is an NL side-channel excluded from observe (D2).
askRouter.use("*", requireOperatorScope());

async function ensureEnabled(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "AI feature is not compiled into this build." }, 404);
	}
	if (!(await isAiActive())) {
		return c.json({ error: "AI is disabled at runtime. Enable in Settings → AI." }, 409);
	}
	if (!(await isLabsFlagEnabled("askAssistant"))) {
		return c.json(
			{ error: "Ask is a Labs feature. Enable 'Ask assistant' in Settings → Labs." },
			409,
		);
	}
	return null;
}

askRouter.get("/ai/ask/threads", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const threads = await listThreads(50);
	return c.json({ threads });
});

askRouter.get("/ai/ask/threads/:id", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const thread = await getThread(id);
	if (!thread) return c.json({ error: "Thread not found" }, 404);
	const messages = await listMessages(id);
	return c.json({ thread, messages });
});

askRouter.delete("/ai/ask/threads/:id", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const ok = await archiveThread(id);
	if (!ok) return c.json({ error: "Thread not found or already archived" }, 404);
	return c.json({ ok: true });
});

askRouter.post("/ai/ask", askBodyLimit, async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const body = await readAskBody(c);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "message required" }, 400);
	}
	if (body.message.trim().length > ASK_MESSAGE_MAX_CHARS) {
		return c.json({ error: "message_too_long", max: ASK_MESSAGE_MAX_CHARS }, 400);
	}
	let sessionIds: string[] | undefined;
	try {
		sessionIds = validateAskSessionIds(body.sessionIds);
	} catch (err) {
		if (err instanceof AskInvalidSessionIdsError) {
			return c.json({ error: "invalid_session_ids", max: ASK_MAX_SESSION_IDS }, 400);
		}
		throw err;
	}
	try {
		const res = await runAskTurn({
			threadId: body.threadId ?? null,
			message: body.message,
			sessionIds,
			actor: await getRequestActor(c),
			// A caller that goes away while waiting for a slot leaves the queue;
			// once its turn has started it runs to completion regardless.
			signal: c.req.raw.signal,
		});
		return c.json(res);
	} catch (err) {
		if (err instanceof AskBusyError || err instanceof AskTurnAbortedError) {
			return c.json({ error: "busy" }, 503, { "Retry-After": "5" });
		}
		if (err instanceof AskRequestError) {
			return c.json({ error: "invalid_request", message: err.message }, 400);
		}
		logAskFailure(err);
		return c.json({ error: "ask_failed" }, 500);
	}
});

/**
 * SSE streaming turn. Emits `start` → zero or more `delta` → `done` /
 * `error`. Each frame is a JSON payload on a `data:` line. Web UI
 * subscribes to deltas so tokens render as they arrive; Telegram keeps
 * using the non-streaming `/ai/ask` endpoint because Telegram's rate
 * limits make per-token message edits hostile.
 */
askRouter.post("/ai/ask/stream", askBodyLimit, async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const body = await readAskBody(c);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "message required" }, 400);
	}
	if (body.message.trim().length > ASK_MESSAGE_MAX_CHARS) {
		return c.json({ error: "message_too_long", max: ASK_MESSAGE_MAX_CHARS }, 400);
	}
	let sessionIds: string[] | undefined;
	try {
		sessionIds = validateAskSessionIds(body.sessionIds);
	} catch (err) {
		if (err instanceof AskInvalidSessionIdsError) {
			return c.json({ error: "invalid_session_ids", max: ASK_MAX_SESSION_IDS }, 400);
		}
		throw err;
	}
	const actor = await getRequestActor(c);
	// Build the SSE stream by hand instead of using hono/streaming. That
	// helper sets `Transfer-Encoding: chunked` which is a connection-
	// specific header forbidden by HTTP/2 — Traefik terminates HTTP/2
	// with the browser, sees the header, and the browser rejects the
	// response with ERR_HTTP2_PROTOCOL_ERROR. Plain `new Response(stream)`
	// lets Bun/Traefik handle framing natively (HTTP/2 DATA frames or
	// HTTP/1.1 chunked, picked per-connection).
	const encoder = new TextEncoder();
	// `cancel` below fires when the client goes away. A turn still waiting for a
	// slot is then dropped from the queue; one that has started is not cancelled
	// (nothing in it can be), it stops at its next event and frees its slot then.
	const clientGone = new AbortController();
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			clientGone.abort();
		},
		async start(controller) {
			const write = (event: unknown) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			// Send an initial :ping comment so some strict proxies flush
			// the response headers to the client immediately, before any
			// LLM token has been generated.
			controller.enqueue(encoder.encode(": stream-open\n\n"));
			// Keep the TCP connection warm while the resolver / enricher /
			// LLM warmup runs. Without this, local setups that take 15-20s
			// to emit the first real token trip browser or proxy idle
			// timeouts and surface to the user as a generic "network error".
			// 5s cadence is well under any sane idle threshold.
			const keepAlive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					// Controller already closed — stop pinging.
					clearInterval(keepAlive);
				}
			}, 5_000);
			try {
				for await (const evt of runAskTurnStream({
					threadId: body.threadId ?? null,
					message: body.message ?? "",
					sessionIds,
					origin: "web",
					actor,
					signal: AbortSignal.any([c.req.raw.signal, clientGone.signal]),
				})) {
					if (clientGone.signal.aborted) break;
					write(evt);
				}
			} catch (err) {
				if (!clientGone.signal.aborted) {
					let message = ASK_FAILED_MESSAGE;
					if (err instanceof AskBusyError || err instanceof AskTurnAbortedError) {
						message = ASK_BUSY_MESSAGE;
					} else if (err instanceof AskRequestError) {
						message = err.message;
					} else {
						logAskFailure(err);
					}
					write({ kind: "error", message, assistantMessage: null });
				}
			} finally {
				clearInterval(keepAlive);
				if (!clientGone.signal.aborted) controller.close();
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
});

export { askRouter };
