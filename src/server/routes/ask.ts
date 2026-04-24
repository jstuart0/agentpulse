import type { Context } from "hono";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { isAiActive, isAiBuildEnabled } from "../services/ai/feature.js";
import {
	archiveThread,
	getThread,
	listMessages,
	listThreads,
	runAskTurn,
	runAskTurnStream,
} from "../services/ask/ask-service.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";

/**
 * Ask chat: global conversational assistant over the user's sessions.
 * Reuses the default LLM provider configured in Settings → AI. All
 * endpoints require the askAssistant labs flag to be enabled so users
 * who haven't opted in don't accidentally spin up LLM calls.
 */
const askRouter = new Hono();
askRouter.use("/ai/ask/*", requireAuth());
askRouter.use("/ai/ask", requireAuth());

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

askRouter.post("/ai/ask", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const body = await c.req.json<{
		threadId?: string | null;
		message?: string;
		sessionIds?: string[];
	}>();
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "message required" }, 400);
	}
	try {
		const res = await runAskTurn({
			threadId: body.threadId ?? null,
			message: body.message,
			sessionIds: body.sessionIds,
		});
		return c.json(res);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: message }, 500);
	}
});

/**
 * SSE streaming turn. Emits `start` → zero or more `delta` → `done` /
 * `error`. Each frame is a JSON payload on a `data:` line. Web UI
 * subscribes to deltas so tokens render as they arrive; Telegram keeps
 * using the non-streaming `/ai/ask` endpoint because Telegram's rate
 * limits make per-token message edits hostile.
 */
askRouter.post("/ai/ask/stream", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const body = await c.req.json<{
		threadId?: string | null;
		message?: string;
		sessionIds?: string[];
	}>();
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "message required" }, 400);
	}
	// Build the SSE stream by hand instead of using hono/streaming. That
	// helper sets `Transfer-Encoding: chunked` which is a connection-
	// specific header forbidden by HTTP/2 — Traefik terminates HTTP/2
	// with the browser, sees the header, and the browser rejects the
	// response with ERR_HTTP2_PROTOCOL_ERROR. Plain `new Response(stream)`
	// lets Bun/Traefik handle framing natively (HTTP/2 DATA frames or
	// HTTP/1.1 chunked, picked per-connection).
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
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
					sessionIds: body.sessionIds,
					origin: "web",
				})) {
					write(evt);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				write({ kind: "error", message, assistantMessage: null });
			} finally {
				clearInterval(keepAlive);
				controller.close();
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
